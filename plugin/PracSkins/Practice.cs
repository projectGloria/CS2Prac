using System.Drawing;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;
using Vector = CounterStrikeSharp.API.Modules.Utils.Vector;

namespace PracSkins;

/// <summary>A competitive spawn point, numbered like MatchZy's .spawn n. Ground is the floor height under it (spawn
/// entities often sit a little above the floor, which made the squares float).</summary>
public record SpawnSpot(CsTeam Team, int Number, Vector Origin, QAngle Angles, float Ground);

/// <summary>
/// Practice extras: spawn markers (a square on the ground and a number per competitive spawn; look at one and press E
/// to stand exactly on it) and bot glow (bots outlined through walls). Toggled with .spawns / .glow in chat
/// (or css_spawns / css_glow); prac_override.cfg turns the markers on whenever MatchZy practice mode starts.
/// </summary>
public partial class PracSkins
{
    private const float MarkerHalf = 16f; // player hull is 32 units wide
    private static readonly Color CtColor = Color.FromArgb(255, 80, 160, 255);
    private static readonly Color TColor = Color.FromArgb(255, 240, 160, 50);

    private bool _spawnsOn;
    private List<SpawnSpot> _spawns = new();
    private readonly List<CEntityInstance> _markerEntities = new();
    private readonly Dictionary<int, ulong> _practiceButtons = new();

    private bool _glowOn;
    private readonly Dictionary<uint, (CBaseModelEntity Relay, CBaseModelEntity Glow)> _glows = new();

    private void InitPractice()
    {
        RegisterListener<Listeners.OnTick>(OnPracticeTick);
        RegisterListener<Listeners.OnMapStart>(_ =>
        {
            _markerEntities.Clear(); // removed with the map
            _glows.Clear();
            _spawns.Clear();
        });
        // A round restart (mp_restartgame, .prac) removes our entities; draw them again.
        RegisterEventHandler<EventRoundStart>((_, _) =>
        {
            AddTimer(0.2f, () =>
            {
                if (_spawnsOn) DrawSpawnMarkers();
                if (_glowOn) GlowAllBots();
            });
            return HookResult.Continue;
        });
        RegisterEventHandler<EventPlayerSpawn>((e, _) =>
        {
            var player = e.Userid;
            if (_glowOn && (player is { IsValid: true } && IsBotAny(player)))
                AddTimer(0.2f, () =>
                {
                    if (player.IsValid) GlowBot(player);
                });
            return HookResult.Continue;
        });
        RegisterEventHandler<EventPlayerDeath>((e, _) =>
        {
            if (e.Userid?.PlayerPawn.Value is { IsValid: true } pawn) RemoveGlow(pawn.Index);
            return HookResult.Continue;
        });

        // ".spawns" and ".glow" in chat, next to MatchZy's dot commands. CSS's own chat triggers are ! and /.
        foreach (var say in new[] { "say", "say_team" })
            AddCommandListener(say, (player, info) =>
            {
                if (player is not { IsValid: true }) return HookResult.Continue;
                var text = info.GetArg(1).Trim().ToLowerInvariant();
                if (text == ".spawns") ToggleSpawns(player);
                else if (text == ".glow") ToggleGlow(player);
                return HookResult.Continue;
            });
    }

    private void UnloadPractice()
    {
        ClearSpawnMarkers();
        foreach (var index in _glows.Keys.ToList()) RemoveGlow(index);
    }

    [ConsoleCommand("css_spawns", "Show or hide the spawn markers (look at one and press E to stand on it)")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnSpawnsCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (player != null) ToggleSpawns(player);
    }

    [ConsoleCommand("css_glow", "Outline bots through walls (toggle)")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnGlowCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (player != null) ToggleGlow(player);
    }

