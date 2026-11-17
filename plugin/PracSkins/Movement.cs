using System.Drawing;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Cvars;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;
using Vector = CounterStrikeSharp.API.Modules.Utils.Vector;

namespace PracSkins;

/// <summary>A recorded jump spot: where the player stands and looks, and the height below which a landing is a miss.</summary>
public class MoveSpot
{
    public string Name { get; set; } = "";
    public float X { get; set; }
    public float Y { get; set; }
    public float Z { get; set; }
    public float Pitch { get; set; }
    public float Yaw { get; set; }
    public float FailZ { get; set; }
    /// <summary>Saved while crouching (e.g. on the Mirage window sill): the start puts the player back crouched, or a
    /// standing hull ends up inside the wall above.</summary>
    public bool Crouch { get; set; }
    /// <summary>Where the jump ends (.movement end): standing on it counts as made. Null until recorded.</summary>
    public float? EndX { get; set; }
    public float? EndY { get; set; }
    public float? EndZ { get; set; }
    /// <summary>The end point's own name (the L window's Rename on the end row); null = "&lt;name&gt; end".</summary>
    public string? EndName { get; set; }

    [JsonIgnore] public bool HasEnd => EndX != null && EndY != null && EndZ != null;
    [JsonIgnore] public string EndLabel => string.IsNullOrWhiteSpace(EndName) ? Name + " end" : EndName;
}

/// <summary>One player's movement practice: current spot and per-spot made/attempt counters.</summary>
public class MoveSession
{
    public int Spot { get; set; }
    public Dictionary<string, (int Made, int Attempts)> Counts { get; } = new();
    /// <summary>A try is running: set at the start, cleared once it is counted.</summary>
    public bool Armed { get; set; }
    public bool LeftGround { get; set; }
    public float IgnoreUntil { get; set; }
    /// <summary>After a made jump: back to the start at this time (0 = nothing pending).</summary>
    public float ReturnAt { get; set; }
    /// <summary>The made/missed banner, re-sent every tick until BannerUntil (a center message alone lasts a moment).</summary>
    public string? Banner { get; set; }
    public float BannerUntil { get; set; }
}

/// <summary>
/// .movement: practice movement spots (e.g. Mirage window to short). The player records spots in game
/// (.movement save name), is teleported to the start, and when they land below the spot's fail height they are put
/// straight back. Landing on the spot's end square (.movement end) counts as made, and 1.5 s later they are back at
/// the start; landings elsewhere above the fail height count as nothing. Spots are saved per map in
/// configs/plugins/PracSkins/movement/&lt;map&gt;.json and drawn as green (start) and gold (end) squares while anyone
/// uses the mode.
/// No fall damage while the mode is on (sv_falldamage_scale 0, restored when the last player leaves it).
/// </summary>
public partial class PracSkins
{
    private const float RearmDistance = 80f; // back within this of the start: the next jump is a new try
    private const float DefaultFailDrop = 64f; // fail height below the start when not set with .movement fail
    private const float EndHalf = 24f; // end square half size (a bit wider than the 32-unit hull, so a foot on it counts)
    private const float EndHeight = 32f; // standing this far above/below the recorded end still counts
    private const float ReturnDelay = 1.5f; // seconds on the end square before going back to the start
    private static readonly Color MoveColor = Color.FromArgb(255, 80, 230, 120);
    private static readonly Color EndColor = Color.FromArgb(255, 255, 200, 60);
    private static readonly string[] MoveWords = { "save", "fail", "end", "delete", "del", "list", "next", "prev", "reset", "off", "on", "help" };

    private readonly Dictionary<int, MoveSession> _move = new();
    private readonly List<CEntityInstance> _moveMarkers = new();
    private List<MoveSpot> _moveSpots = new();
    private string _moveMap = "";
    private float? _savedFallScale;

    private static readonly JsonSerializerOptions MoveJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    private string MoveFile(string map) => Path.Combine(ConfigDir, "movement", map + ".json");

