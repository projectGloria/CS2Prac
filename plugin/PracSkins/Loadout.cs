using System.Text.Json;

namespace PracSkins;

// Mirrors LoadoutFile in src/main/skins/loadoutStore.ts. Keep both in sync.

public class Paint
{
    public int PaintKit { get; set; }
    public float Wear { get; set; }
    public int Seed { get; set; }
    /// <summary>-1 = no StatTrak</summary>
    public int StatTrak { get; set; } = -1;
    public string NameTag { get; set; } = "";
    public bool LegacyModel { get; set; }
}

public class KnifePaint : Paint
{
    public int DefIndex { get; set; }
    public string ClassName { get; set; } = "";
}

public class GlovePaint
{
    public int DefIndex { get; set; }
    public int PaintKit { get; set; }
    public float Wear { get; set; }
    public int Seed { get; set; }
}

public class PerTeam<TItem> where TItem : class
{
    public TItem? T { get; set; }
    public TItem? Ct { get; set; }

    /// <summary>Team numbers: 2 = Terrorist, 3 = Counter-Terrorist.</summary>
    public TItem? For(int teamNum) => teamNum switch { 2 => T, 3 => Ct, _ => null };
}

public class LoadoutFile
{
    public int Schema { get; set; }
    /// <summary>SteamID64 that receives the skins; null = every player, bots included.</summary>
    public string? Owner { get; set; }
    public Dictionary<string, Paint> Weapons { get; set; } = new();
    public PerTeam<KnifePaint> Knife { get; set; } = new();
    public PerTeam<GlovePaint> Gloves { get; set; } = new();

    public static readonly LoadoutFile Empty = new() { Schema = 1 };

    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    public static LoadoutFile Load(string path)
    {
        if (!File.Exists(path)) return Empty;
        var file = JsonSerializer.Deserialize<LoadoutFile>(File.ReadAllText(path), Json) ?? Empty;
        if (file.Schema != 1) throw new InvalidDataException($"Unsupported loadout schema {file.Schema}");
        return file;
    }

    public Paint? WeaponPaint(int defIndex) =>
        Weapons.TryGetValue(defIndex.ToString(), out var p) && p.PaintKit > 0 ? p : null;
}

public class Signatures
{
    public string Windows { get; set; } = "";
    public string Linux { get; set; } = "";

    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    public static Signatures? Load(string path) =>
        File.Exists(path) ? JsonSerializer.Deserialize<Signatures>(File.ReadAllText(path), Json) : null;
}
