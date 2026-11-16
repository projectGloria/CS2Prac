using System.Drawing;
using System.Text.Json;
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
    /// <summary>The made/missed banner, re-sent every tick until BannerUntil (a center message alone lasts a moment).</summary>
    public string? Banner { get; set; }
    public float BannerUntil { get; set; }
}

/// <summary>
/// .movement: practice movement spots (e.g. Mirage window to short). The player records spots in game
/// (.movement save name), is teleported to the start, and when they land below the spot's fail height they are put
/// straight back. A landing away from the start and above the fail height counts as made. Spots are saved per map in
/// configs/plugins/PracSkins/movement/&lt;map&gt;.json and drawn as green squares while anyone uses the mode.
/// No fall damage while the mode is on (sv_falldamage_scale 0, restored when the last player leaves it).
/// </summary>
public partial class PracSkins
{
    private const float MadeDistance = 80f; // a landing at least this far from the start counts as a jump
    private const float DefaultFailDrop = 64f; // fail height below the start when not set with .movement fail
    private static readonly Color MoveColor = Color.FromArgb(255, 80, 230, 120);
    private static readonly string[] MoveWords = { "save", "fail", "delete", "del", "list", "next", "prev", "reset", "off", "on", "help" };

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
                if (player is not { IsValid: true, IsBot: false }) return HookResult.Continue;
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

    [ConsoleCommand("css_movement", "Movement practice: !movement, !movement save <name>, fail, delete <name>, list, next, prev, reset")]
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
            info.ReplyToCommand($"  {s.Name}: {s.X:F1} {s.Y:F1} {s.Z:F1} yaw {s.Yaw:F1}, fail below {s.FailZ:F1}");
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
                                   ".movement save <name> · .movement fail · .movement delete <name> · .movement list");
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
            Name = name, X = o.X, Y = o.Y, Z = o.Z, Pitch = pawn.EyeAngles.X, Yaw = pawn.EyeAngles.Y, FailZ = o.Z - DefaultFailDrop
        };
        var index = _moveSpots.FindIndex(s => s.Name == name);
        var replaced = index >= 0;
        if (replaced) _moveSpots[index] = spot;
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
        player.PrintToChat($"{ChatTag} Spot {name} {(replaced ? "updated" : "saved")}. Landing more than " +
                           $"{DefaultFailDrop:F0} units lower counts as a fall; to set that exactly, stand on the floor you'd " +
                           "fall onto and type .movement fail.");
    }

    private void SetFailHeight(CCSPlayerController player, MoveSession? session)
    {
        if (session == null || _moveSpots.Count == 0)
        {
            player.PrintToChat($"{ChatTag} Turn on .movement and pick the spot first.");
            return;
        }
        var spot = _moveSpots[Math.Clamp(session.Spot, 0, _moveSpots.Count - 1)];
        var pawn = AlivePawn(player);
        if (pawn == null || !OnGround(pawn))
        {
            player.PrintToChat($"{ChatTag} Stand on the floor you'd fall onto, then type .movement fail.");
            return;
        }
        var floor = pawn.AbsOrigin!.Z;
        if (floor >= spot.Z - 8)
        {
            player.PrintToChat($"{ChatTag} That floor isn't below the start of {spot.Name}. Stand on the floor you'd fall onto.");
            return;
        }
        // a little above that floor, so landing anywhere on it counts, but never as high as the start
        spot.FailZ = MathF.Min(floor + 16, spot.Z - 8);
        SaveMoveSpots();
        player.PrintToChat($"{ChatTag} {spot.Name}: landing at this height or lower now counts as a fall.");
        GoToSpot(player, session);
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
        pawn.Teleport(new Vector(spot.X, spot.Y, spot.Z), new QAngle(spot.Pitch, spot.Yaw, 0), new Vector(0, 0, 0));
        session.Armed = true;
        session.LeftGround = false;
        session.IgnoreUntil = Server.CurrentTime + 0.3f;
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

            if (!OnGround(pawn))
            {
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

            if (fromStart <= MadeDistance)
            {
                // back at the start (walked back or hopped in place): the next jump is a new try
                session.Armed = true;
                session.LeftGround = false;
            }
            else if (session.Armed && session.LeftGround)
            {
                var c = session.Counts.GetValueOrDefault(spot.Name);
                session.Counts[spot.Name] = (c.Made + 1, c.Attempts + 1);
                session.Armed = false;
                Banner(player, "<font color='#50e678'>Made it!</font>", session, spot);
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
        }
    }

    private void ClearMoveMarkers()
    {
        foreach (var e in _moveMarkers)
            if (e.IsValid) e.Remove();
        _moveMarkers.Clear();
    }
}
