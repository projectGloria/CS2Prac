// CS2Prac model exporter: weapon models from the local CS2 install → files the Loadout page's 3D editor reads.
//
//   ModelExport list   <csgoDir>                       JSON array of weapon model paths (weapons/models/**.vmdl_c)
//   ModelExport export <csgoDir> <outDir> <model>...   per model: <name>.glb (geometry only), <name>.jpg (base colour
//                                                      of the HD body, ≤ 1024 px) and <name>.json (sticker + charm
//                                                      markup); one JSON line per model on stdout
//
// Read-only on the game files. Nothing here talks to Steam or the network.
using System.Text.Json;
using System.Text.Json.Nodes;
using SkiaSharp;
using SteamDatabase.ValvePak;
using ValveKeyValue;
using ValveResourceFormat;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;
using ValveResourceFormat.Serialization.KeyValues;

static int Fail(string msg)
{
    Console.Error.WriteLine(msg);
    return 1;
}

if (args.Length < 2) return Fail("usage: ModelExport list <csgoDir> | export <csgoDir> <outDir> <model>...");
var csgo = args[1];
var vpkPath = Path.Combine(csgo, "pak01_dir.vpk");
if (!File.Exists(vpkPath)) return Fail($"missing {vpkPath}");

using var pak = new Package();
pak.Read(vpkPath);

if (args[0] == "list")
{
    var list = new JsonArray();
    if (pak.Entries != null && pak.Entries.TryGetValue("vmdl_c", out var entries))
        foreach (var e in entries)
        {
            var p = e.GetFullPath();
            if (p.StartsWith("weapons/models/", StringComparison.Ordinal) && Path.GetFileName(p).StartsWith("weapon_", StringComparison.Ordinal))
                list.Add(p);
        }
    Console.WriteLine(list.ToJsonString());
    return 0;
}

if (args[0] != "export" || args.Length < 4) return Fail("usage: ModelExport export <csgoDir> <outDir> <model>...");
var outDir = args[2];
Directory.CreateDirectory(outDir);
using var loader = new GameFileLoader(pak, vpkPath);

var failed = 0;
foreach (var model in args.Skip(3))
{
    var line = new JsonObject { ["model"] = model };
    try
    {
        Export(model);
        line["ok"] = true;
    }
    catch (Exception ex)
    {
        failed++;
        line["ok"] = false;
        line["error"] = ex.Message;
    }
    Console.WriteLine(line.ToJsonString());
}
return failed == 0 ? 0 : 2;

