using System.Globalization;
using System.Text.Json;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Admin;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Cvars;
using CounterStrikeSharp.API.Modules.Extensions;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;

namespace PracSkins;

/// <summary>One choice of a setting (chip in the window). Value is what server_prefs.json stores.</summary>
public record SetOpt(string Label, string Value);

/// <summary>
/// A server setting of the L window. Cvars are set with "cvar value" (all of them get the same value); Get/Set
/// override that for settings that live in the plugin (glow, god mode, sky ...). Keep the ids and values in sync
/// with src/shared/serverSettings.ts (the app's Play page edits the same server_prefs.json).
/// </summary>
public record SetDef(string Id, string Tab, string Name, string Sub, SetOpt[] Opts, string[] Cvars,
    Func<string>? Get = null, Action<string>? Set = null);

/// <summary>One row of the window: a name and up to RowChips buttons.</summary>
public record SetRow(string Name, string Sub, List<(string Label, bool Picked, Action<CCSPlayerController> Click)> Chips);

/// <summary>An open settings window.</summary>
public class SetSession
{
    public string Tab { get; set; } = "practice";
    public bool MapScope { get; set; }
    public string Status { get; set; } = "";
    public float StatusUntil { get; set; }
    public ulong LastButtons { get; set; }
    public MoveType_t PreviousMoveType { get; set; } = MoveType_t.MOVETYPE_WALK;
    public uint HudBitsAdded { get; set; }
    public List<SetRow> Rows { get; set; } = new();
    /// <summary>Nades tab type filter ("" = all).</summary>
    public string NadeFilter { get; set; } = "";
}

/// <summary>configs/plugins/PracSkins/server_prefs.json: setting id -> value, for every map and per map.</summary>
public class ServerPrefs
{
    public Dictionary<string, string> Global { get; set; } = new();
    public Dictionary<string, Dictionary<string, string>> Maps { get; set; } = new();
}

/// <summary>
/// The server settings window (L = css_settings): a second window in the skin window's Panorama layout (same
/// custom_hud_layout entity, panels ps_*), so only one of them can hold the cursor at a time. Changes apply at once
/// and are kept in server_prefs.json (all maps or this map only); they are applied again after every map start and
/// whenever MatchZy practice mode starts (prac_override.cfg runs css_prac_settings_apply).
/// </summary>
public partial class PracSkins
{
    // Keep in sync with scripts/hud/build-hud.mjs (SET_ROWS, SET_CHIPS).
    private const int SetRows = 32;
    private const int RowChips = 6;

    private static readonly (string Id, string Label)[] SetTabs =
        [("practice", "Practice"), ("server", "Server"), ("bots", "Bots"), ("sky", "Sky"), ("map", "Map"), ("spots", "Spots"), ("nades", "Nades")];

    private static readonly SetOpt[] OffOn = [new("Off", "0"), new("On", "1")];

    /// <summary>Sky materials shipped with CS2 (materials/skybox in pak01, listed with scripts/hud/vpk.mjs).</summary>
    private static readonly (string Name, string Material)[] Skies =
    [
        ("Dust II", "materials/skybox/sky_de_dust2.vmat"),
        ("Mirage", "materials/skybox/sky_de_mirage.vmat"),
        ("Anubis", "materials/skybox/sky_de_annubis.vmat"),
        ("Nuke", "materials/skybox/sky_de_nuke.vmat"),
        ("Nuke (HDR)", "materials/de_nuke/hr_nuke/sky/nuke_sky_hdr.vmat"),
        ("Overpass", "materials/skybox/sky_de_overpass_01.vmat"),
        ("Train", "materials/skybox/sky_de_train03.vmat"),
        ("Vertigo", "materials/skybox/sky_de_vertigo.vmat"),
        ("Cache", "materials/de_cache/sky/de_cache_sky_001.vmat"),
        ("Italy", "materials/skybox/cs_italy_s2_skybox_2.vmat"),
        ("Office", "materials/skybox/cs_office_45_0.vmat"),
        ("Aztec", "materials/skybox/sky_hr_aztec_02.vmat"),
        ("Inferno (test sky)", "materials/skybox/test/s2_de_inferno_sky01.vmat"),
        ("Baggage", "materials/skybox/sky_ar_baggage_01.vmat"),
        ("Convoy", "materials/skybox/convoy_sky.vmat"),
        ("Cloudy", "materials/skybox/sky_csgo_cloudy01.vmat"),
        ("Cloudy (Rush)", "materials/skybox/rush_cloudy_01a.vmat"),
        ("Overcast", "materials/skybox/sky_overcast_01.vmat"),
        ("Daylight (CS 1.5)", "materials/skybox/sky_cs15_daylight01_hdr.vmat"),
        ("Rainy night", "materials/skybox/sky_rain_night_01.vmat"),
        ("Sunset (test sky)", "materials/skybox/light_test_sky_sunset_light.vmat"),
        ("Black", "materials/skybox/sky_black.vmat")
    ];

