using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Extensions;
using CounterStrikeSharp.API.Modules.Utils;

namespace PracSkins;

/// <summary>A held T: the wheel shows once the key is held a moment; a quick tap sprays straight away.</summary>
public class WheelSession
{
    /// <summary>T is still down (a toggle from css_spraywheel without an argument has no release).</summary>
    public bool Held { get; set; }
    public bool Shown { get; set; }
    /// <summary>Cancel / "All graffiti" was clicked: the release sprays nothing.</summary>
    public bool Cancelled { get; set; }
}

/// <summary>
/// The graffiti wheel, like the game's own spray wheel (whose +spray_menu needs graffiti in the Steam inventory and
/// never reaches the server): hold T to see the picked graffiti, the cooldown, the last ones used and the tints; click
/// one to pick it, release T to spray. A tap sprays without the wheel. Part of the skin window's layout
/// (scripts/hud/cs2prac_graffiti.xml/.css, ids gw_*), so it shares its custom_hud_layout and input capture.
/// The client binds T to +cs2prac_spray (Nihil.cfg: css_spraywheel open / close).
/// </summary>
public partial class PracSkins
{
    // Keep in sync with scripts/hud/build-hud.mjs (GW_SLOTS).
    private const int WheelSlots = 8;
    /// <summary>how long T must be held before the wheel shows (shorter = a tap that just sprays)</summary>
    private const float WheelDelay = 0.2f;

    private readonly Dictionary<int, WheelSession> _wheels = new();

    private void InitWheel()
    {
        InitGraffiti();
        RegisterListener<Listeners.OnMapEnd>(() => _wheels.Clear());
        RegisterListener<Listeners.OnClientPutInServer>(slot => _wheels.Remove(slot));
        RegisterListener<Listeners.OnClientDisconnect>(slot => _wheels.Remove(slot));
        RegisterEventHandler<EventPlayerDeath>((e, _) =>
        {
            if (e.Userid is { IsValid: true } p && _wheels.ContainsKey(p.Slot)) CloseWheel(p);
            return HookResult.Continue;
        });
        RegisterListener<Listeners.OnTick>(OnWheelTick);
    }