void Export(string modelPath)
{
    var entry = pak.FindEntry(modelPath) ?? throw new FileNotFoundException("not in the VPK: " + modelPath);
    pak.ReadEntry(entry, out var bytes);
    using var res = new Resource { FileName = modelPath };
    res.Read(new MemoryStream(bytes));
    if (res.DataBlock is not Model model) throw new InvalidDataException("not a model");
    var name = Path.GetFileNameWithoutExtension(modelPath);

    var glb = Path.Combine(outDir, name + ".glb");
    var exporter = new GltfModelExporter(loader)
    {
        ProgressReporter = new Progress<string>(_ => { }),
        ExportAnimations = false,
        ExportMaterials = false,
        AdaptTextures = false,
        SatelliteImages = false,
        ExportExtras = false,
    };
    // the exporter derives side files from the name, so write into a scratch folder and move the .glb
    var scratch = Path.Combine(outDir, ".part");
    Directory.CreateDirectory(scratch);
    exporter.Export(res, Path.Combine(scratch, name + ".glb"), CancellationToken.None);
    File.Move(Path.Combine(scratch, name + ".glb"), glb, true);
    foreach (var f in Directory.GetFiles(scratch)) File.Delete(f);

    var info = new JsonObject { ["model"] = modelPath, ["glb"] = name + ".glb" };
    var meshNames = new JsonArray();
    string? texture = null;
    foreach (var (mesh, meshName) in Meshes(model))
    {
        meshNames.Add(meshName);
        if (texture == null && !meshName.Contains("legacy", StringComparison.OrdinalIgnoreCase))
            texture = SaveBaseColor(mesh, Path.Combine(outDir, name + ".jpg")) ? name + ".jpg" : null;
    }
    info["meshes"] = meshNames;
    info["texture"] = texture;
    AddMarkup(model, info);
    var json = Path.Combine(outDir, name + ".json");
    File.WriteAllText(json + ".tmp", info.ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
    File.Move(json + ".tmp", json, true);
}

IEnumerable<(Mesh Mesh, string Name)> Meshes(Model model)
{
    foreach (var m in model.GetEmbeddedMeshesAndLoD())
        yield return (m.Mesh, m.Name);
    foreach (var r in model.GetReferenceMeshNamesAndLoD())
    {
        var mres = loader.LoadFileCompiled(r.MeshName);
        if (mres?.DataBlock is Mesh mesh) yield return (mesh, Path.GetFileNameWithoutExtension(r.MeshName));
    }
}

/// The first draw call's g_tColor, downscaled to ≤ 1024 px, as JPEG.
bool SaveBaseColor(Mesh mesh, string file)
{
    foreach (var so in mesh.Data.GetArray("m_sceneObjects") ?? [])
        foreach (var dc in so.GetArray("m_drawCalls") ?? [])
        {
            var matPath = dc.GetStringProperty("m_material");
            if (string.IsNullOrEmpty(matPath)) continue;
            using var matRes = loader.LoadFileCompiled(matPath);
            if (matRes?.DataBlock is not Material mat || !mat.TextureParams.TryGetValue("g_tColor", out var texPath)) continue;
            using var texRes = loader.LoadFileCompiled(texPath);
            if (texRes?.DataBlock is not Texture tex) continue;
            uint mip = 0;
            while ((tex.Width >> (int)mip) > 1024 && mip + 1 < tex.NumMipLevels) mip++;
            using var bmp = tex.GenerateBitmap(mipLevel: mip);
            using var img = SKImage.FromBitmap(bmp);
            using var data = img.Encode(SKEncodedImageFormat.Jpeg, 85);
            using (var f = File.Create(file + ".tmp")) data.SaveTo(f);
            File.Move(file + ".tmp", file, true);
            return true;
        }
    return false;
}

/// StickerMarkup / KeychainMarkup out of the model's m_keyValueText (KV3 text).
void AddMarkup(Model model, JsonObject info)
{
    var stickers = new JsonArray();
    var keychains = new JsonArray();
    info["stickers"] = stickers;
    info["keychains"] = keychains;
    var text = model.Data.GetSubCollection("m_modelInfo")?.GetStringProperty("m_keyValueText");
    if (string.IsNullOrWhiteSpace(text)) return;
    // ParseKV3(string) takes a file path
    var kv = KVDocumentExtensions.ParseKV3(new MemoryStream(System.Text.Encoding.UTF8.GetBytes(text))).Root;

    foreach (var s in kv.GetArray("StickerMarkup") ?? [])
    {
        var off = s.GetFloatArray("Offset") ?? [0f, 0f];
        var polys = new JsonArray();
        foreach (var poly in s.GetArray("Polygons") ?? [])
            polys.Add(new JsonArray((poly.GetFloatArray("Vertices") ?? []).Select(v => (JsonNode?)JsonValue.Create(MathF.Round(v, 5))).ToArray()));
        stickers.Add(new JsonObject
        {
            ["index"] = s.GetInt32Property("Index"),
            ["mesh"] = s.GetStringProperty("Mesh") ?? "body_hd",
            ["offset"] = new JsonArray(off[0], off.Length > 1 ? off[1] : 0f),
            ["scale"] = s.GetFloatProperty("Scale", 1f),
            ["rotation"] = s.GetFloatProperty("Rotation", 0f),
            ["special"] = s.GetStringProperty("SpecialIdentifier") ?? "",
            ["polygons"] = polys,
        });
    }
    foreach (var k in kv.GetArray("KeychainMarkup") ?? [])
    {
        var corners = k.GetFloatArray("Corners") ?? [];
        if (corners.Length < 12) continue;
        keychains.Add(new JsonObject
        {
            ["mesh"] = k.GetBooleanProperty("LegacyModel", false) ? "body_legacy" : "body_hd",
            ["bone"] = k.GetStringProperty("BoneName") ?? "",
            ["default"] = k.GetBooleanProperty("DefaultLocation", false),
            ["corners"] = new JsonArray(corners.Take(12).Select(v => (JsonNode?)JsonValue.Create(MathF.Round(v, 4))).ToArray()),
        });
    }
}