    private void InitMovement()
    {
        RegisterListener<Listeners.OnTick>(OnMovementTick);
        RegisterListener<Listeners.OnMapStart>(_ =>
        {
            _move.Clear(); // spots are per map
            _moveMarkers.Clear(); // removed with the map
            _moveMap = "";
            _savedFallScale = null; // the new map's cfgs set it again
        });
        RegisterEventHandler<EventRoundStart>((_, _) =>
        {
            AddTimer(0.25f, () =>
            {
                if (_move.Count > 0) DrawMoveMarkers();
            });
            return HookResult.Continue;
        });
        RegisterEventHandler<EventPlayerSpawn>((e, _) =>
        {
            var player = e.Userid;
            if (player is { IsValid: true } && _move.ContainsKey(player.Slot))
                AddTimer(0.1f, () =>
                {
                    if (player.IsValid && _move.TryGetValue(player.Slot, out var s)) GoToSpot(player, s);
                });
            return HookResult.Continue;
        });
        RegisterEventHandler<EventPlayerDisconnect>((e, _) =>
        {
            if (e.Userid is { } p && _move.Remove(p.Slot)) MovementUsersChanged();
            return HookResult.Continue;
        });

        foreach (var say in new[] { "say", "say_team" })
            AddCommandListener(say, (player, info) =>
            {
                if (player is not { IsValid: true }) return HookResult.Continue;
                // a pending L window rename (bots only have one in server tests)
                if (TakeRename(player, info.ArgCount > 2 ? info.ArgString : info.GetArg(1))) return HookResult.Handled;
                if (IsBotAny(player)) return HookResult.Continue;
                var words = info.GetArg(1).Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (words.Length == 0) return HookResult.Continue;
                var first = words[0].ToLowerInvariant();
                if (first == ".movement") Server.NextFrame(() => MovementCommand(player, words.Skip(1).ToArray()));
                // short forms, only while the mode is on so they never get in the way otherwise
                else if (first is ".next" or ".prev" or ".reset" && _move.ContainsKey(player.Slot))
                    Server.NextFrame(() => MovementCommand(player, new[] { first[1..] }));
                return HookResult.Continue;
            });
    }

    private void UnloadMovement()
    {
        ClearMoveMarkers();
        _move.Clear();
        MovementUsersChanged();
    }

    [ConsoleCommand("css_movement", "Movement practice: !movement, !movement save <name>, end, fail, delete <name>, list, next, prev, reset")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnMovementCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (player is { IsValid: true }) MovementCommand(player, info.ArgString.Split(' ', StringSplitOptions.RemoveEmptyEntries));
    }

