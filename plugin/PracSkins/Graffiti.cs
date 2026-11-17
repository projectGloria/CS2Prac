using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;
using Vector = CounterStrikeSharp.API.Modules.Utils.Vector;

namespace PracSkins;

/// <summary>
/// Graffiti: `css_spray` (bind a key to it, or !spray) puts the loadout's graffiti where the player looks. The game's
/// own spray asks the Steam GC to sign the decal first; we never do that: the server spawns the
/// <c>player_spray_decal</c> entity itself with the sticker kit id (m_nUniqueID) and tint, like the game's server does
/// after it received a signed request. No GC or account involved.
/// </summary>
public partial class PracSkins
{
    /// <summary>how far a player can spray (the game's limit is about this)</summary>
    private const float SprayRange = 200f;
    /// <summary>seconds between two sprays of one player</summary>
    private const float SprayCooldown = 3f;
    /// <summary>sprays kept per player; the oldest goes when a new one is added</summary>
    private const int SpraysPerPlayer = 5;

    /// <summary>items_game graffiti_tints, ids 1-19 (same list as GRAFFITI_TINTS in src/shared/skins.ts)</summary>
    private static readonly (int Id, string Name)[] GraffitiTints =
    [
        (1, "Brick Red"), (2, "Blood Red"), (3, "Tiger Orange"), (4, "Dust Brown"), (5, "Desert Amber"),
        (6, "Tracer Yellow"), (7, "Battle Green"), (8, "Jungle Green"), (9, "Frog Green"), (10, "Cash Green"),
        (11, "Wire Blue"), (12, "Monarch Blue"), (13, "SWAT Blue"), (14, "Violent Violet"), (15, "Monster Purple"),
        (16, "Bazooka Pink"), (17, "Princess Pink"), (18, "War Pig Pink"), (19, "Shark White")
    ];

    private static string TintName(int id) => GraffitiTints.FirstOrDefault(t => t.Id == id).Name ?? $"Tint {id}";

    private readonly Dictionary<int, float> _nextSpray = new();
    private readonly Dictionary<int, List<CPlayerSprayDecal>> _sprays = new();

    [ConsoleCommand("css_spray", "Spray your graffiti where you look (bind a key: bind t css_spray)")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnSprayCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (player is not { IsValid: true }) return;
        if (_loadout.Graffiti <= 0)
        {
            player.PrintToChat($"{ChatTag} No graffiti picked: choose one in the app or the skin window (K, Graffiti tab).");
            return;
        }
        var now = Server.CurrentTime;
        if (_nextSpray.TryGetValue(player.Slot, out var next) && now < next) return;
        var error = Spray(player, _loadout.Graffiti, _loadout.GraffitiTint);
        if (error != null) player.PrintToChat($"{ChatTag} {error}.");
        else
        {
            _nextSpray[player.Slot] = now + SprayCooldown;
            player.PrintToChat($"{ChatTag} Graffiti sprayed.");
        }
    }

    /// <summary>m_nVersion of the decal (the game's own sprays carry 1; settable with css_prac_sprayversion for tests)</summary>
    private static int SprayVersion = 1;