    private readonly Dictionary<int, SetSession> _setSessions = new();
    private ServerPrefs _serverPrefs = new();
    private DateTime _serverPrefsStamp;
    /// <summary>What each setting was on this map before we first changed it (Reset puts it back).</summary>
    private readonly Dictionary<string, string> _setDefaults = new();
    private bool _godOn;
    private bool _noFlashOn;
    private string _sky = "";
    private CEnvSky? _ourSky;
    private readonly List<CEnvSky> _hiddenSkies = new();
    private List<SetDef>? _setDefs;

    private string ServerPrefsPath => Path.Combine(ConfigDir, "server_prefs.json");
    private static string CurrentMap => Server.MapName ?? "";

    private List<SetDef> SetDefs => _setDefs ??= BuildSetDefs();

    private List<SetDef> BuildSetDefs() =>
    [
        new("glow", "practice", "Bot glow", "Bots outlined through walls (.glow)", OffOn, [],
            () => _glowOn ? "1" : "0", v => SetGlow(v == "1")),
        new("spawns", "practice", "Spawn markers", "Look at one and press E to stand on it (.spawns)", OffOn, [],
            () => _spawnsOn ? "1" : "0", v => SetSpawns(v == "1")),
        new("ammo", "practice", "Infinite ammo", "sv_infinite_ammo", [new("Off", "0"), new("Clip", "1"), new("Reserve", "2")], ["sv_infinite_ammo"]),
        new("buyanywhere", "practice", "Buy anywhere", "mp_buy_anywhere", OffOn, ["mp_buy_anywhere"]),
        new("trajectory", "practice", "Grenade preview", "Trajectory line while aiming a grenade", OffOn, ["sv_grenade_trajectory_prac_pipreview"]),
        new("impacts", "practice", "Bullet impacts", "sv_showimpacts", OffOn, ["sv_showimpacts"]),
        new("noflash", "practice", "No flash", "Flashbangs don't blind players (bots still get flashed)", OffOn, [],
            () => _noFlashOn ? "1" : "0", v => _noFlashOn = v == "1"),
        new("god", "practice", "God mode", "Players take no damage (bots still do)", OffOn, [],
            () => _godOn ? "1" : "0", v => SetGod(v == "1")),
        new("bhop", "practice", "Auto bunnyhop", "Hold space to keep hopping", OffOn, ["sv_autobunnyhopping", "sv_enablebunnyhopping"]),

        new("friendlyfire", "server", "Friendly fire", "mp_friendlyfire", OffOn, ["mp_friendlyfire"]),
        new("falldamage", "server", "Fall damage", "sv_falldamage_scale (off in movement mode anyway)", [new("Off", "0"), new("On", "1")], ["sv_falldamage_scale"]),
        new("roundtime", "server", "Round time", "Minutes (mp_roundtime, _defuse, _hostage)",
            [new("1:55", "1.92"), new("5", "5"), new("15", "15"), new("60", "60")], ["mp_roundtime", "mp_roundtime_defuse", "mp_roundtime_hostage"]),
        new("freezetime", "server", "Freeze time", "Seconds at round start (mp_freezetime)", [new("0", "0"), new("5", "5"), new("15", "15")], ["mp_freezetime"]),
        new("gravity", "server", "Gravity", "sv_gravity (800 is normal)", [new("200", "200"), new("400", "400"), new("600", "600"), new("800", "800")], ["sv_gravity"]),
        new("timescale", "server", "Game speed", "host_timescale",
            [new("0.25×", "0.25"), new("0.5×", "0.5"), new("1×", "1"), new("1.5×", "1.5"), new("2×", "2")], ["host_timescale"]),

        new("botradio", "bots", "Bot radio", "Bot voice and radio calls (bot_chatter)",
            [new("Off", "off"), new("Radio", "radio"), new("Minimal", "minimal"), new("Normal", "normal")], ["bot_chatter"]),
        new("botdifficulty", "bots", "Bot difficulty", "For bots added after the change (bot_difficulty)",
            [new("Easy", "0"), new("Normal", "1"), new("Hard", "2"), new("Expert", "3")], ["bot_difficulty"]),
        new("botshoot", "bots", "Bots shoot", "bot_dont_shoot", [new("No", "1"), new("Yes", "0")], ["bot_dont_shoot"]),
        new("botstop", "bots", "Bots frozen", "bot_stop", OffOn, ["bot_stop"]),
        new("botcrouch", "bots", "Bots crouch", "bot_crouch", OffOn, ["bot_crouch"]),

        new("sky", "sky", "Sky", "", [], [], () => _sky, ApplySky)
    ];

