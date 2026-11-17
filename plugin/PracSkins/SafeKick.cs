using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;
using Vector = CounterStrikeSharp.API.Modules.Utils.Vector;

namespace PracSkins;

/// <summary>
/// Crash guard for bot_kick. MatchZy's .bot starts TemporarilyDisableCollisions for the new bot: a 0.1 s repeating
/// timer per (player, bot) pair that runs until the two stop overlapping. Kicking the bot while that timer runs makes
/// it read the freed pawn: a NullReferenceException every tick, then an AccessViolation that kills the server
/// (2026-11-17: six .bot bots, then "Kick all" half a second later). So every bot_kick (the L window, css_cmd, cfgs)
/// is held back: the targeted bots are frozen and lifted far away from everyone, MatchZy's timers see them apart and
/// end themselves, and the same bot_kick runs again ~0.35 s later.
/// </summary>
public partial class PracSkins
{
    private int _kickBypass;
    private const float KickDelay = 0.35f;

    private void InitSafeKick()
    {
        AddCommandListener("bot_kick", OnBotKick);
    }

    /// <summary>Runs a bot_kick (or kickid) without the delay, for bots we know are not overlapping anyone.</summary>
    private void ExecKickNow(string command)
    {
        if (command.StartsWith("bot_kick", StringComparison.OrdinalIgnoreCase)) _kickBypass++;
        Server.ExecuteCommand(command);
    }

    private HookResult OnBotKick(CCSPlayerController? caller, CommandInfo info)
    {
        if (_kickBypass > 0)
        {
            _kickBypass--;
            return HookResult.Continue;
        }
        var arg = info.ArgString.Trim().Trim('"').Trim();
        var targets = KickTargets(arg);
        if (targets.Count == 0) return HookResult.Continue;

        var i = 0;
        // the engine's bot_kick goes by the fake-client flag: put it back on the bots with a picture until the kick ran
        foreach (var bot in targets) HoldBotFlag(bot, KickDelay + 1f);
        foreach (var bot in targets)
        {
            if (bot.PlayerPawn.Value is not { IsValid: true } pawn || pawn.AbsOrigin is not { } o) continue;
            SetMoveType(pawn, MoveType_t.MOVETYPE_NONE);
            pawn.Teleport(new Vector(o.X, o.Y, o.Z + 3000 + 120 * i++), null, new Vector(0, 0, 0));
        }
        var command = arg.Length == 0 ? "bot_kick" : $"bot_kick \"{arg}\"";
        AddTimer(KickDelay, () => ExecKickNow(command), TimerFlags.STOP_ON_MAPCHANGE);
        Logger.LogInformation("bot_kick held {Delay} s for {Count} bot(s) (MatchZy collision timers)", KickDelay, targets.Count);
        return HookResult.Stop;
    }

    /// <summary>The bots a bot_kick argument names: none/all = every bot, t/ct = a team, otherwise a name.</summary>
    private List<CCSPlayerController> KickTargets(string arg)
    {
        var bots = Utilities.GetPlayers().Where(p => (p is { IsValid: true, IsHLTV: false } && IsBotAny(p))).ToList();
        if (arg.Length == 0 || arg.Equals("all", StringComparison.OrdinalIgnoreCase)) return bots;
        if (arg.Equals("t", StringComparison.OrdinalIgnoreCase)) return bots.Where(b => b.Team == CsTeam.Terrorist).ToList();
        if (arg.Equals("ct", StringComparison.OrdinalIgnoreCase)) return bots.Where(b => b.Team == CsTeam.CounterTerrorist).ToList();
        return bots.Where(b => string.Equals(b.PlayerName, arg, StringComparison.OrdinalIgnoreCase)).ToList();
    }
}
