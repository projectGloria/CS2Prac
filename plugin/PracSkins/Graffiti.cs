using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Admin;
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

    /// <summary>sticker kit def -> its decal textures (graffiti.json, written by the app from `npm run build:hud`)</summary>
    private Dictionary<int, List<string>> _graffitiTextures = new();

    // The decal (materials/decals/sprays/playerspraydecal.vmat) takes the kit's texture at runtime. A client only loads
    // what the server precached, so a texture missing from the manifest drew as the magenta/black checkerboard
    // (user report). Every graffiti is precached (~1300 small textures), so a pick works without a map change.
    private void PrecacheGraffiti(ResourceManifest manifest)
    {
        manifest.AddResource("materials/decals/sprays/playerspraydecal.vmat");
        foreach (var m in DecalTestMaterials) manifest.AddResource(m);
        try
        {
            var path = Path.Combine(ConfigDir, "graffiti.json");
            if (!File.Exists(path))
            {
                Logger.LogWarning("graffiti.json missing: sprayed graffiti may show as a checkerboard");
                return;
            }
            var raw = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, List<string>>>(File.ReadAllText(path)) ?? new();
            _graffitiTextures = raw.Where(kv => int.TryParse(kv.Key, out _)).ToDictionary(kv => int.Parse(kv.Key), kv => kv.Value);
            var n = 0;
            foreach (var tex in _graffitiTextures.Values.SelectMany(t => t)) { manifest.AddResource(tex); n++; }
            Logger.LogInformation("precached {Count} graffiti textures", n);
        }
        catch (Exception e)
        {
            Logger.LogWarning("graffiti.json: {Error}", e.Message);
        }
    }

    private readonly Dictionary<int, float> _nextSpray = new();
    private readonly Dictionary<int, List<CPlayerSprayDecal>> _sprays = new();

    [ConsoleCommand("css_spray", "Spray your graffiti where you look (bind a key: bind t css_spray)")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnSprayCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (player is not { IsValid: true }) return;
        SprayNow(player); // GraffitiWheel.cs; the hold-T wheel (css_graffiti) sprays the same way on release
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

    /// <summary>stock map decal materials for css_decaltest (precached so the client has them on any map)</summary>
    private static readonly string[] DecalTestMaterials =
    [
        "materials/decals/decalgraffiti001b.vmat", "materials/decals/bombsite_letter_a_spray.vmat",
        "materials/decals/sprays/playerspraydecal.vmat"
    ];

    /// <summary>
    /// Test for a graffiti route without the GC: player_spray_decal carries a GC signature (m_ubSignature in the
    /// client) and drew nothing in game. env_decal is a plain networked decal entity with a material. In game:
    /// `css_decaltest [index or material] [size]` puts one where the player looks.
    /// </summary>
    /// <summary>
    /// Test for knife finishes that show as vanilla (Nomad Doppler): `css_knifebody 0|1` sets the held weapon's
    /// body group (0 = CS2 mesh, 1 = body_legacy) so we can see which one the finish needs.
    /// </summary>
    [ConsoleCommand("css_knifebody", "Test: set the held weapon's body group: 0 (new) or 1 (legacy)")]
    [CommandHelper(minArgs: 1, usage: "<0|1>", whoCanExecute: CommandUsage.CLIENT_ONLY)]
    [RequiresPermissions("@css/root")]
    public void OnKnifeBody(CCSPlayerController? player, CommandInfo command)
    {
        var w = player?.PlayerPawn.Value?.WeaponServices?.ActiveWeapon.Value;
        if (player == null || w is not { IsValid: true }) return;
        var body = command.GetArg(1) == "1" ? 1 : 0;
        w.AcceptInput("SetBodygroup", value: $"body,{body}");
        var item = w.AttributeManager.Item;
        player.PrintToChat($"{ChatTag} {w.DesignerName} def {item.ItemDefinitionIndex} paint {w.FallbackPaintKit}: body {body}");
        Logger.LogInformation("knifebody {Name} def {Def} paint {Paint} body {Body}", w.DesignerName,
            item.ItemDefinitionIndex, w.FallbackPaintKit, body);
    }

    [ConsoleCommand("css_decaltest","Test: put an env_decal where you look: [index|material] [size]")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    [RequiresPermissions("@css/root")]
    public void OnDecalTest(CCSPlayerController? player, CommandInfo command)
    {
        if (player?.PlayerPawn.Value is not { IsValid: true } pawn || !player.PawnIsAlive || pawn.AbsOrigin is not { } o) return;
        var arg = command.ArgCount > 1 ? command.GetArg(1) : "0";
        var material = int.TryParse(arg, out var i) && i >= 0 && i < DecalTestMaterials.Length ? DecalTestMaterials[i] : arg;
        var size = command.ArgCount > 2 && float.TryParse(command.GetArg(2), System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out var s) ? s : 64f;
        var a = pawn.EyeAngles;
        float yaw = a.Y * MathF.PI / 180f, pr = a.X * MathF.PI / 180f;
        var dir = new Vector(MathF.Cos(pr) * MathF.Cos(yaw), MathF.Cos(pr) * MathF.Sin(yaw), -MathF.Sin(pr));
        var eye = new Vector(o.X, o.Y, o.Z + pawn.ViewOffset.Z);
        var end = new Vector(eye.X + dir.X * 400, eye.Y + dir.Y * 400, eye.Z + dir.Z * 400);
        var hit = Trace.TraceEndShape(eye, end, null!, new TraceOptions { InteractsWith = Masks.PlayerSolidBrushOnly });
        if (!hit.DidHit()) { player.PrintToChat($"{ChatTag} decaltest: nothing in range"); return; }
        var n = hit.Normal;
        // the decal projects along its forward axis: point it into the surface
        var pitch = MathF.Asin(Math.Clamp(n.Z, -1f, 1f)) * 180f / MathF.PI;
        var yawDeg = MathF.Atan2(-n.Y, -n.X) * 180f / MathF.PI;
        var decal = Utilities.CreateEntityByName<CEnvDecal>("env_decal");
        if (decal == null) { player.PrintToChat($"{ChatTag} decaltest: env_decal refused"); return; }
        var kv = new CEntityKeyValues();
        kv.SetString("decalmaterial", material);
        kv.SetFloat("width", size);
        kv.SetFloat("height", size);
        kv.SetFloat("depth", size); // a cube: draws even if the projection axis is not the one we assume
        kv.SetBool("projectonworld", true);
        kv.SetBool("projectoncharacters", false);
        kv.SetVector("origin", new Vector(hit.EndPos.X, hit.EndPos.Y, hit.EndPos.Z));
        kv.SetVector("angles", new Vector(pitch, yawDeg, 0));
        decal.DispatchSpawn(kv);
        decal.Teleport(new Vector(hit.EndPos.X + n.X, hit.EndPos.Y + n.Y, hit.EndPos.Z + n.Z), new QAngle(pitch, yawDeg, 0));
        player.PrintToChat($"{ChatTag} decaltest #{decal.Index}: {material} {size:0} at {hit.EndPos.X:0} {hit.EndPos.Y:0} {hit.EndPos.Z:0}");
        Logger.LogInformation("decaltest #{Index} {Material} size {Size} width {W} pos {Pos} angles {P} {Y}",
            decal.Index, material, size, decal.Width, hit.EndPos, pitch, yawDeg);
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
                // the viewer's left (they look along -n), as on floors; (-n.Y, n.X) drew walls upside down
                left = new Vector(n.Y / len, -n.X / len, 0);
            }
            else
            {
                left = new Vector(-MathF.Sin(yaw), MathF.Cos(yaw), 0);
            }

            var decal = Utilities.CreateEntityByName<CPlayerSprayDecal>("player_spray_decal");            if (decal == null) return "The game refused the graffiti entity";
            decal.UniqueID = def;
            decal.TintID = Math.Max(tint, 0);
            decal.AccountID = (uint)(player.SteamID & 0xFFFFFFFF);
            decal.TraceID = (uint)Random.Shared.Next(1, int.MaxValue);
            decal.RtGcTime = (uint)DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            // the client loads the spray texture from the sticker kit in m_nPlayer (client.dll: the kit's
            // sticker_material → materials/decals/sprays/%s.vtex); the player's index there drew a checkerboard
            decal.Player = def;
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
            PlaySpraySound(player);

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

    // the game's own spray can sound (server.dll: SprayCan.Paint), from the player so everyone nearby hears it
    private void PlaySpraySound(CCSPlayerController player)
    {
        try
        {
            var pawn = player.PlayerPawn.Value;
            if (pawn is not { IsValid: true }) return;
            var filter = new RecipientFilter();
            filter.AddAllPlayers();
            pawn.EmitSound("SprayCan.Paint", filter, 1f, 1f);
        }
        catch (Exception e)
        {
            Logger.LogWarning("Spray sound: {Error}", e.Message);
        }
    }
}