    [ConsoleCommand("css_prac_movement", "Movement spots of the current map (server console)")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnPracMovementCommand(CCSPlayerController? player, CommandInfo info)
    {
        LoadMoveSpots();
        if (info.GetArg(1) == "markers") DrawMoveMarkers();
        info.ReplyToCommand($"{Tag} movement: {_moveSpots.Count} spots on {_moveMap} ({MoveFile(_moveMap)}), " +
                            $"{_move.Count} players in the mode, {_moveMarkers.Count} marker entities");
        foreach (var s in _moveSpots)
            info.ReplyToCommand($"  {s.Name}: {s.X:F1} {s.Y:F1} {s.Z:F1} yaw {s.Yaw:F1}, fail below {s.FailZ:F1}, " +
                                (s.HasEnd ? $"end {s.EndX:F1} {s.EndY:F1} {s.EndZ:F1}" : "no end"));
    }

    private void MovementCommand(CCSPlayerController player, string[] args)
    {
        if (!player.IsValid) return;
        LoadMoveSpots();
        var sub = args.Length > 0 ? args[0].ToLowerInvariant() : "";
        var rest = string.Join(' ', args.Skip(1));
        _move.TryGetValue(player.Slot, out var session);

        switch (sub)
        {
            case "":
                if (session != null) StopMovement(player);
                else StartMovement(player, null);
                break;
            case "on":
                StartMovement(player, null);
                break;
            case "off":
                if (session != null) StopMovement(player);
                break;
            case "save":
                SaveSpot(player, rest);
                break;
            case "fail":
                SetFailHeight(player, session);
                break;
            case "end":
                SetEnd(player, session);
                break;
            case "delete" or "del":
                DeleteSpot(player, rest);
                break;
            case "list":
                player.PrintToChat(_moveSpots.Count == 0
                    ? $"{ChatTag} No movement spots on {_moveMap} yet. Stand at a jump start and type .movement save <name>."
                    : $"{ChatTag} Spots on {_moveMap}: {string.Join(", ", _moveSpots.Select(s => s.Name))}");
                break;
            case "next" or "prev":
                if (session == null || _moveSpots.Count == 0)
                {
                    if (session == null) StartMovement(player, null);
                    break;
                }
                var step = sub == "next" ? 1 : -1;
                session.Spot = ((session.Spot + step) % _moveSpots.Count + _moveSpots.Count) % _moveSpots.Count;
                GoToSpot(player, session, announce: true);
                break;
            case "reset":
                if (session != null) GoToSpot(player, session);
                break;
            case "help":
                player.PrintToChat($"{ChatTag} .movement on/off · .movement <spot> · .next .prev .reset · " +
                                   ".movement save <name> · .movement end · .movement fail · .movement delete <name> · .movement list");
                break;
            default:
                var index = _moveSpots.FindIndex(s => s.Name == SpotName(string.Join(' ', args)));
                if (index < 0)
                {
                    player.PrintToChat($"{ChatTag} No spot called {string.Join(' ', args)}. .movement list shows them.");
                    break;
                }
                StartMovement(player, index);
                break;
        }
    }

    private void StartMovement(CCSPlayerController player, int? spot)
    {
        var fresh = !_move.TryGetValue(player.Slot, out var session);
        session ??= new MoveSession();
        _move[player.Slot] = session;
        if (spot is { } s) session.Spot = s;
        if (fresh)
        {
            MovementUsersChanged();
            DrawMoveMarkers();
        }
        if (_moveSpots.Count == 0)
        {
            player.PrintToChat($"{ChatTag} Movement mode on, but {_moveMap} has no spots yet. Stand where a jump starts, " +
                               "look where you jump, and type .movement save <name>.");
            return;
        }
        if (fresh && spot == null)
            player.PrintToChat($"{ChatTag} Movement mode on: fall and you're put back. .next/.prev switch spots, " +
                               ".reset goes back, .movement turns it off.");
        GoToSpot(player, session, announce: true);
    }

    /// <summary>StartMovement a moment after a window closed: the window's freeze (MOVETYPE_NONE) is lifted in the same
    /// tick, and a teleport in that tick left the player without collision under the map (user report, Mirage).</summary>
    private void StartMovementLater(CCSPlayerController player, int? spot)
    {
        var slot = player.Slot;
        AddTimer(0.1f, () =>
        {
            if (Utilities.GetPlayerFromSlot(slot) is { IsValid: true } p && !WindowOpen(p)) StartMovement(p, spot);
        });
    }

    private void StopMovement(CCSPlayerController player)
    {
        _move.Remove(player.Slot);
        MovementUsersChanged();
        if (_move.Count == 0) ClearMoveMarkers();
        player.PrintToChat($"{ChatTag} Movement mode off.");
    }

    /// <summary>No fall damage while anyone is in the mode; the old value comes back when the last one leaves.</summary>
    private void MovementUsersChanged()
    {
        var cvar = ConVar.Find("sv_falldamage_scale");
        if (cvar == null) return;
        if (_move.Count > 0 && _savedFallScale == null)
        {
            _savedFallScale = cvar.GetPrimitiveValue<float>();
            Server.ExecuteCommand("sv_falldamage_scale 0");
        }
        else if (_move.Count == 0 && _savedFallScale is { } old)
        {
            _savedFallScale = null;
            Server.ExecuteCommand($"sv_falldamage_scale {old.ToString(System.Globalization.CultureInfo.InvariantCulture)}");
        }
    }

    // ---- spots ----

    /// <summary>Spot names are short and simple so they work as chat words: lower case, letters, digits, - and _.</summary>
    private static string SpotName(string raw)
    {
        var name = Regex.Replace(raw.Trim().ToLowerInvariant(), @"\s+", "-");
        name = Regex.Replace(name, @"[^a-z0-9_\-]", "");
        return name.Length > 24 ? name[..24] : name;
    }

    private void LoadMoveSpots()
    {
        var map = Server.MapName;
        if (map == _moveMap) return;
        _moveMap = map;
        _moveSpots = new List<MoveSpot>();
        try
        {
            var file = MoveFile(map);
            if (File.Exists(file))
                _moveSpots = JsonSerializer.Deserialize<List<MoveSpot>>(File.ReadAllText(file), MoveJson) ?? new();
        }
        catch (Exception e)
        {
            Logger.LogError("Could not read movement spots for {Map}: {Message}", map, e.Message);
        }
    }

    private void SaveMoveSpots()
    {
        var file = MoveFile(_moveMap);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var tmp = file + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(_moveSpots, MoveJson));
        File.Move(tmp, file, overwrite: true);
    }

