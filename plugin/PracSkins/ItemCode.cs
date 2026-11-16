using System.Globalization;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;

namespace PracSkins;

/// <summary>A decoded !gen code or inspect link (same rules as src/shared/itemCode.ts).</summary>
public class ImportedItem
{
    public int Def;
    public int Paint;
    public int Seed;
    public float Wear;
    public int StatTrak = -1;
    public string NameTag = "";
    public StickerPaint?[] Stickers = new StickerPaint?[5];
    public KeychainPaint? Keychain;
}

public static class ItemCode
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    /// <summary>Parses "!gen def paint seed wear [sticker wear]x5 [charm seed]", a bare gen code or an inspect link/hex.</summary>
    public static ImportedItem? Parse(string text, out string error)
    {
        error = "";
        var t = Uri.UnescapeDataString(text.Trim());
        if (System.Text.RegularExpressions.Regex.IsMatch(t, @"[SM]\d+A\d+D\d+"))
        {
            error = "That inspect link points at a Steam inventory item; it can't be read locally. Use a !gen code.";
            return null;
        }
        var hex = System.Text.RegularExpressions.Regex.Matches(t, "[0-9a-fA-F]{20,}").LastOrDefault()?.Value;
        if (hex != null && (t.Contains("csgo_econ_action_preview") || hex.Length == t.Length)) return ParseInspect(hex, out error);
        return ParseGen(t, out error);
    }

    public static ImportedItem? ParseGen(string text, out string error)
    {
        error = "";
        var parts = System.Text.RegularExpressions.Regex.Replace(text.Trim(), @"^[!/.]?(gen|g)\b", "", System.Text.RegularExpressions.RegexOptions.IgnoreCase)
            .Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 4)
        {
            error = "Usage: !gen <weapon> <paint> <seed> <wear> [sticker wear]x5 [charm seed]";
            return null;
        }
        var n = new double[parts.Length];
        for (var i = 0; i < parts.Length; i++)
            if (!double.TryParse(parts[i], NumberStyles.Float, Inv, out n[i]))
            {
                error = "A !gen code holds numbers only.";
                return null;
            }
        if (n[0] <= 0 || n[1] < 0 || n[3] < 0 || n[3] > 1)
        {
            error = "Weapon, paint or wear is not valid.";
            return null;
        }
        var item = new ImportedItem { Def = (int)n[0], Paint = (int)n[1], Seed = (int)n[2], Wear = (float)n[3] };
        var i2 = 4;
        for (var slot = 0; slot < 5 && i2 + 1 < n.Length; slot++, i2 += 2)
            if ((int)n[i2] > 0)
                item.Stickers[slot] = new StickerPaint { DefIndex = (int)n[i2], Wear = (float)Math.Clamp(n[i2 + 1], 0, 1), Scale = 1 };
        if (i2 < n.Length && (int)n[i2] > 0)
            item.Keychain = new KeychainPaint { DefIndex = (int)n[i2], Seed = i2 + 1 < n.Length ? (int)n[i2 + 1] : 0 };
        return item;
    }

    public static ImportedItem? ParseInspect(string hex, out string error)
    {
        error = "";
        try
        {
            if (hex.Length % 2 != 0) throw new FormatException();
            var raw = Convert.FromHexString(hex);
            var key = raw[0];
            for (var i = 0; i < raw.Length; i++) raw[i] ^= key;
            if (raw.Length < 6) throw new FormatException();
            var fields = Read(raw.AsSpan(1, raw.Length - 5).ToArray());
            var item = new ImportedItem();
            var hasKillEater = false;
            foreach (var f in fields)
                switch (f.No)
                {
                    case 3: item.Def = (int)f.Num; break;
                    case 4: item.Paint = (int)f.Num; break;
                    case 7: item.Wear = f.Wire == 5 ? f.F32 : BitConverter.Int32BitsToSingle((int)(uint)f.Num); break;
                    case 8: item.Seed = (int)f.Num; break;
                    case 9: hasKillEater = true; break;
                    case 10: hasKillEater = true; item.StatTrak = (int)f.Num; break;
                    case 11: item.NameTag = System.Text.Encoding.UTF8.GetString(f.Bytes); break;
                    case 12:
                    {
                        var s = Read(f.Bytes);
                        var slot = (int)Num(s, 1);
                        var id = (int)Num(s, 2);
                        if (id <= 0 || slot is < 0 or > 4) break;
                        var scale = F32(s, 4);
                        item.Stickers[slot] = new StickerPaint
                        {
                            DefIndex = id, Wear = Math.Clamp(F32(s, 3), 0, 1), Scale = scale > 0 ? scale : 1,
                            Rotation = F32(s, 5), X = F32(s, 7), Y = F32(s, 8)
                        };
                        break;
                    }
                    case 20 when item.Keychain == null:
                    {
                        var s = Read(f.Bytes);
                        var id = (int)Num(s, 2);
                        if (id > 0) item.Keychain = new KeychainPaint { DefIndex = id, X = F32(s, 7), Y = F32(s, 8), Z = F32(s, 9), Seed = (int)Num(s, 10) };
                        break;
                    }
                }
            if (hasKillEater && item.StatTrak < 0) item.StatTrak = 0;
            item.Wear = Math.Clamp(item.Wear, 0, 1);
            if (item.Def <= 0) throw new FormatException();
            return item;
        }
        catch
        {
            error = "The inspect link's item data could not be read.";
            return null;
        }
    }

    private record Field(int No, int Wire, ulong Num, float F32, byte[] Bytes);

    private static ulong Num(List<Field> f, int no) => f.FirstOrDefault(x => x.No == no)?.Num ?? 0;
    private static float F32(List<Field> f, int no) => f.FirstOrDefault(x => x.No == no)?.F32 ?? 0;

    private static List<Field> Read(byte[] b)
    {
        var list = new List<Field>();
        var p = 0;
        ulong Varint()
        {
            ulong r = 0;
            for (var shift = 0; shift < 64; shift += 7)
            {
                if (p >= b.Length) throw new FormatException();
                var x = b[p++];
                r |= (ulong)(x & 0x7f) << shift;
                if ((x & 0x80) == 0) return r;
            }
            throw new FormatException();
        }
        while (p < b.Length)
        {
            var tag = Varint();
            var no = (int)(tag >> 3);
            var wire = (int)(tag & 7);
            switch (wire)
            {
                case 0: list.Add(new(no, 0, Varint(), 0, Array.Empty<byte>())); break;
                case 5:
                    if (p + 4 > b.Length) throw new FormatException();
                    list.Add(new(no, 5, BitConverter.ToUInt32(b, p), BitConverter.ToSingle(b, p), Array.Empty<byte>()));
                    p += 4;
                    break;
                case 1:
                    p += 8;
                    break;
                case 2:
                {
                    var len = (int)Varint();
                    if (len < 0 || p + len > b.Length) throw new FormatException();
                    list.Add(new(no, 2, 0, 0, b[p..(p + len)]));
                    p += len;
                    break;
                }
                default: throw new FormatException();
            }
        }
        return list;
    }

    public static string ToGen(int def, int paint, int seed, float wear, IList<StickerPaint?>? stickers, KeychainPaint? keychain)
    {
        var parts = new List<string> { "!gen", def.ToString(), paint.ToString(), seed.ToString(), wear.ToString("0.######", Inv) };
        if ((stickers?.Any(s => s is { DefIndex: > 0 }) ?? false) || keychain is { DefIndex: > 0 })
        {
            for (var i = 0; i < 5; i++)
            {
                var s = stickers != null && i < stickers.Count ? stickers[i] : null;
                parts.Add((s?.DefIndex ?? 0).ToString());
                parts.Add((s?.Wear ?? 0).ToString("0.######", Inv));
            }
            if (keychain is { DefIndex: > 0 }) parts.AddRange(new[] { keychain.DefIndex.ToString(), keychain.Seed.ToString() });
        }
        return string.Join(' ', parts);
    }
}

