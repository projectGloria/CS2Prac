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
            if (@event.Userid is { IsValid: true } bot && IsBotAny(bot) && !@event.Disconnect)
                AddTimer(0.1f, () => ApplyBotProfile(bot));
            return HookResult.Continue;
        });
        RegisterEventHandler<EventPlayerDisconnect>((@event, _) =>
        {
            if (@event.Userid is { } p)
            {
                _botEntry.Remove(p.Slot);
                ShowBotFlag(p.Slot, null);
                _botAvatarFor.Remove(p.Slot);
            }
            return HookResult.Continue;
        });
        InitBotPictures();
    }

    // ---- pictures on the scoreboard, the top bar and the kill feed ----
    // The client draws its own Avatar__Bot picture (and drops the clan tag, kill feed "BOT") for every controller with
    // FL_FAKECLIENT, whatever ServerAvatarOverrides holds (a flag-off experiment proved it). Server code needs the flag
    // though: CSS IsBot (ours goes through IsBotAny), MatchZy (GetTrackedBotCount drops tracked bots that are not
    // IsBot for good: bot_quota too low, bots kicked, "run .nobots", one crash) and the engine's bot_kick.
    // So the flag is cleared only while the frame's snapshot is built: CheckTransmit clears it, and the next frame's
    // first hook (OnServerPreEntityThink; live-tested order per frame: pre-think, post-think, timers, OnTick,
    // NextFrame, pre-world-update, then the command buffer: rcon, ExecuteCommand, bot_add, put-in-server, spawn/team
    // events) sets it again, in memory only. Everything the server runs sees a bot; every packed snapshot sees a human.
    // Client commands arrive before that first hook, so the listeners below set it back first (chat, MatchZy commands,
    // connects). Earlier tries held the flag (networked, then in memory only) around MatchZy's reads: a networked
    // hold lost every bot's picture on each .bot / death, and a memory-only one leaked into the next snapshot of the
    // controller anyway (user test 2026-11-17).

    /// <summary>slot -> bot whose flag the clients see cleared</summary>
    private readonly Dictionary<int, CCSPlayerController> _botShown = new();
    /// <summary>shown bots whose cleared flag still has to be marked changed (SetStateChanged at the next snapshot)</summary>
    private readonly HashSet<int> _botShownNew = new();
    /// <summary>true between CheckTransmit and the next frame: the shown bots' flag is cleared in memory</summary>
    private bool _botFlagsCleared;
    /// <summary>slot -> server time until which the bot is not shown (held kicks)</summary>
    private readonly Dictionary<int, float> _botFlagHold = new();
    private float _nextBotPictureTick;
    private const uint FakeClientFlag = (uint)PlayerFlags.FL_FAKECLIENT;

    /// <summary>A bot, also while its fake-client flag is cleared for the snapshot.</summary>
    private bool IsBotAny(CCSPlayerController p) => p.IsBot || _botShown.ContainsKey(p.Slot);

    private static bool HasBotAvatarId(CCSPlayerController p) =>
        p.SteamID >= BotAvatarId(2, 0) && p.SteamID < AvatarCopyBase + AvatarCopyRange;

    /// <summary>MatchZy commands that may count, spawn or kick bots (from a client console; chat goes through say).</summary>
    private static readonly string[] BotFlagCommands =
        ("bot boost cbot crouchboost crouchbot nobots prac exitprac match dry dryrun start forcestart restart rr " +
         "endmatch forceend map rmap spawn ct t spec team swap switch sleep tactics tac tech").Split(' ');

    private void InitBotPictures()
    {
        CleanAvatarCopies();
        RegisterListener<Listeners.CheckTransmit>(_ => ClearBotFlags());
        RegisterListener<Listeners.OnServerPreEntityThink>(SetBotFlags);
        RegisterListener<Listeners.OnServerPreWorldUpdate>(_ => SetBotFlags());
        RegisterListener<Listeners.OnTick>(SetBotFlags);
        RegisterListener<Listeners.OnTick>(OnBotPictureTick);
        foreach (var cmd in new[] { "say", "say_team", "jointeam" }.Concat(BotFlagCommands.Select(c => "css_" + c)))
            AddCommandListener(cmd, (_, _) => { SetBotFlags(); return HookResult.Continue; }, HookMode.Pre);
        RegisterListener<Listeners.OnClientConnect>((_, _, _) => SetBotFlags());
        RegisterListener<Listeners.OnClientPutInServer>(_ => SetBotFlags());
        RegisterListener<Listeners.OnClientDisconnect>(_ => SetBotFlags());
        RegisterEventHandler<EventPlayerDisconnect>((_, _) => { SetBotFlags(); return HookResult.Continue; }, HookMode.Pre);
    }

    /// <summary>Snapshot time: the clients get the shown bots without the flag.</summary>
    private void ClearBotFlags()
    {
        if (_botShown.Count == 0) return;
        foreach (var (slot, b) in _botShown)
        {
            if (!b.IsValid) continue;
            b.Flags &= ~FakeClientFlag;
            if (_botShownNew.Contains(slot)) Utilities.SetStateChanged(b, "CBaseEntity", "m_fFlags");
        }
        _botShownNew.Clear();
        _botFlagsCleared = true;
    }

    /// <summary>Server logic: every bot has the flag (memory only; the next snapshot clears it again).</summary>
    private void SetBotFlags()
    {
        if (!_botFlagsCleared) return;
        _botFlagsCleared = false;
        foreach (var b in _botShown.Values)
            if (b.IsValid) b.Flags |= FakeClientFlag;
    }

    /// <summary>Starts (bot) or stops (null) showing a slot as a human to the clients.</summary>
    private void ShowBotFlag(int slot, CCSPlayerController? bot)
    {
        if (bot != null)
        {
            _botShown[slot] = bot;
            _botShownNew.Add(slot);
            return;
        }
        _botShownNew.Remove(slot);
        _botFlagHold.Remove(slot);
        if (!_botShown.Remove(slot, out var b) || !b.IsValid) return;
        b.Flags |= FakeClientFlag;
        Utilities.SetStateChanged(b, "CBaseEntity", "m_fFlags");
    }

    /// <summary>Shows the stock bot for <c>seconds</c> (held kicks: the engine's bot_kick goes by the flag).</summary>
    private void HoldBotFlag(CCSPlayerController p, float seconds)
    {
        if (!IsBotAny(p)) return;
        if (_botShown.ContainsKey(p.Slot)) { SetBotFlags(); ShowBotFlag(p.Slot, null); }
        _botFlagHold[p.Slot] = Server.CurrentTime + seconds;
    }

    private void OnBotPictureTick()
    {
        var now = Server.CurrentTime;
        if (now < _nextBotPictureTick) return;
        _nextBotPictureTick = now + 0.1f;
        if (_botShown.Count == 0 && _bots.T.Count == 0 && _bots.Ct.Count == 0) return;

        var changed = false;
        foreach (var b in Utilities.GetPlayers())
        {
            if (!b.IsValid || b.IsHLTV || !IsBotAny(b)) continue;
            var held = _botFlagHold.TryGetValue(b.Slot, out var until) && now < until;
            var want = !held && b.TeamNum is 2 or 3 && !IsStandIn(b) && HasBotAvatarId(b);
            var shown = _botShown.ContainsKey(b.Slot);
            if (want && !shown)
            {
                ShowBotFlag(b.Slot, b);
                changed = true;
                var bot = b;
                AddTimer(0.1f, () => AnnounceBotPicture(bot));
            }
            else if (!want && shown)
            {
                ShowBotFlag(b.Slot, null);
                changed = true;
            }
        }
        if (changed) RefreshScoreboard();
    }

    // The top bar picks bot picture vs ours when something rebuilds it (a spawn, a death …), not when the flag changes.
    // Once a bot is shown, every later rebuild sees it flag-off; for the first one its spawn is announced again to the
    // human clients only.
    private void AnnounceBotPicture(CCSPlayerController bot)
    {
        if (!bot.IsValid || !_botShown.ContainsKey(bot.Slot) || !bot.PawnIsAlive) return;
        var humans = Utilities.GetPlayers().Where(h => h.IsValid && !IsBotAny(h) && !h.IsHLTV && h.Connected == PlayerConnectedState.Connected).ToList();
        if (humans.Count == 0) return;
        EventPlayerSpawn? e = null;
        try
        {
            e = new EventPlayerSpawn(true) { Userid = bot };
            foreach (var h in humans) e.FireEventToClient(h);
        }
        catch (Exception ex)
        {
            Logger.LogWarning("player_spawn for {Bot}: {Error}", bot.PlayerName, ex.Message);
        }
        finally
        {
            e?.Free();
        }
        RefreshScoreboard();
    }

    /// <summary>Puts the flag back on every bot (plugin unload).</summary>
    private void RestoreBotFlags()
    {
        SetBotFlags();
        foreach (var slot in _botShown.Keys.ToList()) ShowBotFlag(slot, null);
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
        foreach (var bot in Utilities.GetPlayers().Where(p => p is { IsValid: true, IsHLTV: false } && IsBotAny(p)).OrderBy(p => p.Slot))
            ApplyBotProfile(bot);
    }

    private void ApplyBotProfile(CCSPlayerController bot)
    {
        if (!bot.IsValid || !IsBotAny(bot) || IsStandIn(bot) || bot.TeamNum is not (2 or 3)) return;
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
            RefreshScoreboard();
        }

        if (!entry.Avatar)
        {
            _botAvatarFor.Remove(bot.Slot);
            if (bot.SteamID != 0)
            {
                bot.SteamID = 0;
                Utilities.SetStateChanged(bot, "CBasePlayerController", "m_steamID");
            }
            return;
        }
        if (_botAvatarFor.TryGetValue(bot.Slot, out var had) && had == (bot.TeamNum, index) && HasBotAvatarId(bot)) return;
        var id = CopyAvatar(BotAvatarId(bot.TeamNum, index));
        if (id == 0) return;
        _botAvatarFor[bot.Slot] = (bot.TeamNum, index);
        bot.SteamID = id;
        Utilities.SetStateChanged(bot, "CBasePlayerController", "m_steamID");
        // the game reads avatars/<steamid>.png when it sees player_connect_full (fired during server logic: the bot
        // still has its flag, so MatchZy's handler sees a bot)
        FireConnectFull(bot);
    }

    // ---- one SteamID per picture assignment ----
    // The server adds a SteamID's picture to ServerAvatarOverrides only the first time it sees that id
    // ("sv_reliableavatardata: adding player avatar for …"): a later bot given the same entry id kept the stock picture.
    // So every assignment gets a fresh id above the app's ids: the app's avatars/<BotAvatarId>.png is copied to
    // avatars/<fresh id>.png, read at player_connect_full and deleted again a few seconds later.
    private static readonly ulong AvatarCopyBase = BotAvatarId(2, 0) + 1000;
    private const ulong AvatarCopyRange = 1_000_000;
    /// <summary>starts from the clock so a plugin reload doesn't reuse ids the running server already saw</summary>
    private ulong _avatarSeq = (ulong)(DateTimeOffset.UtcNow.ToUnixTimeSeconds() % 900_000);
    /// <summary>slot -> entry the bot's current picture id was made for</summary>
    private readonly Dictionary<int, (byte Team, int Index)> _botAvatarFor = new();
    private static string AvatarsDir => Path.Combine(Server.GameDirectory, "csgo", "avatars");

    /// <summary>Copies the entry's picture to a fresh id; 0 when the picture is missing.</summary>
    private ulong CopyAvatar(ulong entryId)
    {
        try
        {
            var src = Path.Combine(AvatarsDir, $"{entryId}.png");
            if (!File.Exists(src)) return 0;
            _avatarSeq = (_avatarSeq + 1) % AvatarCopyRange;
            var id = AvatarCopyBase + _avatarSeq;
            var dst = Path.Combine(AvatarsDir, $"{id}.png");
            File.Copy(src, dst, true);
            AddTimer(10f, () => { try { File.Delete(dst); } catch { /* next load cleans it */ } });
            return id;
        }
        catch (Exception e)
        {
            Logger.LogWarning("Could not copy the bot picture {Id}: {Error}", entryId, e.Message);
            return 0;
        }
    }

    /// <summary>Removes copies left by an earlier load (a crash or unload within 10 s of a copy).</summary>
    private void CleanAvatarCopies()
    {
        try
        {
            if (!Directory.Exists(AvatarsDir)) return;
            foreach (var f in Directory.GetFiles(AvatarsDir, "*.png"))
                if (ulong.TryParse(Path.GetFileNameWithoutExtension(f), out var id) && id >= AvatarCopyBase && id < AvatarCopyBase + AvatarCopyRange)
                    File.Delete(f);
        }
        catch (Exception e)
        {
            Logger.LogWarning("Could not clean old bot pictures: {Error}", e.Message);
        }
    }

    /// <summary>The scoreboard keeps the clan tags it drew until something makes it rebuild; nextlevel_changed is the
    /// event tag plugins fire for that (it changes nothing else). Batched to one per frame.</summary>
    private bool _scoreboardRefreshQueued;
    private void RefreshScoreboard()
    {
        if (_scoreboardRefreshQueued) return;
        _scoreboardRefreshQueued = true;
        Server.NextFrame(() =>
        {
            _scoreboardRefreshQueued = false;
            try { new EventNextlevelChanged(false).FireEvent(false); }
            catch (Exception e) { Logger.LogWarning("nextlevel_changed: {Error}", e.Message); }
        });
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
        // pictures may have changed: every bot gets a fresh id, so the game reads the files again
        _botAvatarFor.Clear();
        ApplyBotProfiles();
        RefreshScoreboard();
        command.ReplyToCommand($"[PracSkins] bots.json: {_bots.T.Count} T, {_bots.Ct.Count} CT entries");
        foreach (var p in Utilities.GetPlayers().Where(p => p.IsValid && IsBotAny(p)))
            command.ReplyToCommand($"  slot {p.Slot} team {p.TeamNum} name '{p.PlayerName}' clan '{p.Clan}' steamid {p.SteamID}" +
                                   (_botEntry.TryGetValue(p.Slot, out var e) ? $" entry {e.Index}" : "") + (IsStandIn(p) ? " (stand-in)" : "") + (_botShown.ContainsKey(p.Slot) ? " (shown as human)" : ""));
    }
}