    private static CCSPlayerPawn? AlivePawn(CCSPlayerController player) =>
        player.PlayerPawn.Value is { IsValid: true, LifeState: (byte)LifeState_t.LIFE_ALIVE, AbsOrigin: not null } pawn ? pawn : null;

    private static bool OnGround(CCSPlayerPawn pawn) => (pawn.Flags & (uint)PlayerFlags.FL_ONGROUND) != 0;

    private static bool IsCrouched(CCSPlayerPawn pawn)
    {
        if ((pawn.Flags & (uint)PlayerFlags.FL_DUCKING) != 0) return true;
        return pawn.MovementServices is { } ms && new CCSPlayer_MovementServices(ms.Handle).DuckAmount > 0.5f;
    }

    /// <summary>Whether a standing player hull (32 × 32 × 72) fits at <paramref name="at"/> (feet). True when the trace fails.</summary>
    private static bool StandingRoom(Vector at)
    {
        try
        {
            var options = new TraceOptions { InteractsWith = Masks.PlayerSolidBrushOnly };
            var hit = Trace.TraceHullShape(new Vector(at.X, at.Y, at.Z + 2), new Vector(at.X, at.Y, at.Z + 3),
                new Vector(-16, -16, 0), new Vector(16, 16, 72), null!, options);
            return !hit.DidHit() && !hit.IsAllSolid;
        }
        catch
        {
            return true;
        }
    }

    /// <summary>Puts the pawn fully crouched (as AgentView's crouch pose). The game only stands it up again where
    /// there is room, so under a low ceiling the player stays crouched until they move out.</summary>
    private static void SetCrouch(CCSPlayerPawn pawn, bool crouch)
    {
        if (!crouch || pawn.MovementServices is not { } ms) return;
        var move = new CCSPlayer_MovementServices(ms.Handle);
        move.DuckAmount = 1f;
        move.Ducked = true;
        move.DesiresDuck = true;
        pawn.Flags |= (uint)PlayerFlags.FL_DUCKING;
    }

    private void SaveSpot(CCSPlayerController player, string raw)
    {
        var name = SpotName(raw);
        if (name.Length == 0 || MoveWords.Contains(name))
        {
            player.PrintToChat($"{ChatTag} Give the spot a name: .movement save window-short");
            return;
        }
        var pawn = AlivePawn(player);
        if (pawn == null || !OnGround(pawn))
        {
            player.PrintToChat($"{ChatTag} Stand on the ground where the jump starts, then save.");
            return;
        }
        var o = pawn.AbsOrigin!;
        var spot = new MoveSpot
        {
            Name = name, X = o.X, Y = o.Y, Z = o.Z, Pitch = pawn.EyeAngles.X, Yaw = pawn.EyeAngles.Y, FailZ = o.Z - DefaultFailDrop,
            Crouch = IsCrouched(pawn)
        };
        var index = _moveSpots.FindIndex(s => s.Name == name);
        var replaced = index >= 0;
        if (replaced)
        {
            // a new start keeps the end that was recorded
            var old = _moveSpots[index];
            (spot.EndX, spot.EndY, spot.EndZ, spot.EndName) = (old.EndX, old.EndY, old.EndZ, old.EndName);
            _moveSpots[index] = spot;
        }
        else
        {
            _moveSpots.Add(spot);
            index = _moveSpots.Count - 1;
        }
        SaveMoveSpots();

        var session = _move.GetValueOrDefault(player.Slot);
        if (session == null) StartMovement(player, index);
        else
        {
            session.Spot = index;
            session.Counts.Remove(name);
            session.Armed = true;
            session.LeftGround = false;
            DrawMoveMarkers();
        }
        player.PrintToChat($"{ChatTag} Spot {name} {(replaced ? "updated" : "saved")}. " +
                           (spot.HasEnd ? "" : "Now stand where the jump ends and type .movement end. ") +
                           $"Landing more than {DefaultFailDrop:F0} units lower counts as a fall; to set that exactly, " +
                           "stand on the floor you'd fall onto and type .movement fail.");
    }

