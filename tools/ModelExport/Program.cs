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

if (args[0] == "paint")
{
    // ModelExport paint <csgoDir> <outDir> <paintKit>...: per paint kit <outDir>/paint_<n>.png (the pattern texture,
    // ≤ 1024 px) and paint_<n>.json (style, colours, pattern placement); one JSON line per kit on stdout
    if (args.Length < 4) return Fail("usage: ModelExport paint <csgoDir> <outDir> <paintKit>...");
    var pOut = args[2];
    Directory.CreateDirectory(pOut);
    using var pLoader = new GameFileLoader(pak, vpkPath);
    var kits = PaintKits();
    var bad = 0;
    foreach (var a in args.Skip(3))
    {
        var line = new JsonObject { ["paintKit"] = a };
        try
        {
            if (!int.TryParse(a, out var def) || !kits.TryGetValue(def, out var kit)) throw new KeyNotFoundException("unknown paint kit " + a);
            ExportPaint(pLoader, def, kit.Name, kit.Composite, pOut);
            line["ok"] = true;
        }
        catch (Exception ex)
        {
            bad++;
            line["ok"] = false;
            line["error"] = ex.Message;
        }
        Console.WriteLine(line.ToJsonString());
    }
    return bad == 0 ? 0 : 2;
}

if (args[0] == "sky")
{
    // ModelExport sky <csgoDir> <outDir> <material>...: per sky material a 320×180 thumbnail <outDir>/sky_<name>.jpg
    // (the horizon of the sky texture, cubemaps unwrapped to lat-long first); one JSON line per material on stdout
    if (args.Length < 4) return Fail("usage: ModelExport sky <csgoDir> <outDir> <material>...");
    var sOut = args[2];
    Directory.CreateDirectory(sOut);
    using var sLoader = new GameFileLoader(pak, vpkPath);
    var bad = 0;
    foreach (var a in args.Skip(3))
    {
        var line = new JsonObject { ["material"] = a };
        try
        {
            line["file"] = ExportSky(sLoader, a, sOut);
            line["ok"] = true;
        }
        catch (Exception ex)
        {
            bad++;
            line["ok"] = false;
            line["error"] = ex.Message;
        }
        Console.WriteLine(line.ToJsonString());
    }
    return bad == 0 ? 0 : 2;
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

/// items_game paint_kits: def -> (name, composite_material_path or null)
Dictionary<int, (string Name, string? Composite)> PaintKits()
{
    var entry = pak.FindEntry("scripts/items/items_game.txt") ?? throw new FileNotFoundException("items_game.txt");
    pak.ReadEntry(entry, out var bytes);
    var doc = KVSerializer.Create(KVSerializationFormat.KeyValues1Text).Deserialize(new MemoryStream(bytes));
    var kits = new Dictionary<int, (string, string?)>();
    foreach (var (key, section) in doc.Root.Children)
    {
        if (key != "paint_kits") continue;
        foreach (var (defText, kit) in section.Children)
        {
            if (!int.TryParse(defText, out var def) || !kit.IsCollection) continue;
            var name = kit.GetStringProperty("name");
            if (!string.IsNullOrEmpty(name)) kits[def] = (name, kit.GetStringProperty("composite_material_path"));
        }
    }
    return kits;
}

/// Pattern texture + parameters of one paint kit. Parameters come from the kit's composite material: the material
/// it names (legacy kits: paints/vmats/<name>.vmat; community kits: a template) and its loose variables, later ones
/// overriding earlier ones, as the game layers them.
void ExportPaint(GameFileLoader ld, int def, string name, string? composite, string dir)
{
    var p = new Dictionary<string, object>();
    void FromMaterial(string path)
    {
        using var r = ld.LoadFileCompiled(path);
        if (r?.DataBlock is not Material m) return;
        foreach (var (k, v) in m.TextureParams) p[k] = v;
        foreach (var (k, v) in m.VectorParams) p[k] = v;
        foreach (var (k, v) in m.FloatParams) p[k] = v;
        foreach (var (k, v) in m.IntParams) p[k] = (float)v;
    }
    void Walk(KVObject o)
    {
        if (!o.IsCollection && !o.IsArray) return;
        switch (o.IsCollection ? o.GetStringProperty("m_nCompositeMaterialInputContainerSourceType") : null)
        {
            case "CONTAINER_SOURCE_TYPE_SPECIFIC_MATERIAL":
                if (o.GetStringProperty("m_strSpecificContainerMaterial") is { Length: > 0 } mat) FromMaterial(mat);
                return;
            case "CONTAINER_SOURCE_TYPE_LOOSE_VARIABLES":
                foreach (var v in o.GetArray("m_vecLooseVariables") ?? []) LooseVar(v);
                return;
        }
        foreach (var child in o.Values) Walk(child);
    }
    void LooseVar(KVObject v)
    {
        var n = v.GetStringProperty("m_strName");
        if (string.IsNullOrEmpty(n)) return;
        switch (v.GetStringProperty("m_nVariableType"))
        {
            case "LOOSE_VARIABLE_TYPE_RESOURCE_TEXTURE":
                if (v.GetStringProperty("m_strTextureRuntimeResourcePath") is { Length: > 0 } t) p[n] = t;
                break;
            case "LOOSE_VARIABLE_TYPE_COLOR4":
                var c = v.GetFloatArray("m_cValueColor4") ?? [];
                if (c.Length >= 3) p[n] = new System.Numerics.Vector4(c[0] / 255f, c[1] / 255f, c[2] / 255f, 1);
                break;
            case "LOOSE_VARIABLE_TYPE_FLOAT1":
                p[n] = v.GetFloatProperty("m_flValueFloatX");
                break;
            case "LOOSE_VARIABLE_TYPE_FLOAT2":
                p[n] = new System.Numerics.Vector4(v.GetFloatProperty("m_flValueFloatX"), v.GetFloatProperty("m_flValueFloatY"), 0, 0);
                break;
            case "LOOSE_VARIABLE_TYPE_INTEGER1":
                p[n] = (float)v.GetInt32Property("m_nValueIntX");
                break;
            case "LOOSE_VARIABLE_TYPE_BOOLEAN":
                p[n] = v.GetBooleanProperty("m_bValueBoolean") ? 1f : 0f;
                break;
        }
    }

    var compPath = composite ?? $"weapons/paints/legacy/{name}.vcompmat";
    using (var cr = ld.LoadFileCompiled(compPath))
    {
        if (cr?.DataBlock is BinaryKV3 kv3) Walk(kv3.Data);
        else FromMaterial($"materials/models/weapons/customization/paints/vmats/{name}.vmat");
    }
    if (p.Count == 0) throw new InvalidDataException("no paint material for " + name);

    float F(string k, float d) => p.TryGetValue(k, out var v) && v is float f ? f : d;
    System.Numerics.Vector4 V(string k) => p.TryGetValue(k, out var v) && v is System.Numerics.Vector4 x ? x : default;
    string? pattern = null;
    if (p.TryGetValue("g_tPattern", out var tp) && tp is string texPath && !texPath.StartsWith("materials/default/", StringComparison.Ordinal))
    {
        using var texRes = ld.LoadFileCompiled(texPath);
        if (texRes?.DataBlock is Texture tex)
        {
            uint mip = 0;
            while ((tex.Width >> (int)mip) > 1024 && mip + 1 < tex.NumMipLevels) mip++;
            using var full = tex.GenerateBitmap(mipLevel: mip);
            // some textures have no mips: scale down here
            var k = Math.Min(1f, 1024f / Math.Max(full.Width, full.Height));
            using var bmp = k < 1 ? full.Resize(new SKImageInfo((int)(full.Width * k), (int)(full.Height * k)), new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.Linear)) : full.Copy();
            using var img = SKImage.FromBitmap(bmp);
            using var data = img.Encode(SKEncodedImageFormat.Webp, 90);
            pattern = $"paint_{def}.webp";
            using (var f = File.Create(Path.Combine(dir, pattern + ".tmp"))) data.SaveTo(f);
            File.Move(Path.Combine(dir, pattern + ".tmp"), Path.Combine(dir, pattern), true);
        }
    }
    var colors = new JsonArray();
    for (var i = 0; i < 4; i++)
    {
        var c = V($"g_vColor{i}");
        colors.Add(new JsonArray(MathF.Round(c.X, 4), MathF.Round(c.Y, 4), MathF.Round(c.Z, 4)));
    }
    var off = V("g_vPatternTexCoordOffset");
    var info = new JsonObject
    {
        ["paintKit"] = def,
        ["name"] = name,
        ["style"] = (int)F("F_PAINT_STYLE", 0),
        ["pattern"] = pattern,
        ["colors"] = colors,
        ["scale"] = F("g_flPatternTexCoordScale", 1),
        ["rotation"] = F("g_flPatternTexCoordRotation", 0),
        ["offset"] = new JsonArray(off.X, off.Y),
        ["brightness"] = F("g_flColorBrightness", 1),
        ["ignoreWeaponSize"] = F("g_bIgnoreWeaponSizeScale", 0) > 0.5f,
        ["weaponLength"] = F("g_flWeaponLength1", 32),
        ["uvScale"] = F("g_flUvScale1", 1),
    };
    var json = Path.Combine(dir, $"paint_{def}.json");
    File.WriteAllText(json + ".tmp", info.ToJsonString());
    File.Move(json + ".tmp", json, true);
}

