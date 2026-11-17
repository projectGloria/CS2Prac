using System.Drawing;
using System.Text.Json;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Cvars;
using CounterStrikeSharp.API.Modules.Extensions;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;

namespace PracSkins;

/// <summary>What a player last chose in the agents tab; kept in hud_prefs.json per SteamID.</summary>
public class HudPrefs
{
    public string View { get; set; } = "first";
    public string Pose { get; set; } = "held";
    public bool Crouch { get; set; }
    public float Dist { get; set; } = AgentViewDefaults.Dist;
    public float Elev { get; set; } = AgentViewDefaults.Elev;
    /// <summary>graffiti picked last (newest first), shown on the hold-T wheel (GraffitiWheel.cs)</summary>
    public List<int> Graffiti { get; set; } = new();
}

public static class AgentViewDefaults
{
    public const float Dist = 95f;
    public const float Elev = 6f;
    public const float MinDist = 40f;
    public const float MaxDist = 260f;
    public const float MinElev = -30f;
    public const float MaxElev = 75f;
}

/// <summary>The third-person preview while the agents tab is open: a camera and a stand-in (a frozen bot, else a prop).</summary>
public class AgentView
{
    public CDynamicProp? Cam { get; set; }
    /// <summary>The stand-in bot: real CS2 animations, holds the pose's weapon with the player's skins.</summary>
    public CCSPlayerController? Bot { get; set; }
    /// <summary>Came through MatchZy's .bot (practice mode tracks and keeps only its own bots).</summary>
    public bool BotViaMatchZy { get; set; }
    public bool OwnBotTried { get; set; }
    /// <summary>Bot requests so far; MatchZy practice kicks bot_add bots at once, so cap the retries.</summary>
    public int Attempts { get; set; }
    /// <summary>While no bot has shown up yet: give up on this attempt at this time (Server.CurrentTime).</summary>
    public float BotSearchUntil { get; set; }
    public HashSet<int> BotsBefore { get; } = new();
    /// <summary>Fallback when no bot can be added: the agent model as a prop (idle only, no weapons).</summary>
    public CDynamicProp? Doll { get; set; }
    public string DollModel { get; set; } = "";
    public Vector Spot { get; set; } = new(0, 0, 0);
    /// <summary>World yaw from the stand-in to the camera (fixed; the camera looks back along it).</summary>
    public float Yaw { get; set; }
    /// <summary>Which way the stand-in faces; turning changes only this, the camera stays.</summary>
    public float DollYaw { get; set; }
    public float SentYaw { get; set; } = float.NaN;
    /// <summary>Camera height angle above the chest (degrees, positive = above, looking down).</summary>
    public float Elev { get; set; }
    public float Dist { get; set; }
    public bool MouseLook { get; set; }
    public string Pose { get; set; } = "held";
    public bool Crouch { get; set; }
    /// <summary>The player's weapons, taken away while the preview runs and given back on exit (give name, clip, reserve).</summary>
    public List<(string Give, int Clip, int Reserve)>? Stash { get; set; }
    /// <summary>DesignerName of the weapon that was in hand (for `use` after the re-give).</summary>
    public string StashActive { get; set; } = "";
    /// <summary>Give name of the weapon the player held when the preview started (pose "Yours").</summary>
    public string HeldGive { get; set; } = "";
    public Color PawnColor { get; set; }
    public RenderMode_t PawnRenderMode { get; set; }
    public QAngle LastCamAngles { get; set; } = new(0, 0, 0);
    /// <summary>Where the player stood (back there on exit); meanwhile the pawn waits behind the camera.</summary>
    public Vector? PawnHome { get; set; }
    public Vector? PawnSentPos { get; set; }
    public bool PawnTookDamage { get; set; }

    public CCSPlayerPawn? BotPawn => Bot is { IsValid: true, PawnIsAlive: true } b && b.PlayerPawn.Value is { IsValid: true } p ? p : null;
    public bool Searching => Bot == null && Doll == null;
}

/// <summary>A pose button: the weapon the stand-in bot holds (give name per team); "held" = the player's own weapon.</summary>
public record PoseDef(string Key, string Label, string GiveT, string GiveCt);

/// <summary>
/// Third-person agent preview (agents tab, "Third person").
/// Round 1 (user test): the client turns its own pawn to the camera's view direction, so through a camera you only see
/// your own back. Round 2/3: a prop stand-in can't hold weapons (the engine deletes prop_dynamic with a weapon model)
/// or change pose (agent models have no sequences; their anim graph's parameters can't be set by a plugin).
/// So the stand-in is a bot: added through MatchZy's .bot (practice mode keeps only its own bots) or bot_add_* on the
/// other team (no name over its head), frozen (MOVETYPE_NONE, bot_stop 1 while any preview runs), no damage, no
/// collision, on the player's spot with the player's agent model, gloves and skins (_standInTeam makes the skin code
/// treat it as the player's team), turned by teleporting its angles. Poses strip it and give one weapon (it holds the
/// only weapon it has). The real pawn and its viewmodel go invisible; an invisible prop is the pawn's ViewEntity,
/// shifted sideways so the agent stands right of the window. No bot within ~3 s: a prop stand-in (idle only).
/// </summary>
public partial class PracSkins
{
    private const float ChestHeight = 38f;
    /// <summary>Sideways camera offset per unit of distance: puts the agent at ~70 % of the screen width.</summary>
    private const float SideShift = 0.58f;
    private const float TickDt = 1f / 64f;
    /// <summary>COLLISION_GROUP_DEBRIS: collides with the world only.</summary>
    private const byte CollisionDebris = 1;

    public static readonly PoseDef[] Poses =
    [
        new("held", "Yours", "", ""),
        new("knife", "Knife", "weapon_knife_t", "weapon_knife"),
        new("pistol", "Pistol", "weapon_glock", "weapon_usp_silencer"),
        new("smg", "SMG", "weapon_mac10", "weapon_mp9"),
        new("rifle", "Rifle", "weapon_ak47", "weapon_m4a1_silencer"),
        new("shotgun", "Shotgun", "weapon_nova", "weapon_nova"),
        new("sniper", "Sniper", "weapon_awp", "weapon_awp"),
        new("mg", "MG", "weapon_negev", "weapon_negev"),
        new("grenade", "Grenade", "weapon_hegrenade", "weapon_hegrenade"),
        new("c4", "C4", "weapon_c4", "weapon_c4"),
        new("zeus", "Zeus", "weapon_taser", "weapon_taser"),
    ];

    /// <summary>Stand-in bot slot → the team whose loadout it shows (the previewing player's).</summary>
    private readonly Dictionary<int, byte> _standInTeam = new();
    private int? _savedBotStop;

    /// <summary>The team whose loadout a player gets: their own, or for a stand-in bot the previewing player's.</summary>
    private byte SkinTeam(CCSPlayerController p) => _standInTeam.TryGetValue(p.Slot, out var t) ? t : p.TeamNum;