    private void SetEnd(CCSPlayerController player, MoveSession? session)
    {
        if (session == null || _moveSpots.Count == 0)
        {
            player.PrintToChat($"{ChatTag} Turn on .movement and pick the spot first.");
            return;
        }
        SetEndAt(player, session.Spot, goBack: true);
    }

    /// <summary>Records where the player stands as the end of spot <paramref name="index"/> (the L window's "End here").</summary>
    private bool SetEndAt(CCSPlayerController player, int index, bool goBack)
    {
        if (index < 0 || index >= _moveSpots.Count) return false;
        var spot = _moveSpots[index];
        var pawn = AlivePawn(player);
        if (pawn == null || !OnGround(pawn))
        {
            player.PrintToChat($"{ChatTag} Stand on the ground where the jump ends, then type .movement end.");
            return false;
        }
        var o = pawn.AbsOrigin!;
        var dx = o.X - spot.X;
        var dy = o.Y - spot.Y;
        if (MathF.Sqrt(dx * dx + dy * dy) <= RearmDistance)
        {
            player.PrintToChat($"{ChatTag} That's too close to the start of {spot.Name}. Stand where the jump lands.");
            return false;
        }
        if (o.Z < spot.FailZ)
        {
            player.PrintToChat($"{ChatTag} That's below the fail height of {spot.Name}. Stand where the jump lands.");
            return false;
        }
        (spot.EndX, spot.EndY, spot.EndZ) = (o.X, o.Y, o.Z);
        SaveMoveSpots();
        foreach (var s in _move.Values) s.Counts.Remove(spot.Name);
        DrawMoveMarkers();
        player.PrintToChat($"{ChatTag} {spot.Name}: end saved. Land on the gold square to make it.");
        if (goBack && _move.TryGetValue(player.Slot, out var session))
        {
            session.Spot = index;
            GoToSpot(player, session);
        }
        return true;
    }

    private static bool OnEnd(MoveSpot spot, Vector o) =>
        spot.HasEnd && MathF.Abs(o.X - spot.EndX!.Value) <= EndHalf && MathF.Abs(o.Y - spot.EndY!.Value) <= EndHalf &&
        MathF.Abs(o.Z - spot.EndZ!.Value) <= EndHeight;

    private void SetFailHeight(CCSPlayerController player, MoveSession? session)
    {
        if (session == null || _moveSpots.Count == 0)
        {
            player.PrintToChat($"{ChatTag} Turn on .movement and pick the spot first.");
            return;
        }
        SetFailAt(player, session.Spot, goBack: true);
    }

    /// <summary>The floor the player stands on becomes the fall height of spot <paramref name="index"/>.</summary>
    private bool SetFailAt(CCSPlayerController player, int index, bool goBack)
    {
        if (index < 0 || index >= _moveSpots.Count) return false;
        var spot = _moveSpots[index];
        var pawn = AlivePawn(player);
        if (pawn == null || !OnGround(pawn))
        {
            player.PrintToChat($"{ChatTag} Stand on the floor you'd fall onto, then type .movement fail.");
            return false;
        }
        var floor = pawn.AbsOrigin!.Z;
        if (floor >= spot.Z - 8)
        {
            player.PrintToChat($"{ChatTag} That floor isn't below the start of {spot.Name}. Stand on the floor you'd fall onto.");
            return false;
        }
        // a little above that floor, so landing anywhere on it counts, but never as high as the start
        spot.FailZ = MathF.Min(floor + 16, spot.Z - 8);
        SaveMoveSpots();
        player.PrintToChat($"{ChatTag} {spot.Name}: landing at this height or lower now counts as a fall.");
        if (goBack && _move.TryGetValue(player.Slot, out var session))
        {
            session.Spot = index;
            GoToSpot(player, session);
        }
        return true;
    }