    [ConsoleCommand("css_prac_spawns", "Spawn markers on (1) or off (0); used by prac_override.cfg")]
    [CommandHelper(minArgs: 1, usage: "<0|1>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnPracSpawnsCommand(CCSPlayerController? player, CommandInfo info)
    {
        SetSpawns(info.GetArg(1) != "0");
        Logger.LogInformation("spawn markers {State}: {Spawns} spawns, {Entities} entities, lowered by up to {Lift:F1} units",
            _spawnsOn ? "on" : "off", _spawns.Count, _markerEntities.Count,
            _spawns.Count == 0 ? 0 : _spawns.Max(s => s.Origin.Z - s.Ground));
    }

    [ConsoleCommand("css_prac_glow", "Bot glow on (1) or off (0), from the server console")]
    [CommandHelper(minArgs: 1, usage: "<0|1>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnPracGlowCommand(CCSPlayerController? player, CommandInfo info)
    {
        _glowOn = info.GetArg(1) != "0";
        if (_glowOn) GlowAllBots();
        else foreach (var index in _glows.Keys.ToList()) RemoveGlow(index);
        Logger.LogInformation("bot glow {State}: {Count} bots glowing", _glowOn ? "on" : "off", _glows.Count);
        foreach (var (pawnIndex, g) in _glows)
        {
            var pawn = Utilities.GetEntityFromIndex<CCSPlayerPawn>((int)pawnIndex);
            foreach (var (name, e) in new[] { ("relay", g.Relay), ("glow", g.Glow) })
            {
                if (!e.IsValid) { Logger.LogInformation("  pawn {P} {N}: invalid", pawnIndex, name); continue; }
                var model = e.CBodyComponent?.SceneNode?.GetSkeletonInstance().ModelState.ModelName;
                var parent = e.CBodyComponent?.SceneNode?.PParent?.Owner?.Index;
                Logger.LogInformation(
                    "  pawn {P} at {PO} {N}#{I}: model={M} origin={O} parent={Par} render={R} mode={RM} glowType={GT} glowing={G} color={C} range={GR} team={Team} effects={Fx}",
                    pawnIndex, pawn?.AbsOrigin, name, e.Index, model, e.AbsOrigin, parent, e.Render, e.RenderMode,
                    e.Glow.GlowType, e.Glow.Glowing, e.Glow.GlowColorOverride, e.Glow.GlowRange, e.Glow.GlowTeam, e.Effects);
            }
        }
    }

    private void ToggleSpawns(CCSPlayerController player)
    {
        SetSpawns(!_spawnsOn);
        player.PrintToChat(_spawnsOn
            ? $"{ChatTag} Spawns shown: look at one and press E to stand on it. .spawns hides them."
            : $"{ChatTag} Spawns hidden.");
    }

    private void SetSpawns(bool on)
    {
        _spawnsOn = on;
        if (on) DrawSpawnMarkers();
        else ClearSpawnMarkers();
    }

    private void ToggleGlow(CCSPlayerController player)
    {
        _glowOn = !_glowOn;
        if (_glowOn) GlowAllBots();
        else foreach (var index in _glows.Keys.ToList()) RemoveGlow(index);
        player.PrintToChat($"{ChatTag} Bot glow {(_glowOn ? "on" : "off")}.");
    }

    // ---- spawns ----

    /// <summary>Competitive spawns, collected the way MatchZy does so the numbers match .spawn n.</summary>
    private static List<SpawnSpot> CollectSpawns()
    {
        var ct = Utilities.FindAllEntitiesByDesignerName<SpawnPoint>("info_player_counterterrorist").ToList();
        var t = Utilities.FindAllEntitiesByDesignerName<SpawnPoint>("info_player_terrorist").ToList();
        var minPriority = 1;
        foreach (var s in ct)
            if (s.IsValid && s.Enabled && s.Priority < minPriority) minPriority = s.Priority;

        var spots = new List<SpawnSpot>();
        void Add(List<SpawnPoint> list, CsTeam team)
        {
            var n = 0;
            foreach (var s in list)
            {
                if (!s.IsValid || !s.Enabled || s.Priority != minPriority) continue;
                var node = s.CBodyComponent?.SceneNode;
                if (node == null) continue;
                n++;
                var origin = new Vector(node.AbsOrigin.X, node.AbsOrigin.Y, node.AbsOrigin.Z);
                spots.Add(new SpawnSpot(team, n, origin,
                    new QAngle(node.AbsRotation.X, node.AbsRotation.Y, node.AbsRotation.Z), GroundUnder(origin)));
            }
        }
        Add(ct, CsTeam.CounterTerrorist);
        Add(t, CsTeam.Terrorist);
        return spots;
    }

    /// <summary>Floor height under a point: a world trace from just above it down to 256 units below.</summary>
    private static float GroundUnder(Vector p)
    {
        try
        {
            var options = new TraceOptions { InteractsWith = Masks.PlayerSolidBrushOnly };
            var hit = Trace.TraceEndShape(new Vector(p.X, p.Y, p.Z + 8), new Vector(p.X, p.Y, p.Z - 256), null!, options);
            if (hit.DidHit() && !hit.IsAllSolid) return hit.EndPos.Z;
        }
        catch
        {
            // trace natives can break after a CS2 update; fall back to the spawn's own height
        }
        return p.Z;
    }

    private void DrawSpawnMarkers()
    {
        ClearSpawnMarkers();
        _spawns = CollectSpawns();
        foreach (var spot in _spawns)
        {
            var color = spot.Team == CsTeam.CounterTerrorist ? CtColor : TColor;
            var o = spot.Origin;
            var z = spot.Ground + 1; // just above the floor so it doesn't z-fight
            var corners = new[]
            {
                new Vector(o.X - MarkerHalf, o.Y - MarkerHalf, z), new Vector(o.X + MarkerHalf, o.Y - MarkerHalf, z),
                new Vector(o.X + MarkerHalf, o.Y + MarkerHalf, z), new Vector(o.X - MarkerHalf, o.Y + MarkerHalf, z)
            };
            for (var i = 0; i < 4; i++) AddBeam(corners[i], corners[(i + 1) % 4], color);
            // a short arrow showing which way the spawn faces
            var yaw = spot.Angles.Y * MathF.PI / 180f;
            AddBeam(new Vector(o.X, o.Y, z), new Vector(o.X + MathF.Cos(yaw) * MarkerHalf, o.Y + MathF.Sin(yaw) * MarkerHalf, z), color);
            AddLabel(spot, color);
        }
    }

    private void AddBeam(Vector start, Vector end, Color color, List<CEntityInstance>? into = null)
    {
        var beam = Utilities.CreateEntityByName<CBeam>("beam");
        if (beam == null) return;
        beam.Render = color;
        beam.Width = 1.5f;
        beam.Teleport(start, new QAngle(0, 0, 0), new Vector(0, 0, 0));
        beam.EndPos.X = end.X;
        beam.EndPos.Y = end.Y;
        beam.EndPos.Z = end.Z;
        beam.DispatchSpawn();
        (into ?? _markerEntities).Add(beam);
    }

    private void AddLabel(SpawnSpot spot, Color color)
    {
        var text = Utilities.CreateEntityByName<CPointWorldText>("point_worldtext");
        if (text == null) return;
        text.MessageText = spot.Number.ToString();
        text.Enabled = true;
        text.Fullbright = true;
        text.FontSize = 60;
        text.WorldUnitsPerPx = 0.25f;
        text.Color = color;
        text.JustifyHorizontal = PointWorldTextJustifyHorizontal_t.POINT_WORLD_TEXT_JUSTIFY_HORIZONTAL_CENTER;
        text.JustifyVertical = PointWorldTextJustifyVertical_t.POINT_WORLD_TEXT_JUSTIFY_VERTICAL_CENTER;
        text.ReorientMode = PointWorldTextReorientMode_t.POINT_WORLD_TEXT_REORIENT_AROUND_UP; // turns to face you
        text.DispatchSpawn();
        text.Teleport(new Vector(spot.Origin.X, spot.Origin.Y, spot.Ground + 40), new QAngle(0, 0, 90), new Vector(0, 0, 0));
        _markerEntities.Add(text);
    }

    private void ClearSpawnMarkers()
    {
        foreach (var e in _markerEntities)
            if (e.IsValid) e.Remove();
        _markerEntities.Clear();
    }

    private void OnPracticeTick()
    {
        if (!_spawnsOn || _spawns.Count == 0) return;
        foreach (var player in Utilities.GetPlayers())
        {
            if ((player is not { IsValid: true } || IsBotAny(player))) continue;
            var buttons = (ulong)player.Buttons;
            var last = _practiceButtons.GetValueOrDefault(player.Slot);
            _practiceButtons[player.Slot] = buttons;
            if ((buttons & ~last & BtnUse) == 0 || MenuOpen(player)) continue;
            if (AimedSpawn(player) is { } spot) TeleportToSpawn(player, spot);
        }
    }

    /// <summary>The spawn marker closest to the crosshair, if the player is looking at one.</summary>
    private SpawnSpot? AimedSpawn(CCSPlayerController player)
    {
        var pawn = player.PlayerPawn.Value;
        if (pawn is not { IsValid: true, LifeState: (byte)LifeState_t.LIFE_ALIVE } || pawn.AbsOrigin == null) return null;
        var eye = new Vector(pawn.AbsOrigin.X, pawn.AbsOrigin.Y, pawn.AbsOrigin.Z + pawn.ViewOffset.Z);
        var pitch = pawn.EyeAngles.X * MathF.PI / 180f;
        var yaw = pawn.EyeAngles.Y * MathF.PI / 180f;
        var fx = MathF.Cos(pitch) * MathF.Cos(yaw);
        var fy = MathF.Cos(pitch) * MathF.Sin(yaw);
        var fz = -MathF.Sin(pitch);

        SpawnSpot? best = null;
        var bestAngle = float.MaxValue;
        foreach (var spot in _spawns)
        {
            var dx = spot.Origin.X - eye.X;
            var dy = spot.Origin.Y - eye.Y;
            var dz = spot.Ground + 1 - eye.Z;
            var dist = MathF.Sqrt(dx * dx + dy * dy + dz * dz);
            if (dist < 1 || dist > 3000) continue;
            var cos = Math.Clamp((dx * fx + dy * fy + dz * fz) / dist, -1f, 1f);
            var angle = MathF.Acos(cos);
            // the square covers more of the view when it is close
            var allowed = MathF.Max(MathF.Atan(MarkerHalf * 1.5f / dist), 3f * MathF.PI / 180f);
            if (angle <= allowed && angle < bestAngle)
            {
                best = spot;
                bestAngle = angle;
            }
        }
        return best;
    }

    private void TeleportToSpawn(CCSPlayerController player, SpawnSpot spot)
    {
        var pawn = player.PlayerPawn.Value;
        if (pawn is not { IsValid: true }) return;
        pawn.Teleport(spot.Origin, spot.Angles, new Vector(0, 0, 0));
        _practiceSpawn[player.Slot] = (Copy(spot.Origin), Copy(spot.Angles)); // .bs / E bring you back here
        var team = spot.Team == CsTeam.CounterTerrorist ? "CT" : "T";
        player.PrintToCenter($"{team} spawn {spot.Number}");
    }

    // ---- bot glow ----

    private void GlowAllBots()
    {
        foreach (var player in Utilities.GetPlayers())
            if ((player is { IsValid: true, PawnIsAlive: true } && IsBotAny(player))) GlowBot(player);
    }

    /// <summary>
    /// SetModel on an entity that hasn't spawned yet trips an engine assert (EF_IN_STAGING_LIST) whose minidump write
    /// stalls the server ~1 s and drops the client (NETWORK_DISCONNECT_OVERFLOW). Clearing that identity flag first
    /// (bit 2, as exkludera's glowing-entities plugin does) makes it safe.
    /// </summary>
    private static void SetModelBeforeSpawn(CBaseModelEntity e, string model)
    {
        if (e.Entity is { } identity) identity.Flags &= ~(1u << 2);
        e.SetModel(model);
    }

    private static void ApplyGlow(CBaseModelEntity e, Color color)
    {
        e.Glow.GlowColorOverride = color;
        e.Glow.GlowRange = 5000;
        e.Glow.GlowRangeMin = 0;
        e.Glow.GlowTeam = -1;
        e.Glow.GlowType = 3;
    }

    /// <summary>
    /// Outlines a bot through walls: a relay prop bone-merges onto the pawn and a transparent copy of the bot's model
    /// bone-merges onto the relay and carries the glow (pawns can't glow themselves). Confirmed in game. Earlier
    /// attempts that passed the model as a spawn keyvalue had correct server state but the client drew nothing.
    /// </summary>
    private void GlowBot(CCSPlayerController bot)
    {
        var pawn = bot.PlayerPawn.Value;
        if (pawn is not { IsValid: true, LifeState: (byte)LifeState_t.LIFE_ALIVE }) return;
        RemoveGlow(pawn.Index);
        if (IsStandIn(bot)) return; // the third-person preview's stand-in (AgentView.cs) never glows
        var color = bot.Team == CsTeam.CounterTerrorist ? CtColor : Color.FromArgb(255, 255, 60, 60);
        var model = pawn.CBodyComponent?.SceneNode?.GetSkeletonInstance().ModelState.ModelName;
        if (string.IsNullOrEmpty(model)) return;

        var glow = Utilities.CreateEntityByName<CDynamicProp>("prop_dynamic");
        if (glow == null) return;
        glow.Spawnflags = 256u;
        glow.Render = Color.Transparent;
        SetModelBeforeSpawn(glow, model);
        glow.DispatchSpawn();
        ApplyGlow(glow, color);

        var relay = Utilities.CreateEntityByName<CDynamicProp>("prop_dynamic");
        if (relay == null) { glow.Remove(); return; }
        relay.Spawnflags = 256u;
        relay.RenderMode = RenderMode_t.kRenderNone;
        SetModelBeforeSpawn(relay, model);
        relay.DispatchSpawn();
        relay.Teleport(pawn.AbsOrigin, pawn.AbsRotation, new Vector(0, 0, 0));
        glow.Teleport(pawn.AbsOrigin, pawn.AbsRotation, new Vector(0, 0, 0));
        relay.AcceptInput("FollowEntity", pawn, relay, "!activator");
        glow.AcceptInput("FollowEntity", relay, glow, "!activator");
        _glows[pawn.Index] = (relay, glow);
    }

    private void RemoveGlow(uint pawnIndex)
    {
        if (!_glows.Remove(pawnIndex, out var g)) return;
        if (g.Glow.IsValid) g.Glow.Remove();
        if (g.Relay.IsValid) g.Relay.Remove();
    }
}
