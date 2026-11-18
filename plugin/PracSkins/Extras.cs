using System.Text;
using System.Text.Json;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;

namespace PracSkins;

/// <summary>A saved place of a map (.seta / .setb / .setmid).</summary>
public class PlaceSpot
{
    public float X { get; set; }
    public float Y { get; set; }
    public float Z { get; set; }
    public float Pitch { get; set; }
    public float Yaw { get; set; }
}

/// <summary>
/// Small practice helpers (2026-11-18 plan, phase B):
/// - `css_side` / `.side`: switch T ↔ CT at once (no team menu), respawned where you stood.
/// - T/CT-only grenades follow the team: a molotov becomes an incendiary on CT and back.
/// - Back to spawn: `css_backspawn` / `.bs`, and E with nothing usable in front of you (setting "backspawne").
///   The spawn is the last spawn marker / MatchZy .spawn you went to, else where you last spawned.
/// - `.a` / `.b` / `.mid` (css_place a|b|mid): the bomb sites' centres from the game (CCSPlayerResource), mid half
///   way between the two teams' spawns. `.seta` / `.setb` / `.setmid` save your own spot per map (places.json).
/// - A welcome card (center HTML) and chat block when a player joins (setting "welcome").
/// - Banners: center HTML re-sent every tick for a few seconds (a center message alone lasts a moment).
/// </summary>
public partial class PracSkins
{
    private readonly Dictionary<int, (Vector Pos, QAngle Ang)> _roundSpawn = new();
    private readonly Dictionary<int, (Vector Pos, QAngle Ang)> _practiceSpawn = new();
    private readonly Dictionary<int, ulong> _extraButtons = new();
    private readonly Dictionary<int, (string Html, float Until)> _banners = new();
    private readonly HashSet<int> _welcomed = new();
    private Dictionary<string, Dictionary<string, PlaceSpot>> _places = new();
    private bool _backSpawnE = true;
    private bool _welcomeOn = true;

    private string PlacesPath => Path.Combine(ConfigDir, "places.json");

