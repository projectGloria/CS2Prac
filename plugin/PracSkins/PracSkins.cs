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
public class PracSkins : BasePlugin
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

    public override void Load(bool hotReload)
    {
        InitAttributeFunction();
        ReloadLoadout();

        RegisterListener<Listeners.OnMapStart>(_ =>
        {
            _nextItemId = FirstCustomItemId;
            // After the game mode's own cfgs have run: the app's defaults, then the user's server cfg.
            AddTimer(2.0f, () => Server.ExecuteCommand("execifexists cs2prac_defaults.cfg; execifexists cs2prac_server.cfg"),
                TimerFlags.STOP_ON_MAPCHANGE);
        });
        RegisterListener<Listeners.OnEntitySpawned>(OnEntitySpawned);
        RegisterEventHandler<EventPlayerSpawn>(OnPlayerSpawn);
        RegisterEventHandler<EventPlayerDeath>(OnPlayerDeath);
        VirtualFunctions.GiveNamedItemFunc.Hook(OnGiveNamedItemPost, HookMode.Post);
    }

    public override void Unload(bool hotReload)
    {
        // A stale hook delegate crashes the server on the next GiveNamedItem.
        VirtualFunctions.GiveNamedItemFunc.Unhook(OnGiveNamedItemPost, HookMode.Post);
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
        if (!ReloadLoadout())
        {
            command.ReplyToCommand("[PracSkins] reload failed, see server log");
            return;
        }

        var count = 0;
        foreach (var player in Utilities.GetPlayers().Where(IsTarget))
        {
            ApplyToCurrentWeapons(player);
            ApplyGloves(player);
            count++;
        }
        command.ReplyToCommand($"[PracSkins] reloaded, applied to {count} player(s). Respawn or re-buy if a skin doesn't update.");
    }

    /// <summary>
    /// Runs any server command for a root admin (every Steam account on the PC, set up by the app):
    /// <c>!cmd sv_cheats 1</c> in chat or <c>css_cmd exec mycfg</c> in the console.
    /// </summary>
    [ConsoleCommand("css_cmd", "Run a server console command")]
    [RequiresPermissions("@css/root")]
    [CommandHelper(minArgs: 1, usage: "<command…>", whoCanExecute: CommandUsage.CLIENT_AND_SERVER)]
    public void OnCmdCommand(CCSPlayerController? caller, CommandInfo command)
    {
        var line = command.ArgString.Trim();
        if (line.Length >= 2 && line[0] == '"' && line[^1] == '"') line = line[1..^1];
        Logger.LogInformation("{Player} ran: {Command}", caller?.PlayerName ?? "console", line);
        Server.ExecuteCommand(line);
        command.ReplyToCommand($"[CS2Prac] ran: {line}");
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
            $"attribute function {(_setAttribute == null ? "MISSING" : "ok")}"
        };
        foreach (var p in Utilities.GetPlayers())
        {
            var pawn = p.PlayerPawn.Value;
            lines.Add($"  {p.PlayerName} steamid {p.SteamID} team {p.TeamNum} bot {p.IsBot} target {IsTarget(p)} alive {p.PawnIsAlive}" +
                      (pawn is { IsValid: true } ? $" gloves def {pawn.EconGloves.ItemDefinitionIndex}" : ""));
            var weapons = pawn?.WeaponServices?.MyWeapons;
            if (weapons == null) continue;
            foreach (var h in weapons)
                if (h.Value is { IsValid: true } w)
                    lines.Add($"    {w.DesignerName} def {w.AttributeManager.Item.ItemDefinitionIndex} paint {w.FallbackPaintKit} " +
                              $"wear {w.FallbackWear} quality {w.AttributeManager.Item.EntityQuality} itemid {w.AttributeManager.Item.ItemID}");
        }
        command.ReplyToCommand(string.Join('\n', lines));
    }

    // ---------------------------------------------------------------- who gets skins

    private bool IsTarget(CCSPlayerController? player)
    {
        if (player is not { IsValid: true } || player.IsHLTV) return false;
        if (player.TeamNum is not (2 or 3)) return false;
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
            if (IsTarget(player)) ApplyWeapon(player!, weapon);
        }
        catch (Exception e)
        {
            Logger.LogWarning("GiveNamedItem hook: {Error}", e);
        }
        return HookResult.Continue;
    }

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
                if (IsTarget(player)) ApplyWeapon(player!, weapon);
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
        if (IsTarget(player)) Server.NextFrame(() => ApplyGloves(player!));
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
            ? _loadout.Knife.For(player.TeamNum)
            : _loadout.WeaponPaint(weapon.AttributeManager.Item.ItemDefinitionIndex);

    private void ApplyToCurrentWeapons(CCSPlayerController player)
    {
        var weapons = player.PlayerPawn.Value?.WeaponServices?.MyWeapons;
        if (weapons == null) return;
        foreach (var handle in weapons)
            if (handle.Value is { IsValid: true } weapon) ApplyWeapon(player, weapon);
    }

    private void ApplyWeapon(CCSPlayerController player, CBasePlayerWeapon weapon)
    {
        var item = weapon.AttributeManager.Item;
        Paint? paint;

        if (IsKnife(weapon))
        {
            var knife = _loadout.Knife.For(player.TeamNum);
            if (knife == null || knife.DefIndex <= 0) return;

            if (item.ItemDefinitionIndex != knife.DefIndex)
                weapon.AcceptInput("ChangeSubclass", value: knife.DefIndex.ToString());
            item.ItemDefinitionIndex = (ushort)knife.DefIndex;
            item.EntityQuality = 3; // ★
            paint = knife;
        }
        else
        {
            paint = _loadout.WeaponPaint(item.ItemDefinitionIndex);
            if (paint == null) return;
            item.EntityQuality = paint.StatTrak >= 0 ? 9 : 0;
        }

        item.AttributeList.Attributes.RemoveAll();
        item.NetworkedDynamicAttributes.Attributes.RemoveAll();
        NewItemId(item);
        item.AccountID = (uint)player.SteamID;
        item.CustomName = paint.NameTag ?? "";

        Logger.LogDebug("{Player}: {Weapon} -> def {Def}, paint {Paint}", player.PlayerName, weapon.DesignerName, item.ItemDefinitionIndex, paint.PaintKit);
        if (paint.PaintKit <= 0) return; // vanilla knife: model only

        weapon.FallbackPaintKit = paint.PaintKit;
        weapon.FallbackSeed = paint.Seed;
        weapon.FallbackWear = paint.Wear;
        SetTexture(item, paint.PaintKit, paint.Seed, paint.Wear);
        if (paint.StatTrak >= 0) SetStatTrak(item, paint.StatTrak);

        // Legacy (CS:GO-era) finishes are mapped to the old model's body group.
        weapon.AcceptInput("SetBodygroup", value: $"body,{(paint.LegacyModel ? 1 : 0)}");
    }

    private void ApplyGloves(CCSPlayerController player)
    {
        var glove = _loadout.Gloves.For(player.TeamNum);
        var pawn = player.PlayerPawn.Value;
        if (glove is not { PaintKit: > 0 } || pawn is not { IsValid: true } || !player.PawnIsAlive) return;

        var item = pawn.EconGloves;
        item.NetworkedDynamicAttributes.Attributes.RemoveAll();
        item.AttributeList.Attributes.RemoveAll();
        player.ExecuteClientCommand("lastinv"); // forces a model refresh so old and new gloves don't overlap

        AddTimer(0.08f, () =>
        {
            try
            {
                if (!player.IsValid || !player.PawnIsAlive || !pawn.IsValid) return;
                item.ItemDefinitionIndex = (ushort)glove.DefIndex;
                NewItemId(item);
                SetTexture(item, glove.PaintKit, glove.Seed, glove.Wear);
                item.Initialized = true;
                Logger.LogDebug("{Player}: gloves -> def {Def}, paint {Paint}", player.PlayerName, glove.DefIndex, glove.PaintKit);

                player.ExecuteClientCommand("lastinv");
                pawn.AcceptInput("SetBodygroup", value: "first_or_third_person,0");
                AddTimer(0.2f, () =>
                {
                    if (pawn.IsValid) pawn.AcceptInput("SetBodygroup", value: "first_or_third_person,1");
                }, TimerFlags.STOP_ON_MAPCHANGE);
            }
            catch (Exception e)
            {
                Logger.LogWarning("ApplyGloves: {Error}", e);
            }
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
