using System.Drawing;
using System.Globalization;
using System.Text.Json;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Cvars;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;
using CounterStrikeSharp.API.Modules.Entities.Constants;
using Microsoft.Extensions.Logging;

namespace PracSkins;

/// <summary>A prefire route point (configs/plugins/PracSkins/prefire/&lt;map&gt;.json).</summary>
public class PrefirePoint
{
    public float X { get; set; }
    public float Y { get; set; }
    public float Z { get; set; }
    public float Yaw { get; set; }
}

/// <summary>configs/plugins/PracSkins/modes.json: the options last picked and the best results per map.</summary>
public class ModesFile
{
    public Dictionary<string, string> Options { get; set; } = new();
    /// <summary>map -> result key (mode + options) -> best score.</summary>
    public Dictionary<string, Dictionary<string, double>> Best { get; set; } = new();
}

/// <summary>Per player numbers of one run.</summary>
public class ModeStats
{
    public int Kills { get; set; }
    public int Deaths { get; set; }
    public int Shots { get; set; }
    public int Hits { get; set; }
    public int Headshots { get; set; }
    public List<float> Reactions { get; } = new();
}

/// <summary>Where a mode bot belongs while the run lasts.</summary>
public class ModeBot
{
    public Vector Base { get; set; } = new(0, 0, 0);
    public Vector Side { get; set; } = new(0, 0, 0);
    public float Offset { get; set; }
    public float Dir { get; set; } = 1;
    public float NextFlip { get; set; }
    public float Yaw { get; set; }
    public float ShownAt { get; set; }
    public bool Hidden { get; set; }
    public int Point { get; set; } = -1;
    /// <summary>Keep it on Base every tick (aim, AWP, prefire); off in deathmatch.</summary>
    public bool Pinned { get; set; }
    /// <summary>Prefire with shooting back: don't turn the bot (its AI aims).</summary>
    public bool FreeAim { get; set; }
}

/// <summary>A running practice mode (one at a time, started by Owner).</summary>
public class ModeRun
{
    public string Id { get; set; } = "";
    public int Owner { get; set; }
    public int Enemy { get; set; } = 2;
    public float Started { get; set; }
    public float Ends { get; set; }
    public Dictionary<string, string> Opts { get; set; } = new();
    public Dictionary<string, string> SavedCvars { get; } = new();
    public bool LeftPractice { get; set; }
    public Dictionary<int, ModeStats> Stats { get; } = new();
    public Dictionary<int, ModeBot> Bots { get; } = new();
    public float NextBanner { get; set; }
    public bool Finished { get; set; }
    // AWP flicks
    public int Round { get; set; }
    public int Rounds { get; set; }
    public int AwpHits { get; set; }
    public float Window { get; set; } = 1f;
    public float ShowAt { get; set; }
    public float HideAt { get; set; }
    // prefire
    public List<PrefirePoint> Points { get; set; } = new();
    public HashSet<int> Cleared { get; } = new();
    public int NextPoint { get; set; }
}