    private bool IsStandIn(CCSPlayerController p) => _standInTeam.ContainsKey(p.Slot);

    private bool MatchZyInstalled => File.Exists(Path.Combine(Server.GameDirectory, "csgo", "addons", "counterstrikesharp",
        "plugins", "MatchZy", "MatchZy.dll"));

    // ---------------------------------------------------------------- prefs

    private Dictionary<string, HudPrefs>? _hudPrefs;
    private string HudPrefsPath => Path.Combine(ConfigDir, "hud_prefs.json");
    private static readonly JsonSerializerOptions PrefsJson = new() { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true };

    private HudPrefs PrefsFor(CCSPlayerController player)
    {
        if (_hudPrefs == null)
        {
            try
            {
                _hudPrefs = File.Exists(HudPrefsPath)
                    ? JsonSerializer.Deserialize<Dictionary<string, HudPrefs>>(File.ReadAllText(HudPrefsPath), PrefsJson)
                    : null;
            }
            catch (Exception e)
            {
                Logger.LogWarning("hud_prefs.json unreadable, starting fresh: {Error}", e.Message);
            }
            _hudPrefs ??= new();
        }
        var key = player.SteamID.ToString();
        if (!_hudPrefs.TryGetValue(key, out var p)) _hudPrefs[key] = p = new HudPrefs();
        return p;
    }