    [ConsoleCommand("css_prac_sprayversion", "Test: m_nVersion for new sprays")]
    [CommandHelper(minArgs: 1, usage: "<n>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnSprayVersionTest(CCSPlayerController? caller, CommandInfo command)
    {
        if (int.TryParse(command.GetArg(1), out var v)) SprayVersion = v;
        command.ReplyToCommand($"[PracSkins] spray version {SprayVersion}");
    }

    [ConsoleCommand("css_prac_spray", "Test: spray [def] [tint] for the first live bot (or player) where it looks")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnSprayTest(CCSPlayerController? caller, CommandInfo command)
    {
        var p = Utilities.GetPlayers().FirstOrDefault(x => x is { IsValid: true, PawnIsAlive: true });
        if (p == null) { command.ReplyToCommand("[PracSkins] need a live player or bot"); return; }
        int def = command.ArgCount > 1 && int.TryParse(command.GetArg(1), out var d) ? d : Math.Max(_loadout.Graffiti, 1653);
        int tint = command.ArgCount > 2 && int.TryParse(command.GetArg(2), out var t) ? t : _loadout.GraffitiTint;
        // bots look ahead at the horizon: aim them at the floor in front so the trace finds something
        var error = Spray(p, def, tint, testAnyAngle: true);
        command.ReplyToCommand(error != null ? $"[PracSkins] spray failed: {error}" : $"[PracSkins] sprayed {def} tint {tint} for {p.PlayerName}");
        foreach (var e in Utilities.FindAllEntitiesByDesignerName<CPlayerSprayDecal>("player_spray_decal"))
            command.ReplyToCommand($"  #{e.Index} v{e.Version} id {e.UniqueID} tint {e.TintID} player {e.Player} acct {e.AccountID} start {e.Start} end {e.EndPos} " +
                                   $"normal {e.Normal} left {e.Left} origin {e.AbsOrigin} created {e.CreationTime:0.0}");
    }

    /// <summary>Spawns the decal where the player looks. Returns an error text, or null when it worked.</summary>
    private string? Spray(CCSPlayerController player, int def, int tint, bool testAnyAngle = false)
    {
        if (player.PlayerPawn.Value is not { IsValid: true } pawn || !player.PawnIsAlive || pawn.AbsOrigin is not { } o)
            return "You can only spray while alive";
        try
        {
            var a = pawn.EyeAngles;
            float pitch = testAnyAngle && a.X < 20f ? 45f : a.X;
            float yaw = a.Y * MathF.PI / 180f, pr = pitch * MathF.PI / 180f;
            var dir = new Vector(MathF.Cos(pr) * MathF.Cos(yaw), MathF.Cos(pr) * MathF.Sin(yaw), -MathF.Sin(pr));
            var eye = new Vector(o.X, o.Y, o.Z + pawn.ViewOffset.Z);
            var end = new Vector(eye.X + dir.X * SprayRange, eye.Y + dir.Y * SprayRange, eye.Z + dir.Z * SprayRange);
            var options = new TraceOptions { InteractsWith = Masks.PlayerSolidBrushOnly };
            var hit = Trace.TraceEndShape(eye, end, null!, options);
            if (!hit.DidHit() || hit.IsAllSolid) return "Too far away to spray";
            var n = hit.Normal;
            if (n.X * dir.X + n.Y * dir.Y + n.Z * dir.Z > -0.2f) return "The angle is too flat to spray";

            // "left" lies in the surface: on walls the horizontal direction, on floors/ceilings from the player's yaw
            Vector left;
            if (MathF.Abs(n.Z) < 0.7f)
            {
                var len = MathF.Sqrt(n.X * n.X + n.Y * n.Y);
                left = new Vector(-n.Y / len, n.X / len, 0);
            }
            else
            {
                left = new Vector(-MathF.Sin(yaw), MathF.Cos(yaw), 0);
            }

            var decal = Utilities.CreateEntityByName<CPlayerSprayDecal>("player_spray_decal");
            if (decal == null) return "The game refused the graffiti entity";
            decal.UniqueID = def;
            decal.TintID = Math.Max(tint, 0);
            decal.AccountID = (uint)(player.SteamID & 0xFFFFFFFF);
            decal.TraceID = (uint)Random.Shared.Next(1, int.MaxValue);
            decal.RtGcTime = (uint)DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            decal.Player = (int)player.Index;
            decal.Hitbox = 0;
            decal.CreationTime = Server.CurrentTime;
            decal.Version = (byte)SprayVersion;
            // the trace start (the eye): the client re-traces start → end to find the surface to project onto
            decal.Start.X = eye.X; decal.Start.Y = eye.Y; decal.Start.Z = eye.Z;
            decal.EndPos.X = hit.EndPos.X; decal.EndPos.Y = hit.EndPos.Y; decal.EndPos.Z = hit.EndPos.Z;
            decal.Normal.X = n.X; decal.Normal.Y = n.Y; decal.Normal.Z = n.Z;
            decal.Left.X = left.X; decal.Left.Y = left.Y; decal.Left.Z = left.Z;
            decal.DispatchSpawn();
            decal.Teleport(new Vector(hit.EndPos.X, hit.EndPos.Y, hit.EndPos.Z));

            if (!_sprays.TryGetValue(player.Slot, out var list)) _sprays[player.Slot] = list = new();
            list.RemoveAll(e => !e.IsValid);
            list.Add(decal);
            while (list.Count > SpraysPerPlayer)
            {
                if (list[0].IsValid) list[0].Remove();
                list.RemoveAt(0);
            }
            return null;
        }
        catch (Exception e)
        {
            Logger.LogWarning("Spray: {Error}", e.Message);
            return "Graffiti failed (see the server log)";
        }
    }
}