public partial class PracSkins
{
    [ConsoleCommand("css_gen", "Apply a !gen code or inspect link (no argument: show the !gen code of the weapon in your hand)")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnGenCommand(CCSPlayerController? player, CommandInfo command)
    {
        if (!CanEdit(player, command)) return;
        var team = player!.TeamNum;
        var arg = command.ArgString.Trim().Trim('"');
        if (arg.Length == 0)
        {
            var held = HeldWeapon(player);
            string? code = held?.Kind switch
            {
                "weapon" when _loadout.WeaponPaint(held.Def, team) is { } p => ItemCode.ToGen(held.Def, p.PaintKit, p.Seed, p.Wear, p.Stickers, p.Keychain),
                "knife" when _loadout.Knife.For(team) is { } k => ItemCode.ToGen(k.DefIndex, k.PaintKit, k.Seed, k.Wear, null, null),
                _ => null
            };
            command.ReplyToCommand(code != null ? $"{Tag} {code}" : $"{Tag} Usage: !gen <weapon> <paint> <seed> <wear> [sticker wear]x5 [charm seed]");
            return;
        }
        var item = ItemCode.Parse(arg, out var error);
        if (item == null)
        {
            command.ReplyToCommand($"{Tag} {error}");
            return;
        }
        var w = _catalog.Weapon(item.Def);
        if (w == null)
        {
            command.ReplyToCommand($"{Tag} Unknown item {item.Def}.");
            return;
        }
        var skin = _catalog.SkinsFor(item.Def).FirstOrDefault(s => s.Paint == item.Paint);
        var seed = Math.Clamp(item.Seed, 0, 1000);
        var name = $"{w.Name} | {SkinName(item.Def, item.Paint)}";
        switch (w.Kind)
        {
            case "glove":
                SetFor(_loadout.Gloves, player, new GlovePaint { DefIndex = item.Def, PaintKit = item.Paint, Wear = item.Wear, Seed = seed });
                SaveLoadout();
                RefreshPlayer(player);
                break;
            case "knife":
                CommitKnife(player, new KnifePaint
                {
                    DefIndex = item.Def, ClassName = w.Cls, PaintKit = item.Paint, Wear = item.Wear, Seed = seed, StatTrak = item.StatTrak,
                    NameTag = item.NameTag.Length > 20 ? item.NameTag[..20] : item.NameTag, LegacyModel = skin?.Legacy ?? false
                });
                break;
            default:
                CommitWeapon(player, team, item.Def, new Paint
                {
                    PaintKit = item.Paint, Wear = item.Wear, Seed = seed, StatTrak = item.StatTrak,
                    NameTag = item.NameTag.Length > 20 ? item.NameTag[..20] : item.NameTag, LegacyModel = skin?.Legacy ?? false,
                    Stickers = item.Stickers.ToList(), Keychain = item.Keychain
                });
                break;
        }
        command.ReplyToCommand($"{Tag} {name} applied ({(team == 2 ? "T" : "CT")}).");
    }
}
