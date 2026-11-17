using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Timers;

namespace PracSkins;

/// <summary>
/// Every bot gets its own random loadout (agent, knife, gloves, a skin on every gun, sometimes a pin and a music kit)
/// instead of the user's. It's rolled when the bot is first skinned and kept while the bot stays (a new bot in the
/// same slot rolls again). Third-person stand-ins keep showing the previewing player's loadout.
/// </summary>
public partial class PracSkins
{
    private readonly Dictionary<int, LoadoutFile> _botLoadouts = new();

    /// <summary>Per bot slot and team: the rolled primary and pistol (kept while the bot stays, like its skins).</summary>
    private readonly Dictionary<(int Slot, int Team), (string Primary, string Pistol)> _botGuns = new();

    private static readonly string[] TPrimaries =
        ["weapon_ak47", "weapon_galilar", "weapon_sg556", "weapon_awp", "weapon_ssg08", "weapon_mac10", "weapon_mp7",
         "weapon_ump45", "weapon_p90", "weapon_xm1014", "weapon_nova", "weapon_bizon"];
    private static readonly string[] CtPrimaries =
        ["weapon_m4a1", "weapon_m4a1_silencer", "weapon_famas", "weapon_aug", "weapon_awp", "weapon_ssg08", "weapon_mp9",
         "weapon_mp7", "weapon_ump45", "weapon_p90", "weapon_mag7", "weapon_nova"];
    private static readonly string[] TPistols =
        ["weapon_glock", "weapon_tec9", "weapon_p250", "weapon_deagle", "weapon_cz75a", "weapon_elite"];
    private static readonly string[] CtPistols =
        ["weapon_hkp2000", "weapon_usp_silencer", "weapon_fiveseven", "weapon_p250", "weapon_deagle", "weapon_cz75a", "weapon_elite"];

    private void InitBotLoadouts()
    {
        RegisterListener<Listeners.OnClientPutInServer>(slot => ForgetBot(slot));
        RegisterListener<Listeners.OnClientDisconnect>(slot => ForgetBot(slot));
        RegisterListener<Listeners.OnMapStart>(_ => { _botLoadouts.Clear(); _botGuns.Clear(); });
        RegisterEventHandler<EventPlayerSpawn>((e, _) =>
        {
            if (e.Userid is { IsValid: true } bot && IsBotAny(bot))
                // after the game's own spawn gear (and a stand-in claim, which brings its own pose weapon)
                AddTimer(0.2f, () => GiveBotGuns(bot), TimerFlags.STOP_ON_MAPCHANGE);
            return HookResult.Continue;
        });
    }

    private void ForgetBot(int slot)
    {
        _botLoadouts.Remove(slot);
        _botGuns.Remove((slot, 2));
        _botGuns.Remove((slot, 3));
    }

    /// <summary>
    /// Swaps a bot's primary and pistol for its own rolled ones (bots all spawned with the same guns, only the skins
    /// differed). The slot's old gun leaves first: CS2 drops a second gun of the same slot on the floor.
    /// A gun the bot holds goes like the stand-in's pose swap (user-confirmed in game): the hands are emptied
    /// (networked), and the new gun is given 0.1 s later, so the engine deploys it into empty hands. Removing the held
    /// gun and giving the new one in the same tick left bots empty-handed in game with the new gun on their back,
    /// although the server had it active and deployed (live test 2026-11-17). Bots ignore server-sent `use`, `slot3`,
    /// `lastinv` (live-tested), so there is no switching them to the knife first.
    /// </summary>
    private void GiveBotGuns(CCSPlayerController bot)
    {
        if (!bot.IsValid || !IsBotAny(bot) || IsStandIn(bot) || !bot.PawnIsAlive) return;
        var team = bot.TeamNum;
        if (team is not (2 or 3)) return;
        var pawn = bot.PlayerPawn.Value;
        var services = pawn?.WeaponServices;
        if (pawn is not { IsValid: true } || services == null) return;
        var rnd = Random.Shared;
        if (!_botGuns.TryGetValue((bot.Slot, team), out var guns))
        {
            var primaries = team == 2 ? TPrimaries : CtPrimaries;
            var pistols = team == 2 ? TPistols : CtPistols;
            _botGuns[(bot.Slot, team)] = guns = (primaries[rnd.Next(primaries.Length)], pistols[rnd.Next(pistols.Length)]);
        }
        var gives = new List<string>();
        var emptied = false;
        foreach (var (slot, cls) in new[] { (gear_slot_t.GEAR_SLOT_RIFLE, guns.Primary), (gear_slot_t.GEAR_SLOT_PISTOL, guns.Pistol) })
        {
            var held = services.MyWeapons.Select(h => h.Value).Where(w => w is { IsValid: true } && GearSlot(w!) == slot).ToList();
            // already carrying it (a respawn kept it): nothing to do
            if (held.Any(w => GiveName(w!) == cls)) continue;
            foreach (var w in held)
            {
                if (services.ActiveWeapon.Value?.Index == w!.Index)
                {
                    services.ActiveWeapon.Raw = uint.MaxValue;
                    Utilities.SetStateChanged(pawn, "CPlayer_WeaponServices", "m_hActiveWeapon");
                    emptied = true;
                }
                pawn.RemovePlayerItem(w);
                w.Remove();
            }
            gives.Add(cls);
        }
        if (gives.Count == 0) return;
        void Give()
        {
            if (!bot.IsValid || !bot.PawnIsAlive || bot.TeamNum != team) return;
            foreach (var cls in gives) bot.GiveNamedItem<CBasePlayerWeapon>(cls);
        }
        // empty hands: give after the clients saw them empty; the primary goes first, so it is the one drawn
        if (emptied) AddTimer(0.1f, Give, TimerFlags.STOP_ON_MAPCHANGE);
        else Give();
    }

