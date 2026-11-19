using System.Drawing;
using System.Globalization;
using System.Text.Json;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;

namespace PracSkins;

/// <summary>A deathmatch spawn spot (configs/plugins/PracSkins/dm/&lt;map&gt;.json).</summary>
public class DmSpot
{
    public float X { get; set; }
    public float Y { get; set; }
    public float Z { get; set; }
    public float Yaw { get; set; }
}

/// <summary>dm/&lt;map&gt;.json: spots placed by hand (L → Modes → Spawns) and spots learned from where players walked.</summary>
public class DmSpotFile
{
    public List<DmSpot> Manual { get; set; } = new();
    public List<DmSpot> Learned { get; set; } = new();
}

/// <summary>A player's !guns pick ("" = random).</summary>
public class DmGunPick
{
    public string Primary { get; set; } = "";
    public string Pistol { get; set; } = "";
}

/// <summary>
/// Our own deathmatch ("dm" run of Modes.cs): starts and stops in place (no map change, no game_mode switch).
/// Warmup holds the run; respawns are ours (delay option, mp_respawn_on_death off), every spawn is placed by
/// DmSpawn (manual spots, the map's info_deathmatch_spawn, generated and learned spots), guns come from the
/// player's !guns pick within the variant, spawn protection lasts until the first shot, kills can give HP/armor/
/// clip back, and hits/kills/streaks get a sound and a line in the stats panel (ms_feed).
/// </summary>
public partial class PracSkins
{
    private string DmDir => Path.Combine(ConfigDir, "dm");
    private readonly Dictionary<int, float> _dmProtect = new();
    private readonly Dictionary<int, float> _dmFeedUntil = new();
    private readonly List<CEntityInstance> _dmMarkers = new();
    private float _dmNextLearn;

    private static readonly (string Cls, string Name)[] DmPrimaries =
    [
        ("weapon_ak47", "AK-47"), ("weapon_m4a1", "M4A4"), ("weapon_m4a1_silencer", "M4A1-S"), ("weapon_famas", "FAMAS"),
        ("weapon_galilar", "Galil AR"), ("weapon_aug", "AUG"), ("weapon_sg556", "SG 553"), ("weapon_awp", "AWP"),
        ("weapon_ssg08", "SSG 08"), ("weapon_scar20", "SCAR-20"), ("weapon_g3sg1", "G3SG1"), ("weapon_mp9", "MP9"),
        ("weapon_mac10", "MAC-10"), ("weapon_mp7", "MP7"), ("weapon_mp5sd", "MP5-SD"), ("weapon_ump45", "UMP-45"),
        ("weapon_p90", "P90"), ("weapon_bizon", "PP-Bizon"), ("weapon_nova", "Nova"), ("weapon_xm1014", "XM1014"),
        ("weapon_mag7", "MAG-7"), ("weapon_sawedoff", "Sawed-Off"), ("weapon_m249", "M249"), ("weapon_negev", "Negev")
    ];

    private static readonly (string Cls, string Name)[] DmPistols =
    [
        ("weapon_glock", "Glock-18"), ("weapon_usp_silencer", "USP-S"), ("weapon_hkp2000", "P2000"), ("weapon_p250", "P250"),
        ("weapon_fiveseven", "Five-SeveN"), ("weapon_tec9", "Tec-9"), ("weapon_cz75a", "CZ75-Auto"), ("weapon_deagle", "Desert Eagle"),
        ("weapon_revolver", "R8 Revolver"), ("weapon_elite", "Dual Berettas")
    ];

    private static readonly HashSet<string> DmRifles =
        ["weapon_ak47", "weapon_m4a1", "weapon_m4a1_silencer", "weapon_famas", "weapon_galilar", "weapon_aug", "weapon_sg556"];

    private static string DmGunName(string cls) =>
        DmPrimaries.Concat(DmPistols).FirstOrDefault(g => g.Cls == cls).Name ?? (cls.Length == 0 ? "Random" : cls);