    private void InitSettings()
    {
        RegisterListener<Listeners.OnMapStart>(_ =>
        {
            _setDefaults.Clear();
            _sky = "";
            _ourSky = null;
            _hiddenSkies.Clear();
            // after cs2prac_defaults.cfg / cs2prac_server.cfg (2 s, PracSkins.cs)
            AddTimer(2.5f, ApplySettings, TimerFlags.STOP_ON_MAPCHANGE);
        });
        RegisterListener<Listeners.OnMapEnd>(() => _setSessions.Clear());
        RegisterListener<Listeners.OnClientDisconnect>(slot => _setSessions.Remove(slot));
        RegisterListener<Listeners.OnTick>(OnSettingsTick);
        // Sky materials have to be precached with the map, or env_sky draws nothing.
        RegisterListener<Listeners.OnServerPrecacheResources>(manifest =>
        {
            foreach (var (_, material) in Skies) manifest.AddResource(material);
        });
        RegisterEventHandler<EventPlayerSpawn>((e, _) =>
        {
            if (_godOn && e.Userid is { IsValid: true, IsBot: false } p)
                AddTimer(0.1f, () => SetGodFor(p, true), TimerFlags.STOP_ON_MAPCHANGE);
            return HookResult.Continue;
        });
        RegisterEventHandler<EventPlayerBlind>((e, _) =>
        {
            if (_noFlashOn && e.Userid is { IsValid: true, IsBot: false } p) ClearFlash(p);
            return HookResult.Continue;
        });
        RegisterEventHandler<EventPlayerDeath>((e, _) =>
        {
            if (e.Userid is { IsValid: true } p && _setSessions.ContainsKey(p.Slot)) CloseSettings(p);
            return HookResult.Continue;
        });
        // ".settings" in chat, like .spawns
        foreach (var say in new[] { "say", "say_team" })
            AddCommandListener(say, (player, info) =>
            {
                if (player is { IsValid: true } && info.GetArg(1).Trim().ToLowerInvariant() == ".settings")
                    ToggleSettings(player, null);
                return HookResult.Continue;
            });
    }

    private void UnloadSettings()
    {
        foreach (var slot in _setSessions.Keys.ToList())
            if (Utilities.GetPlayerFromSlot(slot) is { IsValid: true } p) CloseSettings(p);
        RemoveOurSky();
    }

    // ---------------------------------------------------------------- commands

