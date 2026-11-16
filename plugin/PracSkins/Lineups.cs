using System.Globalization;
using System.Text.Json;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Utils;

namespace PracSkins;

/// <summary>One of MatchZy's saved nades (cfg/MatchZy/savednades.json), same rules as src/shared/lineups.ts.</summary>
public record Lineup(string Owner, string Name, string Map, string Desc, string Type, Vector Pos, QAngle Ang);

/// <summary>
/// The L window's Nades tab: MatchZy's lineups (.savenade) for this map, the player's own and the global ones
/// ("default"). Go teleports onto the spot with the saved angles and puts the grenade in hand, like .loadnade, but
/// without MatchZy's practice-mode check and fuzzy name match. The file is read when the tab is built (MatchZy and
/// the app write it at any time).
/// </summary>
public partial class PracSkins
{
    private static readonly (string Type, string Label, string Weapon)[] NadeKinds =
    [
        ("Smoke", "Smoke", "weapon_smokegrenade"),
        ("Flash", "Flash", "weapon_flashbang"),
        ("HE", "HE", "weapon_hegrenade"),
        ("Molly", "Molotov", "weapon_molotov"),
        ("Decoy", "Decoy", "weapon_decoy")
    ];

    private static string SavedNadesFile => Path.Combine(Server.GameDirectory, "csgo", "cfg", "MatchZy", "savednades.json");

    private static bool TryTriple(string? s, out float a, out float b, out float c)
    {
        a = b = c = 0;
        if (string.IsNullOrWhiteSpace(s)) return false;
        var parts = s.Trim().Split(new[] { ' ', '\t', ';' }, StringSplitOptions.RemoveEmptyEntries).Select(p => p.TrimEnd(',')).ToArray();
        if (parts.Length == 1) parts = parts[0].Split(',');
        if (parts.Length != 3) return false;
        var n = new float[3];
        for (var i = 0; i < 3; i++)
            if (!float.TryParse(parts[i].Replace(',', '.'), NumberStyles.Float, CultureInfo.InvariantCulture, out n[i])) return false;
        (a, b, c) = (n[0], n[1], n[2]);
        return true;
    }

    /// <summary>Lineups on the current map that this player can load (own first, then global), sorted by name.</summary>
    private List<Lineup> LineupsFor(CCSPlayerController player)
    {
        var list = new List<Lineup>();
        try
        {
            if (!File.Exists(SavedNadesFile)) return list;
            var raw = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, Dictionary<string, string>>>>(File.ReadAllText(SavedNadesFile));
            if (raw == null) return list;
            foreach (var owner in new[] { player.SteamID.ToString(), "default" })
            {
                if (!raw.TryGetValue(owner, out var byName)) continue;
                foreach (var (name, e) in byName.OrderBy(k => k.Key, StringComparer.OrdinalIgnoreCase))
                {
                    if (e.GetValueOrDefault("Map") != CurrentMap) continue;
                    if (!TryTriple(e.GetValueOrDefault("LineupPos"), out var x, out var y, out var z)) continue;
                    if (!TryTriple(e.GetValueOrDefault("LineupAng"), out var p, out var yaw, out var r)) continue;
                    list.Add(new Lineup(owner, name, CurrentMap, e.GetValueOrDefault("Desc") ?? "", e.GetValueOrDefault("Type") ?? "",
                        new Vector(x, y, z), new QAngle(p, yaw, r)));
                }
            }
        }
        catch (Exception e)
        {
            Logger.LogWarningSafe($"savednades.json: {e.Message}");
        }
        return list;
    }