/// A sky material's thumbnail: its sky texture (a cubemap is unwrapped to lat-long), the band around the horizon
/// looking one way, tone-mapped when HDR. Returns the file name written into dir.
string ExportSky(GameFileLoader ld, string material, string dir)
{
    using var mr = ld.LoadFileCompiled(material) ?? throw new FileNotFoundException("not in the VPK: " + material);
    if (mr.DataBlock is not Material m) throw new InvalidDataException("not a material");
    var texPath = m.TextureParams
        .Where(kv => !kv.Value.StartsWith("materials/default/", StringComparison.Ordinal))
        .OrderBy(kv => kv.Key.Contains("Sky", StringComparison.OrdinalIgnoreCase) ? 0 : 1)
        .Select(kv => kv.Value).FirstOrDefault() ?? throw new InvalidDataException("no sky texture");
    using var tr = ld.LoadFileCompiled(texPath) ?? throw new FileNotFoundException("missing " + texPath);
    if (tr.DataBlock is not Texture tex) throw new InvalidDataException("not a texture: " + texPath);
    uint mip = 0;
    while ((tex.Width >> (int)mip) > 512 && mip + 1 < tex.NumMipLevels) mip++;

    SKBitmap latlong;
    var ldrCube = false;
    if ((tex.Flags & VTexFlags.CUBE_TEXTURE) != 0)
    {
        var faces = new SKBitmap[6];
        for (var f = 0; f < 6; f++)
        {
            faces[f] = tex.GenerateBitmap(face: (Texture.CubemapFace)f, mipLevel: mip);
            if (faces[f].ColorType != SKColorType.RgbaF32) // the lat-long helper takes float faces only
            {
                ldrCube = true;
                var old = faces[f];
                faces[f] = old.Copy(SKColorType.RgbaF32);
                old.Dispose();
            }
        }
        var pixmaps = faces.Select(b => b.PeekPixels()).ToArray();
        latlong = TextureExtract.CreateLatLongFromCubemapFaces(pixmaps);
        foreach (var b in faces) b.Dispose();
    }
    else latlong = tex.GenerateBitmap(mipLevel: mip);

    using (latlong)
    {
        // lat-long: top = straight up, middle row = horizon. Take a 16:9 window from high in the sky down to just below
        // the horizon, in the middle of the width.
        var w = latlong.Width;
        var h = latlong.Height;
        var top = (int)(h * 0.12);
        var bottom = (int)(h * 0.56);
        var cw = Math.Min(w, (int)((bottom - top) * 16f / 9f));
        var left = (w - cw) / 2;
        using var crop = new SKBitmap(new SKImageInfo(cw, bottom - top, SKColorType.Rgba8888, SKAlphaType.Opaque));
        var isFloat = latlong.ColorType is SKColorType.RgbaF16 or SKColorType.RgbaF32 or SKColorType.RgbaF16Clamped;
        var hdr = isFloat && !ldrCube;
        // HDR skies: scale so the bright end of the frame sits near white, then Reinhard
        var scale = 1f;
        using var src = latlong.PeekPixels();
        var px = new float[4];
        var samples = new List<float>();
        for (var y = top; y < bottom; y += 3)
            for (var x = left; x < left + cw; x += 3)
            {
                ReadPixel(src, x, y, isFloat, px);
                samples.Add(0.2126f * px[0] + 0.7152f * px[1] + 0.0722f * px[2]);
            }
        if (hdr && samples.Count > 0)
        {
            samples.Sort();
            var p95 = samples[(int)(samples.Count * 0.95)];
            scale = p95 > 1e-4f ? 2.5f / p95 : 1f;
        }
        for (var y = 0; y < crop.Height; y++)
            for (var x = 0; x < cw; x++)
            {
                ReadPixel(src, left + x, top + y, isFloat, px);
                byte Ch(float v)
                {
                    if (hdr)
                    {
                        v *= scale;
                        v /= 1 + v;
                        v = MathF.Pow(v, 1 / 2.2f);
                    }
                    return (byte)Math.Clamp((int)(v * 255 + 0.5f), 0, 255);
                }
                crop.SetPixel(x, y, new SKColor(Ch(px[0]), Ch(px[1]), Ch(px[2])));
            }
        using var thumb = crop.Resize(new SKImageInfo(320, 180), new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.Linear));
        using var img = SKImage.FromBitmap(thumb);
        using var data = img.Encode(SKEncodedImageFormat.Jpeg, 85);
        var name = "sky_" + string.Concat(Path.GetFileNameWithoutExtension(material).Select(ch => char.IsLetterOrDigit(ch) ? ch : '_')) + ".jpg";
        using (var f = File.Create(Path.Combine(dir, name + ".tmp"))) data.SaveTo(f);
        File.Move(Path.Combine(dir, name + ".tmp"), Path.Combine(dir, name), true);
        return name;
    }
}

/// One pixel as linear-ish floats (8-bit: 0..1 sRGB values, float formats: their HDR values).
static void ReadPixel(SKPixmap p, int x, int y, bool isFloat, float[] o)
{
    if (!isFloat)
    {
        var c = p.GetPixelColor(x, y);
        o[0] = c.Red / 255f; o[1] = c.Green / 255f; o[2] = c.Blue / 255f;
        return;
    }
    var span = p.GetPixelSpan();
    var bpp = p.BytesPerPixel;
    var off = y * p.RowBytes + x * bpp;
    if (p.ColorType == SKColorType.RgbaF32)
        for (var i = 0; i < 3; i++) o[i] = BitConverter.ToSingle(span.Slice(off + i * 4, 4));
    else
        for (var i = 0; i < 3; i++) o[i] = (float)BitConverter.ToHalf(span.Slice(off + i * 2, 2));
}
