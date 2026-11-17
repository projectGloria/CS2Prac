using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;

namespace PracSkins;

/// <summary>
/// Music kit previews for the K window's music tab: the kit's sound events (soundevents/music/&lt;kit&gt;/
/// game_sounds_music.vsndevts_c, "Music.&lt;Part&gt;.&lt;kit&gt;"), played only for the player who clicks.
/// </summary>
public partial class PracSkins
{
    /// <summary>items_game music_definitions: def index -> kit name (the sound events' suffix).</summary>
    private static readonly Dictionary<int, string> MusicKitNames = new()
    {
        [1] = "valve_cs2_01", [2] = "valve_02", [3] = "danielsadowski_01", [4] = "noisia_01",
        [5] = "robertallaire_01", [6] = "seanmurray_01", [7] = "feedme_01", [8] = "dren_01",
        [9] = "austinwintory_01", [10] = "sasha_01", [11] = "skog_01", [12] = "midnightriders_01",
        [13] = "mattlange_01", [14] = "mateomessina_01", [15] = "hotlinemiami_01", [16] = "danielsadowski_02",
        [17] = "damjanmravunac_01", [18] = "proxy_01", [19] = "kitheory_01", [20] = "troelsfolmann_01",
        [21] = "kellybailey_01", [22] = "skog_02", [23] = "danielsadowski_03", [24] = "awolnation_01",
        [25] = "mordfustang_01", [26] = "michaelbross_01", [27] = "ianhultquist_01", [28] = "newbeatfund_01",
        [29] = "beartooth_01", [30] = "lenniemoore_01", [31] = "darude_01", [32] = "beartooth_02",
        [33] = "blitzkids_01", [34] = "hundredth_01", [35] = "neckdeep_01", [36] = "roam_01",
        [37] = "twinatlantic_01", [38] = "skog_03", [39] = "theverkkars_01", [40] = "halo_01",
        [41] = "scarlxrd_01", [42] = "hlalyx_01", [43] = "austinwintory_02", [44] = "dren_02",
        [45] = "danielsadowski_04", [46] = "treeadams_benbromfield_01", [47] = "timhuling_01", [48] = "sammarshall_01",
        [49] = "mattlevine_01", [50] = "amontobin_01", [51] = "hades_01", [52] = "neckdeep_02",
        [53] = "scarlxrd_02", [54] = "austinwintory_03", [55] = "chipzel_01", [56] = "freakydna_01",
        [57] = "jesseharlin_01", [58] = "laurashigihara_01", [59] = "sarahschachner_01", [60] = "bbnos_01",
        [61] = "theverkkars_02", [62] = "3kliksphilip_01", [63] = "hlb_01", [64] = "juelz_01",
        [65] = "knock2_01", [66] = "meechydarko_01", [67] = "sullivanking_01", [68] = "perfectworld_01",
        [69] = "denzelcurry_01", [70] = "valve_01", [71] = "dryden_01", [72] = "isoxo_01",
        [73] = "killscript_01", [74] = "knock2_02", [75] = "radcat_01", [76] = "twerl_01",
        [78] = "austinwintory_04", [79] = "benbromfield_01", [80] = "danielsadowski_05", [81] = "dren_03",
        [82] = "mattlevine_02", [83] = "sammarshall_02", [84] = "timhuling_02", [85] = "treeadams_01",
        [86] = "perfectworld_02", [87] = "adambeyer_01", [88] = "ghost_01", [89] = "health_01",
        [90] = "jamesandthecoldgun_01", [91] = "jonathanyoung_01", [92] = "juelz_02", [93] = "killermike_01",
        [94] = "pvris_01", [95] = "selectiveresponse_01", [96] = "tigercub_01", [98] = "alrt_01",
        [99] = "altare_01", [100] = "borne_01", [101] = "pirapus_01", [102] = "repiet_01",
        [103] = "shockone_01", [104] = "starjunk95_01",
    };

    /// <summary>The parts of a kit the music tab can play (label, sound event part). Every kit has all of them.</summary>
    private static readonly (string Label, string Part)[] MusicParts =
    [
        ("Round MVP", "MVPAnthem"), ("Main menu", "MainMenu"), ("Round start", "StartRound"), ("Action", "StartAction"),
        ("Bomb planted", "BombPlanted"), ("10 s left (bomb)", "BombTenSecCount"), ("10 s left (round)", "TenSecCount"),
        ("Round won", "WonRound"), ("Round lost", "LostRound"), ("Death cam", "DeathCam"), ("Match start", "MatchStart"),
        ("Match end", "MatchEnd"), ("Loading screen", "LoadingScreen"), ("MVP preview", "MVPPreview")
    ];

    /// <summary>Which part each player is listening to (slot -> part), so the side list marks it.</summary>
    private readonly Dictionary<int, string> _musicPlaying = new();

    private static string? MusicKitName(int def) => MusicKitNames.GetValueOrDefault(def);

    /// <summary>Plays one part of a kit for this player only (stops what an earlier preview started).</summary>
    private void PlayMusicPreview(CCSPlayerController player, int def, string part)
    {
        StopMusicPreview(player);
        if (MusicKitName(def) is not { } kit || player.PlayerPawn.Value is not { IsValid: true } pawn) return;
        try
        {
            var filter = new RecipientFilter();
            filter.Add(player);
            pawn.EmitSound($"Music.{part}.{kit}", filter, 1f, 1f);
            _musicPlaying[player.Slot] = part;
        }
        catch (Exception e)
        {
            Logger.LogWarning("Music preview {Kit} {Part}: {Error}", kit, part, e.Message);
        }
    }

    /// <summary>Stops every sound on the player's client (the client's own stopsound; we run with sv_cheats 1).</summary>
    private void StopMusicPreview(CCSPlayerController player)
    {
        if (!_musicPlaying.Remove(player.Slot)) return;
        if (player.IsValid && !IsBotAny(player)) player.ExecuteClientCommand("stopsound");
    }
}
