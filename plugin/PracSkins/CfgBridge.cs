using System.Text.Json;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Admin;
using CounterStrikeSharp.API.Modules.Commands;
using Microsoft.Extensions.Logging;

namespace PracSkins;

/// <summary>
/// Runs the server half of the user's own cfgs. The app writes a bridged copy of every client cfg
/// (cfg/cs2prac/&lt;name&gt;.cfg, see src/main/setup/cfgBridge.ts) in which each run of server commands is replaced
/// by <c>css_cfgrun &lt;id&gt;</c>, and lists the commands per id in cfgbridge.json. A client can't run server
/// commands on a dedicated server, so the server runs them here.
/// </summary>
public partial class PracSkins
{
    private sealed class CfgBridgeFile
    {
        public Dictionary<string, string[]> Segments { get; set; } = new();
    }

    private Dictionary<string, string[]> _cfgSegments = new(StringComparer.OrdinalIgnoreCase);
    private DateTime _cfgBridgeTime = DateTime.MinValue;

    private string CfgBridgePath => Path.Combine(ConfigDir, "cfgbridge.json");

    private void LoadCfgBridgeIfChanged()
    {
        try
        {
            var t = File.Exists(CfgBridgePath) ? File.GetLastWriteTimeUtc(CfgBridgePath) : DateTime.MinValue;
            if (t == _cfgBridgeTime) return;
            var file = t == DateTime.MinValue
                ? new CfgBridgeFile()
                : JsonSerializer.Deserialize<CfgBridgeFile>(File.ReadAllText(CfgBridgePath),
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new CfgBridgeFile();
            _cfgSegments = new Dictionary<string, string[]>(file.Segments, StringComparer.OrdinalIgnoreCase);
            _cfgBridgeTime = t;
            Logger.LogInformation("Cfg bridge: {Count} server steps", _cfgSegments.Count);
        }
        catch (Exception e)
        {
            Logger.LogError("Could not read {Path}: {Message}", CfgBridgePath, e.Message);
        }
    }

    [ConsoleCommand("css_cfgrun", "Run the server commands of a bridged cfg step (used by cfg/cs2prac/*.cfg)")]
    [RequiresPermissions("@css/root")]
    [CommandHelper(minArgs: 1, usage: "<id>", whoCanExecute: CommandUsage.CLIENT_AND_SERVER)]
    public void OnCfgRunCommand(CCSPlayerController? caller, CommandInfo command)
    {
        LoadCfgBridgeIfChanged();
        var id = command.GetArg(1);
        if (!_cfgSegments.TryGetValue(id, out var commands))
        {
            command.ReplyToCommand($"[CS2Prac] unknown cfg step {id}: after editing a cfg, restart the server from the app and exec the cfg again");
            return;
        }
        foreach (var c in commands) Server.ExecuteCommand(c);
    }
}
