using System.Text.Json;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;

namespace PracSkins;

/// <summary>One player's weapon showcase: a copy of their held weapon floating and turning in front of them.</summary>
public class Showcase
{
    public CBasePlayerWeapon? Weapon { get; set; }
    /// <summary>Given to the player, dropped 0.1 s later (then it becomes Weapon).</summary>
    public CBasePlayerWeapon? Pending { get; set; }
    public string Give { get; set; } = "";
    public ushort Def { get; set; }
    public bool Knife { get; set; }
    public Vector Eye { get; set; } = new(0, 0, 0);
    public float LookYaw { get; set; }
    public float Dist { get; set; } = 34f;
    public float Spin { get; set; }
    public float Speed { get; set; } = 40f;
    public float Pitch { get; set; }
    public bool Paused { get; set; }
    public string Signature { get; set; } = "";
    public float NextCheck { get; set; }
    public ulong LastButtons { get; set; }
    public MoveType_t PreviousMoveType { get; set; }
    /// <summary>The player's own weapons, stashed so no viewmodel covers the view (as the agent preview does).</summary>
    public AgentView Stash { get; } = new();
}

/// <summary>
/// Phase G: "3D craft in game". Panorama can't show a model, so `!showcase` (css_showcase) spawns a world copy of the
/// held weapon with the player's skin, stickers and charm 34 units in front of their eyes and turns it. The player is
/// frozen and their weapons stashed (no viewmodel in front). Every 0.5 s the loadout is compared and the copy is
/// spawned again when it changed, so K-window sticker / finish edits show on it. Keys: A/D turn it, W/S nearer or
/// farther, E pauses the spin, R tilts it, `!showcase` again (or Tab) ends it.
/// </summary>
public partial class PracSkins
{
    private readonly Dictionary<int, Showcase> _showcases = new();

    private void InitShowcase()
    {
        RegisterListener<Listeners.OnTick>(OnShowcaseTick);
        RegisterListener<Listeners.OnMapStart>(_ => _showcases.Clear());
        RegisterListener<Listeners.OnClientDisconnect>(slot =>
        {
            if (_showcases.Remove(slot, out var sc) && sc.Weapon is { IsValid: true } w) w.Remove();
        });
        RegisterEventHandler<EventPlayerDeath>((e, _) =>
        {
            if (e.Userid is { IsValid: true } p && _showcases.ContainsKey(p.Slot)) StopShowcase(p, restore: false);
            return HookResult.Continue;
        });
    }

    [ConsoleCommand("css_showcase", "Shows your held weapon in front of you, turning (again to stop)")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnShowcaseCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (player is not { IsValid: true }) return;
        if (_showcases.ContainsKey(player.Slot) || info.GetArg(1) == "stop") { StopShowcase(player); return; }
        var msg = StartShowcase(player);
        if (msg.Length > 0) player.PrintToChat($"{ChatTag} {msg}");
    }

    private string StartShowcase(CCSPlayerController player)
    {
        if (player.PlayerPawn.Value is not { IsValid: true, AbsOrigin: not null, WeaponServices: { } ws } pawn) return "Not alive.";
        if (ws.ActiveWeapon.Value is not { IsValid: true } held) return "Hold the weapon you want to see.";
        var knife = IsKnife(held);
        var give = knife ? "weapon_knife" : GiveName(held);
        if (give is "weapon_c4" || give.Contains("grenade") || give is "weapon_flashbang" or "weapon_molotov" or "weapon_decoy" or "weapon_taser")
            return "Hold a gun or the knife.";
        var o = pawn.AbsOrigin;
        var sc = new Showcase
        {
            Give = give,
            Def = held.AttributeManager.Item.ItemDefinitionIndex,
            Knife = knife,
            Eye = new Vector(o.X, o.Y, o.Z + 62),
            LookYaw = pawn.EyeAngles.Y,
            PreviousMoveType = pawn.MoveType,
            LastButtons = (ulong)player.Buttons,
        };
        _showcases[player.Slot] = sc;
        StashWeapons(player, pawn, sc.Stash);
        SetMoveType(pawn, MoveType_t.MOVETYPE_NONE);
        sc.Signature = ShowcaseSignature(player, sc);
        SpawnShowcaseWeapon(player, sc);
        player.PrintToChat($"{ChatTag} Showcase: A/D turn, W/S nearer/farther, E pause, R tilt. K edits stickers live. !showcase again ends it.");
        return "";
    }