    /// <summary>The first free "spot-N" name (the L window's "Add start point").</summary>
    private string NextSpotName()
    {
        for (var n = _moveSpots.Count + 1; ; n++)
            if (_moveSpots.All(s => s.Name != $"spot-{n}")) return $"spot-{n}";
    }

    /// <summary>Renames the start point (the spot's name, also used by .movement go/delete). Null = done, else why not.</summary>
    private string? RenameStart(int index, string raw)
    {
        if (index < 0 || index >= _moveSpots.Count) return "That spot is gone.";
        var name = SpotName(raw);
        if (name.Length == 0 || MoveWords.Contains(name)) return "Use letters, digits, - or _ (one word, like window-short).";
        var spot = _moveSpots[index];
        if (name == spot.Name) return null;
        if (_moveSpots.Any(s => s.Name == name)) return $"There already is a spot called {name}.";
        foreach (var s in _move.Values)
            if (s.Counts.Remove(spot.Name, out var c)) s.Counts[name] = c;
        spot.Name = name;
        SaveMoveSpots();
        if (_move.Count > 0) DrawMoveMarkers();
        return null;
    }

    /// <summary>Renames the end point only (shown on its marker and in the L window). Empty = back to "&lt;name&gt; end".</summary>
    private string? RenameEnd(int index, string raw)
    {
        if (index < 0 || index >= _moveSpots.Count) return "That spot is gone.";
        var spot = _moveSpots[index];
        if (!spot.HasEnd) return "That spot has no end point yet.";
        var name = Regex.Replace(raw.Trim(), @"[\p{C}""<>]", "");
        if (name.Length > 32) name = name[..32];
        spot.EndName = name.Length == 0 ? null : name;
        SaveMoveSpots();
        if (_move.Count > 0) DrawMoveMarkers();
        return null;
    }

    /// <summary>Removes only the end point of a spot (the start stays, nothing counts as made until a new end).</summary>
    private void RemoveEnd(int index)
    {
        if (index < 0 || index >= _moveSpots.Count) return;
        var spot = _moveSpots[index];
        (spot.EndX, spot.EndY, spot.EndZ, spot.EndName) = (null, null, null, null);
        SaveMoveSpots();
        foreach (var s in _move.Values) s.Counts.Remove(spot.Name);
        if (_move.Count > 0) DrawMoveMarkers();
    }

    private void DeleteSpot(CCSPlayerController player, string raw)
    {
        var name = SpotName(raw);
        var index = _moveSpots.FindIndex(s => s.Name == name);
        if (index < 0)
        {
            player.PrintToChat($"{ChatTag} No spot called {raw}. .movement list shows them.");
            return;
        }
        _moveSpots.RemoveAt(index);
        SaveMoveSpots();
        foreach (var s in _move.Values)
        {
            s.Counts.Remove(name);
            if (s.Spot >= index && s.Spot > 0) s.Spot--;
        }
        if (_move.Count > 0) DrawMoveMarkers();
        player.PrintToChat($"{ChatTag} Spot {name} deleted.");
    }

