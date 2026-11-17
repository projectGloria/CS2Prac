using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using Microsoft.Extensions.Logging;

namespace PracSkins;

/// <summary>
/// The in-game skin menu. Choices are written to loadout.json (the app picks them up and updates its profile) and
/// applied right away.
/// </summary>
public partial class PracSkins
{
    private PluginCatalog _catalog = PluginCatalog.Empty;
    private DateTime _catalogTime = DateTime.MinValue;
    private string CatalogPath => Path.Combine(ConfigDir, "catalog.json");

    private const int SearchLimit = 200;

    private static readonly (string Name, float Value)[] WearPresets =
    {
        ("Factory New", 0.01f), ("Minimal Wear", 0.10f), ("Field-Tested", 0.25f), ("Well-Worn", 0.40f), ("Battle-Scarred", 0.70f)
    };

    private static string WearName(float w) =>
        w < 0.07f ? "Factory New" : w < 0.15f ? "Minimal Wear" : w < 0.38f ? "Field-Tested" : w < 0.45f ? "Well-Worn" : "Battle-Scarred";

    private void InitMenu()
    {
        LoadCatalogIfChanged();
        RegisterListener<Listeners.OnTick>(OnMenuTick);
        RegisterEventHandler<EventPlayerDisconnect>((e, _) =>
        {
            if (e.Userid is { } p) _menus.Remove(p.Slot);
            return HookResult.Continue;
        });
        RegisterEventHandler<EventPlayerDeath>((e, _) =>
        {
            if (e.Userid is { IsValid: true } p && MenuOpen(p)) CloseMenu(p);
            return HookResult.Continue;
        });
    }

    private void LoadCatalogIfChanged()
    {
        try
        {
            var t = File.Exists(CatalogPath) ? File.GetLastWriteTimeUtc(CatalogPath) : DateTime.MinValue;
            if (t == _catalogTime) return;
            _catalog = PluginCatalog.Load(CatalogPath);
            _catalogTime = t;
            Logger.LogInformation("Menu catalog: {Weapons} weapons, {Agents} agents, {Stickers} stickers, {Keychains} charms",
                _catalog.Weapons.Count, _catalog.Agents.Count, _catalog.Stickers.Count, _catalog.Keychains.Count);
        }
        catch (Exception e)
        {
            Logger.LogError("Could not read {Path}: {Message}", CatalogPath, e.Message);
        }
    }

    // ---------------------------------------------------------------- commands

    /// <summary>Checks the player may edit the loadout, and prepares catalog and loadout for editing.</summary>
    private bool CanEdit(CCSPlayerController? player, CommandInfo? command = null)
    {
        void Reply(string m)
        {
            if (command != null) command.ReplyToCommand(m);
            else player?.PrintToChat(m);
        }

        if (player is not { IsValid: true } || IsBotAny(player)) return false;
        if (_loadout.Owner != null && player.SteamID.ToString() != _loadout.Owner)
        {
            Reply($"{Tag} Skins are set up for another Steam account (CS2Prac app > Loadout > Skins for).");
            return false;
        }
        if (player.TeamNum is not (2 or 3))
        {
            Reply($"{Tag} Join T or CT first.");
            return false;
        }
        LoadCatalogIfChanged();
        if (_catalog.Weapons.Count == 0)
        {
            Reply($"{Tag} No item list yet: open the Loadout tab in the CS2Prac app once, then restart the server.");
            return false;
        }
        if (ReferenceEquals(_loadout, LoadoutFile.Empty)) _loadout = new LoadoutFile { Schema = 2 };
        return true;
    }