    [ConsoleCommand("css_settings", "Open or close the CS2Prac server settings window (bind a key: bind l css_settings)")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnSettingsCommand(CCSPlayerController? player, CommandInfo command)
    {
        if (player != null) ToggleSettings(player, command);
    }

    [ConsoleCommand("css_prac_settings_apply", "Re-read server_prefs.json and apply it (prac_override.cfg, the app)")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnSettingsApplyCommand(CCSPlayerController? caller, CommandInfo command)
    {
        _serverPrefsStamp = default; // force a re-read
        ApplySettings();
        command.ReplyToCommand($"[PracSkins] settings applied: {string.Join(", ", EffectivePrefs().Select(kv => $"{kv.Key}={kv.Value}"))}");
    }

    [ConsoleCommand("css_prac_settings", "Settings state: every setting's live value and stored override")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnSettingsStatusCommand(CCSPlayerController? caller, CommandInfo command)
    {
        var prefs = EffectivePrefs();
        foreach (var d in SetDefs)
            command.ReplyToCommand($"[PracSkins] {d.Id} = {SettingValue(d)}{(prefs.TryGetValue(d.Id, out var v) ? $" (saved {v})" : "")}");
        var skies = Utilities.FindAllEntitiesByDesignerName<CEnvSky>("env_sky").ToList();
        foreach (var sky in skies)
            command.ReplyToCommand($"[PracSkins] env_sky #{sky.Index}: enabled {sky.Enabled}, material {sky.SkyMaterial.Value != 0}, " +
                                   $"ours {sky.Index == _ourSky?.Index}, brightness {sky.BrightnessScale}");
        command.ReplyToCommand($"[PracSkins] settings window open for {_setSessions.Count}");
    }

    [ConsoleCommand("css_prac_set", "Test: set <id> <value> like a click in the settings window (all maps)")]
    [CommandHelper(minArgs: 2, usage: "<id> <value>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnSetTestCommand(CCSPlayerController? caller, CommandInfo command)
    {
        var def = SetDefs.FirstOrDefault(d => d.Id == command.GetArg(1));
        if (def == null) { command.ReplyToCommand("[PracSkins] unknown setting"); return; }
        ChangeSetting(def, command.GetArg(2), mapOnly: false);
        command.ReplyToCommand($"[PracSkins] {def.Id} = {SettingValue(def)}");
    }

    [ConsoleCommand("css_prac_setopen", "Test: open/close the settings window for the first bot")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnSetOpenTest(CCSPlayerController? caller, CommandInfo command)
    {
        var bot = Utilities.GetPlayers().FirstOrDefault(p => p is { IsValid: true, IsBot: true, PawnIsAlive: true });
        if (bot == null || !HudReady) { command.ReplyToCommand("[PracSkins] need a live bot and the entity"); return; }
        if (_setSessions.ContainsKey(bot.Slot)) CloseSettings(bot); else OpenSettings(bot);
        command.ReplyToCommand($"[PracSkins] settings {(_setSessions.ContainsKey(bot.Slot) ? "open" : "closed")} for {bot.PlayerName}");
    }

    private void ToggleSettings(CCSPlayerController player, CommandInfo? command)
    {
        if (_setSessions.ContainsKey(player.Slot))
        {
            CloseSettings(player);
            return;
        }
        if (player.IsBot) return;
        if (!AdminManager.PlayerHasPermissions(player, "@css/root"))
        {
            var msg = $"{Tag} Server settings need admin (@css/root).";
            if (command != null) command.ReplyToCommand(msg); else player.PrintToChat(msg);
            return;
        }
        if (_hudSessions.ContainsKey(player.Slot)) CloseHud(player);
        if (MenuOpen(player)) CloseMenu(player);
        if (!HudReady)
        {
            OpenMenu(player, SettingsMenuRoot()); // first moments of a map: the text menu works everywhere
            return;
        }
        OpenSettings(player);
    }

    // ---------------------------------------------------------------- open / close

    private void OpenSettings(CCSPlayerController player)
    {
        var s = new SetSession { LastButtons = (ulong)player.Buttons };
        _setSessions[player.Slot] = s;
        var pawn = player.PlayerPawn.Value;
        if (pawn is { IsValid: true })
        {
            s.PreviousMoveType = pawn.MoveType;
            SetMoveType(pawn, MoveType_t.MOVETYPE_NONE);
            s.HudBitsAdded = HudHideBits & ~pawn.HideHUD;
            if (s.HudBitsAdded != 0)
            {
                pawn.HideHUD |= s.HudBitsAdded;
                Utilities.SetStateChanged(pawn, "CBasePlayerPawn", "m_iHideHUD");
            }
        }
        BuildSettings(player, s);
        RenderSettings(player, s);
        HudFlag(player, "pk_dim", "shown", true);
        HudFlag(player, "ps_win", "shown", true);
        _hud!.SetInputCaptureEnabled(player, true);
    }

    private void CloseSettings(CCSPlayerController player)
    {
        if (!_setSessions.Remove(player.Slot, out var s)) return;
        if (!player.IsValid) return;
        if (HudReady)
        {
            HudFlag(player, "pk_dim", "shown", false);
            HudFlag(player, "ps_win", "shown", false);
            _hud!.SetInputCaptureEnabled(player, false);
        }
        var pawn = player.PlayerPawn.Value;
        if (pawn is not { IsValid: true }) return;
        SetMoveType(pawn, s.PreviousMoveType == MoveType_t.MOVETYPE_NONE ? MoveType_t.MOVETYPE_WALK : s.PreviousMoveType);
        if (s.HudBitsAdded != 0)
        {
            pawn.HideHUD &= ~s.HudBitsAdded;
            Utilities.SetStateChanged(pawn, "CBasePlayerPawn", "m_iHideHUD");
        }
    }

    private void OnSettingsTick()
    {
        if (_setSessions.Count == 0) return;
        var now = Server.CurrentTime;
        foreach (var (slot, s) in _setSessions.ToList())
        {
            if (Utilities.GetPlayerFromSlot(slot) is not { IsValid: true } p) continue;
            var buttons = (ulong)p.Buttons;
            var pressed = buttons & ~s.LastButtons;
            s.LastButtons = buttons;
            if ((pressed & (ulong)PlayerButtons.Scoreboard) != 0) // Tab closes, like the skin window
            {
                CloseSettings(p);
                continue;
            }
            if (s.Status.Length == 0 || now < s.StatusUntil) continue;
            s.Status = "";
            HudText(p, "ps_status", "");
        }
    }

    private static void SetStatus(SetSession s, string text)
    {
        s.Status = text;
        s.StatusUntil = Server.CurrentTime + 3f;
    }

    // ---------------------------------------------------------------- content

    private void BuildSettings(CCSPlayerController player, SetSession s)
    {
        s.Rows = new();
        var prefs = EffectivePrefs();
        switch (s.Tab)
        {
            case "sky":
            {
                var def = SetDefs.First(d => d.Id == "sky");
                s.Rows.Add(new SetRow("Map default", "The map's own sky", [("Use", _sky.Length == 0, _ => ChangeSetting(def, "", s.MapScope))]));
                foreach (var (name, material) in Skies)
                    s.Rows.Add(new SetRow(name, material.Split('/').Last().Replace(".vmat", ""),
                        [("Use", _sky == material, _ => ChangeSetting(def, material, s.MapScope))]));
                break;
            }
            case "map":
            {
                s.Rows.Add(new SetRow("Restart round", "mp_restartgame 1", [("Restart", false, _ => Server.ExecuteCommand("mp_restartgame 1"))]));
                foreach (var (name, workshop) in MapChoices())
                {
                    var current = workshop == null ? name == CurrentMap : false;
                    s.Rows.Add(new SetRow(name, workshop != null ? $"Workshop {workshop}" : current ? "current map" : "",
                        [(current ? "Reload" : "Play", current, pl => ChangeMap(pl, name, workshop))]));
                }
                break;
            }
            case "nades":
                BuildNadeRows(player, s);
                break;
            case "spots":
            {
                LoadMoveSpots();
                var on = _move.ContainsKey(player.Slot);
                s.Rows.Add(new SetRow("Movement mode", "Fall and you're put back at the spot (.movement)",
                [
                    ("Off", !on, pl => { if (_move.ContainsKey(pl.Slot)) StopMovement(pl); }),
                    ("On", on, pl => { CloseSettings(pl); StartMovement(pl, null); })
                ]));
                if (_moveSpots.Count == 0)
                    s.Rows.Add(new SetRow("No movement spots yet", "Stand at a jump, look where you jump, type .movement save <name>", []));
                var current = _move.TryGetValue(player.Slot, out var ms) ? ms.Spot : -1;
                for (var i = 0; i < _moveSpots.Count && s.Rows.Count < SetRows; i++)
                {
                    var spot = i;
                    s.Rows.Add(new SetRow(_moveSpots[i].Name, _moveSpots[i].HasEnd ? "start and end point" : "no end point yet (.movement end)",
                        [("Go", spot == current, pl => { CloseSettings(pl); StartMovement(pl, spot); })]));
                }
                break;
            }
            default:
            {
                foreach (var d in SetDefs.Where(d => d.Tab == s.Tab))
                {
                    var value = SettingValue(d);
                    var saved = prefs.ContainsKey(d.Id);
                    s.Rows.Add(new SetRow(d.Name, d.Sub + (saved ? " · saved" : ""),
                        d.Opts.Take(RowChips).Select(o => (o.Label, SameValue(value, o.Value),
                            (Action<CCSPlayerController>)(_ => ChangeSetting(d, o.Value, s.MapScope)))).ToList()));
                }
                if (s.Tab == "bots")
                {
                    s.Rows.Add(new SetRow("Place a bot", "MatchZy .bot where you stand", [("Add", false, pl => pl.ExecuteClientCommandFromServer("css_bot"))]));
                    s.Rows.Add(new SetRow("Kick bots", "bot_kick", [("Kick all", false, _ => Server.ExecuteCommand("bot_kick"))]));
                }
                break;
            }
        }
    }

    private void RenderSettings(CCSPlayerController player, SetSession s)
    {
        if (!HudReady) return;
        HudText(player, "ps_title", $"Server settings · {CurrentMap}");
        foreach (var (id, _) in SetTabs) HudFlag(player, $"ps_tab_{id}", "picked", s.Tab == id);
        for (var i = 0; i < SetRows; i++)
        {
            var row = i < s.Rows.Count ? s.Rows[i] : null;
            HudFlag(player, $"ps_row_{i}", "gone", row == null);
            if (row == null) continue;
            HudText(player, $"ps_row_{i}_name", row.Name);
            HudText(player, $"ps_row_{i}_sub", row.Sub);
            for (var j = 0; j < RowChips; j++)
            {
                var chip = j < row.Chips.Count ? row.Chips[j] : default;
                var id = $"ps_row_{i}_opt_{j}";
                HudFlag(player, id, "gone", j >= row.Chips.Count);
                if (j >= row.Chips.Count) continue;
                HudText(player, id + "_text", chip.Label);
                HudFlag(player, id, "picked", chip.Picked);
            }
        }
        HudFlag(player, "ps_scope_global", "picked", !s.MapScope);
        HudFlag(player, "ps_scope_map", "picked", s.MapScope);
        HudText(player, "ps_status", s.Status);
    }

    private void OnSettingsClicked(CCSPlayerController player, string id)
    {
        if (!_setSessions.TryGetValue(player.Slot, out var s)) return;
        try
        {
            HandleSettingsClick(player, s, id);
        }
        catch (Exception e)
        {
            Logger.LogWarningSafe($"settings window click '{id}': {e}");
            SetStatus(s, "Something went wrong, see the server log");
        }
        if (!_setSessions.ContainsKey(player.Slot)) return; // closed
        BuildSettings(player, s);
        RenderSettings(player, s);
    }

    private void HandleSettingsClick(CCSPlayerController player, SetSession s, string id)
    {
        switch (id)
        {
            case "ps_close": CloseSettings(player); return;
            case "ps_scope_global": s.MapScope = false; SetStatus(s, "Changes are saved for every map"); return;
            case "ps_scope_map": s.MapScope = true; SetStatus(s, $"Changes are saved for {CurrentMap} only"); return;
            case "ps_reset": ResetSettings(s.MapScope); SetStatus(s, s.MapScope ? $"{CurrentMap} settings reset" : "All settings reset"); return;
        }
        if (id.StartsWith("ps_tab_"))
        {
            var tab = id["ps_tab_".Length..];
            if (SetTabs.Any(t => t.Id == tab)) s.Tab = tab;
            return;
        }
        // ps_row_<i>_opt_<j>
        if (!id.StartsWith("ps_row_")) return;
        var parts = id["ps_row_".Length..].Split("_opt_");
        if (parts.Length != 2 || !int.TryParse(parts[0], out var r) || !int.TryParse(parts[1], out var c)) return;
        if (r < 0 || r >= s.Rows.Count || c < 0 || c >= s.Rows[r].Chips.Count) return;
        var row = s.Rows[r];
        var chip = row.Chips[c];
        chip.Click(player);
        if (_setSessions.ContainsKey(player.Slot)) SetStatus(s, $"{row.Name}: {chip.Label}");
    }

    // ---------------------------------------------------------------- text menu fallback

    private MenuPage SettingsMenuRoot() => new()
    {
        Title = "Server settings",
        Build = () => SetTabs.Where(t => t.Id is not ("sky" or "map" or "spots" or "nades"))
            .Select(t => new MenuItem(t.Label, pl => PushPage(pl, SettingsMenuTab(t.Id, t.Label)))).ToList()
    };

    private MenuPage SettingsMenuTab(string tab, string label) => new()
    {
        Title = label,
        Build = () => SetDefs.Where(d => d.Tab == tab).Select(d =>
        {
            var value = SettingValue(d);
            var i = Array.FindIndex(d.Opts, o => SameValue(value, o.Value));
            var shown = i >= 0 ? d.Opts[i].Label : value;
            // E cycles to the next choice
            return new MenuItem($"{d.Name}: {shown}", pl =>
            {
                ChangeSetting(d, d.Opts[(i + 1) % d.Opts.Length].Value, mapOnly: false);
                Flash(pl, $"{d.Name}: {d.Opts[(i + 1) % d.Opts.Length].Label}");
            });
        }).ToList()
    };

    // ---------------------------------------------------------------- values

    private string SettingValue(SetDef d)
    {
        if (d.Get != null) return d.Get();
        return d.Cvars.Length == 0 || ConVar.Find(d.Cvars[0]) is not { } c ? "" : CvarText(c);
    }

    /// <summary>A cvar's value as text, whatever its type ("1"/"0" for bools, invariant numbers).</summary>
    private static string CvarText(ConVar c)
    {
        var inv = CultureInfo.InvariantCulture;
        try
        {
            return c.Type switch
            {
                ConVarType.Bool => c.GetPrimitiveValue<bool>() ? "1" : "0",
                ConVarType.Int16 => c.GetPrimitiveValue<short>().ToString(inv),
                ConVarType.UInt16 => c.GetPrimitiveValue<ushort>().ToString(inv),
                ConVarType.Int32 => c.GetPrimitiveValue<int>().ToString(inv),
                ConVarType.UInt32 => c.GetPrimitiveValue<uint>().ToString(inv),
                ConVarType.Int64 => c.GetPrimitiveValue<long>().ToString(inv),
                ConVarType.UInt64 => c.GetPrimitiveValue<ulong>().ToString(inv),
                ConVarType.Float32 => c.GetPrimitiveValue<float>().ToString(inv),
                ConVarType.Float64 => c.GetPrimitiveValue<double>().ToString(inv),
                _ => c.StringValue
            };
        }
        catch
        {
            try { return c.StringValue; } catch { return ""; }
        }
    }

    private static bool SameValue(string a, string b)
    {
        if (string.Equals(a, b, StringComparison.OrdinalIgnoreCase)) return true;
        static string Bool(string x) => x.ToLowerInvariant() switch { "true" => "1", "false" => "0", _ => x };
        a = Bool(a);
        b = Bool(b);
        return double.TryParse(a, NumberStyles.Float, CultureInfo.InvariantCulture, out var x)
               && double.TryParse(b, NumberStyles.Float, CultureInfo.InvariantCulture, out var y)
               && Math.Abs(x - y) < 0.011;
    }

    private void SetValue(SetDef d, string value)
    {
        if (!_setDefaults.ContainsKey(d.Id)) _setDefaults[d.Id] = SettingValue(d);
        if (d.Set != null)
        {
            d.Set(value);
            return;
        }
        var clean = new string(value.Where(ch => char.IsLetterOrDigit(ch) || ch is '.' or '-' or '_').ToArray());
        foreach (var cvar in d.Cvars) Server.ExecuteCommand($"{cvar} {clean}");
    }

    /// <summary>A click: sets the value now and saves it for every map (and drops this map's own value) or this map.</summary>
    private void ChangeSetting(SetDef d, string value, bool mapOnly)
    {
        SetValue(d, value);
        LoadServerPrefs();
        if (mapOnly)
        {
            if (!_serverPrefs.Maps.TryGetValue(CurrentMap, out var map)) _serverPrefs.Maps[CurrentMap] = map = new();
            map[d.Id] = value;
        }
        else
        {
            _serverPrefs.Global[d.Id] = value;
            if (_serverPrefs.Maps.TryGetValue(CurrentMap, out var map)) map.Remove(d.Id);
        }
        SaveServerPrefs();
    }

    /// <summary>Forgets the saved values (every map's, or this map's) and puts what we changed back.</summary>
    private void ResetSettings(bool mapOnly)
    {
        LoadServerPrefs();
        if (mapOnly) _serverPrefs.Maps.Remove(CurrentMap);
        else _serverPrefs = new ServerPrefs();
        SaveServerPrefs();
        var still = EffectivePrefs();
        foreach (var (id, old) in _setDefaults.ToList())
            if (!still.ContainsKey(id) && SetDefs.FirstOrDefault(d => d.Id == id) is { } d)
            {
                if (d.Set != null) d.Set(old);
                else foreach (var cvar in d.Cvars) Server.ExecuteCommand($"{cvar} {old}");
            }
        ApplySettings();
    }

    /// <summary>Saved values for this map: every-map values, this map's on top.</summary>
    private Dictionary<string, string> EffectivePrefs()
    {
        LoadServerPrefs();
        var all = new Dictionary<string, string>(_serverPrefs.Global);
        if (_serverPrefs.Maps.TryGetValue(CurrentMap, out var map))
            foreach (var (k, v) in map) all[k] = v;
        return all;
    }

    private void ApplySettings()
    {
        foreach (var (id, value) in EffectivePrefs())
            if (SetDefs.FirstOrDefault(d => d.Id == id) is { } d && !SameValue(SettingValue(d), value))
            {
                try { SetValue(d, value); }
                catch (Exception e) { Logger.LogWarning("setting {Id}={Value}: {Message}", id, value, e.Message); }
            }
        foreach (var (slot, s) in _setSessions)
            if (Utilities.GetPlayerFromSlot(slot) is { IsValid: true } p)
            {
                BuildSettings(p, s);
                RenderSettings(p, s);
            }
    }

    private void LoadServerPrefs()
    {
        try
        {
            var stamp = File.Exists(ServerPrefsPath) ? File.GetLastWriteTimeUtc(ServerPrefsPath) : default;
            if (stamp == _serverPrefsStamp) return;
            _serverPrefsStamp = stamp;
            _serverPrefs = stamp == default ? new ServerPrefs()
                : JsonSerializer.Deserialize<ServerPrefs>(File.ReadAllText(ServerPrefsPath), PrefsJson) ?? new ServerPrefs();
        }
        catch (Exception e)
        {
            Logger.LogWarning("server_prefs.json unreadable ({Message}); starting empty", e.Message);
            _serverPrefs = new ServerPrefs();
        }
    }

    private void SaveServerPrefs()
    {
        try
        {
            Directory.CreateDirectory(ConfigDir);
            var tmp = ServerPrefsPath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(_serverPrefs, PrefsJson));
            File.Move(tmp, ServerPrefsPath, true);
            _serverPrefsStamp = File.GetLastWriteTimeUtc(ServerPrefsPath);
        }
        catch (Exception e)
        {
            Logger.LogWarning("server_prefs.json not saved: {Message}", e.Message);
        }
    }

    // ---------------------------------------------------------------- plugin-side settings

    private void SetGlow(bool on)
    {
        _glowOn = on;
        if (on) GlowAllBots();
        else foreach (var index in _glows.Keys.ToList()) RemoveGlow(index);
    }

    private void SetGod(bool on)
    {
        _godOn = on;
        foreach (var p in Utilities.GetPlayers().Where(p => p is { IsValid: true, IsBot: false }))
            SetGodFor(p, on);
    }

    private void SetGodFor(CCSPlayerController player, bool on)
    {
        if (!player.IsValid || player.PlayerPawn.Value is not { IsValid: true } pawn) return;
        // the agent preview keeps the pawn invulnerable while it runs and restores it itself
        if (_hudSessions.TryGetValue(player.Slot, out var hs) && hs.View != null) return;
        pawn.TakesDamage = !on;
    }

    private void ClearFlash(CCSPlayerController player)
    {
        void Clear()
        {
            if (!player.IsValid || player.PlayerPawn.Value is not { IsValid: true } pawn) return;
            pawn.FlashDuration = 0f;
            pawn.FlashMaxAlpha = 0f;
            Utilities.SetStateChanged(pawn, "CCSPlayerPawnBase", "m_flFlashDuration");
            Utilities.SetStateChanged(pawn, "CCSPlayerPawnBase", "m_flFlashMaxAlpha");
        }
        Clear();
        Server.NextFrame(Clear);
    }

    /// <summary>
    /// Sky: a new env_sky with the picked material (precached at map load) and the map's own skies disabled.
    /// "" brings the map's sky back.
    /// </summary>
    private void ApplySky(string material)
    {
        RemoveOurSky();
        _sky = "";
        if (material.Length == 0) return;
        if (Skies.All(s => s.Material != material)) return; // only precached materials
        var originals = Utilities.FindAllEntitiesByDesignerName<CEnvSky>("env_sky").Where(e => e.IsValid).ToList();
        var sky = Utilities.CreateEntityByName<CEnvSky>("env_sky");
        if (sky is not { IsValid: true }) return;
        var kv = new CEntityKeyValues();
        kv.SetString("skyname", material);
        kv.SetBool("StartDisabled", false);
        kv.SetFloat("brightnessscale", originals.FirstOrDefault()?.BrightnessScale is > 0 and var b ? b : 1f);
        sky.DispatchSpawn(kv);
        _ourSky = sky;
        _sky = material;
        foreach (var e in originals)
        {
            if (!e.Enabled) continue;
            e.AcceptInput("Disable");
            _hiddenSkies.Add(e);
        }
    }

    private void RemoveOurSky()
    {
        if (_ourSky is { IsValid: true }) _ourSky.Remove();
        _ourSky = null;
        foreach (var e in _hiddenSkies)
            if (e.IsValid) e.AcceptInput("Enable");
        _hiddenSkies.Clear();
    }

    // ---------------------------------------------------------------- maps

    /// <summary>Installed official maps (game/csgo/maps/*.vpk) plus the workshop maps the app lists in maps.json.</summary>
    private List<(string Name, string? Workshop)> MapChoices()
    {
        var list = new List<(string, string?)>();
        try
        {
            var dir = Path.Combine(Server.GameDirectory, "csgo", "maps");
            foreach (var f in Directory.GetFiles(dir, "*.vpk").Select(Path.GetFileNameWithoutExtension).OrderBy(n => n))
                if (f != null && System.Text.RegularExpressions.Regex.IsMatch(f, "^(de|cs|ar)_[a-z0-9_]+$")
                              && !System.Text.RegularExpressions.Regex.IsMatch(f, "(_vanity|_preview|_skybox|_dir)$"))
                    list.Add((f, null));
        }
        catch { /* no maps folder */ }
        try
        {
            var path = Path.Combine(ConfigDir, "maps.json");
            if (File.Exists(path))
                foreach (var w in JsonSerializer.Deserialize<List<WorkshopMap>>(File.ReadAllText(path), PrefsJson) ?? [])
                    if (w.Id.Length > 0 && w.Id.All(char.IsDigit)) list.Add((w.Name.Length > 0 ? w.Name : $"Workshop {w.Id}", w.Id));
        }
        catch { /* bad file */ }
        return list.Take(SetRows - 1).ToList();
    }

    public class WorkshopMap
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
    }

    private void ChangeMap(CCSPlayerController player, string name, string? workshop)
    {
        CloseSettings(player);
        player.PrintToChat($"{ChatTag} Changing map to {name} ...");
        AddTimer(0.5f, () => Server.ExecuteCommand(workshop != null ? $"host_workshop_map {workshop}" : $"changelevel {name}"),
            TimerFlags.STOP_ON_MAPCHANGE);
    }
}