    /// <summary>The primaries a variant allows (empty: no primary at all).</summary>
    private static string[] DmAllowedPrimaries(string variant) => variant switch
    {
        "rifles" => DmRifles.ToArray(),
        "awp" => ["weapon_awp"],
        "scout" => ["weapon_ssg08"],
        "pistols" or "deagle" => [],
        _ => DmPrimaries.Select(g => g.Cls).ToArray()
    };

    private static string[] DmAllowedPistols(string variant) =>
        variant == "deagle" ? ["weapon_deagle"] : DmPistols.Select(g => g.Cls).ToArray();

    private void InitDeathmatch()
    {
        RegisterListener<Listeners.OnMapStart>(_ =>
        {
            _dmProtect.Clear();
            _dmFeedUntil.Clear();
            _dmMarkers.Clear(); // removed with the map
        });
        RegisterListener<Listeners.OnClientDisconnect>(slot => { _dmProtect.Remove(slot); _dmFeedUntil.Remove(slot); });
    }

    // ---------------------------------------------------------------- spots

    private string DmPath(string map) => Path.Combine(DmDir, $"{map}.json");

    private DmSpotFile LoadDmSpots(string map)
    {
        try
        {
            var path = DmPath(map);
            if (File.Exists(path)) return JsonSerializer.Deserialize<DmSpotFile>(File.ReadAllText(path), ModesJson) ?? new();
        }
        catch (Exception e)
        {
            Logger.LogWarningSafe($"dm spots {map}: {e.Message}");
        }
        return new();
    }

