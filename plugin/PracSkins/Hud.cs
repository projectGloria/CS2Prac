using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
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
    private const int GridTiles = GridCols * 16;
    // CBasePlayerPawn.m_iHideHUD bits hidden while the window is open: weapon selection, crosshair, radar.
    private const uint HudHideBits = (1u << 0) | (1u << 8) | (1u << 12);

    private static readonly string[] HudTabs = ["weapons", "knives", "gloves", "agents"];

    private CCSCustomHudLayout? _hud;
    private bool _hudWorldReady;
    private readonly Dictionary<int, HudSession> _hudSessions = new();
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
        if (_hudSessions.ContainsKey(player.Slot))
        {
            CloseHud(player);
            return;
        }
        if (MenuOpen(player)) CloseMenu(player);
        if (!CanEdit(player, command)) return;
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
        var bot = Utilities.GetPlayers().FirstOrDefault(p => p is { IsValid: true, IsBot: true, PawnIsAlive: true });
        if (bot == null || !HudReady) { command.ReplyToCommand("[PracSkins] need a live bot and the entity"); return; }
        if (_hudSessions.ContainsKey(bot.Slot)) CloseHud(bot); else OpenHud(bot);
        command.ReplyToCommand($"[PracSkins] window {(_hudSessions.ContainsKey(bot.Slot) ? "open" : "closed")} for {bot.PlayerName}");
    }

    [ConsoleCommand("css_prac_hudclick", "Test: click <buttonId> in the first bot's skin window")]
    [CommandHelper(minArgs: 1, usage: "<buttonId>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnHudClickTest(CCSPlayerController? caller, CommandInfo command)
    {
        var bot = Utilities.GetPlayers().FirstOrDefault(p => p is { IsValid: true, IsBot: true, PawnIsAlive: true });
        if (bot == null || !HudReady) return;
        OnHudClicked(bot, _hud!, command.GetArg(1));
    }

    /// <summary>Server test for the window's "click a gun" path: equips a weapon on the first live bot and lists its guns.</summary>
    [ConsoleCommand("css_prac_hudequip", "Test: equip <def> on the first bot like a click in the skin window")]
    [CommandHelper(minArgs: 1, usage: "<def>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnHudEquipTest(CCSPlayerController? caller, CommandInfo command)
    {
        LoadCatalogIfChanged();
        var bot = Utilities.GetPlayers().FirstOrDefault(p => p is { IsValid: true, IsBot: true, PawnIsAlive: true });
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
        var s = new HudSession { Tab = "weapons", LastButtons = (ulong)player.Buttons };
        _hudSessions[player.Slot] = s;
        SelectTab(player, s, "weapons");

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
        RenderHud(player, s);
        HudFlag(player, "pk_dim", "shown", true);
        HudFlag(player, "pk_win", "shown", true);
        _hud!.SetInputCaptureEnabled(player, true);
    }

    private void CloseHud(CCSPlayerController player)
    {
        if (!_hudSessions.Remove(player.Slot, out var s)) return;
        if (!player.IsValid) return;
        if (HudReady)
        {
            HudFlag(player, "pk_dim", "shown", false);
            HudFlag(player, "pk_win", "shown", false);
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

    private void ResetHudFor(CCSPlayerController player)
    {
        if (!HudReady) return;
        if (_hudSent.Remove(player.Slot, out var sent))
            foreach (var (key, cls) in sent.Variants)
                if (cls.Length > 0) _hud!.SetHasClassForPlayer(player, key.Split('|')[0], cls, false);
        _hud!.SetHasClassForPlayer(player, "pk_dim", "shown", false);
        _hud!.SetHasClassForPlayer(player, "pk_win", "shown", false);
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
        s.Selected = tab switch
        {
            "weapons" => HeldWeapon(player) is { Kind: "weapon" } held ? held.Def
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
    }

    /// <summary>Fills s.Side and s.Tiles from the catalog and loadout for the tab and selection.</summary>
    private void BuildHud(CCSPlayerController player, HudSession s)
    {
        var team = player.TeamNum;
        s.Side = new();
        s.Tiles = new();
        switch (s.Tab)
        {
            case "weapons":
            {
                foreach (var w in SortedGuns())
                {
                    var def = w.Def;
                    s.Side.Add(new HudSide(w.Name, SkinName(def, _loadout.WeaponPaint(def, team)?.PaintKit ?? 0), def == s.Selected, pl =>
                    {
                        EquipForHud(pl, w);
                        s.Selected = def;
                        BuildHud(pl, s);
                        ShowCurrentTilePage(s);
                    }, $"b{def}"));
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
                    }, $"b{k.Def}"));
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
                        HudStatus(pl, s, $"{a.Name.Split(" | ")[0]} applied");
                    }));
                break;
            }
        }
        s.SidePage = Math.Clamp(s.SidePage, 0, Math.Max(0, (s.Side.Count - 1) / SideRows));
        s.GridPage = Math.Clamp(s.GridPage, 0, Math.Max(0, (s.Tiles.Count - 1) / GridTiles));
    }

    /// <summary>The finish the wear/StatTrak buttons act on in this tab, or null when there is none.</summary>
    private (float Wear, bool StatTrak, bool CanStatTrak)? HudCurrentFinish(CCSPlayerController player, HudSession s)
    {
        var team = player.TeamNum;
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
        var team = player.TeamNum;
        HudText(player, "pk_title", $"Loadout · {(team == 2 ? "T" : "CT")}");
        foreach (var t in HudTabs) HudFlag(player, $"pk_tab_{t}", "picked", s.Tab == t);

        // left list
        HudFlag(player, "pk_side", "gone", s.Tab == "agents");
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
            "weapons" => _catalog.WeaponName(s.Selected),
            "knives" => s.Selected > 0 ? _catalog.WeaponName(s.Selected) : "Knife",
            "gloves" => s.Selected > 0 ? _catalog.WeaponName(s.Selected) : "Gloves",
            _ => $"Agents ({(team == 2 ? "T" : "CT")})"
        });
        var empty = s.Tiles.Count > 0 ? "" : s.Tab switch
        {
            "knives" => "Default knife in use. Pick a knife on the left.",
            "gloves" => "Default gloves in use. Pick a glove type on the left.",
            _ => "Nothing here. Open the Loadout tab in the CS2Prac app once, then restart the server."
        };
        HudText(player, "pk_empty", empty);
        HudFlag(player, "pk_empty", "gone", empty.Length == 0);

        // grid
        var gridStart = s.GridPage * GridTiles;
        var onPage = Math.Clamp(s.Tiles.Count - gridStart, 0, GridTiles);
        for (var r = 0; r < GridTiles / GridCols; r++) HudFlag(player, $"pk_grow_{r}", "gone", r * GridCols >= onPage);
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
        // the grid scrolls; the pager only appears when a list ever outgrows the 64 tiles
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
        if (id.StartsWith("pk_tab_"))
        {
            var tab = id["pk_tab_".Length..];
            if (HudTabs.Contains(tab) && tab != s.Tab) SelectTab(player, s, tab);
            return;
        }
        switch (id)
        {
            case "pk_prev": s.GridPage = Math.Max(0, s.GridPage - 1); return;
            case "pk_next": s.GridPage++; return;
            case "pk_st": ToggleHudStatTrak(player, s); return;
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
        // Run as the player on the server (works for bots too). Two engine rules shape the order: one gun per slot
        // (giving a second rifle drops it on the floor), and "use" only switches while something is in hand.
        // So: knife out, old gun of that slot removed, new gun given, switch to it.
        void Use(string name)
        {
            if (!player.IsBot) player.ExecuteClientCommand($"use {name}"); // as RefreshPlayer does for players
            player.ExecuteClientCommandFromServer($"use {name}");
        }
        if (owned != null)
        {
            Use(useName!);
            return;
        }
        gear_slot_t? slot = weapon.Cls == "weapon_taser" ? null
            : Pistols.Contains(weapon.Cls) ? gear_slot_t.GEAR_SLOT_PISTOL : gear_slot_t.GEAR_SLOT_RIFLE;
        var replaced = slot == null ? [] : services.MyWeapons.Select(h => h.Value)
            .Where(w => w is { IsValid: true } && GearSlot(w) == slot).ToList();

        void Swap()
        {
            if (!player.IsValid || !player.PawnIsAlive) return;
            foreach (var w in replaced)
                if (w is { IsValid: true }) w.Remove();
            var given = player.GiveNamedItem<CBasePlayerWeapon>(weapon.Cls);
            if (given is { IsValid: true }) Use(given.DesignerName);
        }

        // Holding the gun that goes: take the knife out first and swap once that switch has happened.
        if (replaced.Any(w => w!.Index == services.ActiveWeapon.Value?.Index)
            && services.MyWeapons.Select(h => h.Value).FirstOrDefault(w => w is { IsValid: true } && IsKnife(w)) is { } knife)
        {
            Use(knife.DesignerName);
            AddTimer(0.15f, Swap, CounterStrikeSharp.API.Modules.Timers.TimerFlags.STOP_ON_MAPCHANGE);
        }
        else Swap();
    }

    private static bool TryIndex(string id, string prefix, out int index)
    {
        index = -1;
        return id.StartsWith(prefix) && int.TryParse(id[prefix.Length..], out index) && index >= 0;
    }

    private void SetHudWear(CCSPlayerController player, HudSession s, (string Name, float Value) wear)
    {
        var team = player.TeamNum;
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
        var team = player.TeamNum;
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