    private void StopShowcase(CCSPlayerController player, bool restore = true)
    {
        if (!_showcases.Remove(player.Slot, out var sc)) return;
        if (sc.Weapon is { IsValid: true } w) w.Remove();
        if (sc.Pending is { IsValid: true } pw) pw.Remove();
        if (!player.IsValid || player.PlayerPawn.Value is not { IsValid: true } pawn) return;
        if (pawn.MoveType == MoveType_t.MOVETYPE_NONE && !HudOpenFor(player))
            SetMoveType(pawn, sc.PreviousMoveType == MoveType_t.MOVETYPE_NONE ? MoveType_t.MOVETYPE_WALK : sc.PreviousMoveType);
        if (restore) RestoreWeapons(player, sc.Stash);
    }

    /// <summary>Weapons given during the showcase (a K pick re-gives one): added to the stash and removed again.</summary>
    private void StashMore(CCSPlayerController player, CCSPlayerPawn pawn, AgentView v, List<CBasePlayerWeapon> weapons)
    {
        if (v.Stash == null) { StashWeapons(player, pawn, v); return; }
        foreach (var w in weapons)
        {
            var give = IsKnife(w) ? (player.TeamNum == 2 ? "weapon_knife_t" : "weapon_knife") : GiveName(w);
            if (v.Stash.All(x => x.Give != give)) v.Stash.Add((give, w.Clip1, w.ReserveAmmo[0]));
        }
        if (pawn.WeaponServices is { } ws) ws.ActiveWeapon.Raw = uint.MaxValue;
        foreach (var w in weapons) w.AddEntityIOEvent("Kill", w, null, "", 0.01f);
    }

    private bool HudOpenFor(CCSPlayerController player) => _hudSessions.ContainsKey(player.Slot);

    /// <summary>What the copy depends on: the paint (finish, wear, seed, stickers, charm, name tag) for its team.</summary>
    private string ShowcaseSignature(CCSPlayerController player, Showcase sc)
    {
        try
        {
            var skins = SkinsOf(player);
            object? paint = sc.Knife ? skins.Knife.For(SkinTeam(player)) : skins.WeaponPaint(sc.Def, SkinTeam(player));
            return paint == null ? "none" : JsonSerializer.Serialize(paint);
        }
        catch
        {
            return "";
        }
    }

    /// <summary>
    /// The copy is given to the (stashed, empty-handed) player, so the GiveNamedItem hook skins it as theirs, and then
    /// dropped. A weapon made with CreateEntityByName + DispatchSpawn crashed the server (0xC0000005 in DispatchSpawn,
    /// live test on 27115 2026-11-18).
    /// </summary>
    private void SpawnShowcaseWeapon(CCSPlayerController player, Showcase sc)
    {
        if (sc.Weapon is { IsValid: true } old) old.Remove();
        sc.Weapon = null;
        if (sc.Pending != null) return;
        if (player.PlayerPawn.Value is not { IsValid: true, WeaponServices: { } ws } pawn) return;
        try
        {
            var give = sc.Knife ? (player.TeamNum == 2 ? "weapon_knife_t" : "weapon_knife") : sc.Give;
            var w = player.GiveNamedItem<CBasePlayerWeapon>(give);
            if (w is not { IsValid: true }) { player.PrintToChat($"{ChatTag} Could not give {give}."); return; }
            sc.Pending = w;
            var slot = player.Slot;
            AddTimer(0.1f, () =>
            {
                if (!_showcases.TryGetValue(slot, out var s) || s != sc) { if (w.IsValid) w.Remove(); return; }
                sc.Pending = null;
                if (!w.IsValid || Utilities.GetPlayerFromSlot(slot) is not { IsValid: true } p ||
                    p.PlayerPawn.Value is not { IsValid: true, WeaponServices: { } pws }) return;
                pws.ActiveWeapon.Raw = w.EntityHandle.Raw;
                try { p.DropActiveWeapon(); } catch (Exception e) { Logger.LogWarning("Showcase drop: {Error}", e); }
                pws.ActiveWeapon.Raw = uint.MaxValue;
                Utilities.SetStateChanged(p.PlayerPawn.Value!, "CBasePlayerPawn", "m_pWeaponServices");
                if (Carried(p.PlayerPawn.Value!).Any(x => x.Index == w.Index))
                {
                    // the game kept it (knives can't always be dropped)
                    w.Remove();
                    p.PrintToChat($"{ChatTag} This weapon can't be shown (it can't be dropped).");
                    StopShowcase(p);
                    return;
                }
                sc.Weapon = w;
                PlaceShowcase(sc);
            });
        }
        catch (Exception e)
        {
            Logger.LogWarning("Showcase: {Error}", e);
        }
    }

    private static void PlaceShowcase(Showcase sc)
    {
        if (sc.Weapon is not { IsValid: true } w) return;
        var yaw = sc.LookYaw * MathF.PI / 180f;
        var at = new Vector(sc.Eye.X + MathF.Cos(yaw) * sc.Dist, sc.Eye.Y + MathF.Sin(yaw) * sc.Dist, sc.Eye.Z - 4);
        // side view first: the barrel across the view
        w.Teleport(at, new QAngle(sc.Pitch, sc.LookYaw + 90 + sc.Spin, 0), new Vector(0, 0, 0));
    }

