using System.Runtime.InteropServices;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Admin;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Memory;
using CounterStrikeSharp.API.Modules.Memory.DynamicFunctions;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;

namespace PracSkins;

/// <summary>
/// Applies the skins chosen in the CS2Prac app (loadout.json) on a local practice server.
/// Technique follows the open-source cs2-WeaponPaints plugin (fallback paint kit + econ attributes,
/// knife subclass change, glove econ item on the pawn).
/// </summary>
public partial class PracSkins : BasePlugin
{
    public override string ModuleName => "PracSkins";
    public override string ModuleVersion => "0.2.0";
    public override string ModuleAuthor => "CS2Prac";
    public override string ModuleDescription => "Applies CS2Prac loadout skins";

    // Last known-good signature for CAttributeList::SetOrAddAttributeValueByName (from cs2-WeaponPaints gamedata).
    // Override without rebuilding via configs/plugins/PracSkins/signatures.json.
    private static readonly Signatures DefaultSignatures = new()
    {
        Windows = "48 89 4C 24 ? 53 41 55 41 56",
        Linux = "55 48 89 E5 41 57 41 56 41 55 49 89 FD 41 54 53 48 89 F3 48 83 EC ? F3 0F 11 85"
    };

    private const ulong FirstCustomItemId = 65578;

    private LoadoutFile _loadout = LoadoutFile.Empty;
    private MemoryFunctionVoid<nint, string, float>? _setAttribute;
    private ulong _nextItemId = FirstCustomItemId;

    private string ConfigDir => Path.Combine(Server.GameDirectory, "csgo", "addons", "counterstrikesharp", "configs", "plugins", "PracSkins");
    private string LoadoutPath => Path.Combine(ConfigDir, "loadout.json");

    /// <summary>Server name shown in front of our chat and console messages; the app sets it with css_prac_chat_prefix.</summary>
    private static string _serverName = "CS2Prac";
    private static string Tag => $"[{_serverName}]";
    private static string ChatTag => $" {ChatColors.Green}[{_serverName}]{ChatColors.Default}";

