using System.Text.Json;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;

namespace PracSkins;

/// <summary>One bot entry of bots.json (written by the app's Bots panel).</summary>
public class BotProfile
{
    public string Name { get; set; } = "";
    public string Clan { get; set; } = "";
    /// <summary>true when the app copied a picture to csgo/avatars/&lt;AvatarId&gt;.png for this entry</summary>
    public bool Avatar { get; set; }
}

public class BotsFile
{
    public int Schema { get; set; } = 1;
    public List<BotProfile> T { get; set; } = new();
    public List<BotProfile> Ct { get; set; } = new();
}

/// <summary>
/// Custom bot names, clan tags and pictures. Bots of a team are matched to the team's list in slot order.
/// Pictures use the game's own server avatar overrides (sv_reliableavatardata 1 at launch: the server reads
/// csgo/avatars/&lt;steamid64&gt;.png at player_connect_full and puts it in the ServerAvatarOverrides string table): each
/// listed bot gets a made-up SteamID from an unused account range (BotAvatarId, never a real account, never the
/// user's), the app writes the picture under that id, and we fire player_connect_full for the bot again so the game
/// reads it. Nothing goes to Steam.
/// </summary>
public partial class PracSkins
{
    private string BotsPath => Path.Combine(ConfigDir, "bots.json");
    private BotsFile _bots = new();
    private DateTime _botsStamp;
    /// <summary>slot -> (team, index) the bot was given last, so a bot keeps its entry while it stays on the team</summary>
    private readonly Dictionary<int, (byte Team, int Index)> _botEntry = new();

    /// <summary>Account ids from 4,000,000,000 up are far above any issued Steam account. T bots 0-99, CT bots 100-199.
    /// Same formula as botAvatarId in src/main/setup/bots.ts.</summary>
    internal static ulong BotAvatarId(byte team, int index) =>
        76561197960265728UL + 4_000_000_000UL + (team == 3 ? 100UL : 0UL) + (ulong)index;

    private void InitBots()
    {
        LoadBots();
        RegisterEventHandler<EventPlayerTeam>((@event, _) =>
        {
            if (@event.Userid is { IsValid: true, IsBot: true } bot && !@event.Disconnect)
                AddTimer(0.1f, () => ApplyBotProfile(bot));
            return HookResult.Continue;
        });
        RegisterEventHandler<EventPlayerDisconnect>((@event, _) =>
        {
            if (@event.Userid is { } p) _botEntry.Remove(p.Slot);
            return HookResult.Continue;
        });
    }

    private void LoadBots()
    {
        try
        {
            if (!File.Exists(BotsPath))
            {
                _bots = new();
                return;
            }
            var stamp = File.GetLastWriteTimeUtc(BotsPath);
            if (stamp == _botsStamp) return;
            _bots = JsonSerializer.Deserialize<BotsFile>(File.ReadAllText(BotsPath), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new();
            _botsStamp = stamp;
        }
        catch (Exception e)
        {
            Logger.LogWarning("Could not read {Path}: {Error}", BotsPath, e.Message);
        }
    }

    /// <summary>Names (and pictures) every bot from bots.json; called on team join, spawn and css_prac_reload.</summary>
    private void ApplyBotProfiles()
    {
        LoadBots();
        foreach (var bot in Utilities.GetPlayers().Where(p => p is { IsValid: true, IsBot: true, IsHLTV: false }).OrderBy(p => p.Slot))
            ApplyBotProfile(bot);
    }

    private void ApplyBotProfile(CCSPlayerController bot)
    {
        if (!bot.IsValid || !bot.IsBot || IsStandIn(bot) || bot.TeamNum is not (2 or 3)) return;
        var list = bot.TeamNum == 3 ? _bots.Ct : _bots.T;
        if (list.Count == 0) return;
        // keep the entry while on the same team; else the first one no other bot of the team holds
        int index;
        if (_botEntry.TryGetValue(bot.Slot, out var held) && held.Team == bot.TeamNum && held.Index < list.Count) index = held.Index;
        else
        {
            var taken = Utilities.GetPlayers()
                .Where(p => p.IsValid && p.Slot != bot.Slot && p.TeamNum == bot.TeamNum && _botEntry.TryGetValue(p.Slot, out var e) && e.Team == bot.TeamNum)
                .Select(p => _botEntry[p.Slot].Index).ToHashSet();
            index = Enumerable.Range(0, list.Count).FirstOrDefault(i => !taken.Contains(i), -1);
            if (index < 0) return; // more bots than names: the rest keep the game's names
        }
        _botEntry[bot.Slot] = (bot.TeamNum, index);
        var entry = list[index];

        var name = string.IsNullOrWhiteSpace(entry.Name) ? null : entry.Name.Trim();
        if (name != null && name.Length > 31) name = name[..31];
        if (name != null && bot.PlayerName != name)
        {
            bot.PlayerName = name;
            Utilities.SetStateChanged(bot, "CBasePlayerController", "m_iszPlayerName");
        }
        var clan = entry.Clan.Trim();
        if (clan.Length > 15) clan = clan[..15];
        if (bot.Clan != clan)
        {
            bot.Clan = clan;
            Utilities.SetStateChanged(bot, "CCSPlayerController", "m_szClan");
        }

        var id = entry.Avatar ? BotAvatarId(bot.TeamNum, index) : 0UL;
        if (bot.SteamID != id)
        {
            bot.SteamID = id;
            Utilities.SetStateChanged(bot, "CBasePlayerController", "m_steamID");
            // the game reads avatars/<steamid>.png when it sees player_connect_full
            if (id != 0) FireConnectFull(bot);
        }
    }

    private void FireConnectFull(CCSPlayerController bot)
    {
        try
        {
            var e = new EventPlayerConnectFull(true) { Userid = bot };
            e.FireEvent(false);
        }
        catch (Exception ex)
        {
            Logger.LogWarning("player_connect_full for {Bot}: {Error}", bot.PlayerName, ex.Message);
        }
    }

    [ConsoleCommand("css_prac_bots", "Test: re-apply bots.json and list every bot's name, clan and steamid")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnBotsTest(CCSPlayerController? caller, CommandInfo command)
    {
        _botsStamp = default;
        ApplyBotProfiles();
        // pictures may have changed under the same ids: let the game read the files again
        foreach (var p in Utilities.GetPlayers().Where(p => p is { IsValid: true, IsBot: true } && p.SteamID != 0 && !IsStandIn(p)))
            FireConnectFull(p);
        command.ReplyToCommand($"[PracSkins] bots.json: {_bots.T.Count} T, {_bots.Ct.Count} CT entries");
        foreach (var p in Utilities.GetPlayers().Where(p => p.IsValid && p.IsBot))
            command.ReplyToCommand($"  slot {p.Slot} team {p.TeamNum} name '{p.PlayerName}' clan '{p.Clan}' steamid {p.SteamID}" +
                                   (_botEntry.TryGetValue(p.Slot, out var e) ? $" entry {e.Index}" : "") + (IsStandIn(p) ? " (stand-in)" : ""));
    }
}