    private void SaveDmSpots(string map, DmSpotFile file)
    {
        try
        {
            Directory.CreateDirectory(DmDir);
            var tmp = DmPath(map) + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(file, ModesJson));
            File.Move(tmp, DmPath(map), true);
        }
        catch (Exception e)
        {
            Logger.LogWarningSafe($"dm spots {map}: {e.Message}");
        }
    }

    /// <summary>
    /// The run's spawn spots: 6+ manual spots = only those; else manual + the map's info_deathmatch_spawn, and when
    /// that is under 8, both teams' spawns, free floor around the bombsites/mid and learned spots.
    /// </summary>
    private List<(Vector At, float Yaw)> DmSpots(ModeRun run)
    {
        if (run.DmSpots != null) return run.DmSpots;
        run.DmFile ??= LoadDmSpots(CurrentMap);
        var spots = run.DmFile.Manual.Select(s => (new Vector(s.X, s.Y, s.Z), s.Yaw)).ToList();
        if (spots.Count < 6)
        {
            foreach (var e in Utilities.FindAllEntitiesByDesignerName<CBaseEntity>("info_deathmatch_spawn"))
            {
                if (!e.IsValid || e.CBodyComponent?.SceneNode is not { } node) continue;
                var at = new Vector(node.AbsOrigin.X, node.AbsOrigin.Y, node.AbsOrigin.Z);
                spots.Add((new Vector(at.X, at.Y, GroundUnder(at) + 1), node.AbsRotation.Y));
            }
            run.DmMapSpots = spots.Count - run.DmFile.Manual.Count;
            if (spots.Count < 8)
            {
                foreach (var s in CollectSpawns()) spots.Add((new Vector(s.Origin.X, s.Origin.Y, s.Ground + 1), s.Angles.Y));
                var centers = new[] { PlaceTarget("a"), PlaceTarget("b"), PlaceTarget("mid") }.Where(c => c != null).Select(c => c!).ToList();
                var extra = new List<Vector>(centers);
                for (var i = 0; i < centers.Count; i++)
                    for (var j = i + 1; j < centers.Count; j++)
                        extra.Add(new Vector((centers[i].X + centers[j].X) / 2, (centers[i].Y + centers[j].Y) / 2, Math.Max(centers[i].Z, centers[j].Z)));
                foreach (var c in extra)
                    for (var k = 0; k < 6; k++)
                    {
                        var a = k * MathF.PI / 3;
                        var r = k == 0 ? 0 : 280f;
                        if (FindStandSpot(new Vector(c.X + MathF.Cos(a) * r, c.Y + MathF.Sin(a) * r, c.Z)) is { } at)
                            spots.Add((at, Random.Shared.Next(360)));
                    }
                spots.AddRange(run.DmFile.Learned.Select(s => (new Vector(s.X, s.Y, s.Z), s.Yaw)));
            }
        }
        Logger.LogInformation("Deathmatch: {Count} spawn spots on {Map} ({Manual} manual, {MapSpots} from the map, {Learned} learned)",
            spots.Count, CurrentMap, run.DmFile.Manual.Count, run.DmMapSpots, run.DmFile.Learned.Count);
        return run.DmSpots = spots;
    }

    /// <summary>
    /// A spot no enemy stands close to (600 units) or can see, not where the player died; looser when nothing
    /// qualifies (then the one farthest from everyone).
    /// </summary>
    private (Vector At, float Yaw)? DmPick(ModeRun run, CCSPlayerController p)
    {
        var spots = DmSpots(run);
        if (spots.Count == 0) return null;
        var ffa = run.Opts["dm.type"] == "ffa";
        var enemies = Utilities.GetPlayers()
            .Where(o => o is { IsValid: true, PawnIsAlive: true } && o.Slot != p.Slot && !IsStandIn(o) && (ffa || o.TeamNum != p.TeamNum))
            .Select(o => o.PlayerPawn.Value?.AbsOrigin).Where(v => v != null).Select(v => Copy(v!)).ToList();
        float Nearest(Vector at) => enemies.Count == 0 ? float.MaxValue
            : enemies.Min(e => (e.X - at.X) * (e.X - at.X) + (e.Y - at.Y) * (e.Y - at.Y) + (e.Z - at.Z) * (e.Z - at.Z));
        bool Seen(Vector at) => enemies.Any(e => ClearLine(new Vector(e.X, e.Y, e.Z + 64), new Vector(at.X, at.Y, at.Z + 60)));
        var last = run.DmLastSpot.TryGetValue(p.Slot, out var l) ? l : null;
        bool Fresh((Vector At, float Yaw) s) => last == null || (s.At.X - last.X) * (s.At.X - last.X) + (s.At.Y - last.Y) * (s.At.Y - last.Y) > 200 * 200;
        var shuffled = spots.OrderBy(_ => Random.Shared.Next()).ToList();
        var pick = shuffled.FirstOrDefault(s => Fresh(s) && Nearest(s.At) > 600 * 600 && !Seen(s.At) && StandingRoom(s.At));
        if (pick.At == null) pick = shuffled.FirstOrDefault(s => Fresh(s) && Nearest(s.At) > 400 * 400 && StandingRoom(s.At));
        if (pick.At == null) pick = shuffled.OrderByDescending(s => Nearest(s.At)).First();
        return pick;
    }

    // ---------------------------------------------------------------- spawn / death

    /// <summary>A dm spawn (0.05 s after player_spawn): placed on a spot, protected, guns 0.1 s later.</summary>
    private void DmSpawn(ModeRun run, CCSPlayerController p)
    {
        if (IsStandIn(p) || p.PlayerPawn.Value is not { IsValid: true } pawn) return;
        if (DmPick(run, p) is { } pick)
        {
            pawn.Teleport(pick.At, new QAngle(0, pick.Yaw, 0), new Vector(0, 0, 0));
            run.DmLastSpot[p.Slot] = Copy(pick.At);
        }
        var protect = ModeFloat(run.Opts["dm.protect"], 1);
        if (protect > 0) DmProtect(p, pawn, protect);
        else pawn.TakesDamage = true;
        var slot = p.Slot;
        AddTimer(0.1f, () =>
        {
            if (_modeRun != run || Utilities.GetPlayerFromSlot(slot) is not { IsValid: true, PawnIsAlive: true } pl) return;
            DmGiveGuns(run, pl);
        }, TimerFlags.STOP_ON_MAPCHANGE);
    }

    private void DmProtect(CCSPlayerController p, CCSPlayerPawn pawn, float seconds)
    {
        _dmProtect[p.Slot] = Server.CurrentTime + seconds;
        pawn.TakesDamage = false;
        pawn.Render = Color.FromArgb(255, 120, 200, 255);
        Utilities.SetStateChanged(pawn, "CBaseModelEntity", "m_clrRender");
    }

    private void DmUnprotect(int slot)
    {
        if (!_dmProtect.Remove(slot)) return;
        if (Utilities.GetPlayerFromSlot(slot)?.PlayerPawn.Value is not { IsValid: true } pawn) return;
        pawn.TakesDamage = true;
        pawn.Render = Color.White;
        Utilities.SetStateChanged(pawn, "CBaseModelEntity", "m_clrRender");
    }

    private void DmGiveGuns(ModeRun run, CCSPlayerController p)
    {
        var variant = run.Opts["dm.guns"];
        var primaries = DmAllowedPrimaries(variant);
        var pistols = DmAllowedPistols(variant);
        var rnd = Random.Shared;
        var pick = !IsBotAny(p) && _modes.Guns.TryGetValue(p.SteamID.ToString(CultureInfo.InvariantCulture), out var g) ? g : null;
        string? primary = primaries.Length == 0 ? null
            : pick != null && primaries.Contains(pick.Primary) ? pick.Primary : primaries[rnd.Next(primaries.Length)];
        // AWP/scout rounds: the deagle unless they picked a pistol
        var pistol = pick != null && pistols.Contains(pick.Pistol) ? pick.Pistol
            : variant is "awp" or "scout" ? "weapon_deagle" : pistols[rnd.Next(pistols.Length)];
        GiveModeGuns(p, primary, pistol);
        if (IsBotAny(p)) return;
        var slot = p.Slot;
        // the best gun in hand (GiveNamedItem doesn't switch)
        AddTimer(0.1f, () =>
        {
            if (Utilities.GetPlayerFromSlot(slot) is { IsValid: true, PawnIsAlive: true } pl) pl.ExecuteClientCommand(primary != null ? "slot1" : "slot2");
        }, TimerFlags.STOP_ON_MAPCHANGE);
    }

    /// <summary>A dm death: respawn after the delay, streak reset, the killer's reward, sound and feed line.</summary>
    private void DmDeath(ModeRun run, int victim, int attacker, bool headshot)
    {
        _dmProtect.Remove(victim);
        if (run.Stats.TryGetValue(victim, out var vs)) vs.Streak = 0;
        var delay = Math.Max(0.1f, ModeFloat(run.Opts["dm.respawn"], 1));
        AddTimer(delay, () =>
        {
            if (_modeRun != run || Utilities.GetPlayerFromSlot(victim) is not { IsValid: true } v || v.PawnIsAlive || v.TeamNum is not (2 or 3)) return;
            v.Respawn();
        }, TimerFlags.STOP_ON_MAPCHANGE);
        if (attacker < 0 || attacker == victim || Utilities.GetPlayerFromSlot(attacker) is not { IsValid: true } a) return;
        var st = StatsOf(run, a);
        st.Streak++;
        st.BestStreak = Math.Max(st.BestStreak, st.Streak);
        if (a.PawnIsAlive && a.PlayerPawn.Value is { IsValid: true } pawn) DmReward(run, pawn);
        var limit = (int)ModeFloat(run.Opts["dm.limit"], 0);
        if (limit > 0 && st.Kills >= limit)
        {
            FinishMode(run, $"{a.PlayerName} reached {limit} kills");
            return;
        }
        if (IsBotAny(a)) return;
        var sound = run.Opts["dm.sound"];
        var streakSound = st.Streak switch { 3 => "UI.XP.Milestone_01", 5 => "UI.XP.Milestone_02", 7 => "UI.XP.Milestone_03", 10 => "UI.XP.Milestone_04", 15 => "UI.XP.Milestone_05", _ => null };
        if (sound != "off") DmSound(a, streakSound ?? (headshot ? "UI.DeathMatchBonusKill" : "UI.ArmsRace.Kill1"));
        var name = Utilities.GetPlayerFromSlot(victim)?.PlayerName ?? "";
        DmFeed(a, st.Streak >= 3 ? $"{(headshot ? "Headshot · " : "")}{name} · {st.Streak} kill streak" : $"{(headshot ? "Headshot · " : "Killed ")}{name}");
    }

    private void DmReward(ModeRun run, CCSPlayerPawn pawn)
    {
        var reward = run.Opts["dm.reward"];
        if (reward == "off") return;
        var hp = reward == "full" ? 100 : Math.Min(100, pawn.Health + (int)ModeFloat(reward, 0));
        if (hp > pawn.Health)
        {
            pawn.Health = hp;
            Utilities.SetStateChanged(pawn, "CBaseEntity", "m_iHealth");
        }
        if (reward == "full")
        {
            pawn.ArmorValue = 100;
            Utilities.SetStateChanged(pawn, "CCSPlayerPawn", "m_ArmorValue");
        }
        // a full clip in every gun
        foreach (var w in Carried(pawn))
        {
            try
            {
                var max = w.As<CCSWeaponBase>().VData?.MaxClip1 ?? 0;
                if (max <= 0 || w.Clip1 >= max) continue;
                w.Clip1 = max;
                Utilities.SetStateChanged(w, "CBasePlayerWeapon", "m_iClip1");
            }
            catch { /* not a gun */ }
        }
    }

    /// <summary>A damage line for the attacker (player_hurt; read the values before calling: the event is freed after the handler).</summary>
    private void DmHit(ModeRun run, CCSPlayerController attacker, int damage, int hitgroup, bool fatal)
    {
        if (IsBotAny(attacker)) return;
        if (!fatal && run.Opts["dm.sound"] == "all") DmSound(attacker, "UIPanorama.XP.Ticker");
        if (fatal) return; // the kill line follows
        var part = hitgroup switch { 1 => "head", 2 => "chest", 3 => "stomach", 4 or 5 => "arm", 6 or 7 => "leg", _ => "" };
        DmFeed(attacker, $"−{damage}{(part.Length > 0 ? " " + part : "")}");
    }

    private void DmSound(CCSPlayerController p, string sound)
    {
        try
        {
            if (p.PlayerPawn.Value is not { IsValid: true } pawn) return;
            var filter = new RecipientFilter();
            filter.Add(p);
            pawn.EmitSound(sound, filter, 1f, 1f);
        }
        catch (Exception e)
        {
            Logger.LogWarningSafe($"dm sound {sound}: {e.Message}");
        }
    }

    private void DmFeed(CCSPlayerController p, string text)
    {
        if (!HudReady || IsBotAny(p)) return;
        HudText(p, "ms_feed", text);
        HudFlag(p, "ms_feed", "on", true);
        _dmFeedUntil[p.Slot] = Server.CurrentTime + 2f;
    }

    /// <summary>Per tick while dm runs: protection ends, feed lines fade, learned spots.</summary>
    private void DmTick(ModeRun run)
    {
        var now = Server.CurrentTime;
        foreach (var (slot, until) in _dmProtect.ToList())
            if (now >= until) DmUnprotect(slot);
        foreach (var (slot, until) in _dmFeedUntil.ToList())
        {
            if (now < until) continue;
            _dmFeedUntil.Remove(slot);
            if (HudReady && Utilities.GetPlayerFromSlot(slot) is { IsValid: true } p) HudFlag(p, "ms_feed", "on", false);
        }
        if (now < _dmNextLearn) return;
        _dmNextLearn = now + 3f;
        DmLearn(run);
    }

    /// <summary>
    /// Every 3 s: where an alive player stands on the floor (≥250 units from every spot we have) becomes a learned
    /// spot, so a map without spawns of its own fills up over a few runs (saved on Stop, at most 150).
    /// </summary>
    private void DmLearn(ModeRun run)
    {
        var file = run.DmFile ??= LoadDmSpots(CurrentMap);
        if (file.Learned.Count >= 150) return;
        var spots = DmSpots(run);
        foreach (var p in Utilities.GetPlayers())
        {
            if (p is not { IsValid: true, PawnIsAlive: true } || IsStandIn(p) || p.PlayerPawn.Value is not { IsValid: true, AbsOrigin: not null } pawn) continue;
            if ((pawn.Flags & (uint)PlayerFlags.FL_ONGROUND) == 0 || _dmProtect.ContainsKey(p.Slot)) continue;
            var at = Copy(pawn.AbsOrigin);
            bool Near(float x, float y, float z) => (x - at.X) * (x - at.X) + (y - at.Y) * (y - at.Y) < 250 * 250 && MathF.Abs(z - at.Z) < 120;
            if (spots.Any(s => Near(s.At.X, s.At.Y, s.At.Z)) || file.Learned.Any(s => Near(s.X, s.Y, s.Z))) continue;
            if (!StandingRoom(new Vector(at.X, at.Y, at.Z + 1))) continue;
            file.Learned.Add(new DmSpot { X = at.X, Y = at.Y, Z = at.Z + 1, Yaw = pawn.EyeAngles.Y });
            run.DmLearnedDirty = true;
            // usable at once only where the run already mixes in generated spots
            if (run.DmFile.Manual.Count < 6 && run.DmFile.Manual.Count + run.DmMapSpots < 8) spots.Add((new Vector(at.X, at.Y, at.Z + 1), pawn.EyeAngles.Y));
            if (file.Learned.Count >= 150) break;
        }
    }

    /// <summary>On Stop: learned spots to disk, protection off, feed lines gone.</summary>
    private void DmStop(ModeRun run)
    {
        if (run.DmLearnedDirty && run.DmFile != null) SaveDmSpots(CurrentMap, run.DmFile);
        foreach (var slot in _dmProtect.Keys.ToList()) DmUnprotect(slot);
        foreach (var slot in _dmFeedUntil.Keys.ToList())
            if (HudReady && Utilities.GetPlayerFromSlot(slot) is { IsValid: true } p) HudFlag(p, "ms_feed", "on", false);
        _dmFeedUntil.Clear();
    }

    // ---------------------------------------------------------------- stats

    private (string Title, string Line) DmStatsText(ModeRun run, CCSPlayerController p)
    {
        var st = run.Stats.TryGetValue(p.Slot, out var x) ? x : new ModeStats();
        var now = Server.CurrentTime;
        var title = "Deathmatch";
        var limit = (int)ModeFloat(run.Opts["dm.limit"], 0);
        var top = run.Stats.Values.Select(s => s.Kills).DefaultIfEmpty(0).Max();
        if (run.Ends > 0) title += $"  ·  {Clock(run.Ends - now)}";
        if (limit > 0) title += $"  ·  first to {limit} ({limit - top} to go)";
        var rank = 1 + run.Stats.Count(kv => kv.Key != p.Slot && kv.Value.Kills > st.Kills);
        var players = Math.Max(run.Stats.Count, 1);
        var kd = st.Deaths > 0 ? (double)st.Kills / st.Deaths : st.Kills;
        var hs = st.Kills > 0 ? st.HsKills * 100 / st.Kills : 0;
        var minutes = Math.Max((now - run.Started) / 60f, 0.25f);
        var line = $"#{rank}/{players}  ·  K {st.Kills}  D {st.Deaths}  ·  K/D {kd:0.00}  ·  HS {hs}%  ·  Streak {st.Streak} (best {st.BestStreak})  ·  {st.Kills / minutes:0.0} KPM";
        return (title, line);
    }

    private static string DmScoreText(ModeStats st, ModeRun run)
    {
        var kd = st.Deaths > 0 ? (double)st.Kills / st.Deaths : st.Kills;
        var hs = st.Kills > 0 ? st.HsKills * 100 / st.Kills : 0;
        var acc = st.Shots > 0 ? Math.Min(100, st.Hits * 100 / st.Shots) : 0;
        var minutes = Math.Max((Server.CurrentTime - run.Started) / 60f, 0.25f);
        return $"{st.Kills} kills · {st.Deaths} deaths · K/D {kd:0.00} · {hs}% HS · {acc}% accuracy · best streak {st.BestStreak} · {st.Kills / minutes:0.0} KPM";
    }

    // ---------------------------------------------------------------- !guns

    [ConsoleCommand("css_guns", "Deathmatch: pick your primary and pistol")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnGunsCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (player is not { IsValid: true } || IsBotAny(player)) return;
        Server.NextFrame(() => { if (player.IsValid) OpenGunsMenu(player); });
    }

    private DmGunPick GunPickOf(CCSPlayerController p)
    {
        var key = p.SteamID.ToString(CultureInfo.InvariantCulture);
        if (!_modes.Guns.TryGetValue(key, out var pick)) _modes.Guns[key] = pick = new DmGunPick();
        return pick;
    }

    private string GunPickText(CCSPlayerController p)
    {
        var pick = _modes.Guns.TryGetValue(p.SteamID.ToString(CultureInfo.InvariantCulture), out var g) ? g : new DmGunPick();
        return $"{DmGunName(pick.Primary)} + {DmGunName(pick.Pistol)}";
    }

    private void OpenGunsMenu(CCSPlayerController player)
    {
        var variant = _modeRun is { Id: "dm" } run ? run.Opts["dm.guns"] : ModeOpt("dm.guns");
        var primaries = DmAllowedPrimaries(variant);
        if (DmAllowedPistols(variant).Length == 1 && primaries.Length == 0)
        {
            player.PrintToChat($"{ChatTag} This deathmatch is Desert Eagle only.");
            return;
        }
        var pick = GunPickOf(player);
        var pistolPage = new MenuPage
        {
            Title = "Deathmatch pistol",
            Build = () => new[] { ("", "Random") }.Concat(DmPistols.Where(g => DmAllowedPistols(variant).Contains(g.Cls)))
                .Select(g => new MenuItem(g.Item2, pl =>
                {
                    pick.Pistol = g.Item1;
                    SaveModes();
                    CloseMenu(pl);
                    pl.PrintToChat($"{ChatTag} Deathmatch guns: {GunPickText(pl)}.");
                    if (_modeRun is { Id: "dm" } r && pl.PawnIsAlive) DmGiveGuns(r, pl);
                }, g.Item1 == pick.Pistol)).ToList()
        };
        if (primaries.Length <= 1)
        {
            OpenMenu(player, pistolPage);
            return;
        }
        OpenMenu(player, new MenuPage
        {
            Title = "Deathmatch primary",
            Build = () => new[] { ("", "Random") }.Concat(DmPrimaries.Where(g => primaries.Contains(g.Cls)))
                .Select(g => new MenuItem(g.Item2, pl =>
                {
                    pick.Primary = g.Item1;
                    PushPage(pl, pistolPage);
                }, g.Item1 == pick.Primary)).ToList()
        });
    }

    // ---------------------------------------------------------------- L window: spawns

    private string DmSpawnSummary()
    {
        var file = _modeRun is { Id: "dm", DmFile: { } f } ? f : LoadDmSpots(CurrentMap);
        var mapSpots = Utilities.FindAllEntitiesByDesignerName<CBaseEntity>("info_deathmatch_spawn").Count();
        var use = file.Manual.Count >= 6 ? "only yours are used" : mapSpots + file.Manual.Count >= 8 ? "yours + the map's" : "mixed with generated and learned ones";
        return $"{file.Manual.Count} yours, {mapSpots} from the map, {file.Learned.Count} learned: {use}";
    }

    private string DmAddSpot(CCSPlayerController p)
    {
        if (p.PlayerPawn.Value is not { IsValid: true, AbsOrigin: not null } pawn) return "Not alive";
        var at = new Vector(pawn.AbsOrigin.X, pawn.AbsOrigin.Y, GroundUnder(pawn.AbsOrigin) + 1);
        var file = LoadDmSpots(CurrentMap);
        if (file.Manual.Count >= 64) return "At most 64 spots";
        if (file.Manual.Any(s => (s.X - at.X) * (s.X - at.X) + (s.Y - at.Y) * (s.Y - at.Y) < 64 * 64)) return "A spot is already here";
        file.Manual.Add(new DmSpot { X = at.X, Y = at.Y, Z = at.Z, Yaw = pawn.EyeAngles.Y });
        DmSpotsChanged(file);
        return $"Spot {file.Manual.Count} added{(file.Manual.Count < 6 ? $" ({6 - file.Manual.Count} more and only yours are used)" : "")}";
    }

    private string DmRemoveNearest(CCSPlayerController p)
    {
        if (p.PlayerPawn.Value is not { IsValid: true, AbsOrigin: not null } pawn) return "Not alive";
        var at = pawn.AbsOrigin;
        var file = LoadDmSpots(CurrentMap);
        if (file.Manual.Count == 0) return "No spots of yours here";
        var near = file.Manual.OrderBy(s => (s.X - at.X) * (s.X - at.X) + (s.Y - at.Y) * (s.Y - at.Y)).First();
        file.Manual.Remove(near);
        DmSpotsChanged(file);
        return $"Removed; {file.Manual.Count} left";
    }

    private void DmSpotsChanged(DmSpotFile file)
    {
        // a running run keeps its learned spots
        if (_modeRun is { Id: "dm" } run)
        {
            if (run.DmFile != null) file.Learned = run.DmFile.Learned;
            run.DmFile = file;
            run.DmSpots = null;
        }
        SaveDmSpots(CurrentMap, file);
        if (_dmMarkers.Count > 0) ShowDmMarkers();
    }

    /// <summary>The spots as floor crosses for 30 s: yours green, the map's blue, learned grey (nearest 60 of those).</summary>
    private void ShowDmMarkers(Vector? near = null)
    {
        ClearDmMarkers();
        var file = _modeRun is { Id: "dm", DmFile: { } f } ? f : LoadDmSpots(CurrentMap);
        void Cross(float x, float y, float z, Color c)
        {
            AddBeam(new Vector(x - 16, y - 16, z), new Vector(x + 16, y + 16, z), c, _dmMarkers);
            AddBeam(new Vector(x - 16, y + 16, z), new Vector(x + 16, y - 16, z), c, _dmMarkers);
        }
        foreach (var s in file.Manual) Cross(s.X, s.Y, s.Z, Color.FromArgb(255, 80, 230, 120));
        foreach (var e in Utilities.FindAllEntitiesByDesignerName<CBaseEntity>("info_deathmatch_spawn").Take(80))
            if (e.IsValid && e.CBodyComponent?.SceneNode is { } node)
                Cross(node.AbsOrigin.X, node.AbsOrigin.Y, GroundUnder(node.AbsOrigin) + 1, Color.FromArgb(255, 90, 160, 255));
        var learned = near == null ? file.Learned.Take(60)
            : file.Learned.OrderBy(s => (s.X - near.X) * (s.X - near.X) + (s.Y - near.Y) * (s.Y - near.Y)).Take(60);
        foreach (var s in learned) Cross(s.X, s.Y, s.Z, Color.FromArgb(255, 170, 170, 170));
        var shown = _dmMarkers.Count;
        AddTimer(30f, () => { if (_dmMarkers.Count == shown) ClearDmMarkers(); }, TimerFlags.STOP_ON_MAPCHANGE);
    }

    private void ClearDmMarkers()
    {
        foreach (var e in _dmMarkers)
            if (e.IsValid) e.Remove();
        _dmMarkers.Clear();
    }

    private void BuildDmRows(CCSPlayerController player, SetSession s)
    {
        s.Rows.Add(new SetRow("   Your guns", $"{GunPickText(player)} (also !guns)",
            [("Pick", false, pl => { CloseSettings(pl); AddTimer(0.1f, () => { if (pl.IsValid) OpenGunsMenu(pl); }, TimerFlags.STOP_ON_MAPCHANGE); })]));
        s.Rows.Add(new SetRow("   Spawns", DmSpawnSummary(),
            [("Add here", false, pl => SetStatus(s, DmAddSpot(pl))),
             ("Remove near", false, pl => SetStatus(s, DmRemoveNearest(pl))),
             ("Clear", false, _ =>
             {
                 var file = LoadDmSpots(CurrentMap);
                 file.Manual.Clear();
                 DmSpotsChanged(file);
                 SetStatus(s, "Your spots on this map are gone");
             }),
             ("Forget learned", false, _ =>
             {
                 var file = LoadDmSpots(CurrentMap);
                 file.Learned.Clear();
                 if (_modeRun is { Id: "dm", DmFile: { } rf }) { rf.Learned.Clear(); _modeRun.DmSpots = null; }
                 SaveDmSpots(CurrentMap, file);
                 SetStatus(s, "Learned spots forgotten");
             }),
             ("Show", false, pl => { ShowDmMarkers(pl.PlayerPawn.Value?.AbsOrigin is { } o ? Copy(o) : null); SetStatus(s, "Spots shown for 30 s"); })]));
    }
}