/// <summary>
/// Practice modes (Phase E): deathmatch, aim training, AWP flicks and prefire routes, started from the L window's
/// Modes tab. A run leaves MatchZy practice (css_exitprac, when its autostart mode is practice), holds warmup with
/// respawns and its own cvars, and puts everything back on Stop (saved cvar values, css_prac).
/// </summary>
public partial class PracSkins
{
    private ModeRun? _modeRun;
    private ModesFile _modes = new();
    private string ModesPath => Path.Combine(ConfigDir, "modes.json");
    private string PrefireDir => Path.Combine(ConfigDir, "prefire");
    private static readonly JsonSerializerOptions ModesJson = new() { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private static readonly (string Id, string Name)[] ModeList =
        [("dm", "Deathmatch"), ("aim", "Aim training"), ("awp", "AWP flicks"), ("prefire", "Prefire route")];

    /// <summary>Mode options: key -> (row name, choices (label, value), default value).</summary>
    private static readonly Dictionary<string, (string Mode, string Name, (string Label, string Value)[] Choices, string Default)> ModeOpts = new()
    {
        ["dm.type"] = ("dm", "Type", [("FFA", "ffa"), ("Teams", "teams")], "ffa"),
        ["dm.bots"] = ("dm", "Bots", [("0", "0"), ("3", "3"), ("5", "5"), ("7", "7"), ("9", "9")], "5"),
        ["dm.diff"] = ("dm", "Bot skill", [("Easy", "0"), ("Normal", "1"), ("Hard", "2"), ("Expert", "3")], "2"),
        ["dm.guns"] = ("dm", "Guns", [("Any", "any"), ("Rifles", "rifles"), ("AWP", "awp"), ("Pistols", "pistols"), ("Deagle", "deagle")], "any"),
        ["dm.hs"] = ("dm", "Headshots only", [("Off", "0"), ("On", "1")], "0"),
        ["dm.time"] = ("dm", "Time", [("2 min", "120"), ("5 min", "300"), ("10 min", "600"), ("Endless", "0")], "300"),
        ["aim.targets"] = ("aim", "Targets", [("1", "1"), ("3", "3"), ("5", "5")], "3"),
        ["aim.move"] = ("aim", "Targets move", [("Static", "static"), ("Strafe", "strafe"), ("Crouch", "crouch"), ("Jiggle", "jiggle")], "static"),
        ["aim.range"] = ("aim", "Range", [("Close", "close"), ("Mid", "mid"), ("Far", "far")], "mid"),
        ["aim.hs"] = ("aim", "Headshots only", [("Off", "0"), ("On", "1")], "0"),
        ["aim.time"] = ("aim", "Time", [("30 s", "30"), ("60 s", "60"), ("120 s", "120")], "60"),
        ["awp.rounds"] = ("awp", "Rounds", [("10", "10"), ("20", "20"), ("30", "30")], "20"),
        ["awp.window"] = ("awp", "Shown for", [("1.5 s", "1.5"), ("1 s", "1"), ("0.6 s", "0.6"), ("Shrinks", "shrink")], "1"),
        ["awp.range"] = ("awp", "Range", [("Close", "close"), ("Mid", "mid"), ("Far", "far")], "far"),
        ["prefire.order"] = ("prefire", "Bots", [("One by one", "one"), ("All at once", "all")], "one"),
        ["prefire.shoot"] = ("prefire", "Bots shoot back", [("Off", "0"), ("On", "1")], "0"),
    };

    private static readonly string[] RifleGuns = ["weapon_ak47", "weapon_m4a1", "weapon_m4a1_silencer", "weapon_famas", "weapon_galilar", "weapon_aug", "weapon_sg556"];
    private static readonly string[] PistolGuns = ["weapon_glock", "weapon_usp_silencer", "weapon_hkp2000", "weapon_p250", "weapon_fiveseven", "weapon_tec9", "weapon_cz75a", "weapon_deagle"];

    private void InitModes()
    {
        LoadModes();
        RegisterListener<Listeners.OnTick>(OnModesTick);
        RegisterListener<Listeners.OnMapStart>(_ =>
        {
            // a map change during a run: the cvars live on, so put them back
            if (_modeRun is { } run) { RestoreModeCvars(run); _modeRun = null; }
        });
        RegisterListener<Listeners.OnClientDisconnect>(slot =>
        {
            if (_modeRun is { } run && run.Owner == slot) Server.NextFrame(() => StopMode(null, "the player left"));
            _modeRun?.Bots.Remove(slot);
        });
        RegisterEventHandler<EventPlayerSpawn>((e, _) =>
        {
            if (_modeRun == null || e.Userid is not { IsValid: true } p) return HookResult.Continue;
            var slot = p.Slot;
            // after the spawn teleport and BotLoadouts' gun swap (0.2 s)
            AddTimer(0.45f, () =>
            {
                if (_modeRun is not { } run || Utilities.GetPlayerFromSlot(slot) is not { IsValid: true, PawnIsAlive: true } pl) return;
                OnModeSpawn(run, pl);
            }, TimerFlags.STOP_ON_MAPCHANGE);
            return HookResult.Continue;
        });
        RegisterEventHandler<EventWeaponFire>((e, _) =>
        {
            if (_modeRun is not { } run || e.Userid is not { IsValid: true } p) return HookResult.Continue;
            var w = e.Weapon ?? "";
            if (w.Contains("knife") || w.Contains("grenade") || w.Contains("flashbang") || w.Contains("molotov") || w.Contains("decoy") || w.Contains("bayonet")) return HookResult.Continue;
            StatsOf(run, p).Shots++;
            return HookResult.Continue;
        });
        RegisterEventHandler<EventPlayerHurt>((e, _) =>
        {
            if (_modeRun is not { } run || e.Attacker is not { IsValid: true } a || e.Userid is not { IsValid: true } v || a.Slot == v.Slot) return HookResult.Continue;
            var st = StatsOf(run, a);
            st.Hits++;
            if (e.Hitgroup == 1) st.Headshots++;
            return HookResult.Continue;
        });
        RegisterEventHandler<EventPlayerDeath>((e, _) =>
        {
            if (_modeRun is not { } run || e.Userid is not { IsValid: true } v) return HookResult.Continue;
            StatsOf(run, v).Deaths++;
            if (e.Attacker is { IsValid: true } a && a.Slot != v.Slot)
            {
                var st = StatsOf(run, a);
                st.Kills++;
                if (run.Bots.TryGetValue(v.Slot, out var b) && b.ShownAt > 0) st.Reactions.Add(Server.CurrentTime - b.ShownAt);
            }
            var victim = v.Slot;
            Server.NextFrame(() => OnModeDeath(run, victim, e.Attacker?.Slot ?? -1));
            return HookResult.Continue;
        });
    }

    private static ModeStats StatsOf(ModeRun run, CCSPlayerController p)
    {
        if (!run.Stats.TryGetValue(p.Slot, out var s)) run.Stats[p.Slot] = s = new ModeStats();
        return s;
    }

    private void LoadModes()
    {
        try
        {
            if (File.Exists(ModesPath)) _modes = JsonSerializer.Deserialize<ModesFile>(File.ReadAllText(ModesPath), ModesJson) ?? new();
        }
        catch (Exception e)
        {
            Logger.LogWarningSafe($"modes.json: {e.Message}");
            _modes = new();
        }
    }

    private void SaveModes()
    {
        try
        {
            Directory.CreateDirectory(ConfigDir);
            var tmp = ModesPath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(_modes, ModesJson));
            File.Move(tmp, ModesPath, true);
        }
        catch (Exception e)
        {
            Logger.LogWarningSafe($"modes.json: {e.Message}");
        }
    }

    private string ModeOpt(string key) =>
        _modes.Options.TryGetValue(key, out var v) && ModeOpts[key].Choices.Any(c => c.Value == v) ? v : ModeOpts[key].Default;