    private void SavePrefs()
    {
        if (_hudPrefs == null) return;
        try
        {
            Directory.CreateDirectory(ConfigDir);
            var tmp = HudPrefsPath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(_hudPrefs, PrefsJson));
            File.Move(tmp, HudPrefsPath, true);
        }
        catch (Exception e)
        {
            Logger.LogWarning("hud_prefs.json: {Error}", e.Message);
        }
    }

    // ---------------------------------------------------------------- start / stop

    /// <summary>
    /// Starts or stops the preview so it runs exactly while the agents tab shows with "Third person" picked; while it
    /// runs, keeps the stand-in's model in step with the pawn's (after an agent click).
    /// </summary>
    private void SyncAgentView(CCSPlayerController player, HudSession s)
    {
        var want = s.Tab == "agents" && PrefsFor(player).View == "third" && player.PawnIsAlive && HudReady;
        if (want && s.View == null) StartAgentView(player, s);
        else if (!want && s.View != null) StopAgentView(player, s);
        else if (s.View is { } v && player.PlayerPawn.Value is { IsValid: true } pawn && PawnModel(pawn) is { Length: > 0 } m && m != v.DollModel)
        {
            v.DollModel = m;
            if (v.BotPawn is { } bp)
            {
                bp.SetModel(m);
                ApplyGloves(v.Bot!);
            }
            else if (v.Doll is { IsValid: true } doll) doll.SetModel(m);
        }
    }

    private static string PawnModel(CCSPlayerPawn pawn) =>
        pawn.CBodyComponent?.SceneNode?.GetSkeletonInstance().ModelState.ModelName ?? "";

    private static CDynamicProp? SpawnProp(string model, Color render, bool animGraph = false)
    {
        var e = Utilities.CreateEntityByName<CDynamicProp>("prop_dynamic");
        if (e == null) return null;
        e.Spawnflags = 256u; // no collision
        // the model's own animation graph (as Hammer's "use animgraph"): an idle stance instead of the bind pose
        if (animGraph) e.UseAnimGraph = true;
        e.Render = render;
        if (model.Length > 0) SetModelBeforeSpawn(e, model);
        e.DispatchSpawn();
        e.Render = render;
        Utilities.SetStateChanged(e, "CBaseModelEntity", "m_clrRender");
        return e;
    }

    private void StartAgentView(CCSPlayerController player, HudSession s)
    {
        var pawn = player.PlayerPawn.Value;
        if (pawn is not { IsValid: true } || pawn.CameraServices == null || pawn.AbsOrigin == null) return;
        var prefs = PrefsFor(player);
        try
        {
            var o = pawn.AbsOrigin;
            var active = pawn.WeaponServices?.ActiveWeapon.Value;
            var v = new AgentView
            {
                // Not on the player's own spot: MatchZy's .bot disables collisions between the player and the bot until
                // they stand apart, and kicking the bot while they still overlap crashed the server (user test,
                // AccessViolation in MatchZy's TemporarilyDisableCollisions timer).
                Spot = StandInSpot(o, pawn.EyeAngles.Y),
                Yaw = pawn.EyeAngles.Y,
                DollYaw = pawn.EyeAngles.Y, // faces the camera, which starts where the player looked
                Dist = Math.Clamp(prefs.Dist, AgentViewDefaults.MinDist, AgentViewDefaults.MaxDist),
                Elev = Math.Clamp(prefs.Elev, AgentViewDefaults.MinElev, AgentViewDefaults.MaxElev),
                DollModel = PawnModel(pawn),
                Pose = Poses.Any(p => p.Key == prefs.Pose) ? prefs.Pose : "held",
                Crouch = prefs.Crouch,
                HeldGive = active is { IsValid: true } ? IsKnife(active) ? "knife" : GiveName(active) : "",
                PawnColor = pawn.Render,
                PawnRenderMode = pawn.RenderMode,
                PawnHome = new Vector(o.X, o.Y, o.Z),
                PawnTookDamage = pawn.TakesDamage,
            };
            pawn.TakesDamage = false; // it may wait inside a wall or near a trigger behind the camera
            // camera: no model, fully transparent; only its position and angles matter
            v.Cam = SpawnProp("", Color.FromArgb(0, 255, 255, 255));
            if (v.Cam == null)
            {
                Logger.LogWarning("Third-person view: could not create the camera");
                return;
            }
            s.View = v;
            HidePawn(pawn, true, v);
            StashWeapons(player, pawn, v);
            PlaceCamera(pawn, v, true);
            pawn.CameraServices.ViewEntity.Raw = v.Cam.EntityHandle.Raw;
            Utilities.SetStateChanged(pawn, "CBasePlayerPawn", "m_pCameraServices");
            RequestStandInBot(player, v);
        }
        catch (Exception e)
        {
            Logger.LogError("Third-person view: {Error}", e);
            if (s.View != null) RemoveProps(s.View);
            s.View = null;
        }
    }

    /// <summary>Asks for a bot: MatchZy's .bot first (practice mode), else bot_add on the other team.</summary>
    private void RequestStandInBot(CCSPlayerController player, AgentView v)
    {
        if (++v.Attempts > 4)
        {
            // give up: SearchStandIn falls back to the prop once this expires
            v.OwnBotTried = true;
            v.BotSearchUntil = 0;
            return;
        }
        v.BotsBefore.Clear();
        foreach (var p in Utilities.GetPlayers())
            if ((p is { IsValid: true } && IsBotAny(p))) v.BotsBefore.Add(p.Slot);
        SetBotStop(true);
        if (MatchZyInstalled && !v.BotViaMatchZy && !v.OwnBotTried)
        {
            v.BotViaMatchZy = true;
            player.ExecuteClientCommandFromServer("css_bot");
            v.BotSearchUntil = Server.CurrentTime + 1.2f;
            return;
        }
        v.BotViaMatchZy = false;
        v.OwnBotTried = true;
        Server.ExecuteCommand("bot_join_after_player 0");
        Server.ExecuteCommand(player.TeamNum == 2 ? "bot_add_ct" : "bot_add_t");
        v.BotSearchUntil = Server.CurrentTime + 2f;
    }

    /// <summary>bot_stop 1 while any stand-in bot exists (no AI turning or shooting); the old value comes back after.</summary>
    private void SetBotStop(bool on)
    {
        var cvar = ConVar.Find("bot_stop");
        if (cvar == null) return;
        if (on && _savedBotStop == null)
        {
            _savedBotStop = CvarInt(cvar);
            Server.ExecuteCommand("bot_stop 1");
        }
        else if (!on && _savedBotStop is { } old && !_hudSessions.Values.Any(x => x.View != null))
        {
            _savedBotStop = null;
            Server.ExecuteCommand($"bot_stop {old}");
        }
    }

    /// <summary>A cvar as a number whatever its type (bot_stop isn't a plain int/bool to GetPrimitiveValue).</summary>
    private static int CvarInt(ConVar cvar)
    {
        try { return cvar.GetPrimitiveValue<int>(); } catch { /* other type */ }
        try { return cvar.GetPrimitiveValue<bool>() ? 1 : 0; } catch { /* other type */ }
        try { return int.TryParse(cvar.StringValue, out var n) ? n : cvar.StringValue is "true" ? 1 : 0; } catch { return 0; }
    }

    /// <summary>Per tick while no stand-in exists yet: adopt a new bot, try the next way, or fall back to a prop.</summary>
    private void SearchStandIn(CCSPlayerController player, HudSession s, AgentView v)
    {
        var bot = Utilities.GetPlayers().FirstOrDefault(p => (p is { IsValid: true } && IsBotAny(p))
            && !v.BotsBefore.Contains(p.Slot) && !IsStandIn(p) && p.Slot != player.Slot);
        if (bot != null)
        {
            if (!bot.PawnIsAlive)
            {
                bot.Respawn();
                return;
            }
            SetUpStandInBot(player, s, v, bot);
            return;
        }
        if (Server.CurrentTime < v.BotSearchUntil) return;
        if (!v.OwnBotTried)
        {
            RequestStandInBot(player, v);
            return;
        }
        // no bot: the agent model as a prop (idle only, no weapons)
        Logger.LogWarning("Third-person view: no bot arrived, showing the model as a prop");
        v.Doll = v.DollModel.Length > 0 ? SpawnProp(v.DollModel, Color.White, animGraph: true) : null;
        if (v.Doll == null)
        {
            StopAgentView(player, s);
            return;
        }
        v.Doll.Teleport(v.Spot, new QAngle(0, v.DollYaw, 0), new Vector(0, 0, 0));
        HudStatus(player, s, "No bot could be added: model only (no poses)");
        RenderHud(player, s);
    }

    private void SetUpStandInBot(CCSPlayerController player, HudSession s, AgentView v, CCSPlayerController bot)
    {
        var bp = bot.PlayerPawn.Value!;
        v.Bot = bot;
        _standInTeam[bot.Slot] = player.TeamNum;
        RemoveGlow(bp.Index); // .glow outlines bots; the preview's stand-in must look like the plain agent (user report)
        bp.TakesDamage = false;
        SetMoveType(bp, MoveType_t.MOVETYPE_NONE);
        // no collision with the (invisible) player standing on the same spot
        bp.Collision.CollisionGroup = CollisionDebris;
        bp.Collision.CollisionAttribute.CollisionGroup = CollisionDebris;
        Utilities.SetStateChanged(bp, "CCollisionProperty", "m_CollisionGroup");
        Utilities.SetStateChanged(bp, "CCollisionProperty", "m_collisionAttribute");
        bp.Teleport(v.Spot, new QAngle(0, v.DollYaw, 0), new Vector(0, 0, 0));
        v.SentYaw = v.DollYaw;
        if (v.DollModel.Length > 0) bp.SetModel(v.DollModel);
        ApplyGloves(bot);
        ApplyBotPose(player, v);
        Logger.LogInformation("Third-person view: stand-in bot {Bot} (slot {Slot}, {Via}) for {Player}", bot.PlayerName,
            bot.Slot, v.BotViaMatchZy ? "MatchZy .bot" : "bot_add", player.PlayerName);
    }

    private static void RemoveProps(AgentView v)
    {
        foreach (var e in new[] { v.Doll, v.Cam })
            if (e is { IsValid: true }) e.Remove();
        v.Doll = v.Cam = null;
    }

    private void StopAgentView(CCSPlayerController player, HudSession s)
    {
        var v = s.View;
        if (v == null) return;
        s.View = null;
        if (player.IsValid)
        {
            var prefs = PrefsFor(player);
            prefs.Dist = v.Dist;
            prefs.Elev = v.Elev;
            SavePrefs();
        }
        var pawn = player.IsValid ? player.PlayerPawn.Value : null;
        if (pawn is { IsValid: true })
        {
            if (pawn.CameraServices != null)
            {
                pawn.CameraServices.ViewEntity.Raw = uint.MaxValue;
                Utilities.SetStateChanged(pawn, "CBasePlayerPawn", "m_pCameraServices");
            }
            HidePawn(pawn, false, v);
            RestoreWeapons(player, v);
            pawn.TakesDamage = v.PawnTookDamage;
            // back to where the player stood, looking where they looked at the start (the client turned the view
            // towards the camera meanwhile)
            pawn.Teleport(v.PawnHome, new QAngle(0, v.Yaw, 0), new Vector(0, 0, 0));
        }
        RemoveProps(v);
        ReleaseStandIn(v);
        SetBotStop(false);
        // mouse look released the cursor; the window is still open when only the tab or view changed
        if (v.MouseLook && HudReady && _hudSessions.ContainsKey(player.Slot)) _hud!.SetInputCaptureEnabled(player, true);
    }

    /// <summary>Kicks the stand-in bot (or one still on its way) and puts bot_quota back.</summary>
    private void ReleaseStandIn(AgentView v)
    {
        void Kick(CCSPlayerController bot, bool viaMatchZy)
        {
            _standInTeam.Remove(bot.Slot);
            if (!bot.IsValid) return;
            // a bot kicked with the C4 drops it, and a loose C4 makes the next one given fall to the floor
            if (bot.PlayerPawn.Value is { IsValid: true } bp)
            {
                RemoveOwnC4(bot);
                bot.RemoveWeapons();
                RemoveLooseC4(bp);
            }
            if (viaMatchZy)
            {
                // MatchZy raised bot_quota for its bot; kickid alone would let the engine refill the slot
                Server.ExecuteCommand($"kickid {bot.UserId}");
                if (ConVar.Find("bot_quota") is { } q && CvarInt(q) > 0)
                    Server.ExecuteCommand($"bot_quota {CvarInt(q) - 1}");
            }
            else ExecKickNow($"bot_kick \"{bot.PlayerName}\""); // stands apart already; also lowers bot_quota
        }
        if (v.Bot != null)
        {
            Kick(v.Bot, v.BotViaMatchZy);
            v.Bot = null;
            return;
        }
        if (!v.Searching && v.Doll == null) return;
        // a bot requested but not arrived yet: kick it once it shows up
        var before = v.BotsBefore.ToHashSet();
        var viaMz = v.BotViaMatchZy;
        AddTimer(2f, () =>
        {
            foreach (var p in Utilities.GetPlayers())
                if ((p is { IsValid: true } && IsBotAny(p)) && !before.Contains(p.Slot) && !IsStandIn(p)) Kick(p, viaMz);
        }, TimerFlags.STOP_ON_MAPCHANGE);
    }

    /// <summary>Makes the real pawn, its weapons and its viewmodel invisible while the stand-in shows (and back).</summary>
    private static void HidePawn(CCSPlayerPawn pawn, bool hide, AgentView v)
    {
        void Set(CBaseModelEntity e, Color c, RenderMode_t mode)
        {
            e.Render = c;
            e.RenderMode = mode;
            Utilities.SetStateChanged(e, "CBaseModelEntity", "m_clrRender");
            Utilities.SetStateChanged(e, "CBaseModelEntity", "m_nRenderMode");
        }
        var clear = Color.FromArgb(0, 255, 255, 255);
        Set(pawn, hide ? clear : v.PawnColor, hide ? RenderMode_t.kRenderTransAlpha : v.PawnRenderMode);
        foreach (var w in Carried(pawn))
            Set(w, hide ? clear : Color.White, hide ? RenderMode_t.kRenderTransAlpha : RenderMode_t.kRenderNormal);
        // First-person arms and gloves (the viewmodel) still drew on screen through the camera: hide them too.
        const uint efNoDraw = 1u << 5;
        foreach (var vm in ViewModelsOf(pawn))
        {
            Set(vm, hide ? clear : Color.White, hide ? RenderMode_t.kRenderTransAlpha : RenderMode_t.kRenderNormal);
            vm.Effects = hide ? vm.Effects | efNoDraw : vm.Effects & ~efNoDraw;
            Utilities.SetStateChanged(vm, "CBaseEntity", "m_fEffects");
        }
    }

    /// <summary>
    /// Takes all the player's weapons away for the preview. Rounds 4/5 (user tests): neither hiding the viewmodel nor
    /// a null active weapon on the server stopped the client drawing its gloves and the held weapon (the client
    /// predicts both); with no weapon entities left there is nothing to draw. RestoreWeapons gives them back.
    /// </summary>
    private void StashWeapons(CCSPlayerController player, CCSPlayerPawn pawn, AgentView v)
    {
        if (pawn.WeaponServices is not { } ws || v.Stash != null) return;
        v.StashActive = ws.ActiveWeapon.Value is { IsValid: true } a ? a.DesignerName : "";
        v.Stash = new();
        var weapons = Carried(pawn);
        foreach (var w in weapons)
        {
            var give = IsKnife(w) ? (player.TeamNum == 2 ? "weapon_knife_t" : "weapon_knife") : GiveName(w);
            v.Stash.Add((give, w.Clip1, w.ReserveAmmo[0]));
        }
        ws.ActiveWeapon.Raw = uint.MaxValue;
        foreach (var w in weapons) w.AddEntityIOEvent("Kill", w, null, "", 0.01f);
    }

    private void RestoreWeapons(CCSPlayerController player, AgentView v)
    {
        var stash = v.Stash;
        v.Stash = null;
        if (stash == null || stash.Count == 0) return;
        var active = v.StashActive;
        // a loose C4 would make the given-back one fall to the floor (see ApplyBotPose); removed a frame before the give
        if (stash.Any(x => x.Give == "weapon_c4")) RemoveLooseC4();
        AddTimer(0.1f, () =>
        {
            if (!player.IsValid || !player.PawnIsAlive || player.PlayerPawn.Value is not { IsValid: true } pawn) return;
            var have = Carried(pawn).Select(GiveName).ToHashSet();
            foreach (var (give, clip, reserve) in stash)
            {
                if (have.Contains(give) && !give.Contains("knife")) continue; // e.g. given back by a respawn meanwhile
                var w = player.GiveNamedItem<CBasePlayerWeapon>(give);
                if (w is not { IsValid: true } || give.Contains("knife")) continue;
                if (clip >= 0)
                {
                    w.Clip1 = clip;
                    Utilities.SetStateChanged(w, "CBasePlayerWeapon", "m_iClip1");
                    w.ReserveAmmo[0] = reserve;
                    Utilities.SetStateChanged(w, "CBasePlayerWeapon", "m_pReserveAmmo");
                }
            }
            if (active.Length > 0)
                AddTimer(0.1f, () =>
                {
                    if (player.IsValid && player.PawnIsAlive) UseWeapon(player, IsKnifeName(active) ? "weapon_knife" : active);
                }, TimerFlags.STOP_ON_MAPCHANGE);
        }, TimerFlags.STOP_ON_MAPCHANGE);
    }

    /// <summary>The pawn's viewmodel entities (CSS 1.0.380 has no handle to them, so search by owner).</summary>
    private static IEnumerable<CBaseModelEntity> ViewModelsOf(CCSPlayerPawn pawn) =>
        Utilities.FindAllEntitiesByDesignerName<CBaseModelEntity>("predicted_viewmodel")
            .Where(vm => vm.IsValid && vm.OwnerEntity.Index == pawn.Index);

    // ---------------------------------------------------------------- camera

    /// <summary>
    /// Camera on a sphere around the stand-in's chest, looking back along the orbit direction and moved to its own
    /// left, so the agent stands right of centre (the window covers the left). Walls pull it in. The pawn's eye angles
    /// are set to the camera's too, in case the client renders with its own view angles.
    /// </summary>
    private static void PlaceCamera(CCSPlayerPawn pawn, AgentView v, bool force = false)
    {
        if (v.Cam is not { IsValid: true }) return;
        var c = new Vector(v.Spot.X, v.Spot.Y, v.Spot.Z + ChestHeight);
        var yr = v.Yaw * MathF.PI / 180f;
        var er = v.Elev * MathF.PI / 180f;
        float dx = MathF.Cos(er) * MathF.Cos(yr), dy = MathF.Cos(er) * MathF.Sin(yr), dz = MathF.Sin(er);
        float lx = MathF.Sin(yr), ly = -MathF.Cos(yr);
        var shift = v.Dist * SideShift;
        var want = new Vector(c.X + dx * v.Dist + lx * shift, c.Y + dy * v.Dist + ly * shift, c.Z + dz * v.Dist);
        var angles = new QAngle(v.Elev, NormalizeYaw(v.Yaw + 180f), 0);
        var cam = ClearOfWalls(c, want);
        v.Cam.Teleport(cam, angles, new Vector(0, 0, 0));
        // Rounds 4-7 (user tests): the client still draws its first-person hands (gloves, the last weapon) at the
        // pawn's eye, which stood right in front of the camera, even with the weapons gone and the viewmodel hidden.
        // So the pawn waits behind the camera, out of its view (in a wall there is fine: it is frozen and can't be hurt).
        var hide = new Vector(cam.X + dx * HideBehind, cam.Y + dy * HideBehind, cam.Z + dz * HideBehind - EyeHeight);
        var moved = v.PawnSentPos is not { } sent
                    || MathF.Abs(sent.X - hide.X) + MathF.Abs(sent.Y - hide.Y) + MathF.Abs(sent.Z - hide.Z) > 1f;
        var turned = force || MathF.Abs(angles.X - v.LastCamAngles.X) >= 0.01f || MathF.Abs(angles.Y - v.LastCamAngles.Y) >= 0.01f;
        if (!moved && !turned) return;
        v.LastCamAngles = angles;
        v.PawnSentPos = hide;
        pawn.Teleport(hide, angles, new Vector(0, 0, 0));
    }

    /// <summary>How far behind the camera the player's pawn waits (eye), and the eye height above its feet.</summary>
    private const float HideBehind = 140f;
    private const float EyeHeight = 64f;

    /// <summary>
    /// A free floor spot about 72 units from the player (behind first, then the sides, then in front): clear line at
    /// chest height and floor within a step's reach. Falls back to straight behind.
    /// </summary>
    private static Vector StandInSpot(Vector o, float yaw)
    {
        const float Away = 72f;
        float[] turns = [180f, 90f, -90f, 135f, -135f, 45f, -45f, 0f];
        foreach (var dist in new[] { Away, 56f })
            foreach (var t in turns)
            {
                var r = (yaw + t) * MathF.PI / 180f;
                var p = new Vector(o.X + MathF.Cos(r) * dist, o.Y + MathF.Sin(r) * dist, o.Z);
                try
                {
                    var options = new TraceOptions { InteractsWith = Masks.PlayerSolidBrushOnly };
                    var blocked = new[] { 16f, ChestHeight, 64f }.Any(h =>
                        Trace.TraceEndShape(new Vector(o.X, o.Y, o.Z + h), new Vector(p.X, p.Y, p.Z + h), null!, options).DidHit());
                    if (blocked) continue;
                    var ground = GroundUnder(new Vector(p.X, p.Y, p.Z + 18));
                    if (MathF.Abs(ground - o.Z) > 24f) continue;
                    return new Vector(p.X, p.Y, ground);
                }
                catch
                {
                    break; // trace natives broken: use the fallback
                }
            }
        var b = (yaw + 180f) * MathF.PI / 180f;
        return new Vector(o.X + MathF.Cos(b) * Away, o.Y + MathF.Sin(b) * Away, o.Z);
    }

    private static float NormalizeYaw(float y)
    {
        y %= 360f;
        if (y > 180f) y -= 360f;
        if (y < -180f) y += 360f;
        return y;
    }

    private static Vector ClearOfWalls(Vector from, Vector to)
    {
        try
        {
            var options = new TraceOptions { InteractsWith = Masks.PlayerSolidBrushOnly };
            var hit = Trace.TraceEndShape(from, to, null!, options);
            if (!hit.DidHit() || hit.IsAllSolid) return to;
            float ex = hit.EndPos.X - from.X, ey = hit.EndPos.Y - from.Y, ez = hit.EndPos.Z - from.Z;
            var len = MathF.Sqrt(ex * ex + ey * ey + ez * ez);
            if (len < 1f) return from;
            var k = Math.Max(0f, len - 8f) / len; // stay a little in front of the wall
            return new Vector(from.X + ex * k, from.Y + ey * k, from.Z + ez * k);
        }
        catch
        {
            return to; // trace natives can break after a CS2 update
        }
    }

    /// <summary>Turns the stand-in to DollYaw (and keeps the bot on its spot).</summary>
    private static void PlaceStandIn(AgentView v)
    {
        if (v.BotPawn is { } bp)
        {
            var o = bp.AbsOrigin;
            var moved = o == null || MathF.Abs(o.X - v.Spot.X) + MathF.Abs(o.Y - v.Spot.Y) + MathF.Abs(o.Z - v.Spot.Z) > 4f;
            if (moved || v.SentYaw != v.DollYaw) bp.Teleport(moved ? v.Spot : null, new QAngle(0, v.DollYaw, 0), new Vector(0, 0, 0));
            v.SentYaw = v.DollYaw;
            // A bot's body follows its own eye angles, which teleporting doesn't change (live test: it kept facing
            // its spawn direction), so set them every tick.
            var eyes = bp.EyeAngles;
            if (MathF.Abs(NormalizeYaw(eyes.Y - v.DollYaw)) > 0.1f || MathF.Abs(eyes.X) > 0.1f)
            {
                eyes.X = 0;
                eyes.Y = v.DollYaw;
                Utilities.SetStateChanged(bp, "CCSPlayerPawn", "m_angEyeAngles");
            }
            var va = bp.V_angle;
            if (MathF.Abs(NormalizeYaw(va.Y - v.DollYaw)) > 0.1f || MathF.Abs(va.X) > 0.1f)
            {
                va.X = 0;
                va.Y = v.DollYaw;
            }
        }
        else if (v.Doll is { IsValid: true } doll && v.SentYaw != v.DollYaw)
        {
            doll.Teleport(null, new QAngle(0, v.DollYaw, 0), null);
            v.SentYaw = v.DollYaw;
        }
    }

    /// <summary>Per tick while the preview runs: stand-in, keys, mouse look, no shooting, camera.</summary>
    private void AgentViewTick(CCSPlayerController player, HudSession s, ulong buttons, ulong pressed)
    {
        var v = s.View!;
        var pawn = player.PlayerPawn.Value;
        if (pawn is not { IsValid: true } || !player.PawnIsAlive || v.Cam is not { IsValid: true })
        {
            StopAgentView(player, s);
            return;
        }
        if (v.Searching) SearchStandIn(player, s, v);
        else if (v.Bot != null && v.BotPawn == null)
        {
            // the bot died or left (round restart, kick): ask for a new one
            _standInTeam.Remove(v.Bot.Slot);
            v.Bot = null;
            v.OwnBotTried = false;
            v.BotViaMatchZy = false;
            RequestStandInBot(player, v);
        }
        bool Held(PlayerButtons b) => (buttons & (ulong)b) != 0;

        if ((pressed & (ulong)PlayerButtons.Jump) != 0) SetMouseLook(player, s, !v.MouseLook);

        var turn = 0f;
        if (Held(PlayerButtons.Moveleft) || (v.MouseLook && Held(PlayerButtons.Attack))) turn -= 1f;
        if (Held(PlayerButtons.Moveright) || (v.MouseLook && Held(PlayerButtons.Attack2))) turn += 1f;
        v.DollYaw += turn * 150f * TickDt;
        if (Held(PlayerButtons.Forward)) v.Dist -= 130f * TickDt;
        if (Held(PlayerButtons.Back)) v.Dist += 130f * TickDt;
        v.Dist = Math.Clamp(v.Dist, AgentViewDefaults.MinDist, AgentViewDefaults.MaxDist);

        // Mouse look: if the client lets the mouse move its view, the change turns the stand-in (yaw) and tilts the
        // camera (pitch); PlaceCamera then puts the view back. If the client copies the camera's angles, no change shows.
        if (v.MouseLook)
        {
            var dYaw = NormalizeYaw(pawn.EyeAngles.Y - v.LastCamAngles.Y);
            var dPitch = pawn.EyeAngles.X - v.LastCamAngles.X;
            if (MathF.Abs(dYaw) > 0.3f || MathF.Abs(dPitch) > 0.3f)
            {
                v.DollYaw -= dYaw;
                v.Elev = Math.Clamp(v.Elev + dPitch * 0.8f, AgentViewDefaults.MinElev, AgentViewDefaults.MaxElev);
                v.LastCamAngles = new QAngle(float.NaN, float.NaN, 0); // force the view back
            }
        }
        PlaceStandIn(v);
        ApplyStance(v);

        // Mouse1/Mouse2 turn the stand-in in mouse look; keep every weapon from firing, scoping or throwing meanwhile.
        BlockAttacks(pawn);
        if (v.BotPawn is { } bp) BlockAttacks(bp);

        PlaceCamera(pawn, v);
    }

    /// <summary>
    /// Crouch or stand (the stand-in bot): MatchZy's crouching practice bot technique, CBot.m_isCrouching plus a full
    /// duck amount, re-set every tick since the frozen bot's movement code would let it stand up again.
    /// </summary>
    private static void ApplyStance(AgentView v)
    {
        if (v.BotPawn is not { } bp) return;
        // Round 7 (live test): ~15 s into a round the game drops the C4 of a T who hasn't moved since spawn (AFK bomb
        // rule). The frozen stand-in never moves, so it lost every C4 from then on. Mark it as moved.
        if (!bp.HasMovedSinceSpawn) bp.HasMovedSinceSpawn = true;
        if (bp.Bot is { } ai && ai.IsCrouching != v.Crouch) ai.IsCrouching = v.Crouch;
        if (bp.MovementServices is not { } ms) return;
        var move = new CCSPlayer_MovementServices(ms.Handle);
        if (v.Crouch)
        {
            move.DuckAmount = 1f;
            move.Ducked = true;
            move.DesiresDuck = true;
        }
        else if (move.Ducked || move.DesiresDuck)
        {
            move.Ducked = false;
            move.DesiresDuck = false;
            move.DuckAmount = 0f;
        }
    }

    private static void BlockAttacks(CCSPlayerPawn pawn)
    {
        if (pawn.WeaponServices is not { } ws) return;
        var block = Server.TickCount + 32;
        foreach (var h in ws.MyWeapons)
        {
            if (h.Value is not { IsValid: true } w) continue;
            if (w.NextPrimaryAttackTick < block - 16)
            {
                w.NextPrimaryAttackTick = block;
                Utilities.SetStateChanged(w, "CBasePlayerWeapon", "m_nNextPrimaryAttackTick");
            }
            if (w.NextSecondaryAttackTick < block - 16)
            {
                w.NextSecondaryAttackTick = block;
                Utilities.SetStateChanged(w, "CBasePlayerWeapon", "m_nNextSecondaryAttackTick");
            }
        }
    }

    private void SetMouseLook(CCSPlayerController player, HudSession s, bool on)
    {
        var v = s.View;
        if (v == null || !HudReady || v.MouseLook == on) return;
        v.MouseLook = on;
        _hud!.SetInputCaptureEnabled(player, !on);
        RenderHud(player, s);
    }

    private static string AgentHint(AgentView? v) => v == null ? ""
        : v.Searching ? "Bringing in your agent…"
        : v.MouseLook ? "Mouse1/Mouse2 or A/D: turn · W/S: zoom · Space: cursor back"
        : "A/D: turn · W/S: zoom · Space: mouse look";

    // ---------------------------------------------------------------- HUD clicks (pk_view_*, pk_pose_*, pk_cam_*)

    private bool HandleAgentViewClick(CCSPlayerController player, HudSession s, string id)
    {
        var prefs = PrefsFor(player);
        if (id is "pk_view_first" or "pk_view_third")
        {
            prefs.View = id == "pk_view_third" ? "third" : "first";
            SavePrefs();
            SyncAgentView(player, s);
            return true;
        }
        if (id.StartsWith("pk_pose_"))
        {
            var key = id["pk_pose_".Length..];
            if (s.View is not { } pv || Poses.All(p => p.Key != key)) return true;
            prefs.Pose = key;
            SavePrefs();
            pv.Pose = key;
            ApplyBotPose(player, pv);
            return true;
        }
        if (id is "pk_stance_stand" or "pk_stance_crouch")
        {
            prefs.Crouch = id == "pk_stance_crouch";
            SavePrefs();
            if (s.View is { } sv)
            {
                sv.Crouch = prefs.Crouch;
                ApplyStance(sv);
            }
            return true;
        }
        if (!id.StartsWith("pk_cam_")) return false;
        var v = s.View;
        if (v == null) return true;
        switch (id["pk_cam_".Length..])
        {
            case "left": v.DollYaw -= 30f; break;
            case "right": v.DollYaw += 30f; break;
            case "in": v.Dist = Math.Max(AgentViewDefaults.MinDist, v.Dist - 20f); break;
            case "out": v.Dist = Math.Min(AgentViewDefaults.MaxDist, v.Dist + 20f); break;
            case "up": v.Elev = Math.Min(AgentViewDefaults.MaxElev, v.Elev + 12f); break;
            case "down": v.Elev = Math.Max(AgentViewDefaults.MinElev, v.Elev - 12f); break;
            case "mouse": SetMouseLook(player, s, !v.MouseLook); break;
            case "reset":
                v.DollYaw = v.Yaw;
                v.Dist = AgentViewDefaults.Dist;
                v.Elev = AgentViewDefaults.Elev;
                break;
        }
        PlaceStandIn(v);
        return true;
    }

    // ---------------------------------------------------------------- poses (the bot's weapon)

    private static List<CBasePlayerWeapon> Carried(CCSPlayerPawn pawn) =>
        pawn.WeaponServices?.MyWeapons.Select(h => h.Value).Where(w => w is { IsValid: true }).Select(w => w!).ToList() ?? [];

    /// <summary>
    /// Puts a weapon in hand. The client refuses a server-sent `use` ("[InputService] Cannot execute concommand 'use',
    /// missing required FCVAR flag", user's console 2026-11-17) and a server-side `use` doesn't move the client's own
    /// predicted weapon, so humans get the slot key of the weapon's gear slot (slot1 rifle … slot5 C4), which the
    /// client accepts from the server like `lastinv`. Bots still get the server-side `use`.
    /// </summary>
    private void UseWeapon(CCSPlayerController player, string name)
    {
        if (IsBotAny(player))
        {
            player.ExecuteClientCommandFromServer($"use {name}");
            return;
        }
        var key = SlotKey(player, name);
        if (key != null) player.ExecuteClientCommand(key);
    }

    private static string? SlotKey(CCSPlayerController player, string name)
    {
        if (name == "weapon_knife" || IsKnifeName(name)) return "slot3";
        var w = player.PlayerPawn.Value?.WeaponServices?.MyWeapons.Select(h => h.Value)
            .FirstOrDefault(x => x is { IsValid: true } && x.DesignerName == name);
        return (w?.As<CCSWeaponBase>().VData?.GearSlot) switch
        {
            gear_slot_t.GEAR_SLOT_RIFLE => "slot1",
            gear_slot_t.GEAR_SLOT_PISTOL => "slot2",
            gear_slot_t.GEAR_SLOT_KNIFE => "slot3",
            gear_slot_t.GEAR_SLOT_GRENADES => "slot4",
            gear_slot_t.GEAR_SLOT_C4 => "slot5",
            _ => Pistols.Contains(name) ? "slot2" : "slot1"
        };
    }

    /// <summary>
    /// Strips the stand-in bot and gives it the pose's one weapon, which it then holds (bots don't follow `use`
    /// reliably, but a player with a single weapon always has it out). The skin hook paints it with the player's skin.
    /// </summary>
    private void ApplyBotPose(CCSPlayerController player, AgentView v)
    {
        var bot = v.Bot;
        if (bot == null || v.BotPawn == null) return;
        var team = player.TeamNum;
        var pose = Poses.FirstOrDefault(p => p.Key == v.Pose) ?? Poses[0];
        var give = pose.Key == "held" ? v.HeldGive : team == 2 ? pose.GiveT : pose.GiveCt;
        if (give is "knife" or "") give = team == 2 ? "weapon_knife_t" : "weapon_knife";
        // Round 7 (live test): after RemoveWeapons took a C4 away, the bot could never hold a new one (every later give
        // fell to the floor, even with no other C4 around). Taking the C4 off properly first avoids that.
        RemoveOwnC4(bot);
        bot.RemoveWeapons();
        var c4 = give == "weapon_c4";
        // Round 7 (live test): while any C4 lies loose, a newly given one falls straight to the floor (one per click
        // piled up). Loose ones come from a bot kicked with the C4 and from RemoveWeapons, which leaves the old C4
        // behind. So clear them first (a planted bomb is planted_c4, not touched).
        if (c4)
        {
            if (v.BotPawn is { } old) RemoveLooseC4(old); // its own, carried or just stripped
            RemoveLooseC4();
        }
        var pose0 = v.Pose;
        void Give(int attempt)
        {
            if (!bot.IsValid || v.Bot != bot || v.BotPawn is not { } bp || v.Pose != pose0) return;
            // Round 4 (user test): a CT can't carry the C4 either. Be a T just for the give.
            var asT = c4 && bot.TeamNum != 2;
            byte team = bot.TeamNum, pawnTeam = bp.TeamNum;
            if (asT)
            {
                bot.TeamNum = 2;
                bp.TeamNum = 2;
            }
            try
            {
                bot.GiveNamedItem<CBasePlayerWeapon>(give);
            }
            finally
            {
                if (asT)
                {
                    bot.TeamNum = team;
                    bp.TeamNum = pawnTeam;
                }
            }
            if (!c4 || attempt >= 4) return;
            // Round 7 (live test): a T stand-in still dropped it now and then (right after a carrier was kicked).
            // Check, clear what fell and give again.
            AddTimer(0.2f, () =>
            {
                if (!bot.IsValid || v.Bot != bot || v.BotPawn is not { IsValid: true } p2 || v.Pose != pose0) return;
                if (Carried(p2).Any(w => w.DesignerName == "weapon_c4")) return;
                Server.PrintToConsole($"[PracSkins] stand-in dropped the C4 (try {attempt}), giving it again");
                RemoveLooseC4();
                AddTimer(0.1f, () => Give(attempt + 1), TimerFlags.STOP_ON_MAPCHANGE);
            }, TimerFlags.STOP_ON_MAPCHANGE);
        }
        AddTimer(0.05f, () => Give(1), TimerFlags.STOP_ON_MAPCHANGE);
    }

    private static void RemoveOwnC4(CCSPlayerController bot)
    {
        if (bot.PlayerPawn.Value is { IsValid: true } p && Carried(p).Any(w => w.DesignerName == "weapon_c4"))
            bot.RemoveItemByDesignerName("weapon_c4", true);
    }

    /// <summary>Removes every C4 nobody carries, or with <paramref name="owner"/> only the ones left on that pawn.</summary>
    private static void RemoveLooseC4(CCSPlayerPawn? owner = null)
    {
        var carried = new HashSet<uint>();
        foreach (var p in Utilities.GetPlayers())
            if (p.PlayerPawn.Value is { IsValid: true } pp && pp != owner)
                foreach (var w in Carried(pp)) carried.Add(w.Index);
        foreach (var e in Utilities.FindAllEntitiesByDesignerName<CBaseEntity>("weapon_c4"))
        {
            if (!e.IsValid || carried.Contains(e.Index)) continue;
            if (owner != null && e.OwnerEntity.Value?.Index != owner.Index) continue;
            e.Remove();
        }
    }

    // ---------------------------------------------------------------- agent voice

    /// <summary>Voice sets (soundevents/vo/agents/game_sounds_&lt;set&gt;) per agent with its own vo_prefix in items_game.</summary>
    private static readonly Dictionary<int, string> AgentVoice = new()
    {
        [5108] = "leet_epic", [5308] = "fbihrt_epic", [5400] = "gsg9", [5404] = "seal_epic", [5504] = "balkan_epic",
        [4711] = "swat_epic", [4712] = "swat_fem", [4756] = "swat_fem",
        [4726] = "professional_epic", [4733] = "professional_epic", [4734] = "professional_epic", [4735] = "professional_epic",
        [4736] = "professional_epic", [4613] = "professional_epic", [4727] = "professional_fem", [4730] = "professional_fem",
        [4749] = "gendarmerie_male", [4750] = "gendarmerie_male", [4752] = "gendarmerie_male", [4753] = "gendarmerie_male",
        [4751] = "gendarmerie_fem_epic", [4757] = "seal_fem", [4771] = "seal_diver_01", [4772] = "seal_diver_02",
        [4773] = "jungle_male", [4775] = "jungle_male", [4776] = "jungle_male", [4774] = "jungle_male_epic",
        [4780] = "jungle_male_epic", [4777] = "jungle_fem_epic", [4778] = "jungle_fem", [4781] = "jungle_fem",
    };

    /// <summary>Everyone else speaks with their faction's voice (model folder → set).</summary>
    private static readonly Dictionary<string, string> FactionVoice = new()
    {
        ["tm_leet"] = "leet", ["tm_phoenix"] = "phoenix", ["tm_balkan"] = "balkan", ["tm_professional"] = "professional",
        ["tm_jungle_raider"] = "jungle_male", ["ctm_fbi"] = "fbihrt", ["ctm_st6"] = "seal", ["ctm_sas"] = "sas",
        ["ctm_swat"] = "swat", ["ctm_gendarmerie"] = "gendarmerie_male", ["ctm_diver"] = "seal_diver_01",
    };

    /// <summary>
    /// Plays the agent's inventory preview line (&lt;set&gt;.vo_preview: a random line, as when inspecting the agent in
    /// the game's inventory), only for this player.
    /// </summary>
    private void PlayAgentVoice(CCSPlayerController player, int def, string model)
    {
        var folder = model.Replace('\\', '/').Split('/') is { Length: >= 2 } parts ? parts[^2] : "";
        var set = AgentVoice.TryGetValue(def, out var v) ? v : FactionVoice.GetValueOrDefault(folder, "");
        if (set.Length == 0 || player.PlayerPawn.Value is not { IsValid: true } pawn) return;
        try
        {
            var filter = new RecipientFilter();
            filter.Add(player);
            pawn.EmitSound($"{set}.vo_preview", filter, 1f, 1f);
        }
        catch (Exception e)
        {
            Logger.LogWarning("Agent voice {Set}: {Error}", set, e.Message);
        }
    }

    // ---------------------------------------------------------------- server tests

    [ConsoleCommand("css_prac_view", "Third-person preview state per open skin window")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnAgentViewStatus(CCSPlayerController? caller, CommandInfo command)
    {
        foreach (var (slot, s) in _hudSessions)
        {
            var p = Utilities.GetPlayerFromSlot(slot);
            var pawn = p?.PlayerPawn.Value;
            var v = s.View;
            if (v == null)
            {
                command.ReplyToCommand($"[PracSkins] slot {slot}: tab {s.Tab}, view off (pref {(p != null ? PrefsFor(p).View : "?")}), in hand {pawn?.WeaponServices?.ActiveWeapon.Value?.DesignerName ?? "nothing"}");
                continue;
            }
            string Ent(CBaseEntity? e) => e is { IsValid: true } ? $"#{e.Index} at {e.AbsOrigin} {e.AbsRotation}" : "none";
            var bp = v.BotPawn;
            var viewEnt = pawn?.CameraServices?.ViewEntity.Raw;
            var botText = bp == null ? v.Searching ? "searching" : "none"
                : $"{v.Bot!.PlayerName} slot {v.Bot.Slot} team {v.Bot.TeamNum} skinteam {SkinTeam(v.Bot)} via {(v.BotViaMatchZy ? "MatchZy" : "bot_add")} " +
                  $"{Ent(bp)} eyes {bp.EyeAngles} model {PawnModel(bp)} move {bp.MoveType} dmg {bp.TakesDamage} " +
                  $"weapons [{string.Join(",", Carried(bp).Select(w => $"{GiveName(w)}:{w.AttributeManager.Item.ItemDefinitionIndex}/paint{w.FallbackPaintKit}"))}] " +
                  $"active {bp.WeaponServices?.ActiveWeapon.Value?.DesignerName} crouch {v.Crouch} " +
                  $"duck {(bp.MovementServices is { } ms ? new CCSPlayer_MovementServices(ms.Handle).DuckAmount : -1):0.00} " +
                  $"ai-crouch {bp.Bot?.IsCrouching}";
            command.ReplyToCommand($"[PracSkins] slot {slot}: cam {Ent(v.Cam)}, view entity {(viewEnt == v.Cam?.EntityHandle.Raw ? "set" : $"NOT set ({viewEnt})")}, " +
                                   $"bot {botText}, prop {Ent(v.Doll)}, " +
                                   $"gap {(pawn?.AbsOrigin is { } po && bp?.AbsOrigin is { } bo ? MathF.Sqrt((po.X - bo.X) * (po.X - bo.X) + (po.Y - bo.Y) * (po.Y - bo.Y)) : -1):0}, pawn eyes {pawn?.EyeAngles} alpha {pawn?.Render.A} " +
                                   $"in hand {pawn?.WeaponServices?.ActiveWeapon.Value?.DesignerName ?? "nothing"} (stashed {v.Stash?.Count ?? 0}), " +
                                   $"yaw {v.Yaw:0} turn {v.DollYaw:0} elev {v.Elev:0} dist {v.Dist:0}, pose {v.Pose} (yours {v.HeldGive}), mouse {v.MouseLook}, " +
                                   $"viewmodels {(pawn != null ? string.Join(",", ViewModelsOf(pawn).Select(vm => $"#{vm.Index} a{vm.Render.A} fx{vm.Effects}")) : "")}");
        }
        if (_hudSessions.Count == 0) command.ReplyToCommand("[PracSkins] no skin window open");
        // every C4 in the world and who has it (a dropped one has no owner)
        var c4s = Utilities.FindAllEntitiesByDesignerName<CBaseEntity>("weapon_c4")
            .Select(e => $"#{e.Index} owner {(e.OwnerEntity.Value is { IsValid: true } ow ? ow.Index.ToString() : "none")} at {e.AbsOrigin}");
        command.ReplyToCommand($"[PracSkins] c4: {string.Join(" | ", c4s)}");
        if (Utilities.FindAllEntitiesByDesignerName<CCSGameRulesProxy>("cs_gamerules").FirstOrDefault()?.GameRules is { } gr)
            command.ReplyToCommand($"[PracSkins] rules: warmup {gr.WarmupPeriod} freeze {gr.FreezePeriod} win {gr.RoundWinStatus} " +
                $"dropped {gr.BombDropped} planted {gr.BombPlanted} roundstart {gr.RoundStartTime:0.0} now {Server.CurrentTime:0.0}");
        foreach (var p in Utilities.GetPlayers())
            if (p.PlayerPawn.Value is { IsValid: true } pp)
                command.ReplyToCommand($"[PracSkins] {p.PlayerName} pawn #{pp.Index} team {p.TeamNum} at {pp.AbsOrigin} weapons [{string.Join(",", Carried(pp).Select(w => $"{w.DesignerName}#{w.Index}"))}]");
    }
}
