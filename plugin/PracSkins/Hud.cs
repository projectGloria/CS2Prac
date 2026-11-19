using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Admin;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Extensions;
using Microsoft.Extensions.Logging;

namespace PracSkins;

/// <summary>One row in the window's left list.</summary>
public record HudSide(string Name, string Sub, bool Picked, Action<CCSPlayerController> OnClick, string Icon = "");

/// <summary>One tile in the window's grid. Base/Skin are CSS image classes (b&lt;def&gt;, s&lt;def&gt;_&lt;paint&gt;, a&lt;def&gt;).</summary>
public record HudTile(string Name, string Base, string Skin, bool Picked, Action<CCSPlayerController> OnClick);

/// <summary>An open skin window.</summary>
public class HudSession
{
    public string Tab { get; set; } = "weapons";
    public int Selected { get; set; } = -1;
    public int SidePage { get; set; }
    public int GridPage { get; set; }
    public string Status { get; set; } = "";
    public float StatusUntil { get; set; }
    public MoveType_t PreviousMoveType { get; set; } = MoveType_t.MOVETYPE_WALK;
    public uint HudBitsAdded { get; set; }
    /// <summary>Buttons held last tick; Tab closes the window on a fresh press (ESC never reaches the server).</summary>
    public ulong LastButtons { get; set; }
    public List<HudSide> Side { get; set; } = new();
    public List<HudTile> Tiles { get; set; } = new();
    /// <summary>The third-person agent preview while it runs (AgentView.cs).</summary>
    public AgentView? View { get; set; }
    /// <summary>Team whose loadout the weapons and stickers tabs edit (2 = T, 3 = CT); starts as the player's.</summary>
    public int Team { get; set; } = 3;
    /// <summary>Stickers tab: the slot picks go to (0-4 stickers, 5 = charm).</summary>
    public int Target { get; set; }
    /// <summary>Stickers tab: search text from !sticker / !charm while the window is open.</summary>
    public string Query { get; set; } = "";
    /// <summary>
    /// First grid row shown: the server can't scroll the grid, so on open the rows above the picked tile's row
    /// (minus one) are hidden and a "Show earlier" bar brings them back (the picked skin lands in the middle).
    /// </summary>
    public int FirstRow { get; set; }
    /// <summary>Keyboard rows for the search (pins, music, graffiti, stickers) are open.</summary>
    public bool Keys { get; set; }
}

/// <summary>What the client was last sent per slot (texts, classes), so a render only sends changes.</summary>
public class HudSent
{
    public Dictionary<string, string> Texts { get; } = new();
    public Dictionary<string, bool> Flags { get; } = new();
    public Dictionary<string, string> Variants { get; } = new();
    public HashSet<string> ClassPairs { get; } = new();
}

/// <summary>
/// The skin window: a Panorama layout (custom_hud_layout, built by scripts/hud/build-hud.mjs into
/// resources/hud; the app copies it into the CS2 client's panorama folder) with a mouse cursor. One entity serves
/// everybody; texts, classes and the cursor are per player. css_menu (K) toggles it; the old text menu stays on
/// css_skins / !skins. Technique and engine pitfalls from nvmxre/cs2-ui-kit (MIT).
/// </summary>
public partial class PracSkins
{
    private const string HudLayout = "panorama/layout/custom_game/cs2prac_skins.xml";
    // Keep in sync with scripts/hud/build-hud.mjs (SIDE_ROWS, GRID_COLS * GRID_ROWS).
    // Both lists scroll with the mouse wheel; sized so nothing needs paging (35 guns, 61 AK-47 finishes + Default).
    private const int SideRows = 36;
    private const int GridCols = 4;
    private const int GridTiles = GridCols * 32; // 128: every music kit (~100) on one page
    /// <summary>
    /// CBasePlayerPawn.m_iHideHUD bits while the K or L window is open: the whole game HUD (user request). Weapon
    /// selection 0, flashlight 1, health/armor 3, misc status 6, chat 7, crosshair 8, bonus progress 11, radar 12,
    /// mini scoreboard 13. Not HIDEHUD_ALL (2): it might take our custom_hud_layout window with it (untested; try it
    /// with `css_prac_hidebits`). The client's own cvars (cl_drawhud …) are tried too, see SetClientHud.
    /// </summary>
    // 4 (HIDEHUD_PLAYERDEAD) and 5 (HIDEHUD_NEEDSUIT) added for the money panel, which stayed with the rest (user
    // report; the Source rule hid health/armor/money with them). Unverified in game: css_prac_hidebits tries others.
    private const uint DefaultWindowHideBits = (1u << 0) | (1u << 1) | (1u << 3) | (1u << 4) | (1u << 5) | (1u << 6) |
                                               (1u << 7) | (1u << 8) | (1u << 11) | (1u << 12) | (1u << 13);
    private uint _windowHideBits = DefaultWindowHideBits;

    /// <summary>Adds the window's hide bits the pawn lacks (also every tick: a respawn or the game may clear them).
    /// Returns the bits we added so far, so close removes only those.</summary>
    private uint HideWindowHud(CCSPlayerController player, uint added)
    {
        var pawn = player.PlayerPawn.Value;
        if (pawn is not { IsValid: true }) return added;
        var missing = _windowHideBits & ~pawn.HideHUD;
        if (missing == 0) return added;
        pawn.HideHUD |= missing;
        Utilities.SetStateChanged(pawn, "CBasePlayerPawn", "m_iHideHUD");
        return added | missing;
    }

    private static void ShowWindowHud(CCSPlayerController player, uint added)
    {
        var pawn = player.PlayerPawn.Value;
        if (added == 0 || pawn is not { IsValid: true }) return;
        pawn.HideHUD &= ~added;
        Utilities.SetStateChanged(pawn, "CBasePlayerPawn", "m_iHideHUD");
    }