    private void GoToSpot(CCSPlayerController player, MoveSession session, bool announce = false)
    {
        if (_moveSpots.Count == 0) return;
        session.Spot = Math.Clamp(session.Spot, 0, _moveSpots.Count - 1);
        var spot = _moveSpots[session.Spot];
        var pawn = AlivePawn(player);
        if (pawn == null) return;
        var at = new Vector(spot.X, spot.Y, spot.Z);
        // only a spot saved crouched starts crouched (a standing hull there sits inside the wall above: "inside
        // something" at Mirage window). Never guess it from a room trace: a faked duck right after a teleport (ground
        // cleared) makes the game un-duck "in the air", which lowers the feet by the crouch height into the floor
        // (user: under the map after Go on a standing spot).
        SetCrouch(pawn, spot.Crouch);
        // walking with collision whatever the player had (a window's freeze, noclip): the teleport needs the floor
        if (pawn.MoveType != MoveType_t.MOVETYPE_WALK && !WindowOpen(player)) SetMoveType(pawn, MoveType_t.MOVETYPE_WALK);
        // a hair above the saved floor height, so the hull never starts touching the ground brush
        pawn.Teleport(new Vector(at.X, at.Y, at.Z + 1), new QAngle(spot.Pitch, spot.Yaw, 0), new Vector(0, 0, 0));
        session.Armed = true;
        session.LeftGround = false;
        session.ReturnAt = 0;
        session.IgnoreUntil = Server.CurrentTime + 0.3f;
        if (announce)
            Logger.LogInformation("movement: {Player} to {Spot} ({X:F0} {Y:F0} {Z:F0}, crouch {Crouch}, standing room {Room})",
                player.PlayerName, spot.Name, at.X, at.Y, at.Z, spot.Crouch, StandingRoom(at));
        if (announce) Banner(player, $"<font color='#50e678'>{spot.Name}</font>", session, spot);
    }

    // ---- the jump check ----

    private void OnMovementTick()
    {
        if (_move.Count == 0 || _moveSpots.Count == 0) return;
        var now = Server.CurrentTime;
        foreach (var (slot, session) in _move)
        {
            if (session.Banner != null)
            {
                var p = Utilities.GetPlayerFromSlot(slot);
                if (now >= session.BannerUntil || p is not { IsValid: true } || MenuOpen(p)) session.Banner = null;
                else p.PrintToCenterHtml(session.Banner, 1);
            }
            if (now < session.IgnoreUntil) continue;
            var player = Utilities.GetPlayerFromSlot(slot);
            if (player is not { IsValid: true } || AlivePawn(player) is not { } pawn) continue;
            var spot = _moveSpots[Math.Clamp(session.Spot, 0, _moveSpots.Count - 1)];
            var o = pawn.AbsOrigin!;

            if (session.ReturnAt > 0)
            {
                // made it: a moment on the end square, then back to the start for the next try
                if (now >= session.ReturnAt) GoToSpot(player, session);
                continue;
            }

            if (!OnGround(pawn))
            {
                // fell out of the world (through a floor): back to the start instead of falling forever
                if (o.Z < spot.FailZ - 1024) { GoToSpot(player, session); continue; }
                session.LeftGround = true;
                continue;
            }

            var dx = o.X - spot.X;
            var dy = o.Y - spot.Y;
            var fromStart = MathF.Sqrt(dx * dx + dy * dy);

            if (o.Z < spot.FailZ)
            {
                // landed below the spot: a miss (counted once per try), and straight back to the start
                if (session.Armed && session.LeftGround)
                {
                    var c = session.Counts.GetValueOrDefault(spot.Name);
                    session.Counts[spot.Name] = (c.Made, c.Attempts + 1);
                    GoToSpot(player, session);
                    Banner(player, "<font color='#ff5050'>Missed</font>", session, spot);
                }
                else GoToSpot(player, session);
                continue;
            }

            if (session.Armed && session.LeftGround && OnEnd(spot, o))
            {
                // only the end square counts as made; ledges and steps on the way count as nothing
                var c = session.Counts.GetValueOrDefault(spot.Name);
                session.Counts[spot.Name] = (c.Made + 1, c.Attempts + 1);
                session.Armed = false;
                session.ReturnAt = now + ReturnDelay;
                Banner(player, "<font color='#50e678'>Made it!</font>", session, spot);
            }
            else if (fromStart <= RearmDistance)
            {
                // back at the start (walked back or hopped in place): the next jump is a new try
                session.Armed = true;
                session.LeftGround = false;
            }
        }
    }

    private void Banner(CCSPlayerController player, string headline, MoveSession session, MoveSpot spot)
    {
        if (MenuOpen(player)) return; // the menu owns the center of the screen
        var (made, attempts) = session.Counts.GetValueOrDefault(spot.Name);
        var rate = attempts == 0 ? "" : $" ({made * 100 / attempts}%)";
        session.Banner = $"<font class='fontSize-l'>{headline}</font><br>{spot.Name} · made {made} / {attempts}{rate}";
        session.BannerUntil = Server.CurrentTime + 2f;
    }