    [ConsoleCommand("css_spraywheel", "Graffiti wheel: open on key down, close (and spray) on key up; no argument toggles")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnGraffitiCommand(CCSPlayerController? player, CommandInfo command)
    {
        if (player is not { IsValid: true }) return;
        switch (command.GetArg(1).ToLowerInvariant())
        {
            case "open":
            {
                if (_wheels.ContainsKey(player.Slot)) return; // key repeat
                // the K or L window is open: T does nothing there
                if (_hudSessions.ContainsKey(player.Slot) || _setSessions.ContainsKey(player.Slot)) return;
                var w = new WheelSession { Held = true };
                _wheels[player.Slot] = w;
                AddTimer(WheelDelay, () =>
                {
                    if (player.IsValid && _wheels.TryGetValue(player.Slot, out var cur) && cur == w && w.Held && !w.Shown)
                        ShowWheel(player, w);
                });
                return;
            }
            case "close":
            {
                if (!_wheels.TryGetValue(player.Slot, out var w)) return;
                var spray = !w.Cancelled;
                CloseWheel(player);
                if (spray) SprayNow(player);
                return;
            }
            default:
            {
                if (_wheels.ContainsKey(player.Slot)) { CloseWheel(player); return; }
                if (_hudSessions.ContainsKey(player.Slot) || _setSessions.ContainsKey(player.Slot)) return;
                var w = new WheelSession();
                _wheels[player.Slot] = w;
                ShowWheel(player, w);
                return;
            }
        }
    }

    private void ShowWheel(CCSPlayerController player, WheelSession w)
    {
        if (!HudReady || !player.PawnIsAlive) return; // tap behaviour stays: the release still sprays
        LoadCatalogIfChanged();
        w.Shown = true;
        RenderWheel(player);
        HudFlag(player, "gw_win", "shown", true);
        _hud!.SetInputCaptureEnabled(player, true);
    }

    private void CloseWheel(CCSPlayerController player)
    {
        if (!_wheels.Remove(player.Slot, out var w) || !w.Shown || !player.IsValid || !HudReady) return;
        HudFlag(player, "gw_win", "shown", false);
        // the K/L windows capture the cursor themselves; only release it when neither is open
        if (!_hudSessions.ContainsKey(player.Slot) && !_setSessions.ContainsKey(player.Slot))
            _hud!.SetInputCaptureEnabled(player, false);
    }

    /// <summary>Hides the wheel without spraying: a held T's coming release is swallowed (K/L opened, Cancel …).</summary>
    private void DismissWheel(CCSPlayerController player)
    {
        if (!_wheels.TryGetValue(player.Slot, out var w)) return;
        w.Cancelled = true;
        CloseWheel(player);
        if (w.Held) _wheels[player.Slot] = new WheelSession { Held = true, Cancelled = true };
    }

    /// <summary>Sprays the loadout's graffiti with the cooldown, telling the player what happened.</summary>
    private void SprayNow(CCSPlayerController player)
    {
        if (_loadout.Graffiti <= 0 && !(_randomGraffiti && _catalog.Graffiti.Count > 0))
        {
            player.PrintToChat($"{ChatTag} No graffiti picked: hold T and click one, or K > Graffiti.");
            return;
        }
        var now = SprayClock;
        if (_sprayCooldown > 0 && _nextSpray.TryGetValue(player.Slot, out var next) && now < next)
        {
            player.PrintToChat($"{ChatTag} Next graffiti in {next - now:0.0} s.");
            return;
        }
        var (def, tint) = (_loadout.Graffiti, _loadout.GraffitiTint);
        CatalogGraffiti? random = null;
        if (_randomGraffiti && _catalog.Graffiti.Count > 0)
        {
            random = _catalog.Graffiti[Random.Shared.Next(_catalog.Graffiti.Count)];
            (def, tint) = (random.Def, random.Tinted ? Random.Shared.Next(1, 20) : 0);
        }
        var error = Spray(player, def, tint);
        if (error != null) player.PrintToChat($"{ChatTag} {error}.");
        else if (random != null) AnnounceRandomGraffiti(player, random, tint);
        else if (_sprayCooldown > 0) _nextSpray[player.Slot] = now + _sprayCooldown;
        else _nextSpray.Remove(player.Slot);
    }

    /// <summary>Random graffiti: a short banner (name + tint colour) and a chat line.</summary>
    private void AnnounceRandomGraffiti(CCSPlayerController player, CatalogGraffiti g, int tint)
    {
        var color = tint is >= 1 and <= 19 ? TintColors[tint - 1] : "#ffffff";
        var tintText = tint > 0 ? $"<font class='fontSize-m' color='{color}'>● {Html(TintName(tint))}</font>" : "";
        ShowBanner(player, $"<font class='fontSize-s' color='#a0a0a0'>Random graffiti</font><br><font class='fontSize-l' color='#ffffff'>{Html(g.Name)}</font><br>{tintText}", 2.5f);
        player.PrintToChat($"{ChatTag} Random graffiti: {ChatColors.Gold}{g.Name}{ChatColors.Default}{(tint > 0 ? $" ({TintName(tint)})" : "")}");
    }

    private bool _randomGraffiti;

    /// <summary>The 19 graffiti tints as hex (src/shared/skins.ts GRAFFITI_TINTS).</summary>
    private static readonly string[] TintColors =
    [
        "#874444", "#b14d4d", "#b87148", "#8f7d5d", "#ae833d", "#d4c95b", "#789d53", "#417a4a", "#488f80", "#a6c4a5",
        "#6ba5b2", "#4e7fa9", "#4c5b98", "#af92df", "#6e4f9f", "#ba68b2", "#9d567a", "#e4ccd5", "#c1c1c1"
    ];

    /// <summary>The wheel's graffiti: the last ones picked, the current one, then the catalog's first.</summary>
    private List<CatalogGraffiti> WheelGraffiti(CCSPlayerController player)
    {
        var defs = new List<int>(PrefsFor(player).Graffiti);
        if (_loadout.Graffiti > 0) defs.Add(_loadout.Graffiti);
        var list = defs.Distinct().Select(d => _catalog.Graffiti.FirstOrDefault(g => g.Def == d))
            .OfType<CatalogGraffiti>().ToList();
        foreach (var g in _catalog.Graffiti)
        {
            if (list.Count >= WheelSlots) break;
            if (!list.Contains(g)) list.Add(g);
        }
        return list.Take(WheelSlots).ToList();
    }

    /// <summary>
    /// Remembers a picked graffiti for the wheel (per SteamID in hud_prefs.json). One already on the wheel keeps its
    /// place, so slots don't jump around while picking; a new one goes first and pushes the oldest out.
    /// </summary>
    private void RememberGraffiti(CCSPlayerController player, int def)
    {
        if (def <= 0 || IsBotAny(player)) return;
        var recent = PrefsFor(player).Graffiti;
        if (recent.Contains(def)) return;
        recent.Insert(0, def);
        if (recent.Count > WheelSlots) recent.RemoveRange(WheelSlots, recent.Count - WheelSlots);
        SavePrefs();
    }

    private static string Wash(CatalogGraffiti? g, int tint) => g is { Tinted: true } && tint > 0 ? $"gw-wash-{tint}" : "";

    private void RenderWheel(CCSPlayerController player)
    {
        var list = WheelGraffiti(player);
        var tint = _loadout.GraffitiTint;
        for (var i = 0; i < WheelSlots; i++)
        {
            var panel = $"gw_slot_{i}";
            var g = i < list.Count ? list[i] : null;
            HudFlag(player, panel, "gone", g == null);
            HudFlag(player, panel, "picked", g != null && g.Def == _loadout.Graffiti);
            HudVariant(player, panel + "_img", "img", g == null ? "" : $"g{g.Def}");
            HudVariant(player, panel + "_img", "wash", g != null && g.Def == _loadout.Graffiti ? Wash(g, tint) : "");
        }
        var cur = _catalog.Graffiti.FirstOrDefault(g => g.Def == _loadout.Graffiti);
        HudVariant(player, "gw_cur_img", "img", cur == null ? "" : $"g{cur.Def}");
        HudVariant(player, "gw_cur_img", "wash", Wash(cur, tint));
        HudText(player, "gw_cur_name", cur == null ? "No graffiti picked"
            : cur.Tinted && tint > 0 ? $"{cur.Name} ({TintName(tint)})" : cur.Name);
        HudFlag(player, "gw_tints", "gone", cur is not { Tinted: true });
        for (var t = 1; t <= GraffitiTints.Length; t++) HudFlag(player, $"gw_tint_{t}", "picked", t == tint);
        RenderWheelCooldown(player);
    }

    private void RenderWheelCooldown(CCSPlayerController player)
    {
        var left = _sprayCooldown > 0 && _nextSpray.TryGetValue(player.Slot, out var next) ? next - SprayClock : 0.0;
        HudText(player, "gw_cd", left > 0 ? $"Next in {left:0.0} s" : "Ready");
        HudFlag(player, "gw_cd", "ready", left <= 0);
        var count = LiveSprays(player.Slot);
        HudText(player, "gw_hint", $"Click to pick, release T to spray  ·  {count}/{SpraysPerPlayer} on the map");
    }

    private void OnWheelTick()
    {
        if (_wheels.Count == 0 || !HudReady) return;
        foreach (var (slot, w) in _wheels.ToList())
            if (w.Shown && Utilities.GetPlayerFromSlot(slot) is { IsValid: true } p) RenderWheelCooldown(p);
    }

    private void OnWheelClicked(CCSPlayerController player, string id)
    {
        if (!_wheels.TryGetValue(player.Slot, out var w) || !w.Shown) return;
        switch (id)
        {
            case "gw_cancel":
                DismissWheel(player);
                return;
            case "gw_more":
                DismissWheel(player);
                if (!CanEdit(player)) return;
                OpenHud(player);
                if (_hudSessions.TryGetValue(player.Slot, out var s))
                {
                    SelectTab(player, s, "graffiti");
                    RenderHud(player, s);
                }
                return;
        }
        if (TryIndex(id, "gw_slot_", out var i))
        {
            var list = WheelGraffiti(player);
            if (i >= list.Count) return;
            var g = list[i];
            var tint = g.Tinted ? (_loadout.GraffitiTint > 0 ? _loadout.GraffitiTint : 1) : 0;
            CommitGraffiti(player, g.Def, tint, $"{g.Name} picked");
        }
        else if (TryIndex(id, "gw_tint_", out var t) && t >= 1 && t <= GraffitiTints.Length &&
                 _catalog.Graffiti.FirstOrDefault(g => g.Def == _loadout.Graffiti) is { Tinted: true } cur)
        {
            CommitGraffiti(player, cur.Def, t, $"{cur.Name} ({TintName(t)})");
        }
        RenderWheel(player);
    }
}
