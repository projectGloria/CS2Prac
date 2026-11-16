using System.Text.Json;
using System.Text.Json.Serialization;

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
    /// <summary>Weapons only: 5 slots, null = empty.</summary>
    public List<StickerPaint?> Stickers { get; set; } = new();
    /// <summary>Weapons only.</summary>
    public KeychainPaint? Keychain { get; set; }

    [JsonIgnore]
    public bool HasExtras => Stickers.Any(s => s is { DefIndex: > 0 }) || Keychain is { DefIndex: > 0 };
}

public class StickerPaint
{
    public int DefIndex { get; set; }
    public float Wear { get; set; }
    public float Scale { get; set; } = 1;
    public float Rotation { get; set; }
    public float X { get; set; }
    public float Y { get; set; }
}

public class KeychainPaint
{
    public int DefIndex { get; set; }
    public float X { get; set; }
    public float Y { get; set; }
    public float Z { get; set; }
    public int Seed { get; set; }
}

public class AgentPaint
{
    public int DefIndex { get; set; }
    /// <summary>e.g. agents/models/tm_professional/tm_professional_varf5.vmdl</summary>
    public string Model { get; set; } = "";
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

/// <summary>Weapon paints per team, keyed by def index. Schema 3: {"t":{...},"ct":{...}}.</summary>
[JsonConverter(typeof(TeamWeaponsConverter))]
public class TeamWeapons
{
    public Dictionary<string, Paint> T { get; set; } = new();
    public Dictionary<string, Paint> Ct { get; set; } = new();

    /// <summary>Team numbers: 2 = Terrorist, 3 = Counter-Terrorist.</summary>
    public Dictionary<string, Paint>? For(int teamNum) => teamNum switch { 2 => T, 3 => Ct, _ => null };

    public int Count => T.Count + Ct.Count;
}

/// <summary>Reads schema 3 ({"t":{}, "ct":{}}) and schema 1/2 (one map for both teams, copied to each).</summary>
public class TeamWeaponsConverter : JsonConverter<TeamWeapons>
{
    public override TeamWeapons Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var doc = JsonDocument.ParseValue(ref reader);
        var root = doc.RootElement;
        var result = new TeamWeapons();
        if (root.ValueKind != JsonValueKind.Object) return result;
        Dictionary<string, Paint> Map(JsonElement e) =>
            e.ValueKind == JsonValueKind.Object ? e.Deserialize<Dictionary<string, Paint>>(options) ?? new() : new();
        bool perTeam = false;
        foreach (var prop in root.EnumerateObject())
        {
            if (prop.Name.Equals("t", StringComparison.OrdinalIgnoreCase)) { result.T = Map(prop.Value); perTeam = true; }
            else if (prop.Name.Equals("ct", StringComparison.OrdinalIgnoreCase)) { result.Ct = Map(prop.Value); perTeam = true; }
        }
        if (!perTeam)
        {
            result.T = Map(root);
            result.Ct = Map(root); // separate copy
        }
        return result;
    }

    public override void Write(Utf8JsonWriter writer, TeamWeapons value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        writer.WritePropertyName("t");
        JsonSerializer.Serialize(writer, value.T, options);
        writer.WritePropertyName("ct");
        JsonSerializer.Serialize(writer, value.Ct, options);
        writer.WriteEndObject();
    }
}

public class LoadoutFile
{
    public int Schema { get; set; }
    /// <summary>SteamID64 that receives the skins; null = every player, bots included.</summary>
    public string? Owner { get; set; }
    public TeamWeapons Weapons { get; set; } = new();
    public PerTeam<KnifePaint> Knife { get; set; } = new();
    public PerTeam<GlovePaint> Gloves { get; set; } = new();
    public PerTeam<AgentPaint> Agents { get; set; } = new();
    /// <summary>Profile display item (scoreboard pin/coin) def index, 0 = none. Schema 4.</summary>
    public int Pin { get; set; }
    /// <summary>Music kit def index, 0 = none. Schema 4.</summary>
    public int MusicKit { get; set; }
    /// <summary>Graffiti (sticker kit def index, 0 = none) and its tint (1-19, 0 = none). Schema 5.</summary>
    public int Graffiti { get; set; }
    public int GraffitiTint { get; set; }
    /// <summary>Every agent model, precached at map load so agents can be switched without a map change.</summary>
    public List<string> Precache { get; set; } = new();

    public const int CurrentSchema = 5;

    public static readonly LoadoutFile Empty = new() { Schema = CurrentSchema };

    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    private static readonly JsonSerializerOptions WriteJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true
    };

    /// <summary>Writes the file the app reads back (atomic: temp file + rename, so the app never sees half a file).</summary>
    public void Save(string path)
    {
        Schema = CurrentSchema;
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(this, WriteJson));
        File.Move(tmp, path, overwrite: true);
    }

    public static LoadoutFile Load(string path)
    {
        if (!File.Exists(path)) return Empty;
        var file = JsonSerializer.Deserialize<LoadoutFile>(File.ReadAllText(path), Json) ?? Empty;
        // 1 = before stickers/keychains/agents (those are empty then); 1 and 2 have one weapon map for both teams;
        // 4 added pin and musicKit (0 before), 5 graffiti and graffitiTint
        if (file.Schema is not (1 or 2 or 3 or 4 or 5)) throw new InvalidDataException($"Unsupported loadout schema {file.Schema}");
        return file;
    }

    public Paint? WeaponPaint(int defIndex, int teamNum) =>
        Weapons.For(teamNum) is { } map && map.TryGetValue(defIndex.ToString(), out var p) && (p.PaintKit > 0 || p.HasExtras) ? p : null;
}

public class Signatures
{
    public string Windows { get; set; } = "";
    public string Linux { get; set; } = "";

    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    public static Signatures? Load(string path) =>
        File.Exists(path) ? JsonSerializer.Deserialize<Signatures>(File.ReadAllText(path), Json) : null;
}
