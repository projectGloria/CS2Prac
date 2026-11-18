# Research: custom random maps (Phase H, item 8)

2026-11-18. A research note, nothing built. Decision needed from the user at the end.

## What exists

- **Aim Inferno Rogue** (OrelStealth, CS:GO Workshop). It uses Inferno's models. Before each match it builds a layout
  from prefabricated rooms, floors and cover, which gives tens of millions of variants. You can pick symmetrical or
  asymmetrical layouts, bots navigate it, and seeds can be shared. It was a CS:GO map; its Workshop discussion is full
  of requests for a CS2 port, and none has turned up.
- I found no procedurally generated CS2 map. The tools for one exist (see below).

## How it would work in CS2

- **Geometry can't be generated at runtime in Source 2.** Hammer compiles meshes, lighting, visibility and the nav
  mesh. A "random" map is therefore a map that already contains every piece. At round start a script shows, hides or
  moves pieces (rooms, walls, cover crates, doors).
- **`point_script`** is a CS2 entity that runs JavaScript or TypeScript files placed in the map:
  - The API comes from `import { Instance } from "cs_script/point_script"`. The types are in the Workshop Tools at
    `maps/editor/zoo/scripts/point_script.d.ts`, and the demo map is `script_zoo.vmap`.
  - `Instance.EntFireAtName({ name, input, value?, caller?, activator?, delay? })` fires inputs such as
    `Enable`/`Disable`, `Toggle` or `ForceSpawn` (point_template) at named entities.
  - Scripts can also react to outputs and run on a timer.
  - That covers "pick a random variant per room and switch it on".
- **Variant pieces:** `func_brush` / `prop_dynamic` / `func_door` groups per slot, named `room3_variant2_*`. Hidden
  pieces must also stop blocking movement and shots (Disable on func_brush does that). Lighting is baked, so pieces
  should be lit the same in every state. Pieces made of prop_static are fine since they never move.
- **Bots:** the nav mesh is built at compile time. It has to cover every variant, and blocked areas need
  `func_nav_blocker` (or nav attributes) switched together with the pieces. Otherwise bots walk into walls.
  `point_hiding_spot` gives them hiding places.
- **Config room:** in-map buttons that call script functions (bot count, difficulty, HS only, symmetrical, a seed).
  For us the L window can do this instead: our plugin can fire the same inputs over RCON (`ent_fire <name> <input>`) or
  through CSS `AcceptInput`.

## Options for CS2Prac

1. **No map; randomness on real maps (what we have now).** The Phase E modes run on any map. TargetSpot, the random
   bot spots and the prefire routes come from floor traces, and the L window is the "config room".
   - Pros: no map work, and it works on every map and Workshop map.
   - Cons: the layout itself never changes.
   - Possible next steps: random bot spots taken from the map's own `info_deathmatch_spawn` / spawn entities, and
     "random retake" setups.
2. **Our own Workshop map.** A Hammer project in the repo (`maps/cs2prac_rogue/`): an arena of N room slots × M
   variants, a point_script that rolls a seed per round, nav blockers, and cover crates.
   - Built with the user's own CS2 Workshop Tools, uploaded to the Workshop (or loaded locally with `map` from
     `csgo_addons`), and picked in the app's Workshop browser.
   - The plugin talks to it by entity names: our L window sets the seed and the options, and modes (DM, aim, prefire)
     work on it like on any map.
   - Cost: weeks of level design (rooms, lighting, clipping, nav). Code is the small part.
   - Risk for the account: none. It's a normal Workshop map on our own `-insecure` server.
3. **A middle way: random cover on real maps from the plugin.** The plugin spawns movable cover (crates as
   `prop_dynamic` with collision) at random free spots in an open area.
   - Cons: props with physics models can be spawned, but they aren't in the nav mesh (bots ignore them) and they
     look out of place.
   - Pros: cheap to try, maybe one evening, with our existing StandingRoom/trace helpers.

Recommendation: keep 1. Try 3 as an experiment if you want visible variety. Do 2 only as its own project when you
want to build a map, and first check whether someone ported Aim Rogue to CS2 by then.

**Q:** 1, 3 or 2? And the video you mentioned: send the link so I can see what they built.

## Sources

- [Point script (Source 2), Valve Developer Wiki](https://developer.valvesoftware.com/wiki/Point_script_(Source_2))
- [CS2 Workshop Tools Scripting API, Valve Developer Wiki](https://developer.valvesoftware.com/wiki/Counter-Strike_2_Workshop_Tools/Scripting_API)
- [CS2 Workshop Tools Scripting, Valve Developer Wiki](https://developer.valvesoftware.com/wiki/Counter-Strike_2_Workshop_Tools/Scripting)
- [cs_script dump of the SDK files (amaanq/cs_script)](https://github.com/amaanq/cs_script)
- [CS2 TypeScript addon template (Nyx000)](https://github.com/Nyx000/cs2-typescript-addon-template)
- [CS:GO gets randomly generated map with 30 million variants (gamepressure)](https://www.gamepressure.com/newsroom/csgo-gets-randomly-generated-map-with-30-million-variants/zd2bcf)
- [This procedurally-generated Counter-Strike map has tens of millions of variations (PC Gamer)](https://www.pcgamer.com/this-procedurally-generated-counter-strike-map-has-tens-of-millions-of-variations)
- [Aim Rogue Workshop discussion asking for a CS2 port](https://steamcommunity.com/sharedfiles/filedetails/comments/2749351643)
- [Creating a Classic Counter-Strike Map (CS2), Valve Developer Wiki](https://developer.valvesoftware.com/wiki/Creating_a_Classic_Counter-Strike_Map_(CS2))
- [Co-op Strike / point_hiding_spot, Valve Developer Wiki](https://developer.valvesoftware.com/wiki/CS:GO_Game_Modes/Co-op_Strike)