    private static float ModeFloat(string v, float fallback) =>
        float.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out var f) ? f : fallback;

    // ---------------------------------------------------------------- prefire routes

    private string PrefirePath(string map) => Path.Combine(PrefireDir, $"{map}.json");

    private List<PrefirePoint> LoadPrefire(string map)
    {
        try
        {
            var path = PrefirePath(map);
            if (File.Exists(path)) return JsonSerializer.Deserialize<List<PrefirePoint>>(File.ReadAllText(path), ModesJson) ?? new();
        }
        catch (Exception e)
        {
            Logger.LogWarningSafe($"prefire route {map}: {e.Message}");
        }
        return new();
    }

    private void SavePrefire(string map, List<PrefirePoint> points)
    {
        try
        {
            Directory.CreateDirectory(PrefireDir);
            File.WriteAllText(PrefirePath(map), JsonSerializer.Serialize(points, ModesJson));
        }
        catch (Exception e)
        {
            Logger.LogWarningSafe($"prefire route {map}: {e.Message}");
        }
    }

    /// <summary>Adds the floor spot the player aims at (within 3000 units) to this map's route, the bot facing the player.</summary>
    private string AddPrefirePoint(CCSPlayerController player)
    {
        if (player.PlayerPawn.Value is not { IsValid: true, AbsOrigin: not null } pawn) return "Not alive";
        var eye = new Vector(pawn.AbsOrigin.X, pawn.AbsOrigin.Y, pawn.AbsOrigin.Z + 64);
        var fwd = Forward(pawn.EyeAngles.X, pawn.EyeAngles.Y);
        var end = new Vector(eye.X + fwd.X * 3000, eye.Y + fwd.Y * 3000, eye.Z + fwd.Z * 3000);
        var hit = TraceWorld(eye, end);
        if (hit == null) return "Aim at a floor or wall nearer than 3000 units";
        // step back from walls, then stand on the floor below
        var back = new Vector(hit.X - fwd.X * 24, hit.Y - fwd.Y * 24, hit.Z + 8);
        var floor = TraceWorld(back, new Vector(back.X, back.Y, back.Z - 600));
        if (floor == null) return "No floor there";
        var at = new Vector(floor.X, floor.Y, floor.Z + 1);
        if (!StandingRoom(at)) return "A bot doesn't fit there";
        var map = CurrentMap;
        var points = LoadPrefire(map);
        if (points.Count >= 10) return "A route has at most 10 points";
        var yaw = YawTo(at, pawn.AbsOrigin);
        points.Add(new PrefirePoint { X = at.X, Y = at.Y, Z = at.Z, Yaw = yaw });
        SavePrefire(map, points);
        return $"Point {points.Count} added";
    }

    // ---------------------------------------------------------------- start / stop

    private void StartModeLater(CCSPlayerController player, string id)
    {
        var slot = player.Slot;
        AddTimer(0.1f, () =>
        {
            if (Utilities.GetPlayerFromSlot(slot) is { IsValid: true } p) StartMode(p, id);
        }, TimerFlags.STOP_ON_MAPCHANGE);
    }

    private void StartMode(CCSPlayerController owner, string id)
    {
        if (_modeRun != null) StopMode(null, "", quiet: true);
        var opts = ModeOpts.Where(o => o.Value.Mode == id).ToDictionary(o => o.Key, o => ModeOpt(o.Key));
        var run = new ModeRun { Id = id, Owner = owner.Slot, Opts = opts, Started = Server.CurrentTime };
        if (id == "prefire")
        {
            run.Points = LoadPrefire(CurrentMap);
            if (run.Points.Count == 0)
            {
                owner.PrintToChat($"{ChatTag} No prefire route on this map yet: L → Modes → Add point (aim at the floor).");
                return;
            }
        }
        if (owner.TeamNum is not (2 or 3)) owner.ChangeTeam(CsTeam.CounterTerrorist);
        run.Enemy = owner.TeamNum == 2 ? 3 : 2;
        var enemyTeam = run.Enemy == 2 ? "T" : "CT";

        // leave MatchZy practice (it kicks bots it didn't add), back on Stop
        if (ConVar.Find("matchzy_autostart_mode") is { } az && CvarInt(az) == 2)
        {
            run.LeftPractice = true;
            Server.ExecuteCommand("css_exitprac");
        }
        _modeRun = run;
        var time = id switch { "dm" => ModeFloat(opts["dm.time"], 300), "aim" => ModeFloat(opts["aim.time"], 60), _ => 0 };
        AddTimer(0.6f, () =>
        {
            if (_modeRun != run) return;
            void Set(string cvar, string value) => SetModeCvar(run, cvar, value);
            Server.ExecuteCommand("mp_warmup_start");
            Set("mp_warmup_pausetimer", "1");
            Set("mp_warmuptime", "9999");
            Set("mp_ignore_round_win_conditions", "1");
            Set("mp_respawn_on_death_t", "1");
            Set("mp_respawn_on_death_ct", "1");
            Set("mp_respawn_immunitytime", id == "dm" ? "1" : "0");
            Set("mp_autoteambalance", "0");
            Set("mp_limitteams", "0");
            Set("bot_join_after_player", "0");
            Set("bot_quota_mode", "normal");
            Set("sv_infinite_ammo", "2");
            Set("sv_hibernate_when_empty", "0");
            Set("mp_free_armor", "2");
            switch (id)
            {
                case "dm":
                    Set("mp_teammates_are_enemies", opts["dm.type"] == "ffa" ? "1" : "0");
                    Set("mp_randomspawn", "1");
                    Set("bot_join_team", "any");
                    Set("bot_difficulty", opts["dm.diff"]);
                    Set("bot_stop", "0");
                    Set("bot_dont_shoot", "0");
                    Set("mp_damage_headshot_only", opts["dm.hs"]);
                    Set("mp_buy_anywhere", opts["dm.guns"] == "any" ? "1" : "0");
                    Set("mp_buytime", "99999");
                    Set("mp_maxmoney", "16000");
                    Set("mp_startmoney", "16000");
                    Set("mp_afterroundmoney", "16000");
                    Set("bot_quota", opts["dm.bots"]);
                    break;
                case "aim":
                    Set("bot_join_team", enemyTeam);
                    Set("bot_stop", "1");
                    Set("bot_dont_shoot", "1");
                    Set("mp_damage_headshot_only", opts["aim.hs"]);
                    Set("bot_quota", opts["aim.targets"]);
                    break;
                case "awp":
                    run.Rounds = (int)ModeFloat(opts["awp.rounds"], 20);
                    run.Window = opts["awp.window"] == "shrink" ? 1.5f : ModeFloat(opts["awp.window"], 1);
                    Set("bot_join_team", enemyTeam);
                    Set("bot_stop", "1");
                    Set("bot_dont_shoot", "1");
                    Set("mp_damage_headshot_only", "0");
                    Set("bot_quota", "1");
                    break;
                case "prefire":
                    Set("bot_join_team", enemyTeam);
                    Set("bot_stop", opts["prefire.shoot"] == "1" ? "0" : "1");
                    Set("bot_dont_shoot", opts["prefire.shoot"] == "1" ? "0" : "1");
                    Set("bot_difficulty", "2");
                    Set("mp_damage_headshot_only", "0");
                    Set("bot_quota", opts["prefire.order"] == "all" ? run.Points.Count.ToString(CultureInfo.InvariantCulture) : "1");
                    break;
            }
            run.Started = Server.CurrentTime;
            run.Ends = time > 0 ? run.Started + time : 0;
            // bots already on the server get placed now; new ones on their spawn
            AddTimer(0.5f, () =>
            {
                if (_modeRun != run) return;
                foreach (var p in Utilities.GetPlayers())
                    if (p is { IsValid: true, PawnIsAlive: true }) OnModeSpawn(run, p);
            }, TimerFlags.STOP_ON_MAPCHANGE);
            if (Utilities.GetPlayerFromSlot(run.Owner) is { IsValid: true } o)
            {
                o.PrintToChat($"{ChatTag} {ModeName(id)} started. {ModeHelp(id)} Stop: L → Modes, or !mode stop.");
                if (!o.PawnIsAlive) o.Respawn();
            }
        }, TimerFlags.STOP_ON_MAPCHANGE);
    }

    private static string ModeName(string id) => ModeList.FirstOrDefault(m => m.Id == id).Name ?? id;

    private static string ModeHelp(string id) => id switch
    {
        "aim" => "Shoot the targets; each one comes back somewhere else.",
        "awp" => "A bot shows up for a moment: flick to it.",
        "prefire" => "Clear the route's spots as fast as you can.",
        _ => ""
    };

    private void SetModeCvar(ModeRun run, string cvar, string value)
    {
        if (!run.SavedCvars.ContainsKey(cvar) && ConVar.Find(cvar) is { } c)
        {
            var old = c.Type == ConVarType.String ? c.StringValue : CvarText(c);
            run.SavedCvars[cvar] = old;
        }
        Server.ExecuteCommand($"{cvar} {value}");
    }

    private static void RestoreModeCvars(ModeRun run)
    {
        foreach (var (cvar, value) in run.SavedCvars)
        {
            if (cvar == "bot_quota") continue; // below
            Server.ExecuteCommand(value.Length == 0 || value.Contains(' ') ? $"{cvar} \"{value}\"" : $"{cvar} {value}");
        }
        if (run.SavedCvars.TryGetValue("bot_quota", out var q)) Server.ExecuteCommand($"bot_quota {q}");
    }

    private void StopMode(CCSPlayerController? by, string why, bool quiet = false)
    {
        if (_modeRun is not { } run) return;
        if (!run.Finished && !quiet) ShowModeResult(run, why);
        _modeRun = null;
        foreach (var (slot, b) in run.Bots)
            if (b.Hidden && Utilities.GetPlayerFromSlot(slot)?.PlayerPawn.Value is { IsValid: true } bp) SetPawnShown(bp, true);
        RestoreModeCvars(run);
        if (run.LeftPractice) Server.ExecuteCommand("css_prac");
        else Server.ExecuteCommand("mp_restartgame 1");
        if (!quiet && by != null) by.PrintToChat($"{ChatTag} {ModeName(run.Id)} stopped.");
    }

    // ---------------------------------------------------------------- per player

    private void OnModeSpawn(ModeRun run, CCSPlayerController p)
    {
        if (IsStandIn(p) || p.PlayerPawn.Value is not { IsValid: true, AbsOrigin: not null } pawn) return;
        var bot = IsBotAny(p);
        switch (run.Id)
        {
            case "dm":
            {
                var guns = run.Opts["dm.guns"];
                if (guns == "any") { if (!bot) p.InGameMoneyServices!.Account = 16000; break; }
                var rnd = Random.Shared;
                var (primary, pistol) = guns switch
                {
                    "rifles" => (RifleGuns[rnd.Next(RifleGuns.Length)], PistolGuns[rnd.Next(PistolGuns.Length)]),
                    "awp" => ("weapon_awp", "weapon_deagle"),
                    "pistols" => ((string?)null, PistolGuns[rnd.Next(PistolGuns.Length)]),
                    _ => ((string?)null, "weapon_deagle")
                };
                GiveModeGuns(p, primary, pistol);
                break;
            }
            case "aim":
                if (bot) PlaceTarget(run, p, pawn);
                break;
            case "awp":
                if (bot) { PlaceTarget(run, p, pawn); HideAwpBot(run, p); }
                else GiveModeGuns(p, "weapon_awp", null);
                break;
            case "prefire":
                if (bot) PlacePrefireBot(run, p, pawn);
                break;
        }
    }

    /// <summary>Gives a primary and/or pistol (replacing that slot's gun), the same way as BotLoadouts.GiveBotGuns.</summary>
    private void GiveModeGuns(CCSPlayerController p, string? primary, string? pistol)
    {
        if (p.PlayerPawn.Value is not { IsValid: true, WeaponServices: { } services } pawn) return;
        var team = p.TeamNum;
        var gives = new List<string>();
        CBasePlayerWeapon? dropHeld = null;
        foreach (var (slot, cls) in new[] { (gear_slot_t.GEAR_SLOT_RIFLE, primary), (gear_slot_t.GEAR_SLOT_PISTOL, pistol) })
        {
            var held = services.MyWeapons.Select(h => h.Value).Where(w => w is { IsValid: true } && GearSlot(w!) == slot).ToList();
            if (cls != null && held.Any(w => GiveName(w!) == cls)) continue;
            // no pistol wanted: keep the one they have (pistol rounds need something)
            if (cls == null && slot == gear_slot_t.GEAR_SLOT_PISTOL) continue;
            foreach (var w in held)
            {
                if (services.ActiveWeapon.Value?.Index == w!.Index) { dropHeld = w; continue; }
                pawn.RemovePlayerItem(w);
                w.Remove();
            }
            if (cls != null) gives.Add(cls);
        }
        if (dropHeld != null)
        {
            var dropped = dropHeld;
            try { p.DropActiveWeapon(); }
            catch { pawn.RemovePlayerItem(dropped); }
            AddTimer(0.05f, () => { if (dropped.IsValid && !dropped.OwnerEntity.IsValid) dropped.Remove(); }, TimerFlags.STOP_ON_MAPCHANGE);
        }
        void Give()
        {
            if (!p.IsValid || !p.PawnIsAlive || p.TeamNum != team) return;
            foreach (var cls in gives) p.GiveNamedItem<CBasePlayerWeapon>(cls);
        }
        if (dropHeld != null) AddTimer(0.15f, Give, TimerFlags.STOP_ON_MAPCHANGE);
        else Give();
    }

    private void OnModeDeath(ModeRun run, int victim, int attacker)
    {
        if (_modeRun != run) return;
        switch (run.Id)
        {
            case "awp" when run.Bots.TryGetValue(victim, out var b):
                if (b.ShownAt > 0 && !b.Hidden)
                {
                    run.AwpHits++;
                    if (run.Opts["awp.window"] == "shrink") run.Window = Math.Max(0.4f, run.Window - 0.05f);
                }
                b.ShownAt = 0;
                NextAwpRound(run);
                break;
            case "prefire":
                if (victim == run.Owner)
                {
                    FinishMode(run, "you died");
                    return;
                }
                if (run.Bots.TryGetValue(victim, out var pb) && pb.Point >= 0)
                {
                    run.Cleared.Add(pb.Point);
                    pb.Point = -1;
                    pb.ShownAt = 0;
                    if (run.Cleared.Count >= run.Points.Count) FinishMode(run, "route cleared");
                }
                break;
        }
    }

    // ---------------------------------------------------------------- aim / AWP targets

    private static Vector Forward(float pitch, float yaw)
    {
        var p = pitch * MathF.PI / 180f;
        var y = yaw * MathF.PI / 180f;
        return new Vector(MathF.Cos(p) * MathF.Cos(y), MathF.Cos(p) * MathF.Sin(y), -MathF.Sin(p));
    }

    private static float YawTo(Vector from, Vector to) => MathF.Atan2(to.Y - from.Y, to.X - from.X) * 180f / MathF.PI;

    /// <summary>World-only trace: the hit position, or null when nothing was hit.</summary>
    private static Vector? TraceWorld(Vector from, Vector to)
    {
        try
        {
            var hit = Trace.TraceEndShape(from, to, null!, new TraceOptions { InteractsWith = Masks.PlayerSolidBrushOnly });
            if (!hit.DidHit() || hit.IsAllSolid) return null;
            return new Vector(hit.EndPos.X, hit.EndPos.Y, hit.EndPos.Z);
        }
        catch
        {
            return null;
        }
    }

    private static bool ClearLine(Vector from, Vector to)
    {
        try
        {
            var hit = Trace.TraceEndShape(from, to, null!, new TraceOptions { InteractsWith = Masks.PlayerSolidBrushOnly });
            if (!hit.DidHit()) return true;
            var dx = hit.EndPos.X - to.X;
            var dy = hit.EndPos.Y - to.Y;
            var dz = hit.EndPos.Z - to.Z;
            return dx * dx + dy * dy + dz * dz < 16 * 16;
        }
        catch
        {
            return true;
        }
    }

    /// <summary>A free floor spot the owner can see, in front of them at the range picked (null: none found).</summary>
    private Vector? TargetSpot(ModeRun run, string range, Vector? avoid = null)
    {
        if (Utilities.GetPlayerFromSlot(run.Owner)?.PlayerPawn.Value is not { IsValid: true, AbsOrigin: not null } op) return null;
        var feet = op.AbsOrigin;
        var eye = new Vector(feet.X, feet.Y, feet.Z + 64);
        var (min, max) = range switch { "close" => (250f, 600f), "far" => (1200f, 2200f), _ => (600f, 1200f) };
        var rnd = Random.Shared;
        for (var i = 0; i < 40; i++)
        {
            var spread = i < 20 ? 50f : 80f;
            var yaw = op.EyeAngles.Y + (float)(rnd.NextDouble() * 2 - 1) * spread;
            var dist = min + (float)rnd.NextDouble() * (max - min);
            if (i >= 30) dist = min * 0.6f + (float)rnd.NextDouble() * min;
            var dir = Forward(0, yaw);
            var probe = new Vector(eye.X + dir.X * dist, eye.Y + dir.Y * dist, eye.Z + 32);
            // the line out there must be free (not into a wall), then the floor below it
            if (!ClearLine(eye, probe)) continue;
            var floor = TraceWorld(probe, new Vector(probe.X, probe.Y, probe.Z - 900));
            if (floor == null || MathF.Abs(floor.Z - feet.Z) > 380) continue;
            var at = new Vector(floor.X, floor.Y, floor.Z + 1);
            if (avoid != null && (at.X - avoid.X) * (at.X - avoid.X) + (at.Y - avoid.Y) * (at.Y - avoid.Y) < 150 * 150) continue;
            if (run.Bots.Values.Any(b => !b.Hidden && (b.Base.X - at.X) * (b.Base.X - at.X) + (b.Base.Y - at.Y) * (b.Base.Y - at.Y) < 80 * 80)) continue;
            if (!StandingRoom(at)) continue;
            if (!ClearLine(eye, new Vector(at.X, at.Y, at.Z + 60)) && !ClearLine(eye, new Vector(at.X, at.Y, at.Z + 40))) continue;
            return at;
        }
        return null;
    }

    private void PlaceTarget(ModeRun run, CCSPlayerController bot, CCSPlayerPawn pawn)
    {
        var range = run.Id == "awp" ? run.Opts["awp.range"] : run.Opts["aim.range"];
        var old = run.Bots.TryGetValue(bot.Slot, out var prev) ? prev.Base : null;
        var at = TargetSpot(run, range, old);
        if (at == null || Utilities.GetPlayerFromSlot(run.Owner)?.PlayerPawn.Value is not { IsValid: true, AbsOrigin: not null } op) return;
        var yaw = YawTo(at, op.AbsOrigin);
        var side = Forward(0, yaw + 90);
        var move = run.Id == "aim" ? run.Opts["aim.move"] : "static";
        run.Bots[bot.Slot] = new ModeBot
        {
            Base = at, Side = side, Yaw = yaw, Pinned = true, ShownAt = Server.CurrentTime,
            Dir = Random.Shared.Next(2) == 0 ? -1 : 1, NextFlip = Server.CurrentTime + 0.3f,
            Hidden = prev?.Hidden ?? false
        };
        pawn.TakesDamage = true;
        pawn.Teleport(at, new QAngle(0, yaw, 0), new Vector(0, 0, 0));
        if (move == "crouch") SetDuck(bot, pawn, true);
    }

    private static void SetDuck(CCSPlayerController bot, CCSPlayerPawn pawn, bool crouch)
    {
        if (pawn.Bot is { } ai && ai.IsCrouching != crouch) ai.IsCrouching = crouch;
        if (pawn.MovementServices is not { } ms) return;
        var move = new CCSPlayer_MovementServices(ms.Handle);
        move.DuckAmount = crouch ? 1f : 0f;
        move.Ducked = crouch;
        move.DesiresDuck = crouch;
    }

    private static void SetPawnShown(CCSPlayerPawn pawn, bool shown)
    {
        void Set(CBaseModelEntity e)
        {
            e.Render = shown ? Color.White : Color.FromArgb(0, 255, 255, 255);
            e.RenderMode = shown ? RenderMode_t.kRenderNormal : RenderMode_t.kRenderTransAlpha;
            Utilities.SetStateChanged(e, "CBaseModelEntity", "m_clrRender");
            Utilities.SetStateChanged(e, "CBaseModelEntity", "m_nRenderMode");
        }
        Set(pawn);
        foreach (var w in Carried(pawn)) Set(w);
        pawn.TakesDamage = shown;
    }

    private void HideAwpBot(ModeRun run, CCSPlayerController bot)
    {
        if (!run.Bots.TryGetValue(bot.Slot, out var b) || bot.PlayerPawn.Value is not { IsValid: true } pawn) return;
        b.Hidden = true;
        b.ShownAt = 0;
        SetPawnShown(pawn, false);
        run.ShowAt = Server.CurrentTime + 0.7f + (float)Random.Shared.NextDouble() * 1.5f;
        run.HideAt = 0;
    }

    private void NextAwpRound(ModeRun run)
    {
        run.Round++;
        if (run.Round >= run.Rounds) { FinishMode(run, ""); return; }
        // a missed bot stays alive: move and hide it; a killed one does that on its respawn
        foreach (var (slot, b) in run.Bots)
        {
            if (Utilities.GetPlayerFromSlot(slot) is not { IsValid: true, PawnIsAlive: true } bot || bot.PlayerPawn.Value is not { IsValid: true } pawn) continue;
            PlaceTarget(run, bot, pawn);
            HideAwpBot(run, bot);
        }
    }

    private void PlacePrefireBot(ModeRun run, CCSPlayerController bot, CCSPlayerPawn pawn)
    {
        var taken = run.Bots.Where(kv => kv.Key != bot.Slot && kv.Value.Point >= 0).Select(kv => kv.Value.Point).ToHashSet();
        var point = -1;
        for (var i = 0; i < run.Points.Count; i++)
            if (!run.Cleared.Contains(i) && !taken.Contains(i)) { point = i; break; }
        // one by one: only the next point is out
        if (run.Opts["prefire.order"] == "one" && taken.Count > 0) point = -1;
        if (point < 0)
        {
            // nothing left for it: park it out of sight
            run.Bots[bot.Slot] = new ModeBot { Base = Copy(pawn.AbsOrigin!), Hidden = true, Pinned = true };
            SetPawnShown(pawn, false);
            bot.RemoveWeapons();
            return;
        }
        var pt = run.Points[point];
        var at = new Vector(pt.X, pt.Y, pt.Z);
        run.Bots[bot.Slot] = new ModeBot { Base = at, Yaw = pt.Yaw, Point = point, Pinned = true, FreeAim = run.Opts["prefire.shoot"] == "1", ShownAt = Server.CurrentTime };
        SetPawnShown(pawn, true);
        pawn.Teleport(at, new QAngle(0, pt.Yaw, 0), new Vector(0, 0, 0));
        if (run.Started > 0 && run.Cleared.Count == 0 && taken.Count == 0) run.Started = Server.CurrentTime;
    }

    // ---------------------------------------------------------------- tick

    private void OnModesTick()
    {
        if (_modeRun is not { } run) return;
        var now = Server.CurrentTime;
        var dt = Server.TickInterval;
        var move = run.Id == "aim" ? run.Opts["aim.move"] : "static";
        foreach (var (slot, b) in run.Bots.ToList())
        {
            if (!b.Pinned || Utilities.GetPlayerFromSlot(slot) is not { IsValid: true, PawnIsAlive: true } bot
                || bot.PlayerPawn.Value is not { IsValid: true } pawn) continue;
            var vel = new Vector(0, 0, 0);
            if (!b.Hidden && move is "strafe" or "jiggle")
            {
                var speed = move == "strafe" ? 200f : 250f;
                var limit = move == "strafe" ? 140f : 40f;
                var next = b.Offset + b.Dir * speed * dt;
                var nextPos = new Vector(b.Base.X + b.Side.X * next, b.Base.Y + b.Side.Y * next, b.Base.Z);
                var flip = MathF.Abs(next) > limit || (move == "jiggle" && now >= b.NextFlip) || !StandingRoom(nextPos);
                if (flip)
                {
                    b.Dir = -b.Dir;
                    b.NextFlip = now + 0.15f + (float)Random.Shared.NextDouble() * 0.3f;
                }
                else b.Offset = next;
                vel = new Vector(b.Side.X * b.Dir * speed, b.Side.Y * b.Dir * speed, 0);
            }
            var pos = new Vector(b.Base.X + b.Side.X * b.Offset, b.Base.Y + b.Side.Y * b.Offset, b.Base.Z);
            if (b.FreeAim) pawn.Teleport(pos, null, new Vector(0, 0, 0));
            else pawn.Teleport(pos, new QAngle(0, b.Yaw, 0), vel);
            if (move == "crouch") SetDuck(bot, pawn, true);
            if (!pawn.HasMovedSinceSpawn) pawn.HasMovedSinceSpawn = true;
            if (b.Hidden && pawn.TakesDamage) pawn.TakesDamage = false;
        }

        if (run.Id == "awp")
        {
            if (run.ShowAt > 0 && now >= run.ShowAt)
            {
                run.ShowAt = 0;
                foreach (var (slot, b) in run.Bots)
                {
                    if (Utilities.GetPlayerFromSlot(slot)?.PlayerPawn.Value is not { IsValid: true } pawn) continue;
                    b.Hidden = false;
                    b.ShownAt = now;
                    SetPawnShown(pawn, true);
                }
                run.HideAt = now + run.Window;
            }
            else if (run.HideAt > 0 && now >= run.HideAt)
            {
                run.HideAt = 0;
                NextAwpRound(run);
            }
        }

        if (run.Ends > 0 && now >= run.Ends) { FinishMode(run, ""); return; }
        if (now < run.NextBanner) return;
        run.NextBanner = now + 0.5f;
        if (Utilities.GetPlayerFromSlot(run.Owner) is { IsValid: true } owner) ShowBanner(owner, ModeBanner(run, owner), 0.8f);
    }

    private static string Clock(float seconds)
    {
        var s = (int)MathF.Max(0, MathF.Ceiling(seconds));
        return $"{s / 60}:{s % 60:00}";
    }

    private string ModeBanner(ModeRun run, CCSPlayerController owner)
    {
        var st = run.Stats.TryGetValue(owner.Slot, out var x) ? x : new ModeStats();
        var now = Server.CurrentTime;
        var acc = st.Shots > 0 ? $"{Math.Min(100, st.Hits * 100 / st.Shots)}%" : "–";
        var line = run.Id switch
        {
            "awp" => $"Round {Math.Min(run.Round + 1, run.Rounds)}/{run.Rounds} · Hits {run.AwpHits}",
            "prefire" => $"Cleared {run.Cleared.Count}/{run.Points.Count} · {Clock(now - run.Started)}",
            _ => $"Kills {st.Kills} · Deaths {st.Deaths} · Acc {acc} · HS {st.Headshots}"
        };
        var time = run.Ends > 0 ? $" · {Clock(run.Ends - now)} left" : "";
        return $"<font color='#f0a83a'>{ModeName(run.Id)}</font><br><font class='fontSize-m'>{line}{time}</font>";
    }

    // ---------------------------------------------------------------- results

    private string ResultKey(ModeRun run) => run.Id + ":" + string.Join(":", run.Opts.OrderBy(o => o.Key).Select(o => o.Value));

    /// <summary>The run's score (higher is better; prefire: seconds, lower is better) and its text.</summary>
    private (double Score, bool LowerBetter, string Text) ModeScore(ModeRun run)
    {
        var st = run.Stats.TryGetValue(run.Owner, out var x) ? x : new ModeStats();
        var acc = st.Shots > 0 ? Math.Min(100, st.Hits * 100 / st.Shots) : 0;
        var react = st.Reactions.Count > 0 ? $" · avg {st.Reactions.Average():0.00} s to kill" : "";
        return run.Id switch
        {
            "awp" => (run.AwpHits, false, $"{run.AwpHits}/{run.Rounds} hits{react}"),
            "prefire" => (Server.CurrentTime - run.Started, true, $"{run.Cleared.Count}/{run.Points.Count} cleared in {Server.CurrentTime - run.Started:0.0} s"),
            _ => (st.Kills, false, $"{st.Kills} kills · {st.Deaths} deaths · {acc}% accuracy · {st.Headshots} HS{react}")
        };
    }

    private void FinishMode(ModeRun run, string why)
    {
        if (_modeRun != run || run.Finished) return;
        ShowModeResult(run, why);
        run.Finished = true;
        StopMode(null, why, quiet: true);
    }

    private void ShowModeResult(ModeRun run, string why)
    {
        var (score, lower, text) = ModeScore(run);
        var complete = run.Id != "prefire" || run.Cleared.Count >= run.Points.Count;
        var map = CurrentMap;
        var key = ResultKey(run);
        if (!_modes.Best.TryGetValue(map, out var best)) _modes.Best[map] = best = new();
        var hadBest = best.TryGetValue(key, out var old);
        var record = complete && (!hadBest || (lower ? score < old : score > old));
        if (record)
        {
            best[key] = Math.Round(score, 2);
            SaveModes();
        }
        var bestText = record ? "New best!" : hadBest ? $"Best: {FormatBest(run.Id, old)}" : "";
        if (Utilities.GetPlayerFromSlot(run.Owner) is not { IsValid: true } owner) return;
        var reason = why.Length > 0 ? $" ({why})" : "";
        owner.PrintToChat($"{ChatTag} {ModeName(run.Id)} over{reason}: {text}. {bestText}");
        ShowBanner(owner, $"<font color='#f0a83a'>{ModeName(run.Id)} over</font><br><font class='fontSize-m'>{text}<br>{bestText}</font>", 6f);
    }

    private static string FormatBest(string id, double v) => id switch
    {
        "prefire" => $"{v:0.0} s",
        "awp" => $"{v:0} hits",
        _ => $"{v:0} kills"
    };

    // ---------------------------------------------------------------- L window: Modes tab

    private void BuildModeRows(CCSPlayerController player, SetSession s)
    {
        var running = _modeRun;
        if (running != null)
        {
            var left = running.Ends > 0 ? $"{Clock(running.Ends - Server.CurrentTime)} left" : "running";
            var id = running.Id;
            s.Rows.Add(new SetRow($"{ModeName(id)}: {left}", ModeScore(running).Text,
                [("Stop", false, pl => { StopMode(pl, "stopped"); SetStatus(s, "Stopped"); }),
                 ("Restart", false, pl => { CloseSettings(pl); StartModeLater(pl, id); })]) { Icon = "ic-timer" });
        }
        var best = _modes.Best.TryGetValue(CurrentMap, out var b) ? b : new();
        foreach (var (id, name) in ModeList)
        {
            var opts = ModeOpts.Where(o => o.Value.Mode == id).ToDictionary(o => o.Key, o => ModeOpt(o.Key));
            var key = id + ":" + string.Join(":", opts.OrderBy(o => o.Key).Select(o => o.Value));
            var sub = best.TryGetValue(key, out var v) ? $"Best here with these options: {FormatBest(id, v)}" : ModeHelp(id);
            if (id == "prefire")
            {
                var n = LoadPrefire(CurrentMap).Count;
                sub = n == 0 ? "No route on this map yet: aim at the floor and Add point" : $"{n} point(s) on this map · {sub}";
            }
            if (id == "dm") sub = best.TryGetValue(key, out var dv) ? sub : "Bots fight you (and each other in FFA), respawns on";
            var icon = id switch { "dm" => "ic-kill", "aim" => "ic-crosshair", "awp" => "ie-awp", _ => "ic-pin" };
            s.Rows.Add(new SetRow(name, sub, [("Start", running?.Id == id, pl => { CloseSettings(pl); StartModeLater(pl, id); })]) { Icon = icon });
            foreach (var (optKey, o) in ModeOpts.Where(o => o.Value.Mode == id))
            {
                var cur = opts[optKey];
                s.Rows.Add(new SetRow("   " + o.Name, "", o.Choices.Select(c => (c.Label, c.Value == cur, (Action<CCSPlayerController>)(_ =>
                {
                    _modes.Options[optKey] = c.Value;
                    SaveModes();
                }))).ToList()));
            }
            if (id == "prefire")
            {
                s.Rows.Add(new SetRow("   Route", "Add point = where you aim (floor or wall base)",
                    [("Add point", false, pl => SetStatus(s, AddPrefirePoint(pl))),
                     ("Remove last", false, _ =>
                     {
                         var pts = LoadPrefire(CurrentMap);
                         if (pts.Count > 0) { pts.RemoveAt(pts.Count - 1); SavePrefire(CurrentMap, pts); }
                         SetStatus(s, $"{pts.Count} point(s) left");
                     }),
                     ("Clear", false, _ => { SavePrefire(CurrentMap, new()); SetStatus(s, "Route cleared"); })]));
            }
        }
        s.Rows.Add(new SetRow("Movement", "Jump and run spots live in the Spots tab", [("Spots", false, _ => s.Tab = "spots")]) { Icon = "ic-fast" });
    }

    // ---------------------------------------------------------------- commands

    [ConsoleCommand("css_mode", "Practice modes: css_mode dm|aim|awp|prefire|stop")]
    [CommandHelper(minArgs: 1, usage: "dm|aim|awp|prefire|stop", whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnModeCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (player is not { IsValid: true }) return;
        if (!IsAdmin(player)) { player.PrintToChat($"{ChatTag} Only admins can start modes."); return; }
        var id = info.GetArg(1).ToLowerInvariant();
        if (id == "stop") { StopMode(player, "stopped"); return; }
        if (ModeList.All(m => m.Id != id)) { player.PrintToChat($"{ChatTag} Modes: dm, aim, awp, prefire, stop."); return; }
        StartMode(player, id);
    }

    [ConsoleCommand("css_prac_modes", "Server test: the running practice mode")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnPracModesCommand(CCSPlayerController? _, CommandInfo info)
    {
        if (_modeRun is not { } run) { info.ReplyToCommand("no mode running"); return; }
        info.ReplyToCommand($"{run.Id} owner {run.Owner} enemy {run.Enemy} left practice {run.LeftPractice} started {run.Started:0.0} ends {run.Ends:0.0} now {Server.CurrentTime:0.0}");
        info.ReplyToCommand($"  {ModeScore(run).Text}; awp round {run.Round}/{run.Rounds} window {run.Window:0.00}; cleared {run.Cleared.Count}/{run.Points.Count}");
        foreach (var (slot, b) in run.Bots)
        {
            var p = Utilities.GetPlayerFromSlot(slot);
            var at = p?.PlayerPawn.Value?.AbsOrigin;
            info.ReplyToCommand($"  bot {slot} {p?.PlayerName} alive {p?.PawnIsAlive} hidden {b.Hidden} point {b.Point} base {b.Base.X:0} {b.Base.Y:0} {b.Base.Z:0} at {at?.X:0} {at?.Y:0} {at?.Z:0}");
        }
        foreach (var (cvar, v) in run.SavedCvars) info.ReplyToCommand($"  saved {cvar} = {v}");
    }

    [ConsoleCommand("css_prac_mode", "Server test: css_prac_mode <id|stop> (for the first human, else the first bot)")]
    [CommandHelper(minArgs: 1, whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnPracModeCommand(CCSPlayerController? _, CommandInfo info)
    {
        var id = info.GetArg(1).ToLowerInvariant();
        if (id == "stop") { StopMode(null, "stopped"); info.ReplyToCommand("stopped"); return; }
        var players = Utilities.GetPlayers().Where(p => p is { IsValid: true } && !IsStandIn(p)).ToList();
        var owner = players.FirstOrDefault(p => !IsBotAny(p)) ?? players.FirstOrDefault();
        if (owner == null) { info.ReplyToCommand("nobody on the server"); return; }
        StartMode(owner, id);
        info.ReplyToCommand($"started {id} for {owner.PlayerName}");
    }
}
