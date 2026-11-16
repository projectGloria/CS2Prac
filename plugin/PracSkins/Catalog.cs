using System.Text.Json;

namespace PracSkins;

// Mirrors PluginCatalog in src/main/skins/pluginCatalog.ts (written by the app as catalog.json). Keep both in sync.

public class CatalogWeapon
{
    public int Def { get; set; }
    public string Cls { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>weapon, knife or glove</summary>
    public string Kind { get; set; } = "";
}

public class CatalogSkin
{
    public int Paint { get; set; }
    public string Name { get; set; } = "";
    public float Min { get; set; }
    public float Max { get; set; } = 1;
    public bool Legacy { get; set; }
}

public class CatalogAgent
{
    public int Def { get; set; }
    public string Name { get; set; } = "";
    /// <summary>t or ct</summary>
    public string Team { get; set; } = "";
    public string Model { get; set; } = "";
}

public class CatalogNamed
{
    public int Def { get; set; }
    public string Name { get; set; } = "";
}

public class CatalogGraffiti
{
    public int Def { get; set; }
    public string Name { get; set; } = "";
    /// <summary>comes in the 19 graffiti tints (an untinted one ignores the tint)</summary>
    public bool Tinted { get; set; }
}

public class PluginCatalog
{
    public long FetchedAt { get; set; }
    public List<CatalogWeapon> Weapons { get; set; } = new();
    public Dictionary<string, List<CatalogSkin>> Skins { get; set; } = new();
    public List<CatalogAgent> Agents { get; set; } = new();
    public List<CatalogNamed> Stickers { get; set; } = new();
    public List<CatalogNamed> Keychains { get; set; } = new();
    public List<CatalogNamed> Pins { get; set; } = new();
    public List<CatalogNamed> MusicKits { get; set; } = new();
    public List<CatalogGraffiti> Graffiti { get; set; } = new();

    public static readonly PluginCatalog Empty = new();

    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    public static PluginCatalog Load(string path) =>
        File.Exists(path) ? JsonSerializer.Deserialize<PluginCatalog>(File.ReadAllText(path), Json) ?? Empty : Empty;

    public List<CatalogSkin> SkinsFor(int def) => Skins.TryGetValue(def.ToString(), out var l) ? l : new();

    public CatalogWeapon? Weapon(int def) => Weapons.FirstOrDefault(w => w.Def == def);

    public string WeaponName(int def) => Weapon(def)?.Name ?? $"Weapon {def}";
}