    // css_menu (K) opens the skin window (Hud.cs); this text menu stays as the fallback.
    [ConsoleCommand("css_skins", "Open or close the CS2Prac text skin menu")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnMenuCommand(CCSPlayerController? player, CommandInfo command)
    {
        if (player != null && MenuOpen(player))
        {
            CloseMenu(player);
            return;
        }
        if (!CanEdit(player, command)) return;
        OpenMenu(player!, RootPage(player!));
    }

    /// <summary>Writes the loaded loadout back to loadout.json, as the menu does (for testing the app's import).</summary>
    [ConsoleCommand("css_prac_save", "Write the current loadout to loadout.json")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnSaveCommand(CCSPlayerController? caller, CommandInfo command)
    {
        LoadCatalogIfChanged();
        SaveLoadout();
        command.ReplyToCommand($"[PracSkins] saved; catalog has {_catalog.Weapons.Count} weapons, {_catalog.Stickers.Count} stickers");
    }

    [ConsoleCommand("css_skin", "Search finishes for the weapon in your hand: !skin <text>")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnSkinSearch(CCSPlayerController? player, CommandInfo command)
    {
        if (!CanEdit(player, command)) return;
        var held = HeldWeapon(player!);
        if (held == null)
        {
            command.ReplyToCommand($"{Tag} Hold the weapon you want to change.");
            return;
        }
        var q = command.ArgString;
        OpenMenu(player!, held.Kind == "knife" ? KnifeSearchPage(player!, q) : FinishPage(player!.TeamNum, held.Def, q));
    }

    [ConsoleCommand("css_knife", "Search knives: !knife <text>, e.g. !knife karambit doppler")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnKnifeSearch(CCSPlayerController? player, CommandInfo command)
    {
        if (!CanEdit(player, command)) return;
        OpenMenu(player!, command.ArgString.Trim().Length == 0 ? KnifeModelPage(player!) : KnifeSearchPage(player!, command.ArgString));
    }

    [ConsoleCommand("css_gloves", "Search gloves: !gloves <text>")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnGloveSearch(CCSPlayerController? player, CommandInfo command)
    {
        if (!CanEdit(player, command)) return;
        OpenMenu(player!, command.ArgString.Trim().Length == 0 ? GloveTypePage(player!) : GloveSearchPage(player!, command.ArgString));
    }

    [ConsoleCommand("css_agent", "Pick an agent: !agent [text]")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnAgentSearch(CCSPlayerController? player, CommandInfo command)
    {
        if (!CanEdit(player, command)) return;
        OpenMenu(player!, AgentPage(player!, command.ArgString));
    }

    [ConsoleCommand("css_pin", "Pick a scoreboard pin/coin: !pin [text]")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnPinSearch(CCSPlayerController? player, CommandInfo command)
    {
        if (!CanEdit(player, command)) return;
        OpenMenu(player!, PinPage(command.ArgString));
    }

    [ConsoleCommand("css_music", "Pick a music kit: !music [text]")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnMusicSearch(CCSPlayerController? player, CommandInfo command)
    {
        if (!CanEdit(player, command)) return;
        OpenMenu(player!, MusicPage(command.ArgString));
    }

    [ConsoleCommand("css_graffiti", "Pick a graffiti: !graffiti [text] (spray it with css_spray)")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnGraffitiSearch(CCSPlayerController? player, CommandInfo command)
    {
        if (!CanEdit(player, command)) return;
        OpenMenu(player!, GraffitiPage(command.ArgString));
    }

    [ConsoleCommand("css_sticker", "Search stickers for the weapon in your hand: !sticker <text>")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnStickerSearch(CCSPlayerController? player, CommandInfo command)
    {
        if (!CanEdit(player, command)) return;
        if (HudSearch(player!, command.ArgString, false)) return;
        var held = HeldWeapon(player!);
        if (held is not { Kind: "weapon" })
        {
            command.ReplyToCommand($"{Tag} Hold the gun you want to put stickers on.");
            return;
        }
        var q = command.ArgString;
        OpenMenu(player!, q.Trim().Length == 0 ? StickerSlotsPage(player!.TeamNum, held.Def) : StickerSearchPage(player!.TeamNum, held.Def, null, q));
    }

    [ConsoleCommand("css_charm", "Pick a charm for the weapon in your hand: !charm [text]")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnCharmSearch(CCSPlayerController? player, CommandInfo command)
    {
        if (!CanEdit(player, command)) return;
        if (HudSearch(player!, command.ArgString, true)) return;
        var held = HeldWeapon(player!);
        if (held is not { Kind: "weapon" })
        {
            command.ReplyToCommand($"{Tag} Hold the gun you want to put a charm on.");
            return;
        }
        OpenMenu(player!, CharmPage(player!.TeamNum, held.Def, command.ArgString));
    }

    // ---------------------------------------------------------------- helpers

    private static bool Matches(string text, string query)
    {
        var words = query.ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var t = text.ToLowerInvariant();
        return words.All(t.Contains);
    }

    private static string Team(CCSPlayerController p) => p.TeamNum == 2 ? "t" : "ct";
    private static string TeamLabel(CCSPlayerController p) => p.TeamNum == 2 ? "T" : "CT";

    private static void SetFor<T>(PerTeam<T> perTeam, CCSPlayerController p, T? value) where T : class
    {
        if (p.TeamNum == 2) perTeam.T = value;
        else perTeam.Ct = value;
    }

    /// <summary>The weapon in the player's hand, as a catalog entry (knives map to the knife they carry).</summary>
    private CatalogWeapon? HeldWeapon(CCSPlayerController player)
    {
        var w = player.PlayerPawn.Value?.WeaponServices?.ActiveWeapon.Value;
        if (w is not { IsValid: true }) return null;
        if (IsKnife(w)) return new CatalogWeapon { Def = w.AttributeManager.Item.ItemDefinitionIndex, Kind = "knife", Name = "Knife" };
        return _catalog.Weapon(w.AttributeManager.Item.ItemDefinitionIndex);
    }

    private Paint WeaponPaintOrNew(int team, int def) =>
        _loadout.Weapons.For(team) is { } map && map.TryGetValue(def.ToString(), out var p) ? p : new Paint { Wear = 0.01f, StatTrak = -1 };

    /// <summary>
    /// The paint a sticker/charm edit starts from. A gun without a skin on this team takes the other team's skin
    /// first (user report: stickers picked as CT landed on a plain Desert Eagle while the skin existed only on T).
    /// </summary>
    private Paint StickerBasePaint(int team, int def)
    {
        var p = WeaponPaintOrNew(team, def);
        if (p.PaintKit > 0) return p;
        if (_loadout.WeaponPaint(def, team == 2 ? 3 : 2) is { PaintKit: > 0 } other)
        {
            p.PaintKit = other.PaintKit;
            p.Seed = other.Seed;
            p.Wear = other.Wear;
            p.LegacyModel = other.LegacyModel;
            if (p.StatTrak < 0) p.StatTrak = other.StatTrak;
        }
        return p;
    }

    private void SaveLoadout()
    {
        try
        {
            _loadout.Save(LoadoutPath);
        }
        catch (Exception e)
        {
            Logger.LogError("Could not write {Path}: {Message}", LoadoutPath, e.Message);
        }
    }

    /// <summary>Stores a weapon's selection (dropping it when nothing is left on it), saves and re-gives weapons.</summary>
    private void CommitWeapon(CCSPlayerController player, int team, int def, Paint paint)
    {
        var key = def.ToString();
        if (_loadout.Weapons.For(team) is not { } map) return;
        if (paint.PaintKit <= 0 && !paint.HasExtras && paint.StatTrak < 0 && string.IsNullOrEmpty(paint.NameTag)) map.Remove(key);
        else map[key] = paint;
        SaveLoadout();
        RefreshPlayer(player, def);
    }

    private void CommitKnife(CCSPlayerController player, KnifePaint? knife)
    {
        SetFor(_loadout.Knife, player, knife);
        SaveLoadout();
        RefreshPlayer(player, -1);
    }

    private string SkinName(int def, int paint) =>
        paint <= 0 ? "Default" : _catalog.SkinsFor(def).FirstOrDefault(s => s.Paint == paint)?.Name ?? $"Paint {paint}";

    private static float ClampWear(float wear, CatalogSkin? s) => s == null ? wear : Math.Clamp(wear, s.Min, s.Max);

    // ---------------------------------------------------------------- pages

    private MenuPage RootPage(CCSPlayerController player) => new()
    {
        Title = "Skins",
        Build = () =>
        {
            var items = new List<MenuItem>();
            var held = HeldWeapon(player);
            if (held is { Kind: "weapon" })
            {
                var p = _loadout.WeaponPaint(held.Def, player.TeamNum);
                items.Add(new($"{held.Name}: {SkinName(held.Def, p?.PaintKit ?? 0)}", pl => PushPage(pl, FinishPage(player!.TeamNum, held.Def))));
            }
            var knife = _loadout.Knife.For(player.TeamNum);
            items.Add(new($"Knife ({TeamLabel(player)}): {KnifeLabel(knife)}", pl => PushPage(pl, KnifeModelPage(pl))));
            var gloves = _loadout.Gloves.For(player.TeamNum);
            items.Add(new($"Gloves ({TeamLabel(player)}): {GloveLabel(gloves)}", pl => PushPage(pl, GloveTypePage(pl))));
            var agent = _loadout.Agents.For(player.TeamNum);
            items.Add(new($"Agent ({TeamLabel(player)}): {AgentLabel(agent)}", pl => PushPage(pl, AgentPage(pl, ""))));
            if (held is { Kind: "weapon" })
            {
                var p = _loadout.WeaponPaint(held.Def, player.TeamNum);
                var n = p?.Stickers.Count(s => s is { DefIndex: > 0 }) ?? 0;
                items.Add(new($"Stickers on {held.Name} ({n}/5)", pl => PushPage(pl, StickerSlotsPage(player!.TeamNum, held.Def))));
                items.Add(new($"Charm on {held.Name}: {CharmLabel(p?.Keychain)}", pl => PushPage(pl, CharmPage(player!.TeamNum, held.Def, ""))));
                if (p is { PaintKit: > 0 })
                    items.Add(new($"StatTrak on {held.Name}: {(p.StatTrak >= 0 ? "on" : "off")}", pl =>
                    {
                        var cur = WeaponPaintOrNew(player.TeamNum, held.Def);
                        cur.StatTrak = cur.StatTrak >= 0 ? -1 : 0;
                        CommitWeapon(pl, player.TeamNum, held.Def, cur);
                        Flash(pl, cur.StatTrak >= 0 ? "StatTrak on" : "StatTrak off");
                    }));
            }
            else items.Add(new("(hold a gun for its skin, stickers and charm)", Color: "#8a93a3"));
            items.Add(new($"Pin: {PinLabel()}", pl => PushPage(pl, PinPage(""))));
            items.Add(new($"Music kit: {MusicLabel()}", pl => PushPage(pl, MusicPage(""))));
            items.Add(new($"Graffiti: {GraffitiLabel()}", pl => PushPage(pl, GraffitiPage(""))));
            items.Add(new("Close", CloseMenu));
            return items;
        }
    };

    private string KnifeLabel(KnifePaint? k) =>
        k is not { DefIndex: > 0 } ? "Default" : $"{_catalog.WeaponName(k.DefIndex)}{(k.PaintKit > 0 ? " | " + SkinName(k.DefIndex, k.PaintKit) : "")}";

    private string GloveLabel(GlovePaint? g) =>
        g is not { PaintKit: > 0 } ? "Default" : $"{_catalog.WeaponName(g.DefIndex)} | {SkinName(g.DefIndex, g.PaintKit)}";

    private string AgentLabel(AgentPaint? a) =>
        a is not { DefIndex: > 0 } ? "Default" : (_catalog.Agents.FirstOrDefault(x => x.Def == a.DefIndex)?.Name.Split(" | ")[0] ?? $"Agent {a.DefIndex}");

    private string CharmLabel(KeychainPaint? k) =>
        k is not { DefIndex: > 0 } ? "None" : _catalog.Keychains.FirstOrDefault(x => x.Def == k.DefIndex)?.Name ?? $"Charm {k.DefIndex}";

    /// <summary>Finishes for a gun. Picking one applies it at once; the first line opens the wear presets.</summary>
    private MenuPage FinishPage(int team, int def, string query = "") => new()
    {
        Title = query.Trim().Length > 0 ? $"{_catalog.WeaponName(def)} \"{query.Trim()}\"" : _catalog.WeaponName(def),
        Build = () =>
        {
            var cur = _loadout.WeaponPaint(def, team);
            var items = new List<MenuItem>();
            if (cur is { PaintKit: > 0 })
                items.Add(new($"Wear: {WearName(cur.Wear)} ({cur.Wear:0.00})", pl => PushPage(pl, WearPage(
                    () => WeaponPaintOrNew(team, def).Wear,
                    (p2, w) =>
                    {
                        var p = WeaponPaintOrNew(team, def);
                        p.Wear = ClampWear(w, _catalog.SkinsFor(def).FirstOrDefault(s => s.Paint == p.PaintKit));
                        CommitWeapon(p2, team, def, p);
                    }))));
            items.Add(new("Default", pl =>
            {
                var p = WeaponPaintOrNew(team, def);
                p.PaintKit = 0;
                p.LegacyModel = false;
                CommitWeapon(pl, team, def, p);
                Flash(pl, "Default finish");
            }, Current: cur is not { PaintKit: > 0 }));
            foreach (var s in _catalog.SkinsFor(def).Where(s => Matches(s.Name, query)).Take(query.Length > 0 ? SearchLimit : int.MaxValue))
                items.Add(new(s.Name, pl =>
                {
                    var p = WeaponPaintOrNew(team, def);
                    p.Wear = p.PaintKit > 0 ? ClampWear(p.Wear, s) : ClampWear(0.01f, s);
                    p.PaintKit = s.Paint;
                    p.LegacyModel = s.Legacy;
                    CommitWeapon(pl, team, def, p);
                    Flash(pl, $"{s.Name} applied");
                }, Current: cur?.PaintKit == s.Paint));
            return items;
        }
    };

    private MenuPage WearPage(Func<float> current, Action<CCSPlayerController, float> set) => new()
    {
        Title = "Wear",
        Build = () => WearPresets.Select(w => new MenuItem(w.Name, pl =>
        {
            set(pl, w.Value);
            Flash(pl, $"{w.Name} applied");
            PopPage(pl);
        }, Current: WearName(current()) == w.Name)).ToList()
    };

    private MenuPage KnifeModelPage(CCSPlayerController player) => new()
    {
        Title = $"Knife ({TeamLabel(player)})",
        Build = () =>
        {
            var cur = _loadout.Knife.For(player.TeamNum);
            var items = new List<MenuItem>
            {
                new("Default knife", pl =>
                {
                    CommitKnife(pl, null);
                    Flash(pl, "Default knife");
                }, Current: cur is not { DefIndex: > 0 })
            };
            foreach (var k in _catalog.Weapons.Where(w => w.Kind == "knife"))
                items.Add(new(k.Name, pl =>
                {
                    var now = _loadout.Knife.For(pl.TeamNum);
                    if (now?.DefIndex != k.Def)
                    {
                        CommitKnife(pl, new KnifePaint { DefIndex = k.Def, ClassName = k.Cls, Wear = now?.Wear ?? 0.01f, Seed = now?.Seed ?? 0, StatTrak = -1 });
                        Flash(pl, $"{k.Name} applied");
                    }
                    PushPage(pl, KnifeFinishPage(pl, k));
                }, Current: cur?.DefIndex == k.Def));
            return items;
        }
    };

    private MenuPage KnifeFinishPage(CCSPlayerController player, CatalogWeapon knife) => new()
    {
        Title = knife.Name,
        Build = () =>
        {
            var cur = _loadout.Knife.For(player.TeamNum);
            var items = new List<MenuItem>();
            if (cur is { PaintKit: > 0 })
                items.Add(new($"Wear: {WearName(cur.Wear)} ({cur.Wear:0.00})", pl => PushPage(pl, WearPage(
                    () => _loadout.Knife.For(pl.TeamNum)?.Wear ?? 0,
                    (p2, w) =>
                    {
                        if (_loadout.Knife.For(p2.TeamNum) is not { } k) return;
                        k.Wear = ClampWear(w, _catalog.SkinsFor(k.DefIndex).FirstOrDefault(s => s.Paint == k.PaintKit));
                        CommitKnife(p2, k);
                    }))));
            items.Add(new("Vanilla", pl => ApplyKnifeFinish(pl, knife, null), Current: cur?.DefIndex == knife.Def && cur.PaintKit <= 0));
            foreach (var s in _catalog.SkinsFor(knife.Def))
                items.Add(new(s.Name, pl => ApplyKnifeFinish(pl, knife, s), Current: cur?.DefIndex == knife.Def && cur.PaintKit == s.Paint));
            return items;
        }
    };

    private void ApplyKnifeFinish(CCSPlayerController player, CatalogWeapon knife, CatalogSkin? skin)
    {
        var now = _loadout.Knife.For(player.TeamNum);
        var k = new KnifePaint
        {
            DefIndex = knife.Def,
            ClassName = knife.Cls,
            PaintKit = skin?.Paint ?? 0,
            Wear = ClampWear(now?.Wear ?? 0.01f, skin),
            Seed = now?.Seed ?? 0,
            StatTrak = now?.StatTrak ?? -1,
            NameTag = now?.NameTag ?? "",
            LegacyModel = skin?.Legacy ?? false
        };
        CommitKnife(player, k);
        Flash(player, $"{knife.Name} | {skin?.Name ?? "Vanilla"} applied");
    }

    private MenuPage KnifeSearchPage(CCSPlayerController player, string query) => new()
    {
        Title = $"Knives \"{query.Trim()}\"",
        Build = () =>
        {
            var cur = _loadout.Knife.For(player.TeamNum);
            var items = new List<MenuItem>();
            foreach (var k in _catalog.Weapons.Where(w => w.Kind == "knife"))
            {
                if (Matches($"{k.Name} vanilla", query))
                    items.Add(new($"{k.Name} | Vanilla", pl => ApplyKnifeFinish(pl, k, null), Current: cur?.DefIndex == k.Def && cur.PaintKit <= 0));
                foreach (var s in _catalog.SkinsFor(k.Def).Where(s => Matches($"{k.Name} {s.Name}", query)))
                    items.Add(new($"{k.Name} | {s.Name}", pl => ApplyKnifeFinish(pl, k, s), Current: cur?.DefIndex == k.Def && cur.PaintKit == s.Paint));
                if (items.Count >= SearchLimit) break;
            }
            return items;
        }
    };

    private MenuPage GloveTypePage(CCSPlayerController player) => new()
    {
        Title = $"Gloves ({TeamLabel(player)})",
        Build = () =>
        {
            var cur = _loadout.Gloves.For(player.TeamNum);
            var items = new List<MenuItem>
            {
                new("Default gloves", pl =>
                {
                    SetFor(_loadout.Gloves, pl, null);
                    SaveLoadout();
                    Flash(pl, "Default gloves from your next respawn");
                }, Current: cur is not { PaintKit: > 0 })
            };
            foreach (var g in _catalog.Weapons.Where(w => w.Kind == "glove"))
                items.Add(new(g.Name, pl => PushPage(pl, GloveFinishPage(pl, g, "")), Current: cur?.DefIndex == g.Def));
            return items;
        }
    };

    private void ApplyGlove(CCSPlayerController player, CatalogWeapon glove, CatalogSkin skin)
    {
        var now = _loadout.Gloves.For(player.TeamNum);
        SetFor(_loadout.Gloves, player, new GlovePaint
        {
            DefIndex = glove.Def,
            PaintKit = skin.Paint,
            Wear = ClampWear(now?.Wear ?? 0.01f, skin),
            Seed = now?.Seed ?? 0
        });
        SaveLoadout();
        ApplyGloves(player);
        Flash(player, $"{glove.Name} | {skin.Name} applied");
    }

    private MenuPage GloveFinishPage(CCSPlayerController player, CatalogWeapon glove, string query) => new()
    {
        Title = glove.Name,
        Build = () =>
        {
            var cur = _loadout.Gloves.For(player.TeamNum);
            var items = new List<MenuItem>();
            if (cur is { PaintKit: > 0 } && cur.DefIndex == glove.Def)
                items.Add(new($"Wear: {WearName(cur.Wear)} ({cur.Wear:0.00})", pl => PushPage(pl, WearPage(
                    () => _loadout.Gloves.For(pl.TeamNum)?.Wear ?? 0,
                    (p2, w) =>
                    {
                        if (_loadout.Gloves.For(p2.TeamNum) is not { } g) return;
                        g.Wear = ClampWear(w, _catalog.SkinsFor(g.DefIndex).FirstOrDefault(s => s.Paint == g.PaintKit));
                        SaveLoadout();
                        ApplyGloves(p2);
                    }))));
            foreach (var s in _catalog.SkinsFor(glove.Def).Where(s => Matches(s.Name, query)))
                items.Add(new(s.Name, pl => ApplyGlove(pl, glove, s), Current: cur?.DefIndex == glove.Def && cur.PaintKit == s.Paint));
            return items;
        }
    };

    private MenuPage GloveSearchPage(CCSPlayerController player, string query) => new()
    {
        Title = $"Gloves \"{query.Trim()}\"",
        Build = () =>
        {
            var cur = _loadout.Gloves.For(player.TeamNum);
            var items = new List<MenuItem>();
            foreach (var g in _catalog.Weapons.Where(w => w.Kind == "glove"))
            foreach (var s in _catalog.SkinsFor(g.Def).Where(s => Matches($"{g.Name} {s.Name}", query)))
                items.Add(new($"{g.Name} | {s.Name}", pl => ApplyGlove(pl, g, s), Current: cur?.DefIndex == g.Def && cur.PaintKit == s.Paint));
            return items.Take(SearchLimit).ToList();
        }
    };

    private MenuPage AgentPage(CCSPlayerController player, string query) => new()
    {
        Title = $"Agent ({TeamLabel(player)})",
        Build = () =>
        {
            var team = Team(player);
            var cur = _loadout.Agents.For(player.TeamNum);
            var items = new List<MenuItem>
            {
                new("Default agent", pl =>
                {
                    SetFor(_loadout.Agents, pl, null);
                    SaveLoadout();
                    Flash(pl, "Default agent from your next respawn");
                }, Current: cur is not { DefIndex: > 0 })
            };
            foreach (var a in _catalog.Agents.Where(a => a.Team == team && Matches(a.Name, query)))
                items.Add(new(a.Name, pl =>
                {
                    SetFor(_loadout.Agents, pl, new AgentPaint { DefIndex = a.Def, Model = a.Model });
                    SaveLoadout();
                    ApplyAgent(pl);
                    Flash(pl, $"{a.Name.Split(" | ")[0]} applied");
                }, Current: cur?.DefIndex == a.Def));
            return items;
        }
    };

    private string PinLabel() =>
        _loadout.Pin <= 0 ? "None" : _catalog.Pins.FirstOrDefault(p => p.Def == _loadout.Pin)?.Name ?? $"Item {_loadout.Pin}";

    private string MusicLabel() =>
        _loadout.MusicKit <= 0 ? "Default" : _catalog.MusicKits.FirstOrDefault(m => m.Def == _loadout.MusicKit)?.Name ?? $"Kit {_loadout.MusicKit}";

    /// <summary>Pin and music kit are one per loadout (not per team) and live on the controller: applied to every target.</summary>
    private void CommitProfileItems(CCSPlayerController player, string flash)
    {
        SaveLoadout();
        foreach (var p in Utilities.GetPlayers().Where(IsTarget)) ApplyProfileItems(p);
        Flash(player, flash);
    }

    private MenuPage PinPage(string query) => new()
    {
        Title = "Pin",
        Build = () =>
        {
            var items = new List<MenuItem>
            {
                new("No pin", pl => { _loadout.Pin = 0; CommitProfileItems(pl, "Pin removed"); }, Current: _loadout.Pin <= 0)
            };
            foreach (var p in _catalog.Pins.Where(p => Matches(p.Name, query)))
                items.Add(new(p.Name, pl => { _loadout.Pin = p.Def; CommitProfileItems(pl, $"{p.Name} applied"); }, Current: _loadout.Pin == p.Def));
            return items;
        }
    };

    private MenuPage MusicPage(string query) => new()
    {
        Title = "Music kit",
        Build = () =>
        {
            var items = new List<MenuItem>
            {
                new("Default music", pl => { _loadout.MusicKit = 0; CommitProfileItems(pl, "Default music"); }, Current: _loadout.MusicKit <= 0)
            };
            foreach (var m in _catalog.MusicKits.Where(m => Matches(m.Name, query)))
                items.Add(new(m.Name, pl => { _loadout.MusicKit = m.Def; CommitProfileItems(pl, $"{m.Name} applied"); }, Current: _loadout.MusicKit == m.Def));
            return items;
        }
    };

    private string GraffitiLabel()
    {
        if (_loadout.Graffiti <= 0) return "None";
        var g = _catalog.Graffiti.FirstOrDefault(x => x.Def == _loadout.Graffiti);
        var name = g?.Name ?? $"Graffiti {_loadout.Graffiti}";
        return g is { Tinted: true } && _loadout.GraffitiTint > 0 ? $"{name} ({TintName(_loadout.GraffitiTint)})" : name;
    }

    private void CommitGraffiti(CCSPlayerController player, int def, int tint, string flash)
    {
        _loadout.Graffiti = def;
        _loadout.GraffitiTint = tint;
        SaveLoadout();
        RememberGraffiti(player, def);
        Flash(player, flash);
    }

    private MenuPage GraffitiPage(string query) => new()
    {
        Title = "Graffiti",
        Build = () =>
        {
            var items = new List<MenuItem>
            {
                new("No graffiti", pl => CommitGraffiti(pl, 0, 0, "Graffiti removed"), Current: _loadout.Graffiti <= 0)
            };
            foreach (var g in _catalog.Graffiti.Where(g => Matches(g.Name, query)))
                items.Add(new(g.Tinted ? $"{g.Name} (tints)" : g.Name, pl =>
                {
                    if (g.Tinted) PushPage(pl, TintPage(g));
                    else CommitGraffiti(pl, g.Def, 0, $"{g.Name}: tap T to spray");
                }, Current: _loadout.Graffiti == g.Def));
            return items;
        }
    };

    private MenuPage TintPage(CatalogGraffiti g) => new()
    {
        Title = g.Name,
        Build = () => GraffitiTints.Select(t => new MenuItem(t.Name, pl => CommitGraffiti(pl, g.Def, t.Id, $"{g.Name} ({t.Name}): tap T to spray"),
            Current: _loadout.Graffiti == g.Def && _loadout.GraffitiTint == t.Id)).ToList()
    };

    private static StickerPaint? SlotOf(Paint p, int slot) => slot < p.Stickers.Count ? p.Stickers[slot] : null;

    private static void SetSlot(Paint p, int slot, StickerPaint? s)
    {
        while (p.Stickers.Count < 5) p.Stickers.Add(null);
        p.Stickers[slot] = s;
    }

    private MenuPage StickerSlotsPage(int team, int def) => new()
    {
        Title = $"Stickers on {_catalog.WeaponName(def)}",
        Build = () =>
        {
            var p = WeaponPaintOrNew(team, def);
            var items = new List<MenuItem>();
            for (var i = 0; i < 5; i++)
            {
                var slot = i;
                var s = SlotOf(p, slot);
                var name = s is { DefIndex: > 0 } ? _catalog.Stickers.FirstOrDefault(x => x.Def == s.DefIndex)?.Name ?? $"Sticker {s.DefIndex}" : "empty";
                items.Add(new($"Slot {slot + 1}: {name}", pl => PushPage(pl, StickerSlotPage(team, def, slot))));
            }
            items.Add(new("Tip: !sticker <name> in chat searches all stickers", Color: "#8a93a3"));
            return items;
        }
    };

    private MenuPage StickerSlotPage(int team, int def, int slot) => new()
    {
        Title = $"Slot {slot + 1}",
        Build = () =>
        {
            var s = SlotOf(WeaponPaintOrNew(team, def), slot);
            var items = new List<MenuItem>
            {
                new("Type !sticker <name> in chat to search", Color: "#8a93a3")
            };
            if (s is { DefIndex: > 0 })
            {
                items.Add(new($"Scrape: {s.Wear:0.0} (E to change)", pl =>
                {
                    var p = WeaponPaintOrNew(team, def);
                    if (SlotOf(p, slot) is not { } cur) return;
                    cur.Wear = cur.Wear >= 0.95f ? 0 : MathF.Round(cur.Wear + 0.25f, 2);
                    CommitWeapon(pl, team, def, p);
                }));
                items.Add(new("Remove sticker", pl =>
                {
                    var p = WeaponPaintOrNew(team, def);
                    SetSlot(p, slot, null);
                    CommitWeapon(pl, team, def, p);
                    Flash(pl, "Sticker removed");
                    PopPage(pl);
                }));
            }
            return items;
        }
    };

    /// <summary>Sticker search results. With a slot, picking applies there; without, it asks for the slot.</summary>
    private MenuPage StickerSearchPage(int team, int def, int? slot, string query) => new()
    {
        Title = $"Stickers \"{query.Trim()}\"",
        Build = () => _catalog.Stickers.Where(s => Matches(s.Name, query)).Take(SearchLimit).Select(s => new MenuItem(s.Name, pl =>
        {
            if (slot is { } fixedSlot) PutSticker(pl, team, def, fixedSlot, s);
            else PushPage(pl, StickerTargetPage(team, def, s));
        })).ToList()
    };

    private MenuPage StickerTargetPage(int team, int def, CatalogNamed sticker) => new()
    {
        Title = "Which slot?",
        Build = () =>
        {
            var p = WeaponPaintOrNew(team, def);
            return Enumerable.Range(0, 5).Select(i =>
            {
                var s = SlotOf(p, i);
                var name = s is { DefIndex: > 0 } ? _catalog.Stickers.FirstOrDefault(x => x.Def == s.DefIndex)?.Name ?? "?" : "empty";
                return new MenuItem($"Slot {i + 1} ({name})", pl =>
                {
                    PutSticker(pl, team, def, i, sticker);
                    PopPage(pl);
                });
            }).ToList();
        }
    };

    private void PutSticker(CCSPlayerController player, int team, int def, int slot, CatalogNamed sticker)
    {
        var p = WeaponPaintOrNew(team, def);
        var old = SlotOf(p, slot);
        SetSlot(p, slot, new StickerPaint { DefIndex = sticker.Def, Wear = old?.Wear ?? 0, Scale = old?.Scale ?? 1, Rotation = old?.Rotation ?? 0, X = old?.X ?? 0, Y = old?.Y ?? 0 });
        CommitWeapon(player, team, def, p);
        Flash(player, $"{sticker.Name} → slot {slot + 1}");
    }

    private MenuPage CharmPage(int team, int def, string query) => new()
    {
        Title = $"Charm on {_catalog.WeaponName(def)}",
        Build = () =>
        {
            var cur = _loadout.WeaponPaint(def, team)?.Keychain;
            var items = new List<MenuItem>
            {
                new("No charm", pl =>
                {
                    var p = WeaponPaintOrNew(team, def);
                    p.Keychain = null;
                    CommitWeapon(pl, team, def, p);
                    Flash(pl, "Charm removed");
                }, Current: cur is not { DefIndex: > 0 })
            };
            foreach (var k in _catalog.Keychains.Where(k => Matches(k.Name, query)))
                items.Add(new(k.Name, pl =>
                {
                    var p = WeaponPaintOrNew(team, def);
                    p.Keychain = new KeychainPaint { DefIndex = k.Def, Seed = p.Keychain?.Seed ?? 0, X = p.Keychain?.X ?? 0, Y = p.Keychain?.Y ?? 0, Z = p.Keychain?.Z ?? 0 };
                    CommitWeapon(pl, team, def, p);
                    Flash(pl, $"{k.Name} applied");
                }, Current: cur?.DefIndex == k.Def));
            return items;
        }
    };
}