    /// <summary>The loadout a player wears: a bot's own random one, else the user's.</summary>
    private LoadoutFile SkinsOf(CCSPlayerController player)
    {
        if (!IsBotAny(player) || IsStandIn(player)) return _loadout;
        if (_botLoadouts.TryGetValue(player.Slot, out var l)) return l;
        l = RandomLoadout();
        // without a catalog yet there is nothing to roll from: try again next time
        if (_catalog.Weapons.Count > 0) _botLoadouts[player.Slot] = l;
        return l;
    }

    private LoadoutFile RandomLoadout()
    {
        var rnd = Random.Shared;
        var l = new LoadoutFile { Schema = LoadoutFile.CurrentSchema };
        T? Pick<T>(IList<T> list) where T : class => list.Count == 0 ? null : list[rnd.Next(list.Count)];
        float Wear(CatalogSkin s) => MathF.Round(s.Min + (float)rnd.NextDouble() * Math.Max(0, s.Max - s.Min), 4);
        int Seed() => rnd.Next(0, 1001);

        foreach (var team in new[] { 2, 3 })
        {
            var weapons = team == 2 ? l.Weapons.T : l.Weapons.Ct;
            foreach (var w in _catalog.Weapons.Where(w => w.Kind == "weapon"))
                if (Pick(_catalog.SkinsFor(w.Def)) is { } s)
                    weapons[w.Def.ToString()] = new Paint
                    {
                        PaintKit = s.Paint, Wear = Wear(s), Seed = Seed(), LegacyModel = s.Legacy,
                        StatTrak = rnd.Next(4) == 0 ? rnd.Next(0, 500) : -1
                    };

            KnifePaint? knife = null;
            if (Pick(_catalog.Weapons.Where(w => w.Kind == "knife").ToList()) is { } k)
            {
                var s = Pick(_catalog.SkinsFor(k.Def)); // null = vanilla
                knife = new KnifePaint
                {
                    DefIndex = k.Def, ClassName = k.Cls, PaintKit = s?.Paint ?? 0, Wear = s != null ? Wear(s) : 0,
                    Seed = Seed(), LegacyModel = s?.Legacy ?? false, StatTrak = -1
                };
            }

            GlovePaint? gloves = null;
            if (Pick(_catalog.Weapons.Where(w => w.Kind == "glove").ToList()) is { } g && Pick(_catalog.SkinsFor(g.Def)) is { } gs)
                gloves = new GlovePaint { DefIndex = g.Def, PaintKit = gs.Paint, Wear = Wear(gs), Seed = Seed() };

            var side = team == 2 ? "t" : "ct";
            AgentPaint? agent = Pick(_catalog.Agents.Where(a => a.Team == side && a.Model.Length > 0).ToList()) is { } a
                ? new AgentPaint { DefIndex = a.Def, Model = a.Model }
                : null;

            if (team == 2) { l.Knife.T = knife; l.Gloves.T = gloves; l.Agents.T = agent; }
            else { l.Knife.Ct = knife; l.Gloves.Ct = gloves; l.Agents.Ct = agent; }
        }
        if (rnd.Next(2) == 0) l.Pin = Pick(_catalog.Pins)?.Def ?? 0;
        if (rnd.Next(2) == 0) l.MusicKit = Pick(_catalog.MusicKits)?.Def ?? 0;
        return l;
    }
}