    // ---- markers ----

    private void DrawMoveMarkers()
    {
        ClearMoveMarkers();
        LoadMoveSpots();
        foreach (var spot in _moveSpots)
        {
            var z = spot.Z + 1;
            var corners = new[]
            {
                new Vector(spot.X - MarkerHalf, spot.Y - MarkerHalf, z), new Vector(spot.X + MarkerHalf, spot.Y - MarkerHalf, z),
                new Vector(spot.X + MarkerHalf, spot.Y + MarkerHalf, z), new Vector(spot.X - MarkerHalf, spot.Y + MarkerHalf, z)
            };
            for (var i = 0; i < 4; i++) AddBeam(corners[i], corners[(i + 1) % 4], MoveColor, _moveMarkers);
            var yaw = spot.Yaw * MathF.PI / 180f;
            AddBeam(new Vector(spot.X, spot.Y, z),
                new Vector(spot.X + MathF.Cos(yaw) * MarkerHalf * 1.5f, spot.Y + MathF.Sin(yaw) * MarkerHalf * 1.5f, z), MoveColor, _moveMarkers);

            var text = Utilities.CreateEntityByName<CPointWorldText>("point_worldtext");
            if (text == null) continue;
            text.MessageText = spot.Name;
            text.Enabled = true;
            text.Fullbright = true;
            text.FontSize = 40;
            text.WorldUnitsPerPx = 0.25f;
            text.Color = MoveColor;
            text.JustifyHorizontal = PointWorldTextJustifyHorizontal_t.POINT_WORLD_TEXT_JUSTIFY_HORIZONTAL_CENTER;
            text.JustifyVertical = PointWorldTextJustifyVertical_t.POINT_WORLD_TEXT_JUSTIFY_VERTICAL_CENTER;
            text.ReorientMode = PointWorldTextReorientMode_t.POINT_WORLD_TEXT_REORIENT_AROUND_UP;
            text.DispatchSpawn();
            text.Teleport(new Vector(spot.X, spot.Y, spot.Z + 48), new QAngle(0, 0, 90), new Vector(0, 0, 0));
            _moveMarkers.Add(text);

            if (spot.HasEnd) DrawEndMarker(spot);
        }
    }

    private void DrawEndMarker(MoveSpot spot)
    {
        float x = spot.EndX!.Value, y = spot.EndY!.Value, z = spot.EndZ!.Value + 1;
        var corners = new[]
        {
            new Vector(x - EndHalf, y - EndHalf, z), new Vector(x + EndHalf, y - EndHalf, z),
            new Vector(x + EndHalf, y + EndHalf, z), new Vector(x - EndHalf, y + EndHalf, z)
        };
        for (var i = 0; i < 4; i++) AddBeam(corners[i], corners[(i + 1) % 4], EndColor, _moveMarkers);
        var text = Utilities.CreateEntityByName<CPointWorldText>("point_worldtext");
        if (text == null) return;
        text.MessageText = spot.EndLabel;
        text.Enabled = true;
        text.Fullbright = true;
        text.FontSize = 40;
        text.WorldUnitsPerPx = 0.25f;
        text.Color = EndColor;
        text.JustifyHorizontal = PointWorldTextJustifyHorizontal_t.POINT_WORLD_TEXT_JUSTIFY_HORIZONTAL_CENTER;
        text.JustifyVertical = PointWorldTextJustifyVertical_t.POINT_WORLD_TEXT_JUSTIFY_VERTICAL_CENTER;
        text.ReorientMode = PointWorldTextReorientMode_t.POINT_WORLD_TEXT_REORIENT_AROUND_UP;
        text.DispatchSpawn();
        text.Teleport(new Vector(x, y, z + 47), new QAngle(0, 0, 90), new Vector(0, 0, 0));
        _moveMarkers.Add(text);
    }

    private void ClearMoveMarkers()
    {
        foreach (var e in _moveMarkers)
            if (e.IsValid) e.Remove();
        _moveMarkers.Clear();
    }
}