    [ConsoleCommand("css_prac_hidebits", "m_iHideHUD bits the K/L windows set (decimal or 0x hex; 'default'; no arg = show)")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnHideBitsCommand(CCSPlayerController? caller, CommandInfo command)
    {
        var arg = command.GetArg(1).Trim().ToLowerInvariant();
        if (arg == "default") _windowHideBits = DefaultWindowHideBits;
        else if (arg.Length > 0)
        {
            var ok = arg.StartsWith("0x")
                ? uint.TryParse(arg[2..], System.Globalization.NumberStyles.HexNumber, null, out var v)
                : uint.TryParse(arg, out v);
            if (!ok) { command.ReplyToCommand("[PracSkins] usage: css_prac_hidebits <mask|0xhex|default>"); return; }
            // open windows: drop what we added, the tick adds the new set
            foreach (var (slot, s) in _hudSessions)
                if (Utilities.GetPlayerFromSlot(slot) is { IsValid: true } p) { ShowWindowHud(p, s.HudBitsAdded); s.HudBitsAdded = 0; }
            foreach (var (slot, s) in _setSessions)
                if (Utilities.GetPlayerFromSlot(slot) is { IsValid: true } p) { ShowWindowHud(p, s.HudBitsAdded); s.HudBitsAdded = 0; }
            _windowHideBits = v;
        }
        var bits = Enumerable.Range(0, 32).Where(i => (_windowHideBits & (1u << i)) != 0);
        command.ReplyToCommand($"[PracSkins] window hide bits 0x{_windowHideBits:X} (bits {string.Join(",", bits)})");
        foreach (var p in Utilities.GetPlayers().Where(p => (p is { IsValid: true } && !IsBotAny(p))))
            if (p.PlayerPawn.Value is { IsValid: true } pawn)
                command.ReplyToCommand($"[PracSkins]   {p.PlayerName}: m_iHideHUD 0x{pawn.HideHUD:X}");
    }

    private static readonly string[] HudTabs = ["weapons", "knives", "gloves", "agents", "pins", "music", "graffiti", "stickers"];

    private CCSCustomHudLayout? _hud;
    private bool _hudWorldReady;
    private readonly Dictionary<int, HudSession> _hudSessions = new();
    /// <summary>Where each player left the skin window (by SteamID: outlives map changes and reconnects).</summary>
    private readonly Dictionary<ulong, (string Tab, int Selected, int Team, int Target)> _hudLast = new();
    private readonly Dictionary<int, HudSent> _hudSent = new();

    private void InitHud(bool hotReload)
    {
        RegisterListener<Listeners.OnCustomHudClicked>(OnHudClicked);
        RegisterListener<Listeners.OnMapEnd>(() =>
        {
            _hudWorldReady = false;
            _hud = null; // the map takes the entity with it
            _hudSessions.Clear();
            _hudSent.Clear();
        });
        // Entities may only be created once the world exists: the first round start of each map.
        RegisterEventHandler<EventRoundStart>((_, _) =>
        {
            _hudWorldReady = true;
            SpawnHud();
            return HookResult.Continue;
        });
        // Per-player state on the entity is stored by slot and outlives a disconnect: clear it for a newcomer.
        RegisterListener<Listeners.OnClientPutInServer>(slot =>
        {
            _hudSessions.Remove(slot);
            if (Utilities.GetPlayerFromSlot(slot) is { IsValid: true } p) ResetHudFor(p);
        });
        RegisterListener<Listeners.OnClientDisconnect>(slot => _hudSessions.Remove(slot));
        RegisterEventHandler<EventPlayerDeath>((e, _) =>
        {
            if (e.Userid is { IsValid: true } p && _hudSessions.ContainsKey(p.Slot)) CloseHud(p);
            return HookResult.Continue;
        });
        RegisterListener<Listeners.OnTick>(OnHudTick);

        if (!hotReload) return;
        _hudWorldReady = true;
        SpawnHud();
    }

    private void UnloadHud()
    {
        foreach (var slot in _hudSessions.Keys.ToList())
            if (Utilities.GetPlayerFromSlot(slot) is { IsValid: true } p) CloseHud(p);
        if (_hud is { IsValid: true }) _hud.Remove();
        _hud = null;
    }

    private bool HudReady => _hud is { IsValid: true };

    private void SpawnHud()
    {
        if (!_hudWorldReady || HudReady) return;
        try
        {
            // Leftovers from an earlier load would keep a captured cursor nobody can release.
            foreach (var old in Utilities.FindAllEntitiesByDesignerName<CCSCustomHudLayout>("custom_hud_layout"))
                if (old.IsValid && old.StrLayout == HudLayout) old.Remove();
            var e = Utilities.CreateEntityByName<CCSCustomHudLayout>("custom_hud_layout");
            if (e is not { IsValid: true }) return;
            e.StrLayout = HudLayout;
            e.DispatchSpawn();
            _hud = e;
            _hudSent.Clear();
        }
        catch (Exception ex)
        {
            Logger.LogError("Skin window: could not create custom_hud_layout: {Message}", ex.Message);
        }
    }

    // ---------------------------------------------------------------- commands

    [ConsoleCommand("css_menu", "Open or close the CS2Prac skin window (bind a key: bind k css_menu)")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnHudCommand(CCSPlayerController? player, CommandInfo command)
    {
        if (player == null) return;
        // "open" / "close" come from the client's K/L binds (Nihil.cfg), which also switch the client's HUD cvars;
        // no argument toggles as before
        var arg = command.GetArg(1).ToLowerInvariant();
        // next frame, not in the command handler: see OnPracMenuCommand (the first window costs ~0.3 s)
        Server.NextFrame(() => { if (player.IsValid) HudCommand(player, arg); });
    }

    private void HudCommand(CCSPlayerController player, string arg)
    {
        if (arg == "close")
        {
            CloseHud(player);
            CloseSettings(player);
            return;
        }
        if (_hudSessions.ContainsKey(player.Slot))
        {
            if (arg != "open") CloseHud(player);
            return;
        }
        if (MenuOpen(player)) CloseMenu(player);
        if (!CanEdit(player)) return;
        if (_setSessions.ContainsKey(player.Slot)) CloseSettings(player);
        if (!HudReady)
        {
            // first moments of a map, before the world is ready: the text menu works everywhere
            OpenMenu(player, RootPage(player));
            return;
        }
        OpenHud(player);
    }

    [ConsoleCommand("css_prac_hud", "Skin window state (entity, open windows)")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnHudStatusCommand(CCSPlayerController? caller, CommandInfo command)
    {
        command.ReplyToCommand($"[PracSkins] skin window: world {(_hudWorldReady ? "ready" : "not ready")}, " +
                               $"entity {(HudReady ? _hud!.Index.ToString() : "none")} ({HudLayout}), open for {_hudSessions.Count}");
        foreach (var (slot, sent) in _hudSent)
            command.ReplyToCommand($"[PracSkins]   slot {slot}: {sent.ClassPairs.Count} panel/class pairs ever sent " +
                                   $"({sent.Flags.Count(f => f.Value) + sent.Variants.Count(v => v.Value.Length > 0)} on), {sent.Texts.Count} texts");
    }



    [ConsoleCommand("css_prac_hudopen", "Test: open/close the skin window for the first bot")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnHudOpenTest(CCSPlayerController? caller, CommandInfo command)
    {
        var bot = Utilities.GetPlayers().FirstOrDefault(p => (p is { IsValid: true, PawnIsAlive: true } && IsBotAny(p)));
        if (bot == null || !HudReady) { command.ReplyToCommand("[PracSkins] need a live bot and the entity"); return; }
        if (_hudSessions.ContainsKey(bot.Slot)) CloseHud(bot); else OpenHud(bot);
        command.ReplyToCommand($"[PracSkins] window {(_hudSessions.ContainsKey(bot.Slot) ? "open" : "closed")} for {bot.PlayerName}");
    }

    [ConsoleCommand("css_prac_hudclick", "Test: click <buttonId> in the first bot's skin window")]
    [CommandHelper(minArgs: 1, usage: "<buttonId>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnHudClickTest(CCSPlayerController? caller, CommandInfo command)
    {
        var bot = Utilities.GetPlayers().FirstOrDefault(p => (p is { IsValid: true, PawnIsAlive: true } && IsBotAny(p)));
        if (bot == null || !HudReady) return;
        OnHudClicked(bot, _hud!, command.GetArg(1));
    }

    /// <summary>Server test for the window's "click a gun" path: equips a weapon on the first live bot and lists its guns.</summary>
    [ConsoleCommand("css_prac_hudequip", "Test: equip <def> on the first bot like a click in the skin window")]
    [CommandHelper(minArgs: 1, usage: "<def>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnHudEquipTest(CCSPlayerController? caller, CommandInfo command)
    {
        LoadCatalogIfChanged();
        var bot = Utilities.GetPlayers().FirstOrDefault(p => (p is { IsValid: true, PawnIsAlive: true } && IsBotAny(p)));
        if (bot == null || !int.TryParse(command.GetArg(1), out var def) || _catalog.Weapon(def) is not { } weapon)
        {
            command.ReplyToCommand("[PracSkins] need a live bot and a catalog weapon def");
            return;
        }
        EquipForHud(bot, weapon);
        AddTimer(0.3f, () =>
        {
            var guns = bot.PlayerPawn.Value?.WeaponServices?.MyWeapons.Select(h => h.Value)
                .Where(w => w is { IsValid: true }).Select(w => $"{w!.DesignerName}({GearSlot(w)})") ?? [];
            Logger.LogInformation("hudequip {Bot}: active {Active}; carries {Guns}", bot.PlayerName,
                bot.PlayerPawn.Value?.WeaponServices?.ActiveWeapon.Value?.DesignerName, string.Join(", ", guns));
        });
    }

    // ---------------------------------------------------------------- open / close

    private void OpenHud(CCSPlayerController player)
    {
        DismissWheel(player);
        var s = new HudSession { Tab = "weapons", LastButtons = (ulong)player.Buttons, Team = player.TeamNum == 2 ? 2 : 3 };
        _hudSessions[player.Slot] = s;
        // Holding a gun or knife: open on it (user request). Otherwise reopen where the player left it (tab, selection,
        // sticker slot). The T/CT switch always starts on the player's own team: a stale switch saved edits to the
        // other team, which looked like "the skin pick didn't work".
        var held = HeldWeapon(player);
        if (held is { Kind: "weapon" })
        {
            SelectTab(player, s, _hudLast.TryGetValue(player.SteamID, out var l) && l.Tab == "stickers" ? "stickers" : "weapons");
        }
        else if (held is { Kind: "knife" }) SelectTab(player, s, "knives");
        else if (_hudLast.TryGetValue(player.SteamID, out var last) && HudTabs.Contains(last.Tab))
        {
            s.Target = last.Target;
            SelectTab(player, s, last.Tab);
            if (last.Selected > 0 && last.Tab is "weapons" or "knives" or "gloves" or "stickers")
            {
                s.Selected = last.Selected;
                BuildHud(player, s);
                var sideIndex = s.Side.FindIndex(x => x.Picked);
                s.SidePage = sideIndex < 0 ? 0 : sideIndex / SideRows;
                ShowCurrentTilePage(s);
            }
        }
        else SelectTab(player, s, "weapons");

        var pawn = player.PlayerPawn.Value;
        if (pawn is { IsValid: true })
        {
            s.PreviousMoveType = pawn.MoveType;
            SetMoveType(pawn, MoveType_t.MOVETYPE_NONE);
        }
        s.HudBitsAdded = HideWindowHud(player, 0);
        // reopened on the agents tab with "Third person" picked: start the preview now, not only after the next click
        SyncAgentView(player, s);
        RenderHud(player, s); // also shows the dim backdrop (not in third person)
        HudFlag(player, "pk_win", "shown", true);
        _hud!.SetInputCaptureEnabled(player, true);
        SetClientHud(player, true);
    }

    /// <summary>
    /// Client cvars for while the K or L window is open (the user's list; cl_drawhud 0 is not usable: it hides the
    /// custom window too). The client refuses server-sent cvars and aliases (no alias ack ever came back), so the
    /// user's Nihil.cfg switches them in its own K/L/Tab binds (cs2prac_k_open …, css_menu open|close). This only
    /// tries the server routes too, in case a client accepts them.
    /// </summary>
    private static readonly (string Cvar, string Hidden, string Shown)[] ClientHudCvars =
    [
        ("cl_hud_telemetry_frametime_show", "0", "2"),
        ("cl_hud_telemetry_ping_show", "0", "2"),
        ("cl_hud_telemetry_net_misdelivery_show", "0", "2"),
        ("cl_drawhud_force_radar", "-1", "0")
    ];

    private readonly HashSet<int> _clientHudHidden = new();

    /// <summary>Hides (or brings back) the client's own HUD. Shown again only once neither window is open.</summary>
    private void SetClientHud(CCSPlayerController player, bool hide)
    {
        if (!player.IsValid || IsBotAny(player)) return;
        if (!hide && (_hudSessions.ContainsKey(player.Slot) || _setSessions.ContainsKey(player.Slot))) return;
        if (hide ? !_clientHudHidden.Add(player.Slot) : !_clientHudHidden.Remove(player.Slot)) return;
        foreach (var (cvar, hidden, shown) in ClientHudCvars)
        {
            var v = hide ? hidden : shown;
            try { player.ReplicateConVar(cvar, v); } catch { /* not allowed */ }
        }
    }

    private void CloseHud(CCSPlayerController player)
    {
        if (!_hudSessions.Remove(player.Slot, out var s)) return;
        StopAgentView(player, s);
        if (!player.IsValid) return;
        _hudLast[player.SteamID] = (s.Tab, s.Selected, s.Team, s.Target);
        StopMusicPreview(player);
        if (HudReady)
        {
            HudFlag(player, "pk_dim", "shown", false);
            HudFlag(player, "pk_win", "shown", false);
            _hud!.SetInputCaptureEnabled(player, false);
        }
        SetClientHud(player, false);
        var pawn = player.PlayerPawn.Value;
        if (pawn is not { IsValid: true }) return;
        SetMoveType(pawn, s.PreviousMoveType == MoveType_t.MOVETYPE_NONE ? MoveType_t.MOVETYPE_WALK : s.PreviousMoveType);
        ShowWindowHud(player, s.HudBitsAdded);
    }

    private void ResetHudFor(CCSPlayerController player)
    {
        if (!HudReady) return;
        if (_hudSent.Remove(player.Slot, out var sent))
            foreach (var (key, cls) in sent.Variants)
                if (cls.Length > 0) _hud!.SetHasClassForPlayer(player, key.Split('|')[0], cls, false);
        _hud!.SetHasClassForPlayer(player, "pk_dim", "shown", false);
        _hud!.SetHasClassForPlayer(player, "pk_win", "shown", false);
        _hud!.SetHasClassForPlayer(player, "ps_win", "shown", false);
        _hud!.SetHasClassForPlayer(player, "gw_win", "shown", false);
        _hud!.SetInputCaptureEnabled(player, false);
    }

    private void OnHudTick()
    {
        if (_hudSessions.Count == 0) return;
        var now = Server.CurrentTime;
        foreach (var (slot, s) in _hudSessions.ToList())
        {
            if (Utilities.GetPlayerFromSlot(slot) is not { IsValid: true } p) continue;
            var buttons = (ulong)p.Buttons;
            var pressed = buttons & ~s.LastButtons;
            s.LastButtons = buttons;
            if ((pressed & (ulong)PlayerButtons.Scoreboard) != 0)
            {
                CloseHud(p);
                continue;
            }
            s.HudBitsAdded = HideWindowHud(p, s.HudBitsAdded);
            if (s.View != null) AgentViewTick(p, s, buttons, pressed);
            if (s.Status.Length == 0 || now < s.StatusUntil) continue;
            s.Status = "";
            HudText(p, "pk_status", "");
        }
    }

    private void HudStatus(CCSPlayerController player, HudSession s, string text)
    {
        s.Status = text;
        s.StatusUntil = Server.CurrentTime + 3f;
    }

    // ---------------------------------------------------------------- sending (only what changed)

    private HudSent SentFor(CCSPlayerController p)
    {
        if (!_hudSent.TryGetValue(p.Slot, out var s)) _hudSent[p.Slot] = s = new HudSent();
        return s;
    }

    private void HudText(CCSPlayerController p, string panel, string text)
    {
        var sent = SentFor(p);
        if (sent.Texts.TryGetValue(panel, out var old) && old == text) return;
        sent.Texts[panel] = text;
        _hud!.SetDialogVariableStringForPlayer(p, panel, "text", text);
    }

    private void HudFlag(CCSPlayerController p, string panel, string cls, bool on)
    {
        var sent = SentFor(p);
        var key = panel + "|" + cls;
        if (sent.Flags.TryGetValue(key, out var old) && old == on) return;
        sent.Flags[key] = on;
        sent.ClassPairs.Add(key);
        _hud!.SetHasClassForPlayer(p, panel, cls, on);
    }

    /// <summary>One class out of a group (e.g. a tile's image) on a panel: removes the previous one.</summary>
    private void HudVariant(CCSPlayerController p, string panel, string group, string cls)
    {
        var sent = SentFor(p);
        var key = panel + "|" + group;
        sent.Variants.TryGetValue(key, out var old);
        old ??= "";
        if (old == cls) return;
        if (old.Length > 0) _hud!.SetHasClassForPlayer(p, panel, old, false);
        if (cls.Length > 0) { sent.ClassPairs.Add(panel + "|" + cls); _hud!.SetHasClassForPlayer(p, panel, cls, true); }
        sent.Variants[key] = cls;
    }

    // ---------------------------------------------------------------- content

    private static string Team(int teamNum) => teamNum == 2 ? "t" : "ct";

    private void SelectTab(CCSPlayerController player, HudSession s, string tab)
    {
        s.Tab = tab;
        s.Query = "";
        s.Keys = false;
        s.Selected = tab switch
        {
            "weapons" or "stickers" => HeldWeapon(player) is { Kind: "weapon" } held ? held.Def
                : SortedGuns().FirstOrDefault()?.Def ?? 0,
            "knives" => _loadout.Knife.For(player.TeamNum)?.DefIndex ?? 0,
            "gloves" => _loadout.Gloves.For(player.TeamNum) is { PaintKit: > 0 } g ? g.DefIndex : 0,
            _ => 0
        };
        BuildHud(player, s);
        var sideIndex = s.Side.FindIndex(x => x.Picked);
        s.SidePage = sideIndex < 0 ? 0 : sideIndex / SideRows;
        ShowCurrentTilePage(s);
    }

    private static void ShowCurrentTilePage(HudSession s)
    {
        var tileIndex = s.Tiles.FindIndex(x => x.Picked);
        s.GridPage = tileIndex < 0 ? 0 : tileIndex / GridTiles;
        // picked tile in the second visible row (user request: the picked skin in the middle of the window)
        s.FirstRow = tileIndex < 0 ? 0 : Math.Max(0, tileIndex % GridTiles / GridCols - 1);
    }

    /// <summary>Fills s.Side and s.Tiles from the catalog and loadout for the tab and selection.</summary>
    private void BuildHud(CCSPlayerController player, HudSession s)
    {
        var team = HudTeam(player, s);
        s.Side = new();
        s.Tiles = new();
        switch (s.Tab)
        {
            case "weapons":
            {
                foreach (var w in SortedGuns())
                {
                    var def = w.Def;
                    var kit = _loadout.WeaponPaint(def, team)?.PaintKit ?? 0;
                    s.Side.Add(new HudSide(w.Name, SkinName(def, kit), def == s.Selected, pl =>
                    {
                        EquipForHud(pl, w); // any gun on either side (user request: AK/Glock as CT, M4/USP as T)
                        s.Selected = def;
                        BuildHud(pl, s);
                        ShowCurrentTilePage(s);
                    }, kit > 0 ? $"s{def}_{kit}" : $"b{def}")); // the picked skin's icon (user request)
                }
                if (s.Selected <= 0) break;
                var sel = s.Selected;
                var cur = _loadout.WeaponPaint(sel, team);
                s.Tiles.Add(new HudTile("Default", $"b{sel}", "", cur is not { PaintKit: > 0 }, pl =>
                {
                    var p = WeaponPaintOrNew(team, sel);
                    p.PaintKit = 0;
                    p.LegacyModel = false;
                    CommitWeapon(pl, team, sel, p);
                    HudStatus(pl, s, $"{_catalog.WeaponName(sel)}: default finish");
                }));
                // random craft (Craft.cs): finish, wear, seed, stickers, charm in one roll
                s.Tiles.Add(new HudTile("Random craft", $"b{sel}", "", false, pl =>
                {
                    HudStatus(pl, s, RandomCraft(pl, team, sel));
                    ShowCurrentTilePage(s);
                }));
                if (HasCraftUndo(player, team, sel))
                    s.Tiles.Add(new HudTile("Undo craft", $"b{sel}", "", false, pl =>
                    {
                        UndoCraft(pl, team, sel, out var msg);
                        HudStatus(pl, s, msg);
                    }));
                foreach (var skin in _catalog.SkinsFor(sel))
                    s.Tiles.Add(new HudTile(skin.Name, $"b{sel}", $"s{sel}_{skin.Paint}", cur?.PaintKit == skin.Paint, pl =>
                    {
                        var p = WeaponPaintOrNew(team, sel);
                        p.Wear = p.PaintKit > 0 ? ClampWear(p.Wear, skin) : ClampWear(0.01f, skin);
                        p.PaintKit = skin.Paint;
                        p.LegacyModel = skin.Legacy;
                        CommitWeapon(pl, team, sel, p);
                        HudStatus(pl, s, $"{_catalog.WeaponName(sel)} | {skin.Name} applied");
                    }));
                break;
            }
            case "knives":
            {
                var knife = _loadout.Knife.For(team);
                s.Side.Add(new HudSide("Default knife", knife is { DefIndex: > 0 } ? "" : "in use", knife is not { DefIndex: > 0 }, pl =>
                {
                    CommitKnife(pl, null);
                    s.Selected = 0;
                    HudStatus(pl, s, "Default knife");
                }, team == 2 ? "b59" : "b42"));
                foreach (var k in _catalog.Weapons.Where(w => w.Kind == "knife"))
                {
                    var mine = knife?.DefIndex == k.Def;
                    s.Side.Add(new HudSide(k.Name, mine ? SkinName(k.Def, knife!.PaintKit).Replace("Default", "Vanilla") : "", k.Def == s.Selected, pl =>
                    {
                        var now = _loadout.Knife.For(pl.TeamNum);
                        if (now?.DefIndex != k.Def)
                        {
                            CommitKnife(pl, new KnifePaint { DefIndex = k.Def, ClassName = k.Cls, Wear = now?.Wear ?? 0.01f, Seed = now?.Seed ?? 0, StatTrak = -1 });
                            HudStatus(pl, s, $"{k.Name} applied");
                        }
                        s.Selected = k.Def;
                        BuildHud(pl, s);
                        ShowCurrentTilePage(s);
                    }, mine && knife!.PaintKit > 0 ? $"s{k.Def}_{knife.PaintKit}" : $"b{k.Def}"));
                }
                var selKnife = _catalog.Weapons.FirstOrDefault(w => w.Kind == "knife" && w.Def == s.Selected);
                if (selKnife == null) break;
                var on = knife?.DefIndex == selKnife.Def;
                s.Tiles.Add(new HudTile("Vanilla", $"b{selKnife.Def}", "", on && knife!.PaintKit <= 0, pl =>
                {
                    ApplyKnifeFinish(pl, selKnife, null);
                    HudStatus(pl, s, $"{selKnife.Name} | Vanilla applied");
                }));
                foreach (var skin in _catalog.SkinsFor(selKnife.Def))
                    s.Tiles.Add(new HudTile(skin.Name, $"b{selKnife.Def}", $"s{selKnife.Def}_{skin.Paint}", on && knife!.PaintKit == skin.Paint, pl =>
                    {
                        ApplyKnifeFinish(pl, selKnife, skin);
                        HudStatus(pl, s, $"{selKnife.Name} | {skin.Name} applied");
                    }));
                break;
            }
            case "gloves":
            {
                var gloves = _loadout.Gloves.For(team);
                var custom = gloves is { PaintKit: > 0 };
                s.Side.Add(new HudSide("Default gloves", custom ? "" : "in use", s.Selected == 0, pl =>
                {
                    SetFor(_loadout.Gloves, pl, null);
                    SaveLoadout();
                    s.Selected = 0;
                    HudStatus(pl, s, "Default gloves from your next respawn");
                }));
                foreach (var g in _catalog.Weapons.Where(w => w.Kind == "glove"))
                {
                    var mine = custom && gloves!.DefIndex == g.Def;
                    // gloves have no base icon: show the worn pair, else the type's first finish
                    var gIcon = mine ? $"s{g.Def}_{gloves!.PaintKit}" : _catalog.SkinsFor(g.Def).FirstOrDefault() is { } first ? $"s{g.Def}_{first.Paint}" : "";
                    s.Side.Add(new HudSide(g.Name, mine ? SkinName(g.Def, gloves!.PaintKit) : "", g.Def == s.Selected, pl =>
                    {
                        s.Selected = g.Def;
                        BuildHud(pl, s);
                        ShowCurrentTilePage(s);
                    }, gIcon));
                }
                var selGlove = _catalog.Weapons.FirstOrDefault(w => w.Kind == "glove" && w.Def == s.Selected);
                if (selGlove == null) break;
                foreach (var skin in _catalog.SkinsFor(selGlove.Def))
                    s.Tiles.Add(new HudTile(skin.Name, "", $"s{selGlove.Def}_{skin.Paint}", custom && gloves!.DefIndex == selGlove.Def && gloves.PaintKit == skin.Paint, pl =>
                    {
                        ApplyGlove(pl, selGlove, skin);
                        HudStatus(pl, s, $"{selGlove.Name} | {skin.Name} applied");
                    }));
                break;
            }
            case "agents":
            {
                var cur = _loadout.Agents.For(team);
                s.Tiles.Add(new HudTile("Default agent", "", "", cur is not { DefIndex: > 0 }, pl =>
                {
                    SetFor(_loadout.Agents, pl, null);
                    SaveLoadout();
                    HudStatus(pl, s, "Default agent from your next respawn");
                }));
                foreach (var a in _catalog.Agents.Where(a => a.Team == Team(team)))
                    s.Tiles.Add(new HudTile(a.Name.Split(" | ")[0], $"a{a.Def}", "", cur?.DefIndex == a.Def, pl =>
                    {
                        SetFor(_loadout.Agents, pl, new AgentPaint { DefIndex = a.Def, Model = a.Model });
                        SaveLoadout();
                        ApplyAgent(pl);
                        PlayAgentVoice(pl, a.Def, a.Model);
                        HudStatus(pl, s, $"{a.Name.Split(" | ")[0]} applied");
                    }));
                break;
            }
            case "pins":
            {
                s.Tiles.Add(new HudTile("No pin", "", "", _loadout.Pin <= 0, pl =>
                {
                    _loadout.Pin = 0;
                    CommitProfileItems(pl, "Pin removed");
                    HudStatus(pl, s, "Pin removed");
                }));
                foreach (var p in _catalog.Pins.Where(p => Matches(p.Name, s.Query)))
                    s.Tiles.Add(new HudTile(p.Name, $"p{p.Def}", "", _loadout.Pin == p.Def, pl =>
                    {
                        _loadout.Pin = p.Def;
                        CommitProfileItems(pl, $"{p.Name} applied");
                        HudStatus(pl, s, $"{p.Name}: shows on the scoreboard");
                    }));
                break;
            }
            case "music":
            {
                // left: listen to the picked kit (the parts the game plays: MVP, main menu, round start ...)
                var kitDef = _loadout.MusicKit;
                if (kitDef > 0 && MusicKitName(kitDef) != null)
                {
                    var playing = _musicPlaying.GetValueOrDefault(player.Slot, "");
                    s.Side.Add(new HudSide("Stop", "stop the preview", false, pl =>
                    {
                        StopMusicPreview(pl);
                        HudStatus(pl, s, "Preview stopped");
                    }));
                    foreach (var (label, part) in MusicParts)
                        s.Side.Add(new HudSide(label, playing == part ? "playing" : "listen", playing == part, pl =>
                        {
                            PlayMusicPreview(pl, kitDef, part);
                            var kitName = _catalog.MusicKits.FirstOrDefault(m => m.Def == kitDef)?.Name ?? "Music kit";
                            HudStatus(pl, s, $"{kitName}: {label}");
                        }, $"m{kitDef}"));
                }
                s.Tiles.Add(new HudTile("Default music", "", "", _loadout.MusicKit <= 0, pl =>
                {
                    StopMusicPreview(pl);
                    _loadout.MusicKit = 0;
                    CommitProfileItems(pl, "Default music");
                    HudStatus(pl, s, "Default music");
                }));
                foreach (var m in _catalog.MusicKits.Where(m => Matches(m.Name, s.Query)))
                    s.Tiles.Add(new HudTile(m.Name, $"m{m.Def}", "", _loadout.MusicKit == m.Def, pl =>
                    {
                        _loadout.MusicKit = m.Def;
                        CommitProfileItems(pl, $"{m.Name} applied");
                        PlayMusicPreview(pl, m.Def, "MVPAnthem");
                        HudStatus(pl, s, $"{m.Name}: listen to it on the left");
                    }));
                break;
            }
            case "graffiti":
            {
                // left: the spray timer (server setting "spraycooldown", admins only), then the tints (only for
                // graffiti that has them); tiles: the patterns
                var timer = SetDefs.First(d => d.Id == "spraycooldown");
                var timerNow = SettingValue(timer);
                var timerKnown = timer.Opts.Any(o => SameValue(timerNow, o.Value));
                foreach (var o in timer.Opts)
                {
                    var on = SameValue(timerNow, o.Value);
                    s.Side.Add(new HudSide($"Timer: {o.Label}", on ? "in use" : "", on, pl =>
                    {
                        if (!IsAdmin(pl))
                        {
                            HudStatus(pl, s, "Only admins can change the graffiti timer");
                            return;
                        }
                        ChangeSetting(timer, o.Value, mapOnly: false);
                        RefreshSettingsWindows();
                        HudStatus(pl, s, o.Value == "0" ? "Graffiti timer: no limit" : $"Graffiti timer: {o.Label} between sprays");
                    }));
                }
                // a value typed in the app that no row has (7 s …)
                if (!timerKnown && timerNow.Length > 0)
                    s.Side.Add(new HudSide($"Timer: {timerNow} s", "in use (set in the app)", true, _ => { }));
                var cur = _catalog.Graffiti.FirstOrDefault(g => g.Def == _loadout.Graffiti);
                if (cur is { Tinted: true })
                    foreach (var t in GraffitiTints)
                        s.Side.Add(new HudSide(t.Name, _loadout.GraffitiTint == t.Id ? "in use" : "", _loadout.GraffitiTint == t.Id, pl =>
                        {
                            CommitGraffiti(pl, cur.Def, t.Id, $"{cur.Name} ({t.Name})");
                            HudStatus(pl, s, $"{cur.Name} ({t.Name}): tap T to spray, hold T for the wheel");
                        }));
                s.Tiles.Add(new HudTile("No graffiti", "", "", _loadout.Graffiti <= 0, pl =>
                {
                    CommitGraffiti(pl, 0, 0, "Graffiti removed");
                    HudStatus(pl, s, "Graffiti removed");
                }));
                foreach (var g in _catalog.Graffiti.Where(g => Matches(g.Name, s.Query)))
                    s.Tiles.Add(new HudTile(g.Name, $"g{g.Def}", "", _loadout.Graffiti == g.Def, pl =>
                    {
                        var tint = g.Tinted ? (_loadout.GraffitiTint > 0 ? _loadout.GraffitiTint : 1) : 0;
                        CommitGraffiti(pl, g.Def, tint, $"{g.Name} picked");
                        HudStatus(pl, s, g.Tinted ? $"{g.Name}: pick a colour on the left, tap T to spray" : $"{g.Name}: tap T to spray, hold T for the wheel");
                        }));
                break;
            }
            case "stickers":
                BuildStickerTab(s, team);
                break;
        }
        s.SidePage = Math.Clamp(s.SidePage, 0, Math.Max(0, (s.Side.Count - 1) / SideRows));
        s.GridPage = Math.Clamp(s.GridPage, 0, Math.Max(0, (s.Tiles.Count - 1) / GridTiles));
        var rowsOnPage = (Math.Clamp(s.Tiles.Count - s.GridPage * GridTiles, 0, GridTiles) + GridCols - 1) / GridCols;
        s.FirstRow = Math.Clamp(s.FirstRow, 0, Math.Max(0, rowsOnPage - 1));
    }

    /// <summary>Tabs with the search bar and on-screen keyboard (Panorama has no text input).</summary>
    private static bool HasSearch(string tab) => tab is "pins" or "music" or "graffiti" or "stickers";

    private const int MaxQuery = 24;

    /// <summary>A key of the window's keyboard: filters at once (user request: search on every keystroke).</summary>
    private static void HudKey(HudSession s, string key)
    {
        s.Query = key switch
        {
            "back" => s.Query.Length > 0 ? s.Query[..^1] : "",
            "clear" => "",
            "space" => s.Query.Length is > 0 and < MaxQuery && !s.Query.EndsWith(' ') ? s.Query + " " : s.Query,
            _ when key.Length == 1 && s.Query.Length < MaxQuery => s.Query + key,
            _ => s.Query
        };
        s.GridPage = 0;
        s.FirstRow = 0;
    }

    /// <summary>The team a tab edits: the T/CT switch for weapons and stickers, the player's own team elsewhere.</summary>
    private static int HudTeam(CCSPlayerController player, HudSession s) => s.Tab is "weapons" or "stickers" ? s.Team : player.TeamNum;

    private static string ShortName(string name) => name.Contains(" | ") ? name[(name.IndexOf(" | ") + 3)..] : name;

    private string StickerName(int def) => _catalog.Stickers.FirstOrDefault(x => x.Def == def) is { } st ? ShortName(st.Name) : $"Sticker {def}";

    /// <summary>
    /// Stickers tab: guns on the left; tiles = the five sticker slots and the charm (click one to make it the target),
    /// then what can go there. Without a search the sticker list shows the ones already used plus the first of the
    /// catalog; !sticker / !charm &lt;text&gt; in chat search while the window is open.
    /// </summary>
    private void BuildStickerTab(HudSession s, int team)
    {
        foreach (var w in SortedGuns())
        {
            var def = w.Def;
            var wp = _loadout.WeaponPaint(def, team);
            var n = wp?.Stickers.Count(x => x is { DefIndex: > 0 }) ?? 0;
            var charm = wp?.Keychain is { DefIndex: > 0 };
            var kit = wp?.PaintKit ?? 0;
            var extras = n == 0 && !charm ? "" : $"{n}/5{(charm ? " + charm" : "")}";
            var sub = kit > 0 ? (extras.Length > 0 ? $"{extras} · {SkinName(def, kit)}" : SkinName(def, kit)) : extras;
            s.Side.Add(new HudSide(w.Name, sub, def == s.Selected, pl =>
            {
                if (team == pl.TeamNum) EquipForHud(pl, w);
                s.Selected = def;
                s.GridPage = 0; s.FirstRow = 0;
            }, kit > 0 ? $"s{def}_{kit}" : $"b{def}"));
        }
        if (s.Selected <= 0) return;
        var sel = s.Selected;
        var cur = WeaponPaintOrNew(team, sel);
        for (var slot = 0; slot < 5; slot++)
        {
            var i = slot;
            var st = SlotOf(cur, i);
            s.Tiles.Add(new HudTile($"Slot {i + 1}: {(st is { DefIndex: > 0 } ? StickerName(st.DefIndex) : "empty")}", st is { DefIndex: > 0 } ? $"k{st.DefIndex}" : "", "", s.Target == i, _ =>
            {
                s.Target = i;
                s.GridPage = 0; s.FirstRow = 0;
            }));
        }
        s.Tiles.Add(new HudTile($"Charm: {ShortName(CharmLabel(cur.Keychain))}", cur.Keychain is { DefIndex: > 0 } kc ? $"c{kc.DefIndex}" : "", "", s.Target == 5, _ =>
        {
            s.Target = 5;
            s.GridPage = 0; s.FirstRow = 0;
        }));
        var weaponName = _catalog.WeaponName(sel);
        if (s.Target == 5)
        {
            s.Tiles.Add(new HudTile("No charm", "", "", false, pl =>
            {
                var p = StickerBasePaint(team, sel);
                p.Keychain = null;
                CommitWeapon(pl, team, sel, p);
                HudStatusFor(pl, $"{weaponName}: charm removed");
            }));
            foreach (var k in _catalog.Keychains.Where(k => Matches(k.Name, s.Query)))
                s.Tiles.Add(new HudTile(ShortName(k.Name), $"c{k.Def}", "", cur.Keychain?.DefIndex == k.Def, pl =>
                {
                    var p = StickerBasePaint(team, sel);
                    p.Keychain = new KeychainPaint { DefIndex = k.Def, Seed = p.Keychain?.Seed ?? 0, X = p.Keychain?.X ?? 0, Y = p.Keychain?.Y ?? 0, Z = p.Keychain?.Z ?? 0 };
                    CommitWeapon(pl, team, sel, p);
                    HudStatusFor(pl, $"{weaponName}: {ShortName(k.Name)}");
                }));
            return;
        }
        var target = s.Target;
        var onSlot = SlotOf(cur, target);
        s.Tiles.Add(new HudTile("Remove sticker", "", "", false, pl =>
        {
            var p = StickerBasePaint(team, sel);
            SetSlot(p, target, null);
            CommitWeapon(pl, team, sel, p);
            HudStatusFor(pl, $"{weaponName}: slot {target + 1} cleared");
        }));
        IEnumerable<CatalogNamed> list;
        if (s.Query.Length > 0) list = _catalog.Stickers.Where(x => Matches(x.Name, s.Query)).Take(256);
        else
        {
            // no text entry in the window: what the loadout already uses, then the start of the catalog
            var used = new[] { 2, 3 }.SelectMany(t => _loadout.Weapons.For(t)?.Values ?? Enumerable.Empty<Paint>())
                .SelectMany(p => p.Stickers).Where(x => x is { DefIndex: > 0 }).Select(x => x!.DefIndex).ToHashSet();
            var usedList = _catalog.Stickers.Where(x => used.Contains(x.Def)).ToList();
            list = usedList.Concat(_catalog.Stickers.Where(x => !used.Contains(x.Def))).Take(Math.Max(usedList.Count, GridTiles - s.Tiles.Count));
        }
        foreach (var st in list)
            s.Tiles.Add(new HudTile(ShortName(st.Name), $"k{st.Def}", "", onSlot?.DefIndex == st.Def, pl =>
            {
                var p = StickerBasePaint(team, sel);
                var old = SlotOf(p, target);
                SetSlot(p, target, new StickerPaint { DefIndex = st.Def, Wear = old?.Wear ?? 0, Scale = old?.Scale ?? 1, Rotation = old?.Rotation ?? 0, X = old?.X ?? 0, Y = old?.Y ?? 0 });
                CommitWeapon(pl, team, sel, p);
                HudStatusFor(pl, $"{weaponName}: {ShortName(st.Name)} -> slot {target + 1}");
            }));
    }

    private void HudStatusFor(CCSPlayerController player, string text)
    {
        if (_hudSessions.TryGetValue(player.Slot, out var s)) HudStatus(player, s, text);
    }

    /// <summary>!sticker / !charm while the skin window is open: search in its stickers tab instead of the text menu.</summary>
    private bool HudSearch(CCSPlayerController player, string query, bool charm)
    {
        if (!_hudSessions.TryGetValue(player.Slot, out var s) || !HudReady) return false;
        if (s.Tab != "stickers") SelectTab(player, s, "stickers");
        s.Query = query.Trim();
        if (charm) s.Target = 5;
        else if (s.Target == 5) s.Target = 0;
        s.GridPage = 0; s.FirstRow = 0;
        BuildHud(player, s);
        RenderHud(player, s);
        return true;
    }

    /// <summary>The finish the wear/StatTrak buttons act on in this tab, or null when there is none.</summary>
    private (float Wear, bool StatTrak, bool CanStatTrak)? HudCurrentFinish(CCSPlayerController player, HudSession s)
    {
        var team = HudTeam(player, s);
        switch (s.Tab)
        {
            case "weapons" when _loadout.WeaponPaint(s.Selected, team) is { PaintKit: > 0 } p:
                return (p.Wear, p.StatTrak >= 0, true);
            case "knives" when _loadout.Knife.For(team) is { DefIndex: > 0, PaintKit: > 0 } k && k.DefIndex == s.Selected:
                return (k.Wear, k.StatTrak >= 0, true);
            case "gloves" when _loadout.Gloves.For(team) is { PaintKit: > 0 } g && g.DefIndex == s.Selected:
                return (g.Wear, false, false);
            default:
                return null;
        }
    }

    private void RenderHud(CCSPlayerController player, HudSession s)
    {
        if (!HudReady) return;
        var team = HudTeam(player, s);
        HudText(player, "pk_title", $"Loadout · {(team == 2 ? "T" : "CT")}");
        foreach (var t in HudTabs) HudFlag(player, $"pk_tab_{t}", "picked", s.Tab == t);
        var teamBar = s.Tab is "weapons" or "stickers";
        HudFlag(player, "pk_teambar", "gone", !teamBar);
        HudFlag(player, "pk_team_t", "picked", s.Team == 2);
        HudFlag(player, "pk_team_ct", "picked", s.Team != 2);
        HudText(player, "pk_teamhint", !teamBar ? "" : s.Tab == "stickers"
            ? "" : s.Team != player.TeamNum ? "Editing the other team's skins" : "");

        // agents tab: first/third person; in third person the window moves left, no dim, pose + camera buttons
        var agents = s.Tab == "agents";
        var view = s.View;
        var thirdPref = PrefsFor(player).View == "third";
        HudFlag(player, "pk_dim", "shown", view == null);
        HudFlag(player, "pk_win", "agents", agents);
        HudFlag(player, "pk_win", "third", view != null);
        HudFlag(player, "pk_agentbar", "gone", !agents);
        HudFlag(player, "pk_view_first", "picked", !thirdPref);
        HudFlag(player, "pk_view_third", "picked", thirdPref);
        HudFlag(player, "pk_tp", "gone", view == null);
        HudText(player, "pk_hint", AgentHint(view));
        if (view != null)
        {
            foreach (var pose in Poses) HudFlag(player, $"pk_pose_{pose.Key}", "picked", view.Pose == pose.Key);
            HudFlag(player, "pk_cam_mouse", "picked", view.MouseLook);
            HudFlag(player, "pk_stance_stand", "picked", !view.Crouch);
            HudFlag(player, "pk_stance_crouch", "picked", view.Crouch);
        }

        // left list
        var noSide = s.Tab is "agents" or "pins" || (s.Tab is "graffiti" or "music" && s.Side.Count == 0);
        HudFlag(player, "pk_side", "gone", noSide);
        // no side list: the grid takes the whole width (user report: blank space on the right); not in third person
        HudFlag(player, "pk_win", "noside", noSide && view == null);

        // search bar + keyboard
        var search = HasSearch(s.Tab);
        HudFlag(player, "pk_searchbar", "gone", !search);
        HudFlag(player, "pk_keys", "gone", !search || !s.Keys);
        HudFlag(player, "pk_search", "picked", s.Keys);
        HudText(player, "pk_query", s.Query.Length > 0 ? s.Query + (s.Keys ? "_" : "")
            : s.Keys ? "_" : s.Tab == "stickers" ? "Click to type (or !sticker / !charm <text> in chat)" : "Click to type");
        var sideStart = s.SidePage * SideRows;
        for (var i = 0; i < SideRows; i++)
        {
            var row = sideStart + i < s.Side.Count ? s.Side[sideStart + i] : null;
            HudFlag(player, $"pk_side_{i}", "gone", row == null);
            if (row == null) continue;
            HudText(player, $"pk_side_{i}_name", row.Name);
            HudText(player, $"pk_side_{i}_sub", row.Sub);
            HudVariant(player, $"pk_side_{i}_img", "i", row.Icon);
            HudFlag(player, $"pk_side_{i}", "picked", row.Picked);
        }

        // heading
        HudText(player, "pk_heading", s.Tab switch
        {
            "weapons" => _catalog.WeaponName(s.Selected) + HeadingInfo(team, s.Selected),
            "knives" => s.Selected > 0 ? _catalog.WeaponName(s.Selected) + HeadingInfo(team, s.Selected) : "Knife",
            "gloves" => s.Selected > 0 ? _catalog.WeaponName(s.Selected) : "Gloves",
            "pins" => "Pin (both teams)",
            "music" => "Music kit (both teams)",
            "graffiti" => "Graffiti (tap T to spray, hold T for the wheel)",
            "stickers" => s.Selected > 0 ? $"{_catalog.WeaponName(s.Selected)} · {(s.Target == 5 ? "charm" : $"sticker slot {s.Target + 1}")}" : "Stickers",
            _ => $"Agents ({(team == 2 ? "T" : "CT")})"
        });
        var empty = s.Tiles.Count > 0 ? "" : s.Tab switch
        {
            "knives" => "Default knife in use. Pick a knife on the left.",
            "gloves" => "Default gloves in use. Pick a glove type on the left.",
            "stickers" => "Pick a gun on the left.",
            _ => "Nothing here. Open the Loadout tab in the CS2Prac app once, then restart the server."
        };
        HudText(player, "pk_empty", empty);
        HudFlag(player, "pk_empty", "gone", empty.Length == 0);

        // grid
        var gridStart = s.GridPage * GridTiles;
        var onPage = Math.Clamp(s.Tiles.Count - gridStart, 0, GridTiles);
        for (var r = 0; r < GridTiles / GridCols; r++) HudFlag(player, $"pk_grow_{r}", "gone", r * GridCols >= onPage || r < s.FirstRow);
        HudFlag(player, "pk_earlier", "gone", s.FirstRow == 0);
        for (var i = 0; i < GridTiles; i++)
        {
            var tile = gridStart + i < s.Tiles.Count ? s.Tiles[gridStart + i] : null;
            HudFlag(player, $"pk_tile_{i}", "gone", tile == null);
            if (tile == null) continue;
            HudText(player, $"pk_tile_{i}_name", tile.Name);
            HudFlag(player, $"pk_tile_{i}", "picked", tile.Picked);
            HudVariant(player, $"pk_tile_{i}_img", "b", tile.Base);
            HudVariant(player, $"pk_tile_{i}_img", "s", tile.Skin);
            HudVariant(player, $"pk_tile_{i}_bar", "s", tile.Skin);
        }
        var pages = Math.Max(1, (s.Tiles.Count + GridTiles - 1) / GridTiles);
        HudText(player, "pk_page", $"{s.GridPage + 1} / {pages}");
        HudFlag(player, "pk_prev", "off", s.GridPage == 0);
        HudFlag(player, "pk_next", "off", s.GridPage >= pages - 1);
        // the grid scrolls; the pager only appears when a list ever outgrows the 128 tiles
        foreach (var id in new[] { "pk_prev", "pk_page", "pk_next" }) HudFlag(player, id, "gone", pages <= 1);
        HudText(player, "pk_status", s.Status);

        // wear + StatTrak
        var finish = HudCurrentFinish(player, s);
        HudFlag(player, "pk_wears", "gone", finish == null);
        if (finish is { } f)
        {
            var wearIndex = Array.FindIndex(WearPresets, w => w.Name == WearName(f.Wear));
            for (var i = 0; i < WearPresets.Length; i++) HudFlag(player, $"pk_wear_{i}", "picked", i == wearIndex);
            HudFlag(player, "pk_st", "gone", !f.CanStatTrak);
            HudFlag(player, "pk_st", "picked", f.StatTrak);
        }
    }

    // ---------------------------------------------------------------- clicks

    private void OnHudClicked(CCSPlayerController player, CCSCustomHudLayout layout, string id)
    {
        if (!player.IsValid || !HudReady || layout.Index != _hud!.Index) return;
        if (id.StartsWith("ps_")) // the settings window lives in the same layout (SettingsHud.cs)
        {
            OnSettingsClicked(player, id);
            return;
        }
        if (id.StartsWith("gw_")) // and the graffiti wheel (GraffitiWheel.cs)
        {
            try { OnWheelClicked(player, id); }
            catch (Exception e) { Logger.LogWarningSafe($"graffiti wheel click '{id}': {e}"); }
            return;
        }
        if (!_hudSessions.TryGetValue(player.Slot, out var s)) return;
        try
        {
            HandleHudClick(player, s, id);
        }
        catch (Exception e)
        {
            Logger.LogWarningSafe($"skin window click '{id}': {e}");
            HudStatus(player, s, "Something went wrong, see the server log");
        }
        if (!_hudSessions.ContainsKey(player.Slot)) return; // closed
        SyncAgentView(player, s);
        BuildHud(player, s);
        RenderHud(player, s);
    }

    private void HandleHudClick(CCSPlayerController player, HudSession s, string id)
    {
        if (id is "pk_close")
        {
            CloseHud(player);
            return;
        }
        if (HandleAgentViewClick(player, s, id)) return;
        if (id.StartsWith("pk_tab_"))
        {
            var tab = id["pk_tab_".Length..];
            if (HudTabs.Contains(tab) && tab != s.Tab) SelectTab(player, s, tab);
            return;
        }
        switch (id)
        {
            case "pk_prev": s.GridPage = Math.Max(0, s.GridPage - 1); s.FirstRow = 0; return;
            case "pk_next": s.GridPage++; s.FirstRow = 0; return;
            case "pk_earlier": s.FirstRow = 0; return;
            case "pk_st": ToggleHudStatTrak(player, s); return;
            case "pk_search": s.Keys = !s.Keys; return;
            case "pk_team_t": s.Team = 2; s.GridPage = 0; s.FirstRow = 0; return;
            case "pk_team_ct": s.Team = 3; s.GridPage = 0; s.FirstRow = 0; return;
        }
        if (id.StartsWith("pk_key_"))
        {
            HudKey(s, id["pk_key_".Length..]);
            return;
        }
        if (TryIndex(id, "pk_side_", out var side) && s.SidePage * SideRows + side < s.Side.Count)
            s.Side[s.SidePage * SideRows + side].OnClick(player);
        else if (TryIndex(id, "pk_tile_", out var tile) && s.GridPage * GridTiles + tile < s.Tiles.Count)
            s.Tiles[s.GridPage * GridTiles + tile].OnClick(player);
        else if (TryIndex(id, "pk_wear_", out var wear) && wear < WearPresets.Length)
            SetHudWear(player, s, WearPresets[wear]);
    }

    /// <summary>Side-list order for the weapons tab: pistols, SMGs, heavy, rifles, snipers (buy-menu style).</summary>
    private static readonly string[] GunOrder =
    [
        "weapon_glock", "weapon_hkp2000", "weapon_usp_silencer", "weapon_elite", "weapon_p250", "weapon_tec9",
        "weapon_fiveseven", "weapon_cz75a", "weapon_deagle", "weapon_revolver",
        "weapon_mac10", "weapon_mp9", "weapon_mp7", "weapon_mp5sd", "weapon_ump45", "weapon_p90", "weapon_bizon",
        "weapon_nova", "weapon_xm1014", "weapon_sawedoff", "weapon_mag7", "weapon_m249", "weapon_negev",
        "weapon_galilar", "weapon_famas", "weapon_ak47", "weapon_m4a1", "weapon_m4a1_silencer", "weapon_sg556",
        "weapon_aug", "weapon_ssg08", "weapon_awp", "weapon_g3sg1", "weapon_scar20"
    ];

    /// <summary>Catalog guns in GunOrder; anything not listed (new guns, Zeus) keeps catalog order at the end.</summary>
    private IEnumerable<CatalogWeapon> SortedGuns() => _catalog.Weapons.Where(w => w.Kind == "weapon")
        .Select((w, i) => (w, i))
        .OrderBy(x => Array.IndexOf(GunOrder, x.w.Cls) is var o and >= 0 ? o : GunOrder.Length + x.i)
        .Select(x => x.w);

    private static gear_slot_t? GearSlot(CBasePlayerWeapon w) => w.As<CCSWeaponBase>().VData?.GearSlot;

    private static readonly HashSet<string> Pistols =
    [
        "weapon_glock", "weapon_hkp2000", "weapon_usp_silencer", "weapon_p250", "weapon_fiveseven", "weapon_tec9",
        "weapon_cz75a", "weapon_deagle", "weapon_revolver", "weapon_elite"
    ];

    /// <summary>
    /// Puts the clicked gun in the player's hands: switches to it when they carry it, otherwise gives it and drops the
    /// gun it replaces (same primary/pistol slot; knife, Zeus and grenades stay). The skin hook paints it on the way.
    /// </summary>
    private void EquipForHud(CCSPlayerController player, CatalogWeapon weapon)
    {
        var pawn = player.PlayerPawn.Value;
        var services = pawn?.WeaponServices;
        if (pawn is not { IsValid: true } || services == null || !player.PawnIsAlive || weapon.Cls.Length == 0) return;

        var owned = services.MyWeapons.Select(h => h.Value)
            .FirstOrDefault(w => w is { IsValid: true } && w.AttributeManager.Item.ItemDefinitionIndex == weapon.Def);
        // the entity's own name: the M4A1-S is weapon_m4a1 there, which is what the server's "use" matches
        var useName = owned?.DesignerName;
        // One gun per slot (giving a second rifle drops it on the floor), so the slot's old gun is removed before
        // the new one is given.
        void Use(string name) => UseWeapon(player, name);
        if (owned != null)
        {
            Use(useName!);
            return;
        }
        gear_slot_t? slot = weapon.Cls == "weapon_taser" ? null
            : Pistols.Contains(weapon.Cls) ? gear_slot_t.GEAR_SLOT_PISTOL : gear_slot_t.GEAR_SLOT_RIFLE;
        var replaced = slot == null ? [] : services.MyWeapons.Select(h => h.Value)
            .Where(w => w is { IsValid: true } && GearSlot(w) == slot).ToList();

        // The old gun leaves the inventory at once (RemovePlayerItem frees the slot in this tick, a plain Remove only at
        // the end of the frame) and the new one is given in the same tick: with the hands empty the engine deploys it,
        // so one draw animation. Taking the knife out first was a second draw (user report 2026-11-17).
        foreach (var w in replaced)
        {
            if (w is not { IsValid: true }) continue;
            if (services.ActiveWeapon.Value?.Index == w.Index) services.ActiveWeapon.Raw = uint.MaxValue;
            pawn.RemovePlayerItem(w);
            w.Remove();
        }
        var given = player.GiveNamedItem<CBasePlayerWeapon>(weapon.Cls);
        // only sends a slot key if the engine didn't deploy it (once the client has the entity)
        if (given is { IsValid: true }) SwitchTo(player, WeaponKey(given), 0.1f, true);
    }

    private static bool TryIndex(string id, string prefix, out int index)
    {
        index = -1;
        return id.StartsWith(prefix) && int.TryParse(id[prefix.Length..], out index) && index >= 0;
    }

    private void SetHudWear(CCSPlayerController player, HudSession s, (string Name, float Value) wear)
    {
        var team = HudTeam(player, s);
        switch (s.Tab)
        {
            case "weapons" when _loadout.WeaponPaint(s.Selected, team) is { PaintKit: > 0 }:
            {
                var p = WeaponPaintOrNew(team, s.Selected);
                p.Wear = ClampWear(wear.Value, _catalog.SkinsFor(s.Selected).FirstOrDefault(x => x.Paint == p.PaintKit));
                CommitWeapon(player, team, s.Selected, p);
                break;
            }
            case "knives" when _loadout.Knife.For(team) is { PaintKit: > 0 } k:
                k.Wear = ClampWear(wear.Value, _catalog.SkinsFor(k.DefIndex).FirstOrDefault(x => x.Paint == k.PaintKit));
                CommitKnife(player, k);
                break;
            case "gloves" when _loadout.Gloves.For(team) is { PaintKit: > 0 } g:
                g.Wear = ClampWear(wear.Value, _catalog.SkinsFor(g.DefIndex).FirstOrDefault(x => x.Paint == g.PaintKit));
                SaveLoadout();
                ApplyGloves(player);
                break;
            default:
                return;
        }
        HudStatus(player, s, $"{wear.Name} applied");
    }

    private void ToggleHudStatTrak(CCSPlayerController player, HudSession s)
    {
        var team = HudTeam(player, s);
        bool on;
        switch (s.Tab)
        {
            case "weapons" when _loadout.WeaponPaint(s.Selected, team) is { PaintKit: > 0 }:
            {
                var p = WeaponPaintOrNew(team, s.Selected);
                p.StatTrak = p.StatTrak >= 0 ? -1 : 0;
                on = p.StatTrak >= 0;
                CommitWeapon(player, team, s.Selected, p);
                break;
            }
            case "knives" when _loadout.Knife.For(team) is { PaintKit: > 0 } k:
                k.StatTrak = k.StatTrak >= 0 ? -1 : 0;
                on = k.StatTrak >= 0;
                CommitKnife(player, k);
                break;
            default:
                return;
        }
        HudStatus(player, s, on ? "StatTrak on" : "StatTrak off");
    }
}