    [ConsoleCommand("css_prac_chat_prefix", "Name shown in front of CS2Prac messages")]
    [CommandHelper(minArgs: 1, usage: "<name>", whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnChatPrefixCommand(CCSPlayerController? caller, CommandInfo command)
    {
        var name = command.ArgString.Trim().Trim('"').Trim();
        if (name.Length > 0) _serverName = name;
    }

    private static readonly string[] SoundCommands =["play", "playvol", "play_distance", "playflush", "stopsound", "snd_playsounds"];

    public override void Load(bool hotReload)
    {
        InitAttributeFunction();
        ReloadLoadout();
        InitMenu();
        InitPractice();
        InitMovement();
        InitHud(hotReload);
        InitWheel();
        InitBotLoadouts();
        InitSettings();
        InitBots();
        InitSafeKick();
        InitExtras();
        InitModes();

        // A dedicated server has no sound system: `play <sound>` (common in client cfgs and aliases run with
        // !cmd exec) crashes it with an access violation. Swallow the sound commands server-side.
        foreach (var sound in SoundCommands)
            AddCommandListener(sound, (_, _) => HookResult.Stop);

        RegisterListener<Listeners.OnMapStart>(_ =>
        {
            _nextItemId = FirstCustomItemId;
            _refreshPending.Clear(); // their timers stopped with the old map
            // After the game mode's own cfgs have run: the app's defaults, then the user's server cfg.
            AddTimer(2.0f, () => Server.ExecuteCommand("execifexists cs2prac_defaults.cfg; execifexists cs2prac_server.cfg"),
                TimerFlags.STOP_ON_MAPCHANGE);
        });
        RegisterListener<Listeners.OnEntitySpawned>(OnEntitySpawned);
        // Agent models must be precached at map load or SetModel fails; the app lists every agent model.
        RegisterListener<Listeners.OnServerPrecacheResources>(manifest =>
        {
            LoadCatalogIfChanged();
            foreach (var model in _loadout.Precache.Concat(AgentModels()).Concat(_catalog.Agents.Select(a => a.Model)).Distinct())
                manifest.AddResource(model);
            manifest.AddResource(HandsResetModel);
            PrecacheGraffiti(manifest);
        });
        RegisterEventHandler<EventPlayerSpawn>(OnPlayerSpawn);
        RegisterEventHandler<EventPlayerDeath>(OnPlayerDeath);
        VirtualFunctions.GiveNamedItemFunc.Hook(OnGiveNamedItemPost, HookMode.Post);
    }

    public override void Unload(bool hotReload)
    {
        // A stale hook delegate crashes the server on the next GiveNamedItem.
        VirtualFunctions.GiveNamedItemFunc.Unhook(OnGiveNamedItemPost, HookMode.Post);
        foreach (var slot in _menus.Keys.ToList())
            if (Utilities.GetPlayerFromSlot(slot) is { IsValid: true } p) CloseMenu(p);
        UnloadPractice();
        UnloadMovement();
        UnloadSettings();
        UnloadHud();
        RestoreBotFlags();
    }

    // ---------------------------------------------------------------- setup

    private void InitAttributeFunction()
    {
        var sigs = DefaultSignatures;
        try
        {
            sigs = Signatures.Load(Path.Combine(ConfigDir, "signatures.json")) ?? DefaultSignatures;
        }
        catch (Exception e)
        {
            Logger.LogWarning("signatures.json is invalid ({Message}); using built-in signatures", e.Message);
        }

        var sig = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? sigs.Windows : sigs.Linux;
        try
        {
            _setAttribute = new MemoryFunctionVoid<nint, string, float>(sig);
        }
        catch (Exception e)
        {
            // Skins still partly work through the fallback fields, but finishes may not render.
            _setAttribute = null;
            Logger.LogError("SetOrAddAttributeValueByName signature not found ({Message}). A CS2 update probably changed it.", e.Message);
        }
    }

    private bool ReloadLoadout()
    {
        try
        {
            _loadout = LoadoutFile.Load(LoadoutPath);
            Logger.LogInformation("Loaded loadout: {Weapons} weapon skins, owner {Owner}",
                _loadout.Weapons.Count, _loadout.Owner ?? "everyone");
            return true;
        }
        catch (Exception e)
        {
            Logger.LogError("Could not read {Path}: {Message}", LoadoutPath, e.Message);
            return false;
        }
    }

    [ConsoleCommand("css_prac_reload", "Reload loadout.json and re-apply skins")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnReloadCommand(CCSPlayerController? caller, CommandInfo command)
    {
        LoadCatalogIfChanged();
        if (!ReloadLoadout())
        {
            command.ReplyToCommand("[PracSkins] reload failed, see server log");
            return;
        }

        var count = 0;
        foreach (var player in Utilities.GetPlayers().Where(IsTarget))
        {
            RefreshPlayer(player);
            count++;
        }
        command.ReplyToCommand($"[PracSkins] reloaded, applied to {count} player(s).");
    }

    /// <summary>
    /// @css/root check used instead of [RequiresPermissions]. CSS trusts only Steam-verified ids, and a tools-mode
    /// client (the app's "Start CS2 with 1.6 sounds") fails the ticket check ("STEAMAUTH: Client … received failure
    /// code 8; ignoring because local connection"), so it would lose admin. A player connected from this PC
    /// (loopback) is checked by its unverified SteamID; anyone else still needs a verified one. null = server console.
    /// </summary>
    internal static bool IsAdmin(CCSPlayerController? p)
    {
        if (p == null) return true;
        if (AdminManager.PlayerHasPermissions(p, "@css/root")) return true;
        if (!p.IsValid || p.SteamID == 0) return false;
        // AuthorizedSteamID isn't checked: an unverified player may report a zero id instead of null
        var ip = p.IpAddress ?? "";
        var local = ip.StartsWith("127.0.0.1") || ip.StartsWith("loopback");
        var ok = local && AdminManager.PlayerHasPermissions(new CounterStrikeSharp.API.Modules.Entities.SteamID(p.SteamID), "@css/root");
        if (!ok && _adminDenyLogged.Add(p.SteamID))
            Console.WriteLine($"[PracSkins] admin denied: {p.PlayerName} steam {p.SteamID} authorized " +
                              $"{p.AuthorizedSteamID?.SteamId64.ToString() ?? "null"} ip '{ip}' local {local}");
        return ok;
    }

    private static readonly HashSet<ulong> _adminDenyLogged = new();

    internal static bool AdminOrReply(CCSPlayerController? p, CommandInfo command)
    {
        if (IsAdmin(p)) return true;
        command.ReplyToCommand("[CSS] You do not have the correct permissions to execute this command.");
        return false;
    }

    /// <summary>
    /// Runs any server command for a root admin (every Steam account on the PC, set up by the app):
    /// <c>!cmd sv_cheats 1</c> in chat or <c>css_cmd exec mycfg</c> in the console.
    /// </summary>
    [ConsoleCommand("css_cmd", "Run a server console command")]
    [CommandHelper(minArgs: 1, usage: "<command…>", whoCanExecute: CommandUsage.CLIENT_AND_SERVER)]
    public void OnCmdCommand(CCSPlayerController? caller, CommandInfo command)
    {
        if (!AdminOrReply(caller, command)) return;
        var line = command.ArgString.Trim();
        if (line.Length >= 2 && line[0] == '"' && line[^1] == '"') line = line[1..^1];
        Logger.LogInformation("{Player} ran: {Command}", caller?.PlayerName ?? "console", line);
        Server.ExecuteCommand(line);
        command.ReplyToCommand($"{Tag} ran: {line}");
    }

    [ConsoleCommand("css_prac_status", "Show what PracSkins sees for each player")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnStatusCommand(CCSPlayerController? caller, CommandInfo command)
    {
        var lines = new List<string>
        {
            $"[PracSkins] owner {_loadout.Owner ?? "everyone"}, {_loadout.Weapons.Count} weapon skins, " +
            $"knife T {_loadout.Knife.T?.DefIndex ?? 0}/CT {_loadout.Knife.Ct?.DefIndex ?? 0}, " +
            $"gloves T {_loadout.Gloves.T?.DefIndex ?? 0}/CT {_loadout.Gloves.Ct?.DefIndex ?? 0}, " +
            $"pin {_loadout.Pin}, music kit {_loadout.MusicKit}, " +
            $"attribute function {(_setAttribute == null ? "MISSING" : "ok")}"
        };
        foreach (var p in Utilities.GetPlayers())
        {
            var pawn = p.PlayerPawn.Value;
            lines.Add($"  {p.PlayerName} steamid {p.SteamID} team {p.TeamNum} bot {p.IsBot} target {IsTarget(p)} alive {p.PawnIsAlive}" +
                      $" pin {(p.InventoryServices is { } iv ? (int)iv.Rank[5] : -1)} music {p.MusicKitID}" +
                      (pawn is { IsValid: true }
                          ? $" active {pawn.WeaponServices?.ActiveWeapon.Value?.DesignerName ?? "none"} gloves def {pawn.EconGloves.ItemDefinitionIndex} model {pawn.CBodyComponent?.SceneNode?.GetSkeletonInstance()?.ModelState.ModelName}"
                          : ""));
            var weapons = pawn?.WeaponServices?.MyWeapons;
            if (weapons == null) continue;
            foreach (var h in weapons)
                if (h.Value is { IsValid: true } w)
                    lines.Add($"    {w.DesignerName} def {w.AttributeManager.Item.ItemDefinitionIndex} paint {w.FallbackPaintKit} " +
                              $"wear {w.FallbackWear} quality {w.AttributeManager.Item.EntityQuality} itemid {w.AttributeManager.Item.ItemID} " +
                              $"attrs {w.AttributeManager.Item.NetworkedDynamicAttributes.Attributes.Count} deploytick {w.As<CCSWeaponBase>().DeployTick} now {Server.TickCount}");
        }
        command.ReplyToCommand(string.Join('\n', lines));
    }

    // ---------------------------------------------------------------- who gets skins

    private bool IsTarget(CCSPlayerController? player)
    {
        if (player is not { IsValid: true } || player.IsHLTV) return false;
        if (player.TeamNum is not (2 or 3)) return false;
        if (IsStandIn(player)) return true; // third-person stand-in bot: shows the previewing player's loadout
        if (IsBotAny(player)) return true;  // bots wear their own random loadout (BotLoadouts.cs)
        return _loadout.Owner is null || player.SteamID.ToString() == _loadout.Owner;
    }

    // ---------------------------------------------------------------- hooks

    private HookResult OnGiveNamedItemPost(DynamicHook hook)
    {
        try
        {
            var itemServices = hook.GetParam<CCSPlayer_ItemServices>(0);
            var weapon = hook.GetReturn<CBasePlayerWeapon>();
            if (weapon is not { IsValid: true } || weapon.DesignerName?.Contains("weapon") != true) return HookResult.Continue;

            var pawn = itemServices?.Pawn.Value;
            var player = pawn is { IsValid: true } ? pawn.Controller.Value?.As<CCSPlayerController>() : null;
            FixVariant(weapon, hook.GetParam<string>(1));
            if (IsTarget(player)) ApplyWeapon(player!, weapon);
        }
        catch (Exception e)
        {
            Logger.LogWarning("GiveNamedItem hook: {Error}", e);
        }
        return HookResult.Continue;
    }

    /// <summary>
    /// Item def per give name for guns that share an entity class with another gun (M4A1-S is a weapon_m4a1, USP-S a
    /// weapon_hkp2000, …). GiveNamedItem picks the item from the player's team loadout, so a T asking for
    /// weapon_m4a1_silencer gets an M4A4 and a CT asking for weapon_m4a1 may get an M4A1-S.
    /// </summary>
    private static readonly Dictionary<string, int> VariantDefs = new()
    {
        ["weapon_m4a1"] = 16, ["weapon_m4a1_silencer"] = 60,
        ["weapon_hkp2000"] = 32, ["weapon_usp_silencer"] = 61,
        ["weapon_p250"] = 36, ["weapon_cz75a"] = 63,
        ["weapon_deagle"] = 1, ["weapon_revolver"] = 64,
        ["weapon_mp7"] = 33, ["weapon_mp5sd"] = 23,
    };

    /// <summary>Turns a given gun into the one that was asked for (knife technique: ChangeSubclass + item def).</summary>
    private static void FixVariant(CBasePlayerWeapon weapon, string? asked)
    {
        if (asked == null || !VariantDefs.TryGetValue(asked, out var def)) return;
        var item = weapon.AttributeManager.Item;
        if (item.ItemDefinitionIndex == def) return;
        weapon.AcceptInput("ChangeSubclass", value: def.ToString());
        item.ItemDefinitionIndex = (ushort)def;
    }

    /// <summary>The give name for a carried gun: its DesignerName is shared (weapon_m4a1 for the M4A1-S too).</summary>
    private static string GiveName(CBasePlayerWeapon w) =>
        VariantDefs.FirstOrDefault(kv => kv.Value == w.AttributeManager.Item.ItemDefinitionIndex).Key ?? w.DesignerName;

    /// <summary>Catches weapons the GiveNamedItem hook misses (e.g. picked up or spawned by the game).</summary>
    private void OnEntitySpawned(CEntityInstance entity)
    {
        if (entity.DesignerName?.Contains("weapon") != true) return;

        Server.NextWorldUpdate(() =>
        {
            try
            {
                var weapon = new CBasePlayerWeapon(entity.Handle);
                if (!weapon.IsValid) return;

                CCSPlayerController? player = null;
                if (weapon.OriginalOwnerXuidLow > 0)
                    player = Utilities.GetPlayers().FirstOrDefault(p => p.IsValid && (uint)p.SteamID == weapon.OriginalOwnerXuidLow);
                if (player == null)
                {
                    var ownerPawn = weapon.OwnerEntity.Value?.As<CCSPlayerPawn>();
                    player = ownerPawn is { IsValid: true } ? ownerPawn.Controller.Value?.As<CCSPlayerController>() : null;
                }
                if (!IsTarget(player)) return;
                // Already skinned by the GiveNamedItem hook for this player: only re-set the attributes. A second full
                // apply (attributes wiped, new item id a frame after the give) made the client drop the stickers
                // until the next weapon switch (user report 2026-11-17).
                var item = weapon.AttributeManager.Item;
                var ours = item.ItemID >= FirstCustomItemId && item.AccountID == (uint)player!.SteamID;
                ApplyWeapon(player!, weapon, keepId: ours);
            }
            catch (Exception e)
            {
                Logger.LogWarning("OnEntitySpawned: {Error}", e);
            }
        });
    }

    private HookResult OnPlayerSpawn(EventPlayerSpawn @event, GameEventInfo info)
    {
        var player = @event.Userid;
        if ((player is { IsValid: true } && IsBotAny(player))) Server.NextFrame(() => { if (player.IsValid) ApplyBotProfile(player); });
        if (IsTarget(player))
            Server.NextFrame(() =>
            {
                ApplyProfileItems(player!);
                ApplyAgent(player!);
                ApplyGloves(player!);
            });
        return HookResult.Continue;
    }

    /// <summary>Counts StatTrak kills for this session (not written back to the app).</summary>
    private HookResult OnPlayerDeath(EventPlayerDeath @event, GameEventInfo info)
    {
        var attacker = @event.Attacker;
        if (!IsTarget(attacker) || @event.Userid == attacker) return HookResult.Continue;

        var weapon = attacker!.PlayerPawn.Value?.WeaponServices?.ActiveWeapon.Value;
        if (weapon is not { IsValid: true }) return HookResult.Continue;

        var paint = PaintFor(attacker, weapon);
        if (paint is not { StatTrak: >= 0 }) return HookResult.Continue;

        paint.StatTrak++;
        SetStatTrak(weapon.AttributeManager.Item, paint.StatTrak);
        return HookResult.Continue;
    }

    // ---------------------------------------------------------------- applying skins

    private static bool IsKnife(CBasePlayerWeapon weapon)
    {
        var name = weapon.DesignerName ?? "";
        return name.Contains("knife") || name.Contains("bayonet");
    }

    private Paint? PaintFor(CCSPlayerController player, CBasePlayerWeapon weapon) =>
        IsKnife(weapon)
            ? SkinsOf(player).Knife.For(SkinTeam(player))
            : SkinsOf(player).WeaponPaint(weapon.AttributeManager.Item.ItemDefinitionIndex, SkinTeam(player));

    private void ApplyToCurrentWeapons(CCSPlayerController player)
    {
        var weapons = player.PlayerPawn.Value?.WeaponServices?.MyWeapons;
        if (weapons == null) return;
        foreach (var handle in weapons)
            if (handle.Value is { IsValid: true } weapon) ApplyWeapon(player, weapon);
    }

    /// <param name="keepId">the weapon already carries this skin (our item id): set the attributes again in place,
    /// without wiping them or giving it a new item id</param>
    private void ApplyWeapon(CCSPlayerController player, CBasePlayerWeapon weapon, bool keepId = false)
    {
        var item = weapon.AttributeManager.Item;
        Paint? paint;

        if (IsKnife(weapon))
        {
            var knife = SkinsOf(player).Knife.For(SkinTeam(player));
            if (knife == null || knife.DefIndex <= 0) return;

            if (item.ItemDefinitionIndex != knife.DefIndex)
                weapon.AcceptInput("ChangeSubclass", value: knife.DefIndex.ToString());
            item.ItemDefinitionIndex = (ushort)knife.DefIndex;
            item.EntityQuality = 3; // ★
            paint = knife;
        }
        else
        {
            paint = SkinsOf(player).WeaponPaint(item.ItemDefinitionIndex, SkinTeam(player));
            if (paint == null) return;
            item.EntityQuality = paint.StatTrak >= 0 ? 9 : 0;
        }

        if (!keepId)
        {
            item.AttributeList.Attributes.RemoveAll();
            item.NetworkedDynamicAttributes.Attributes.RemoveAll();
            NewItemId(item);
        }
        item.AccountID = (uint)player.SteamID;
        item.CustomName = paint.NameTag ?? "";

        Logger.LogDebug("{Player}: {Weapon} -> def {Def}, paint {Paint}", player.PlayerName, weapon.DesignerName, item.ItemDefinitionIndex, paint.PaintKit);
        if (paint.StatTrak >= 0) SetStatTrak(item, paint.StatTrak);

        if (paint.PaintKit > 0)
        {
            weapon.FallbackPaintKit = paint.PaintKit;
            weapon.FallbackSeed = paint.Seed;
            weapon.FallbackWear = paint.Wear;
            SetTexture(item, paint.PaintKit, paint.Seed, paint.Wear);
            // Legacy (CS:GO-era) finishes are mapped to the old model's body group.
            weapon.AcceptInput("SetBodygroup", value: $"body,{(paint.LegacyModel || ForceLegacy(item.ItemDefinitionIndex, paint.PaintKit) ? 1 : 0)}");
        }

        if (!IsKnife(weapon))
        {
            ApplyStickers(item, paint);
            ApplyKeychain(item, paint.Keychain);
        }
    }

    /// <summary>Sticker attributes (cs2-WeaponPaints technique); ids are passed as float bit patterns.</summary>
    private void ApplyStickers(CEconItemView item, Paint paint)
    {
        for (var slot = 0; slot < paint.Stickers.Count && slot < 5; slot++)
        {
            if (paint.Stickers[slot] is not { DefIndex: > 0 } s) continue;
            SetDynAttr(item, $"sticker slot {slot} id", BitsAsFloat((uint)s.DefIndex));
            if (s.X != 0 || s.Y != 0) SetDynAttr(item, $"sticker slot {slot} schema", 0);
            SetDynAttr(item, $"sticker slot {slot} offset x", s.X);
            SetDynAttr(item, $"sticker slot {slot} offset y", s.Y);
            SetDynAttr(item, $"sticker slot {slot} wear", s.Wear);
            SetDynAttr(item, $"sticker slot {slot} scale", s.Scale);
            SetDynAttr(item, $"sticker slot {slot} rotation", s.Rotation);
        }
    }

    private void ApplyKeychain(CEconItemView item, KeychainPaint? k)
    {
        if (k is not { DefIndex: > 0 }) return;
        SetDynAttr(item, "keychain slot 0 id", BitsAsFloat((uint)k.DefIndex));
        SetDynAttr(item, "keychain slot 0 offset x", k.X);
        SetDynAttr(item, "keychain slot 0 offset y", k.Y);
        SetDynAttr(item, "keychain slot 0 offset z", k.Z);
        SetDynAttr(item, "keychain slot 0 seed", BitsAsFloat((uint)k.Seed));
    }

    private IEnumerable<string> AgentModels() =>
        new[] { _loadout.Agents.T, _loadout.Agents.Ct }.Where(a => a is { DefIndex: > 0 }).Select(a => a!.Model);

    private void ApplyAgent(CCSPlayerController player)
    {
        var agent = SkinsOf(player).Agents.For(SkinTeam(player));
        var pawn = player.PlayerPawn.Value;
        if (agent is not { DefIndex: > 0 } || string.IsNullOrEmpty(agent.Model) || pawn is not { IsValid: true } || !player.PawnIsAlive) return;
        try
        {
            pawn.SetModel(agent.Model);
            // Radio and other voice lines go by the pawn's character/voice fields, not the model (a female agent
            // still spoke with the default male voice): <set>.<line> sound events, same sets as the preview voice.
            var set = VoiceSet(agent.DefIndex, agent.Model);
            pawn.CharacterDefIndex = (ushort)agent.DefIndex;
            if (set.Length > 0)
            {
                pawn.StrVOPrefix = set;
                pawn.HasFemaleVoice = set.Contains("fem");
            }
        }
        catch (Exception e)
        {
            Logger.LogWarning("ApplyAgent {Model}: {Error}", agent.Model, e.Message);
        }
    }

    // The Zeus is refreshed too (it was listed here, so a Zeus skin pick never showed until the next spawn).
    private static readonly string[] NotRefreshed = { "weapon_c4", "grenade", "flashbang", "decoy", "molotov", "weapon_healthshot" };

    /// <summary>A re-give on its way (0.1 s): the weapons taken away so far and what ends up in hand.</summary>
    private sealed class PendingRefresh
    {
        public readonly List<(string Give, int Clip, int Reserve, bool Knife, int Def)> Held = new();
        public int ActiveDef; // in hand when the refresh started (-1 = knife, 0 = nothing)
        public int Focus;     // the def just picked (-1 = knife), 0 = none
        public bool Gloves;
    }

    /// <summary>Slots with a re-give still pending: a second pick within 0.1 s joins it instead of giving twice.</summary>
    private readonly Dictionary<int, PendingRefresh> _refreshPending = new();

    // Paracord, Survival, Nomad and Skeleton (2019 knives) got the Doppler family and Ultraviolet in a later case.
    // Like that case's Marble Fade / Tiger Tooth / Damascus / Rust Coat (use_legacy_model 1) they draw on the
    // body_legacy mesh, but items_game and ByMykel don't flag them: on body 0 the knife shows vanilla (user test
    // 2026-11-17: Nomad Ruby fixed with body 1, Skeleton Ruby also broken). Keep in sync with catalog.ts.
    private static readonly HashSet<int> LateChromaKnives = [517, 518, 521, 525];
    private static bool ForceLegacy(int def, int paint) =>
        LateChromaKnives.Contains(def) && (paint is >= 415 and <= 421 || paint == 98);

    private static bool IsKnifeName(string name) => name.Contains("knife") || name.Contains("bayonet");

    private static int WeaponKey(CBasePlayerWeapon w) => IsKnife(w) ? -1 : w.AttributeManager.Item.ItemDefinitionIndex;

    /// <summary>
    /// Applies a changed loadout right away by re-giving weapons (the client keeps an old skin otherwise), then
    /// re-applies agent and gloves. A pick (focusDef) re-gives only the picked weapon: the others keep their skin and
    /// stay where they are, so the hands play one draw animation. A reload or a glove change re-gives everything
    /// (keeping ammo), since the re-give is what redraws the hands.
    /// </summary>
    /// <param name="focusDef">the weapon def just picked (-1 = the knife): it ends up in hand if the player carries it</param>
    private void RefreshPlayer(CCSPlayerController player, int focusDef = 0)
    {
        ApplyProfileItems(player);
        var pawn = player.PlayerPawn.Value;
        var services = pawn?.WeaponServices;
        if (pawn is not { IsValid: true } || services == null || !player.PawnIsAlive) return;
        var slot = player.Slot;
        var fresh = !_refreshPending.TryGetValue(slot, out var p);
        if (p == null)
        {
            var aw = services.ActiveWeapon.Value;
            p = new PendingRefresh { ActiveDef = aw is { IsValid: true } ? WeaponKey(aw) : 0 };
            _refreshPending[slot] = p;
        }
        if (focusDef != 0) p.Focus = focusDef;
        // Gloves only when they changed (re-applying them on every pick with `lastinv` switches was the "hands
        // refresh twice"). Cleared now, set before the give.
        if (GlovesChanged(player))
        {
            p.Gloves = true;
            ClearGloves(pawn);
            ResetHandsModel(pawn);
        }
        var all = focusDef == 0 || p.Gloves;

        foreach (var h in services.MyWeapons)
        {
            if (h.Value is not { IsValid: true } w || w.DesignerName is not { } name) continue;
            if (NotRefreshed.Any(name.Contains)) continue;
            var key = WeaponKey(w);
            // a weapon already taken by this refresh is still listed until its Kill runs
            if (!all && key != focusDef || p.Held.Any(e => e.Def == key)) continue;
            var knife = key == -1;
            p.Held.Add((knife ? (player.TeamNum == 2 ? "weapon_knife_t" : "weapon_knife") : GiveName(w), w.Clip1,
                w.ReserveAmmo[0], knife, key));
            if (services.ActiveWeapon.Value?.Index == w.Index) services.ActiveWeapon.Raw = uint.MaxValue;
            w.AddEntityIOEvent("Kill", w, null, "", 0.01f);
        }
        if (!fresh) return;

        AddTimer(0.1f, () =>
        {
            _refreshPending.Remove(slot);
            if (!player.IsValid || !player.PawnIsAlive) return;
            if (p.Gloves || GlovesChanged(player)) SetGloves(player);
            // what ends up in hand: the def just picked, else what was in hand before
            var want = p.Focus != 0 ? p.Focus : p.ActiveDef;
            // Given last: with nothing in hand (the held weapon was killed) the engine draws the first weapon given.
            foreach (var (give, clip, reserve, knife, _) in p.Held.OrderBy(e => e.Def == want ? 1 : 0))
            {
                var w = player.GiveNamedItem<CBasePlayerWeapon>(give);
                if (w is not { IsValid: true } || knife) continue;
                w.Clip1 = clip;
                Utilities.SetStateChanged(w, "CBasePlayerWeapon", "m_iClip1");
                w.ReserveAmmo[0] = reserve;
                Utilities.SetStateChanged(w, "CBasePlayerWeapon", "m_pReserveAmmo");
            }
            ApplyAgent(player);
            if (want != 0) SwitchTo(player, want, 0.1f, true);
            // The client builds stickers/charms when a weapon is drawn, and the re-given weapon is drawn in the
            // tick it's created (the old one was killed), before its attributes arrive: so it showed none until a
            // weapon switch (user report). A quick knife-and-back draws it again with the attributes.
            if (want > 0 && !IsBotAny(player) && SkinsOf(player).WeaponPaint(want, SkinTeam(player)) is { HasExtras: true })
                AddTimer(0.45f, () =>
                {
                    if (!player.IsValid || !player.PawnIsAlive) return;
                    SwitchTo(player, -1, 0.01f, false);
                    SwitchTo(player, want, 0.3f, true);
                }, TimerFlags.STOP_ON_MAPCHANGE);
        }, TimerFlags.STOP_ON_MAPCHANGE);
    }

    /// <summary>
    /// Puts weapon <paramref name="key"/> (def, -1 = knife) in hand after <paramref name="delay"/>, once the client has
    /// the given entity (a slot key sent in the give's own tick found nothing to switch to). Nothing is sent when it
    /// is already in hand (slot3/slot4 cycle: a second press would switch away); one check follows 0.3 s later.
    /// </summary>
    private void SwitchTo(CCSPlayerController player, int key, float delay, bool recheck)
    {
        AddTimer(delay, () =>
        {
            if (!player.IsValid || !player.PawnIsAlive || _refreshPending.ContainsKey(player.Slot)) return;
            var services = player.PlayerPawn.Value?.WeaponServices;
            if (services == null) return;
            if (services.ActiveWeapon.Value is { IsValid: true } now && WeaponKey(now) == key) return;
            var w = services.MyWeapons.Select(h => h.Value).FirstOrDefault(x => x is { IsValid: true } && WeaponKey(x) == key);
            if (w == null) return;
            UseWeapon(player, key == -1 ? "weapon_knife" : w.DesignerName);
            if (recheck) SwitchTo(player, key, 0.3f, false);
        }, TimerFlags.STOP_ON_MAPCHANGE);
    }

    /// <summary>Slots whose pin/music kit we set, so clearing them in the loadout resets them (and nothing else).</summary>
    private readonly HashSet<int> _profileItemsSet = new();

    /// <summary>
    /// Pin (profile display item, InventoryServices.Rank[5]) and music kit (MusicID + the controller's MusicKitID), the
    /// WeaponPaints technique. They live on the controller, so they work dead or alive and for both teams.
    /// </summary>
    private void ApplyProfileItems(CCSPlayerController player)
    {
        if (!player.IsValid || player.InventoryServices is not { } inv) return;
        var mine = SkinsOf(player);
        int pin = mine.Pin, kit = mine.MusicKit;
        if (pin <= 0 && kit <= 0 && !_profileItemsSet.Contains(player.Slot)) return;
        try
        {
            inv.Rank[5] = (MedalRank_t)Math.Max(pin, 0);
            inv.MusicID = (ushort)Math.Max(kit, 0);
            Utilities.SetStateChanged(player, "CCSPlayerController", "m_pInventoryServices");
            player.MusicKitID = Math.Max(kit, 0);
            Utilities.SetStateChanged(player, "CCSPlayerController", "m_iMusicKitID");
            if (pin > 0 || kit > 0) _profileItemsSet.Add(player.Slot);
            else _profileItemsSet.Remove(player.Slot);
        }
        catch (Exception e)
        {
            Logger.LogWarning("ApplyProfileItems: {Error}", e.Message);
        }
    }

    /// <summary>slot -> the gloves last set on that slot's pawn (pawn index, def, paint, seed, wear)</summary>
    private readonly Dictionary<int, (uint Pawn, int Def, int Paint, int Seed, float Wear)> _glovesSet = new();

    private (uint, int, int, int, float)? GloveSig(CCSPlayerController player)
    {
        var glove = SkinsOf(player).Gloves.For(SkinTeam(player));
        var pawn = player.PlayerPawn.Value;
        if (glove is not { PaintKit: > 0 } || pawn is not { IsValid: true }) return null;
        return (pawn.Index, glove.DefIndex, glove.PaintKit, glove.Seed, glove.Wear);
    }

    /// <summary>True when the loadout's gloves differ from the ones on the pawn (or the pawn is new).</summary>
    private bool GlovesChanged(CCSPlayerController player) =>
        GloveSig(player) is { } sig && (!_glovesSet.TryGetValue(player.Slot, out var cur) || cur != sig);

    private static void ClearGloves(CCSPlayerPawn pawn)
    {
        var item = pawn.EconGloves;
        item.NetworkedDynamicAttributes.Attributes.RemoveAll();
        item.AttributeList.Attributes.RemoveAll();
    }

    /// <summary>a stock model the pawn is switched to for a moment (precached in Load)</summary>
    private const string HandsResetModel = "characters/models/tm_jumpsuit/tm_jumpsuit_varianta.vmdl";

    /// <summary>
    /// Makes the client rebuild the hands: the pawn's model is swapped away and back (WeaponPaints technique). Hand
    /// wraps attach their own model, and without this the client kept drawing it on every later pair of gloves
    /// (user report 2026-11-17: "every glove gets wrapped"). Runs before the new gloves are set.
    /// </summary>
    private void ResetHandsModel(CCSPlayerPawn pawn)
    {
        try
        {
            var model = pawn.CBodyComponent?.SceneNode?.GetSkeletonInstance()?.ModelState.ModelName;
            if (string.IsNullOrEmpty(model)) return;
            pawn.SetModel(HandsResetModel);
            pawn.SetModel(model);
        }
        catch (Exception e)
        {
            Logger.LogWarning("ResetHandsModel: {Error}", e.Message);
        }
    }

    /// <summary>Writes the loadout's gloves onto the pawn (attributes cleared beforehand).</summary>
    private void SetGloves(CCSPlayerController player)
    {
        var glove = SkinsOf(player).Gloves.For(SkinTeam(player));
        var pawn = player.PlayerPawn.Value;
        if (glove is not { PaintKit: > 0 } || pawn is not { IsValid: true } || !player.PawnIsAlive) return;
        try
        {
            ClearGloves(pawn);
            var item = pawn.EconGloves;
            item.ItemDefinitionIndex = (ushort)glove.DefIndex;
            NewItemId(item);
            SetTexture(item, glove.PaintKit, glove.Seed, glove.Wear);
            item.Initialized = true;
            _glovesSet[player.Slot] = (pawn.Index, glove.DefIndex, glove.PaintKit, glove.Seed, glove.Wear);
            Logger.LogDebug("{Player}: gloves -> def {Def}, paint {Paint}", player.PlayerName, glove.DefIndex, glove.PaintKit);

            pawn.AcceptInput("SetBodygroup", value: "first_or_third_person,0");
            AddTimer(0.2f, () =>
            {
                if (pawn.IsValid) pawn.AcceptInput("SetBodygroup", value: "first_or_third_person,1");
            }, TimerFlags.STOP_ON_MAPCHANGE);
        }
        catch (Exception e)
        {
            Logger.LogWarning("SetGloves: {Error}", e);
        }
    }

    /// <summary>
    /// Gloves outside a re-give (spawn, wear changes, stand-ins): cleared, one weapon switch away and back so the client
    /// redraws the hands without the old gloves overlapping. The way back is an explicit `use` of the weapon that was
    /// in hand (a second `lastinv` could land on the wrong one).
    /// </summary>
    private void ApplyGloves(CCSPlayerController player)
    {
        var pawn = player.PlayerPawn.Value;
        if (GloveSig(player) == null || pawn is not { IsValid: true } || !player.PawnIsAlive) return;

        var active = pawn.WeaponServices?.ActiveWeapon.Value?.DesignerName;
        ClearGloves(pawn);
        ResetHandsModel(pawn);
        if (!IsBotAny(player)) player.ExecuteClientCommand("lastinv");

        AddTimer(0.08f, () =>
        {
            if (!player.IsValid || !player.PawnIsAlive || !pawn.IsValid) return;
            SetGloves(player);
            if (active != null && !IsBotAny(player)) UseWeapon(player, IsKnifeName(active) ? "weapon_knife" : active);
        }, TimerFlags.STOP_ON_MAPCHANGE);
    }

    // ---------------------------------------------------------------- econ helpers

    private void NewItemId(CEconItemView item)
    {
        var id = _nextItemId++;
        item.ItemID = id;
        item.ItemIDLow = (uint)(id & 0xFFFFFFFF);
        item.ItemIDHigh = (uint)(id >> 32);
    }

    private void SetAttr(CEconItemView item, string name, float value)
    {
        if (_setAttribute == null) return;
        _setAttribute.Invoke(item.NetworkedDynamicAttributes.Handle, name, value);
        _setAttribute.Invoke(item.AttributeList.Handle, name, value);
    }

    /// <summary>Stickers and keychains live only in the networked attribute list.</summary>
    private void SetDynAttr(CEconItemView item, string name, float value)
    {
        _setAttribute?.Invoke(item.NetworkedDynamicAttributes.Handle, name, value);
    }

    private void SetTexture(CEconItemView item, int paintKit, int seed, float wear)
    {
        SetAttr(item, "set item texture prefab", paintKit);
        SetAttr(item, "set item texture seed", seed);
        SetAttr(item, "set item texture wear", wear);
    }

    /// <summary>Integer attributes are passed as the float with the same bit pattern.</summary>
    private static float BitsAsFloat(uint value) => BitConverter.Int32BitsToSingle((int)value);

    private void SetStatTrak(CEconItemView item, int kills)
    {
        SetAttr(item, "kill eater", BitsAsFloat((uint)kills));
        SetAttr(item, "kill eater score type", 0);
    }
}