    private void LoadLineup(CCSPlayerController player, Lineup l)
    {
        var pawn = player.PlayerPawn.Value;
        if (pawn == null || !pawn.IsValid || pawn.LifeState != (byte)LifeState_t.LIFE_ALIVE)
        {
            player.PrintToChat($"{ChatTag} You need to be alive to go to a lineup.");
            return;
        }
        pawn.Teleport(l.Pos, l.Ang, new Vector(0, 0, 0));
        var kind = NadeKinds.FirstOrDefault(k => k.Type == l.Type);
        var weapon = kind.Weapon ?? "weapon_smokegrenade";
        var owned = pawn.WeaponServices?.MyWeapons.Any(w => w.Value?.DesignerName == weapon ||
            (weapon == "weapon_molotov" && w.Value?.DesignerName == "weapon_incgrenade")) ?? false;
        if (!owned) player.GiveNamedItem(weapon);
        var use = weapon == "weapon_molotov" && player.TeamNum == 3 && !owned ? "weapon_incgrenade" : weapon;
        AddTimer(0.1f, () =>
        {
            if (player.IsValid) player.ExecuteClientCommandFromServer($"use {use}");
        });
        player.PrintToChat($"{ChatTag} Lineup {l.Name}{(l.Desc.Length > 0 ? $": {l.Desc}" : "")}");
        if (l.Desc.Length > 0) player.PrintToCenter(l.Desc);
    }

    /// <summary>Rows of the Nades tab: a type filter, then one row per lineup.</summary>
    private void BuildNadeRows(CCSPlayerController player, SetSession s)
    {
        var all = LineupsFor(player);
        var chips = new List<(string, bool, Action<CCSPlayerController>)> { ("All", s.NadeFilter.Length == 0, _ => s.NadeFilter = "") };
        foreach (var k in NadeKinds.Take(RowChips - 1))
        {
            var type = k.Type;
            chips.Add(($"{k.Label} ({all.Count(l => l.Type == type)})", s.NadeFilter == type, _ => s.NadeFilter = type));
        }
        s.Rows.Add(new SetRow($"Lineups on {CurrentMap}", ".savenade <name> [description] saves where you stand (MatchZy practice)", chips));
        var shown = all.Where(l => s.NadeFilter.Length == 0 || l.Type == s.NadeFilter).ToList();
        if (shown.Count == 0)
            s.Rows.Add(new SetRow(all.Count == 0 ? "No lineups saved on this map" : "None of this type",
                "The app's Play page > Lineups imports shared lineup files", []));
        foreach (var l in shown.Take(SetRows - 1))
        {
            var lineup = l;
            var type = NadeKinds.FirstOrDefault(k => k.Type == l.Type).Label ?? "Nade";
            var sub = $"{type}{(l.Owner == "default" ? " · everyone" : "")}{(l.Desc.Length > 0 ? $" · {l.Desc}" : "")}";
            s.Rows.Add(new SetRow(l.Name, sub, [("Go", false, pl => { CloseSettings(pl); LoadLineup(pl, lineup); })]));
        }
    }

    [ConsoleCommand("css_prac_lineups", "List the lineups the first human (or bot) can load on this map (server test)")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnPracLineups(CCSPlayerController? _, CommandInfo command)
    {
        var p = Utilities.GetPlayers().FirstOrDefault(x => x.IsValid && !x.IsBot) ?? Utilities.GetPlayers().FirstOrDefault(x => x.IsValid);
        if (p == null)
        {
            command.ReplyToCommand("no players");
            return;
        }
        var list = LineupsFor(p);
        command.ReplyToCommand($"{list.Count} lineups on {CurrentMap} for {p.PlayerName} ({SavedNadesFile})");
        foreach (var l in list)
            command.ReplyToCommand($"  [{l.Type}] {l.Name} owner={l.Owner} pos={l.Pos.X:0.#} {l.Pos.Y:0.#} {l.Pos.Z:0.#} ang={l.Ang.X:0.#} {l.Ang.Y:0.#} desc={l.Desc}");
        if (command.ArgCount > 1 && int.TryParse(command.GetArg(1), out var i) && i >= 0 && i < list.Count)
        {
            LoadLineup(p, list[i]);
            var o = p.PlayerPawn.Value?.AbsOrigin;
            command.ReplyToCommand($"loaded {list[i].Name}: pawn now at {o?.X:0.#} {o?.Y:0.#} {o?.Z:0.#}");
        }
    }
}
