using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;

namespace PracSkins;

// Item info (2026-11-18 Phase I): `css_info` / `!info` prints what the held item is (finish, rarity, collection, wear,
// weapon stats) to chat. The lines come from catalog.json: skins' Info (itemInfo.ts metaLine) and weapons' Stats
// (weaponStatLine, from the game's weapons.vdata). The K window heading shows the same Info for the picked finish.
public partial class PracSkins
{
    [ConsoleCommand("css_info", "What the item in your hand is: finish, rarity, collection and weapon stats")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnInfoCommand(CCSPlayerController? player, CommandInfo command)
    {
        if (player is not { IsValid: true }) return;
        var held = HeldWeapon(player);
        if (held == null)
        {
            command.ReplyToCommand($"{Tag} Hold a gun or knife first.");
            return;
        }
        foreach (var line in InfoLines(player.TeamNum, held)) player.PrintToChat($"{Tag} {line}");
    }

    private IEnumerable<string> InfoLines(int team, CatalogWeapon held)
    {
        var (skin, wear, statTrak) = PickedSkin(team, held);
        if (skin != null)
        {
            yield return $"{held.Name} | {skin.Name}{(statTrak ? " (StatTrak)" : "")}";
            if (skin.Info.Length > 0) yield return skin.Info;
            yield return $"Wear {wear:0.0000} ({WearShort(wear)}), range {skin.Min:0.00}-{skin.Max:0.00}, paint kit {skin.Paint}";
        }
        else yield return $"{held.Name} (no finish picked)";
        if (held.Stats.Length > 0) yield return held.Stats;
    }

    /// <summary>The finish this team wears on the weapon (knife: only when the held knife is the picked one).</summary>
    private (CatalogSkin? Skin, float Wear, bool StatTrak) PickedSkin(int team, CatalogWeapon w)
    {
        int paint;
        float wear;
        bool st;
        if (w.Kind == "knife")
        {
            if (_loadout.Knife.For(team) is not { DefIndex: > 0, PaintKit: > 0 } k || k.DefIndex != w.Def) return (null, 0, false);
            (paint, wear, st) = (k.PaintKit, k.Wear, k.StatTrak >= 0);
        }
        else
        {
            if (_loadout.WeaponPaint(w.Def, team) is not { PaintKit: > 0 } p) return (null, 0, false);
            (paint, wear, st) = (p.PaintKit, p.Wear, p.StatTrak >= 0);
        }
        return (_catalog.SkinsFor(w.Def).FirstOrDefault(s => s.Paint == paint), wear, st);
    }

    /// <summary>" · Classified · The Phoenix Collection" for the K window heading, or "".</summary>
    private string HeadingInfo(int team, int def)
    {
        var w = _catalog.Weapon(def);
        if (w == null) return "";
        var (skin, _, _) = PickedSkin(team, w);
        if (skin == null) return "";
        return skin.Info.Length > 0 ? $" · {skin.Name} · {skin.Info}" : $" · {skin.Name}";
    }

    private static string WearShort(float w) => w switch
    {
        < 0.07f => "FN",
        < 0.15f => "MW",
        < 0.38f => "FT",
        < 0.45f => "WW",
        _ => "BS"
    };
}