    private static readonly JsonSerializerOptions PlacesJson = new() { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private void InitExtras()
    {
        LoadPlaces();
        RegisterListener<Listeners.OnTick>(OnExtrasTick);
        RegisterListener<Listeners.OnMapStart>(_ =>
        {
            _roundSpawn.Clear();
            _practiceSpawn.Clear();
            _banners.Clear();
        });
        RegisterListener<Listeners.OnClientPutInServer>(slot =>
        {
            _roundSpawn.Remove(slot);
            _practiceSpawn.Remove(slot);
            _banners.Remove(slot);
            _welcomed.Remove(slot);
        });
        RegisterEventHandler<EventPlayerSpawn>((e, _) =>
        {
            if (e.Userid is not { IsValid: true } p || IsBotAny(p)) return HookResult.Continue;
            AddTimer(0.15f, () =>
            {
                if (!p.IsValid || p.PlayerPawn.Value is not { IsValid: true, AbsOrigin: not null } pawn) return;
                _roundSpawn[p.Slot] = (Copy(pawn.AbsOrigin), Copy(pawn.EyeAngles));
                SwapTeamGrenades(p);
            }, TimerFlags.STOP_ON_MAPCHANGE);
            return HookResult.Continue;
        });
        RegisterEventHandler<EventPlayerTeam>((e, _) =>
        {
            if (e.Userid is not { IsValid: true } p || IsBotAny(p)) return HookResult.Continue;
            _practiceSpawn.Remove(p.Slot); // the other team's spawns
            AddTimer(0.1f, () => { if (p.IsValid) SwapTeamGrenades(p); }, TimerFlags.STOP_ON_MAPCHANGE);
            return HookResult.Continue;
        });
        RegisterEventHandler<EventPlayerConnectFull>((e, _) =>
        {
            if (e.Userid is { IsValid: true } p && !IsBotAny(p))
                AddTimer(3f, () => { if (p.IsValid) Welcome(p); }, TimerFlags.STOP_ON_MAPCHANGE);
            return HookResult.Continue;
        });

        foreach (var say in new[] { "say", "say_team" })
            AddCommandListener(say, (player, info) =>
            {
                if (player is not { IsValid: true }) return HookResult.Continue;
                var text = info.GetArg(1).Trim().ToLowerInvariant();
                switch (text)
                {
                    case ".side": SwitchSide(player); break;
                    case ".bs": case ".backspawn": BackToSpawn(player); break;
                    case ".a": GoPlace(player, "a"); break;
                    case ".b": GoPlace(player, "b"); break;
                    case ".mid": GoPlace(player, "mid"); break;
                    case ".seta": SavePlace(player, "a"); break;
                    case ".setb": SavePlace(player, "b"); break;
                    case ".setmid": SavePlace(player, "mid"); break;
                    case ".welcome": Welcome(player); break;
                    default:
                        // MatchZy's .spawn n / .ctspawn n / .tspawn n: remember where it put the player
                        if (text.StartsWith(".spawn ") || text.StartsWith(".ctspawn ") || text.StartsWith(".tspawn "))
                            AddTimer(0.3f, () => RememberPracticeSpawn(player), TimerFlags.STOP_ON_MAPCHANGE);
                        break;
                }
                return HookResult.Continue;
            });
    }

    private static Vector Copy(Vector v) => new(v.X, v.Y, v.Z);
    private static QAngle Copy(QAngle a) => new(a.X, a.Y, a.Z);

    // ---------------------------------------------------------------- banners

    /// <summary>Shows center HTML for <paramref name="seconds"/> (re-sent every tick; skipped while a window or menu is open).</summary>
    private void ShowBanner(CCSPlayerController player, string html, float seconds = 2.5f)
    {
        if (!player.IsValid || IsBotAny(player)) return;
        _banners[player.Slot] = (html, Server.CurrentTime + seconds);
    }

    private void OnExtrasTick()
    {
        var now = Server.CurrentTime;
        foreach (var (slot, b) in _banners.ToList())
        {
            var p = Utilities.GetPlayerFromSlot(slot);
            if (now >= b.Until || p is not { IsValid: true }) { _banners.Remove(slot); continue; }
            if (MenuOpen(p) || _hudSessions.ContainsKey(slot) || _setSessions.ContainsKey(slot)) continue;
            p.PrintToCenterHtml(b.Html, 1);
        }

        if (!_backSpawnE) return;
        foreach (var player in Utilities.GetPlayers())
        {
            if (player is not { IsValid: true, PawnIsAlive: true } || IsBotAny(player)) continue;
            var buttons = (ulong)player.Buttons;
            var last = _extraButtons.GetValueOrDefault(player.Slot);
            _extraButtons[player.Slot] = buttons;
            if ((buttons & ~last & BtnUse) == 0) continue;
            if (MenuOpen(player) || _hudSessions.ContainsKey(player.Slot) || _setSessions.ContainsKey(player.Slot)) continue;
            if (_move.ContainsKey(player.Slot)) continue; // movement mode has its own reset
            if (_spawnsOn && AimedSpawn(player) != null) continue; // E on a spawn marker stands on it (Practice.cs)
            if (SomethingUsable(player)) continue;
            BackToSpawn(player, quiet: true);
        }
    }

    // ---------------------------------------------------------------- side switch

    [ConsoleCommand("css_side", "Switch T <-> CT at once and stay where you stand")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnSideCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (player != null) SwitchSide(player);
    }

    private void SwitchSide(CCSPlayerController player)
    {
        if (!player.IsValid) return;
        var to = player.TeamNum == (byte)CsTeam.Terrorist ? CsTeam.CounterTerrorist : CsTeam.Terrorist;
        var pawn = player.PlayerPawn.Value;
        (Vector Pos, QAngle Ang)? at = pawn is { IsValid: true, AbsOrigin: not null } && player.PawnIsAlive
            ? (Copy(pawn.AbsOrigin), Copy(pawn.EyeAngles)) : null;
        player.SwitchTeam(to);
        AddTimer(0.05f, () =>
        {
            if (!player.IsValid) return;
            player.Respawn();
            AddTimer(0.1f, () =>
            {
                if (!player.IsValid || at == null || player.PlayerPawn.Value is not { IsValid: true } p) return;
                p.Teleport(at.Value.Pos, at.Value.Ang, new Vector(0, 0, 0));
            }, TimerFlags.STOP_ON_MAPCHANGE);
        }, TimerFlags.STOP_ON_MAPCHANGE);
        var name = to == CsTeam.CounterTerrorist ? "<font color='#5aa0ff'>Counter-Terrorists</font>" : "<font color='#f0a032'>Terrorists</font>";
        ShowBanner(player, $"<font class='fontSize-l'>{name}</font>", 1.5f);
    }

    /// <summary>T and CT have their own fire grenade: a molotov kept as CT becomes an incendiary and back.</summary>
    private void SwapTeamGrenades(CCSPlayerController player)
    {
        if (!player.IsValid || !player.PawnIsAlive) return;
        var pawn = player.PlayerPawn.Value;
        var services = pawn?.WeaponServices;
        if (pawn is not { IsValid: true } || services == null) return;
        var (wrong, right) = player.TeamNum switch
        {
            (byte)CsTeam.CounterTerrorist => ("weapon_molotov", "weapon_incgrenade"),
            (byte)CsTeam.Terrorist => ("weapon_incgrenade", "weapon_molotov"),
            _ => ("", "")
        };
        if (wrong.Length == 0) return;
        var weapons = services.MyWeapons.Select(h => h.Value).Where(w => w is { IsValid: true }).ToList();
        var bad = weapons.Where(w => w!.DesignerName == wrong).ToList();
        if (bad.Count == 0) return;
        var hasRight = weapons.Any(w => w!.DesignerName == right);
        foreach (var w in bad)
        {
            pawn.RemovePlayerItem(w!);
            w!.Remove();
        }
        if (!hasRight) player.GiveNamedItem(right);
    }

    // ---------------------------------------------------------------- back to spawn

    [ConsoleCommand("css_backspawn", "Back to your spawn (the last spawn marker / .spawn you went to, else where you spawned)")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnBackSpawnCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (player != null) BackToSpawn(player);
    }

    private void RememberPracticeSpawn(CCSPlayerController player)
    {
        if (player.IsValid && player.PlayerPawn.Value is { IsValid: true, AbsOrigin: not null } pawn)
            _practiceSpawn[player.Slot] = (Copy(pawn.AbsOrigin), Copy(pawn.EyeAngles));
    }

    private void BackToSpawn(CCSPlayerController player, bool quiet = false)
    {
        if (!player.IsValid || !player.PawnIsAlive || player.PlayerPawn.Value is not { IsValid: true } pawn) return;
        var practice = _practiceSpawn.TryGetValue(player.Slot, out var spot);
        if (!practice && !_roundSpawn.TryGetValue(player.Slot, out spot))
        {
            if (!quiet) player.PrintToChat($"{ChatTag} No spawn known yet: it is remembered from your next spawn.");
            return;
        }
        pawn.Teleport(spot.Pos, spot.Ang, new Vector(0, 0, 0));
        ShowBanner(player, practice ? "<font color='#50e678'>Back to your practice spawn</font>" : "<font color='#50e678'>Back to spawn</font>", 1.2f);
    }

    /// <summary>Whether E would do something: a door, button, loose weapon, the bomb or a hostage close in front.</summary>
    private static bool SomethingUsable(CCSPlayerController player)
    {
        var pawn = player.PlayerPawn.Value;
        if (pawn?.AbsOrigin == null) return true;
        var eye = new Vector(pawn.AbsOrigin.X, pawn.AbsOrigin.Y, pawn.AbsOrigin.Z + pawn.ViewOffset.Z);
        var pitch = pawn.EyeAngles.X * MathF.PI / 180f;
        var yaw = pawn.EyeAngles.Y * MathF.PI / 180f;
        var f = new Vector(MathF.Cos(pitch) * MathF.Cos(yaw), MathF.Cos(pitch) * MathF.Sin(yaw), -MathF.Sin(pitch));
        try
        {
            foreach (var prefix in new[] { "prop_door", "func_door", "func_button", "func_rot_button", "weapon_", "planted_c4", "hostage_entity", "item_" })
                foreach (var e in Utilities.FindAllEntitiesByDesignerName<CBaseEntity>(prefix))
                {
                    if (!e.IsValid || e.AbsOrigin == null) continue;
                    // a weapon someone carries isn't on the floor
                    if (e.DesignerName.StartsWith("weapon_") && e.OwnerEntity.IsValid) continue;
                    var reach = prefix is "prop_door" or "func_door" ? 130f : 110f;
                    var d = new Vector(e.AbsOrigin.X - eye.X, e.AbsOrigin.Y - eye.Y, e.AbsOrigin.Z - eye.Z);
                    var dist = MathF.Sqrt(d.X * d.X + d.Y * d.Y + d.Z * d.Z);
                    if (dist > reach) continue;
                    if (dist < 40) return true;
                    var cos = (d.X * f.X + d.Y * f.Y + d.Z * f.Z) / dist;
                    if (cos > 0.6f) return true;
                }
        }
        catch
        {
            return true; // when in doubt, leave E alone
        }
        return false;
    }

    // ---------------------------------------------------------------- .a / .b / .mid

    [ConsoleCommand("css_place", "Teleport to a bomb site or mid: a | b | mid (save your own with css_setplace)")]
    [CommandHelper(minArgs: 1, usage: "<a|b|mid>", whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnPlaceCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (player != null) GoPlace(player, info.GetArg(1).ToLowerInvariant());
    }

    [ConsoleCommand("css_setplace", "Save where you stand as this map's a | b | mid (clear: css_setplace <name> clear)")]
    [CommandHelper(minArgs: 1, usage: "<a|b|mid> [clear]", whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnSetPlaceCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (player == null) return;
        var name = info.GetArg(1).ToLowerInvariant();
        if (info.ArgCount > 2 && info.GetArg(2) == "clear")
        {
            if (_places.TryGetValue(CurrentMap, out var m) && m.Remove(name)) SavePlaces();
            player.PrintToChat($"{ChatTag} {PlaceLabel(name)} back to the game's own spot.");
        }
        else SavePlace(player, name);
    }

    private static string PlaceLabel(string name) => name switch { "a" => "A site", "b" => "B site", _ => "Mid" };

    private void GoPlace(CCSPlayerController player, string name)
    {
        if (name is not ("a" or "b" or "mid")) return;
        if (!player.IsValid || !player.PawnIsAlive || player.PlayerPawn.Value is not { IsValid: true } pawn) return;
        if (_places.TryGetValue(CurrentMap, out var saved) && saved.TryGetValue(name, out var s))
        {
            pawn.Teleport(new Vector(s.X, s.Y, s.Z), new QAngle(s.Pitch, s.Yaw, 0), new Vector(0, 0, 0));
            ShowBanner(player, $"<font class='fontSize-l' color='#ffd24a'>{PlaceLabel(name)}</font>", 1.5f);
            return;
        }
        var target = PlaceTarget(name);
        if (target == null)
        {
            player.PrintToChat($"{ChatTag} This map has no {PlaceLabel(name)} the game knows of. Stand there and type .set{name}.");
            return;
        }
        var stand = FindStandSpot(target);
        if (stand == null)
        {
            player.PrintToChat($"{ChatTag} No free floor found near {PlaceLabel(name)}. Stand there and type .set{name}.");
            return;
        }
        // look the way the enemy comes from: towards the other team's spawns
        var spawns = CollectSpawns();
        var enemy = player.TeamNum == (byte)CsTeam.CounterTerrorist ? CsTeam.Terrorist : CsTeam.CounterTerrorist;
        var yaw = 0f;
        if (Average(spawns.Where(x => x.Team == enemy).Select(x => x.Origin).ToList()) is { } e)
            yaw = MathF.Atan2(e.Y - stand.Y, e.X - stand.X) * 180f / MathF.PI;
        pawn.Teleport(stand, new QAngle(0, yaw, 0), new Vector(0, 0, 0));
        ShowBanner(player, $"<font class='fontSize-l' color='#ffd24a'>{PlaceLabel(name)}</font>", 1.5f);
    }

    private Vector? PlaceTarget(string name)
    {
        if (name == "mid")
        {
            var spawns = CollectSpawns();
            var t = Average(spawns.Where(s => s.Team == CsTeam.Terrorist).Select(s => s.Origin).ToList());
            var ct = Average(spawns.Where(s => s.Team == CsTeam.CounterTerrorist).Select(s => s.Origin).ToList());
            if (t == null || ct == null) return null;
            return new Vector((t.X + ct.X) / 2, (t.Y + ct.Y) / 2, Math.Max(t.Z, ct.Z));
        }
        var res = Utilities.FindAllEntitiesByDesignerName<CCSPlayerResource>("cs_player_manager").FirstOrDefault();
        if (res is not { IsValid: true }) return null;
        var c = name == "a" ? res.BombsiteCenterA : res.BombsiteCenterB;
        if (c.X == 0 && c.Y == 0 && c.Z == 0) return null;
        return new Vector(c.X, c.Y, c.Z);
    }

    private static Vector? Average(List<Vector> points)
    {
        if (points.Count == 0) return null;
        return new Vector(points.Average(p => p.X), points.Average(p => p.Y), points.Average(p => p.Z));
    }

    /// <summary>Free floor near <paramref name="c"/>: rings of points, each traced down to the floor, the first one a standing hull fits.</summary>
    private static Vector? FindStandSpot(Vector c)
    {
        foreach (var r in new[] { 0f, 48f, 96f, 144f, 192f, 256f, 320f })
        {
            var n = r == 0 ? 1 : 12;
            for (var k = 0; k < n; k++)
            {
                var a = k * 2 * MathF.PI / n;
                var x = c.X + MathF.Cos(a) * r;
                var y = c.Y + MathF.Sin(a) * r;
                foreach (var top in new[] { c.Z + 64, c.Z + 160, c.Z + 300 })
                {
                    try
                    {
                        var options = new TraceOptions { InteractsWith = Masks.PlayerSolidBrushOnly };
                        var hit = Trace.TraceEndShape(new Vector(x, y, top), new Vector(x, y, top - 700), null!, options);
                        if (!hit.DidHit() || hit.IsAllSolid) continue;
                        var at = new Vector(x, y, hit.EndPos.Z + 1);
                        if (StandingRoom(at)) return at;
                    }
                    catch
                    {
                        return new Vector(c.X, c.Y, c.Z + 8);
                    }
                }
            }
        }
        return null;
    }

    private void SavePlace(CCSPlayerController player, string name)
    {
        if (name is not ("a" or "b" or "mid")) return;
        if (!IsAdmin(player)) return;
        if (player.PlayerPawn.Value is not { IsValid: true, AbsOrigin: not null } pawn) return;
        if (!_places.TryGetValue(CurrentMap, out var m)) _places[CurrentMap] = m = new();
        m[name] = new PlaceSpot
        {
            X = pawn.AbsOrigin.X, Y = pawn.AbsOrigin.Y, Z = pawn.AbsOrigin.Z, Pitch = pawn.EyeAngles.X, Yaw = pawn.EyeAngles.Y
        };
        SavePlaces();
        player.PrintToChat($"{ChatTag} {PlaceLabel(name)} saved for {CurrentMap}: .{name} brings you here (css_setplace {name} clear forgets it).");
    }

    private void LoadPlaces()
    {
        try
        {
            if (File.Exists(PlacesPath))
                _places = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, PlaceSpot>>>(File.ReadAllText(PlacesPath), PlacesJson) ?? new();
        }
        catch (Exception e)
        {
            Logger.LogWarning("places.json is invalid: {Message}", e.Message);
        }
    }

    private void SavePlaces()
    {
        try
        {
            Directory.CreateDirectory(ConfigDir);
            var tmp = PlacesPath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(_places, PlacesJson));
            File.Move(tmp, PlacesPath, true);
        }
        catch (Exception e)
        {
            Logger.LogWarning("could not write places.json: {Message}", e.Message);
        }
    }

    // ---------------------------------------------------------------- welcome

    private void Welcome(CCSPlayerController player)
    {
        if (!_welcomeOn || !player.IsValid || IsBotAny(player)) return;
        var first = _welcomed.Add(player.Slot);
        var html = new StringBuilder();
        html.Append("<font class='fontSize-xl'>").Append(Gradient(_serverName, (90, 230, 140), (90, 160, 255))).Append("</font><br>");
        html.Append($"<font class='fontSize-m' color='#c8c8c8'>Welcome, </font><font class='fontSize-m' color='#ffffff'>{Html(player.PlayerName)}</font>");
        html.Append($"<font class='fontSize-m' color='#c8c8c8'> · {Html(CurrentMap)}</font><br>");
        html.Append("<font class='fontSize-s' color='#ffd24a'>K</font><font class='fontSize-s' color='#a0a0a0'> skins   </font>");
        html.Append("<font class='fontSize-s' color='#ffd24a'>L</font><font class='fontSize-s' color='#a0a0a0'> settings   </font>");
        html.Append("<font class='fontSize-s' color='#ffd24a'>M</font><font class='fontSize-s' color='#a0a0a0'> side   </font>");
        html.Append("<font class='fontSize-s' color='#ffd24a'>.a .b .mid</font><font class='fontSize-s' color='#a0a0a0'> places   </font>");
        html.Append("<font class='fontSize-s' color='#ffd24a'>E / .bs</font><font class='fontSize-s' color='#a0a0a0'> spawn</font>");
        ShowBanner(player, html.ToString(), 6f);

        if (!first) return;
        player.PrintToChat($" {ChatColors.Green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        player.PrintToChat($" {ChatColors.Green}{_serverName}{ChatColors.Default} · welcome, {ChatColors.Gold}{player.PlayerName}{ChatColors.Default}");
        player.PrintToChat($" {ChatColors.Gold}K{ChatColors.Default} skins · {ChatColors.Gold}L{ChatColors.Default} server settings · {ChatColors.Gold}M{ChatColors.Default} switch side · {ChatColors.Gold}T{ChatColors.Default} graffiti");
        player.PrintToChat($" {ChatColors.Gold}.a .b .mid{ChatColors.Default} sites · {ChatColors.Gold}.bs{ChatColors.Default} / E back to spawn · {ChatColors.Gold}.spawns .glow{ChatColors.Default} · {ChatColors.Gold}.movement");
        player.PrintToChat($" {ChatColors.Green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    }

    private static string Html(string s) => s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");

    /// <summary>One font tag per letter, colours blended from <paramref name="a"/> to <paramref name="b"/>.</summary>
    private static string Gradient(string text, (int R, int G, int B) a, (int R, int G, int B) b)
    {
        var sb = new StringBuilder();
        var n = Math.Max(1, text.Length - 1);
        for (var i = 0; i < text.Length; i++)
        {
            var t = (float)i / n;
            int Mix(int x, int y) => (int)MathF.Round(x + (y - x) * t);
            sb.Append($"<font color='#{Mix(a.R, b.R):x2}{Mix(a.G, b.G):x2}{Mix(a.B, b.B):x2}'>{Html(text[i].ToString())}</font>");
        }
        return sb.ToString();
    }
}