    private void OnShowcaseTick()
    {
        if (_showcases.Count == 0) return;
        var now = Server.CurrentTime;
        var dt = Server.TickInterval;
        foreach (var (slot, sc) in _showcases.ToList())
        {
            if (Utilities.GetPlayerFromSlot(slot) is not { IsValid: true, PawnIsAlive: true } player || player.PlayerPawn.Value is not { IsValid: true } pawn)
            {
                if (sc.Weapon is { IsValid: true } w) w.Remove();
                _showcases.Remove(slot);
                continue;
            }
            var buttons = (ulong)player.Buttons;
            var pressed = buttons & ~sc.LastButtons;
            sc.LastButtons = buttons;
            // keys only while no window has the input (the K window freezes and reads them itself)
            if (!HudOpenFor(player))
            {
                if (pawn.MoveType != MoveType_t.MOVETYPE_NONE) SetMoveType(pawn, MoveType_t.MOVETYPE_NONE);
                if ((buttons & (ulong)PlayerButtons.Moveleft) != 0) sc.Spin += 120 * dt;
                if ((buttons & (ulong)PlayerButtons.Moveright) != 0) sc.Spin -= 120 * dt;
                if ((buttons & (ulong)PlayerButtons.Forward) != 0) sc.Dist = Math.Max(18, sc.Dist - 30 * dt);
                if ((buttons & (ulong)PlayerButtons.Back) != 0) sc.Dist = Math.Min(90, sc.Dist + 30 * dt);
                if ((pressed & (ulong)PlayerButtons.Use) != 0) sc.Paused = !sc.Paused;
                if ((pressed & (ulong)PlayerButtons.Reload) != 0) sc.Pitch = sc.Pitch switch { 0 => -30, -30 => 30, _ => 0 };
                if ((pressed & (ulong)PlayerButtons.Scoreboard) != 0) { StopShowcase(player); continue; }
            }
            if (!sc.Paused) sc.Spin += sc.Speed * dt;
            if (sc.Spin > 360) sc.Spin -= 360;
            if (sc.Spin < 0) sc.Spin += 360;
            if (sc.Pending != null) continue;
            var carried = Carried(pawn);
            if (sc.Weapon is not { IsValid: true } || carried.Any(x => x.Index == sc.Weapon.Index))
            {
                if (sc.Weapon is { IsValid: true } took) took.Remove();
                // picked up or removed (a respawn, a round restart): spawn it again
                sc.Weapon = null;
                SpawnShowcaseWeapon(player, sc);
                continue;
            }
            PlaceShowcase(sc);
            if (now < sc.NextCheck) continue;
            sc.NextCheck = now + 0.5f;
            var sig = ShowcaseSignature(player, sc);
            if (sig != sc.Signature)
            {
                sc.Signature = sig;
                // a fresh entity: the client builds stickers when it first draws the weapon
                SpawnShowcaseWeapon(player, sc);
            }
            // a K-window pick of another weapon stays on that weapon; a stashed player has none in hand
            if (!HudOpenFor(player) && carried.Count > 0) StashMore(player, pawn, sc.Stash, carried);
        }
    }

    [ConsoleCommand("css_prac_showcase", "Server test: css_prac_showcase (first human, else first bot): lists the showcases")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnPracShowcaseCommand(CCSPlayerController? _, CommandInfo info)
    {
        if (info.ArgCount > 1 && info.GetArg(1) == "start")
        {
            var players = Utilities.GetPlayers().Where(p => p is { IsValid: true, PawnIsAlive: true } && !IsStandIn(p)).ToList();
            var who = players.FirstOrDefault(p => !IsBotAny(p)) ?? players.FirstOrDefault();
            if (who == null) { info.ReplyToCommand("nobody alive"); return; }
            info.ReplyToCommand($"{who.PlayerName}: {(StartShowcase(who) is { Length: > 0 } m ? m : "started")}");
        }
        foreach (var (slot, sc) in _showcases)
        {
            var w = sc.Weapon;
            var item = w is { IsValid: true } ? w.AttributeManager.Item : null;
            var at = w is { IsValid: true } ? w.AbsOrigin : null;
            info.ReplyToCommand($"slot {slot} {sc.Give} def {item?.ItemDefinitionIndex} paint {w?.FallbackPaintKit} attrs {item?.NetworkedDynamicAttributes.Attributes.Count} at {at?.X:0} {at?.Y:0} {at?.Z:0} spin {sc.Spin:0} dist {sc.Dist:0}");
        }
        if (_showcases.Count == 0) info.ReplyToCommand("no showcase");
    }
}
