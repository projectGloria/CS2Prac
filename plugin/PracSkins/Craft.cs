using System.Text;
using System.Text.Json;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;

namespace PracSkins;

/// <summary>
/// Random craft (2026-11-18 Phase C): `css_craft` / `!craft` (and the K window's "Random craft" tile) rolls a finish,
/// wear, seed, sometimes StatTrak, 0–5 stickers (a theme: mixed, one sticker several times, one tournament, one
/// finish such as Holo/Gold) and sometimes a charm for the gun in hand. It is saved like a K-window pick (so the app's
/// profile gets it too); `!craft undo` puts back what the gun had before the last roll(s), the !gen code in chat keeps a
/// craft for later.
/// </summary>
public partial class PracSkins
{
    /// <summary>(slot, team, def) → the gun's paint before the first unkept roll (null = it had none).</summary>
    private readonly Dictionary<(int Slot, int Team, int Def), Paint?> _craftUndo = new();

    private static readonly string[] StickerFinishes = ["(Holo)", "(Gold)", "(Foil)", "(Glitter)", "(Lenticular)"];

    [ConsoleCommand("css_craft", "Random craft for the gun in your hand (css_craft undo: put the old one back)")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnCraftCommand(CCSPlayerController? player, CommandInfo command)
    {
        if (!CanEdit(player, command)) return;
        var held = HeldWeapon(player!);
        if (held is not { Kind: "weapon" })
        {
            command.ReplyToCommand($"{Tag} Hold a gun first (knives, gloves and grenades can't be crafted).");
            return;
        }
        if (command.ArgString.Trim().Equals("undo", StringComparison.OrdinalIgnoreCase))
        {
            if (!UndoCraft(player!, player!.TeamNum, held.Def, out var msg)) command.ReplyToCommand($"{Tag} {msg}");
            return;
        }
        RandomCraft(player!, player!.TeamNum, held.Def);
    }

    /// <summary>Rolls and applies a craft; returns the line shown in the K window's status.</summary>
    private string RandomCraft(CCSPlayerController player, int team, int def)
    {
        var skins = _catalog.SkinsFor(def);
        if (skins.Count == 0) return $"No skins for {_catalog.WeaponName(def)} in the catalog yet.";
        var rnd = Random.Shared;
        var skin = skins[rnd.Next(skins.Count)];
        var wear = MathF.Round(skin.Min + (float)rnd.NextDouble() * Math.Max(0, skin.Max - skin.Min), 6);
        var paint = new Paint
        {
            PaintKit = skin.Paint, Wear = wear, Seed = rnd.Next(0, 1001), LegacyModel = skin.Legacy,
            StatTrak = rnd.Next(5) == 0 ? rnd.Next(0, 2500) : -1
        };
        var theme = RollStickers(paint);
        if (_catalog.Keychains.Count > 0 && rnd.Next(3) == 0)
            paint.Keychain = new KeychainPaint { DefIndex = _catalog.Keychains[rnd.Next(_catalog.Keychains.Count)].Def, Seed = rnd.Next(0, 100001) };

        var key = (player.Slot, team, def);
        if (!_craftUndo.ContainsKey(key)) _craftUndo[key] = Clone(_loadout.WeaponPaint(def, team));
        CommitWeapon(player, team, def, paint);
        AnnounceCraft(player, team, def, paint, theme);
        return $"{_catalog.WeaponName(def)} | {skin.Name} crafted (!craft undo to go back)";
    }

    private bool UndoCraft(CCSPlayerController player, int team, int def, out string message)
    {
        var key = (player.Slot, team, def);
        if (!_craftUndo.Remove(key, out var old))
        {
            message = $"Nothing to undo for the {_catalog.WeaponName(def)}.";
            return false;
        }
        CommitWeapon(player, team, def, old ?? new Paint { StatTrak = -1 });
        message = $"{_catalog.WeaponName(def)}: back to {SkinName(def, old?.PaintKit ?? 0)}.";
        player.PrintToChat($"{ChatTag} {message}");
        return true;
    }

    private bool HasCraftUndo(CCSPlayerController player, int team, int def) => _craftUndo.ContainsKey((player.Slot, team, def));

    /// <summary>Fills paint.Stickers with a themed roll; returns the theme's name ("" = no stickers).</summary>
    private string RollStickers(Paint paint)
    {
        var rnd = Random.Shared;
        var all = _catalog.Stickers;
        paint.Stickers = new List<StickerPaint?> { null, null, null, null, null };
        if (all.Count == 0 || rnd.Next(5) == 0) return "";
        var count = rnd.Next(1, 6);
        var slots = Enumerable.Range(0, 5).OrderBy(_ => rnd.Next()).Take(count).ToList();
        var theme = "mixed";
        List<CatalogNamed> pool = all;
        CatalogNamed? only = null;
        switch (rnd.Next(4))
        {
            case 1: // one sticker several times
                only = all[rnd.Next(all.Count)];
                theme = count > 1 ? $"{count}× the same" : "single";
                break;
            case 2: // one tournament / collection (the text after the last " | ")
            {
                var events = all.Where(s => s.Name.Contains(" | ")).GroupBy(s => s.Name[(s.Name.LastIndexOf(" | ") + 3)..])
                    .Where(g => g.Count() >= 5).ToList();
                if (events.Count > 0)
                {
                    var g = events[rnd.Next(events.Count)];
                    pool = g.ToList();
                    theme = g.Key;
                }
                break;
            }
            case 3: // one finish
            {
                var finish = StickerFinishes[rnd.Next(StickerFinishes.Length)];
                var list = all.Where(s => s.Name.Contains(finish, StringComparison.OrdinalIgnoreCase)).ToList();
                if (list.Count > 0)
                {
                    pool = list;
                    theme = $"all {finish.Trim('(', ')')}";
                }
                break;
            }
        }
        var tilted = rnd.Next(3) == 0;
        foreach (var slot in slots)
        {
            var pick = only ?? pool[rnd.Next(pool.Count)];
            paint.Stickers[slot] = new StickerPaint
            {
                DefIndex = pick.Def,
                Wear = rnd.Next(4) == 0 ? MathF.Round((float)rnd.NextDouble() * 0.6f, 3) : 0,
                Scale = 1,
                Rotation = tilted ? rnd.Next(-30, 31) : 0,
                // a little off the slot's centre now and then (uv units; 0 = the slot's own spot)
                X = rnd.Next(3) == 0 ? MathF.Round(((float)rnd.NextDouble() - 0.5f) * 0.06f, 4) : 0,
                Y = rnd.Next(3) == 0 ? MathF.Round(((float)rnd.NextDouble() - 0.5f) * 0.06f, 4) : 0
            };
        }
        return theme;
    }

    private static Paint? Clone(Paint? p) => p == null ? null : JsonSerializer.Deserialize<Paint>(JsonSerializer.Serialize(p));

    /// <summary>Banner (weapon + skin, wear and float, stickers by slot, charm) and chat with the !gen code.</summary>
    private void AnnounceCraft(CCSPlayerController player, int team, int def, Paint p, string theme)
    {
        var weapon = _catalog.WeaponName(def);
        var skin = SkinName(def, p.PaintKit);
        var st = p.StatTrak >= 0 ? "StatTrak™ " : "";
        var html = new StringBuilder();
        html.Append($"<font class='fontSize-l' color='#ffd75e'>🎲 {Html(st + weapon)} | {Html(skin)}</font><br>");
        html.Append($"<font class='fontSize-s' color='#c8d2dc'>{WearName(p.Wear)} · float {p.Wear:0.0000} · seed {p.Seed}</font><br>");
        var stickers = p.Stickers.Select((s, i) => (s, i)).Where(x => x.s is { DefIndex: > 0 }).ToList();
        if (stickers.Count > 0)
        {
            html.Append($"<font class='fontSize-s' color='#9ad0ff'>Stickers ({Html(theme)}):</font><br>");
            foreach (var (s, i) in stickers)
                html.Append($"<font class='fontSize-s' color='#e6e6e6'>{i + 1}. {Html(StickerName(s!.DefIndex))}</font><br>");
        }
        if (p.Keychain is { DefIndex: > 0 } k)
            html.Append($"<font class='fontSize-s' color='#b6f5a8'>Charm: {Html(KeychainName(k.DefIndex))}</font>");
        ShowBanner(player, html.ToString(), 6f);

        player.PrintToChat($"{ChatTag} Crafted {st}{weapon} | {skin} ({WearName(p.Wear)}, {p.Wear:0.0000}, seed {p.Seed}) for {(team == 2 ? "T" : "CT")}.");
        if (stickers.Count > 0)
            player.PrintToChat($"{ChatTag} Stickers ({theme}): {string.Join(", ", stickers.Select(x => $"{x.i + 1} {StickerName(x.s!.DefIndex)}"))}");
        if (p.Keychain is { DefIndex: > 0 } kc) player.PrintToChat($"{ChatTag} Charm: {KeychainName(kc.DefIndex)}");
        player.PrintToChat($"{ChatTag} {ItemCode.ToGen(def, p.PaintKit, p.Seed, p.Wear, p.Stickers, p.Keychain)}");
        player.PrintToChat($"{ChatTag} !craft again for another roll, !craft undo to go back.");
    }

    private string KeychainName(int def) => _catalog.Keychains.FirstOrDefault(x => x.Def == def) is { } k ? ShortName(k.Name) : $"Charm {def}";
}
