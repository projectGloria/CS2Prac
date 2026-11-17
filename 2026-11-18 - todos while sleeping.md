# 2026-11-18: todos while sleeping

Your 13 requests from last night, sorted into phases. Each item says what I found in the code, how I'd build it,
and what I need you to decide (**Q:**). Phase A is done. The rest waits for you to read this, so we can plan it together.

Same rules as always: nothing touches the Steam account or the client's memory, commits only when you say so,
live tests on port 27115, and you test in game.

---

## Phase A: cfg files (item 1). Done, not tested in game

Folder `cfg/` in the repo root:

- **`cfg/Nihil.cfg`** (for online). It's your current file with these changes:
  - Removed the `pracGloria` section (K/L/T/Tab binds and the `css_cmd` aliases). It moved to NihilPrac.cfg, so
    online you're back to `+showscores`, `+spray_menu` and `teammenu`.
  - `pracNihil` stays as it was, for the official Valve client.
  - Logic fixes:
    - The thick crosshair preset used `cl_crosshairstyle 6`, but only styles 0–5 exist. It's now 4 (classic
      static, the same as the thin preset). If you meant another style, tell me.
    - The comment on the F3 buy bind said "F1".
    - The comment on `cl_hide_avatar_images 0` said "(2)".
- **`cfg/NihilPrac.cfg`** (for practice on our server):
  - Starts like Nihil.cfg: `unbindall`, name, movement/weapon binds, crosshair, viewmodel, HUD, radar, audio, buy
    binds. At the end it has the menu backgrounds, the AWP art and the voice line.
  - The practice part follows the `pracNihil` logic, but adapted to our server:
    - Server cvars go through `css_cmd` (same values as pracNihil).
    - Numpad + = `.bot` (css_bot), Numpad − = `.nobots`.
    - Insert = `.rethrow` (your own grenade; `sv_rethrow_last_grenade` threw the server's last one).
    - Delete = `.clear`, plus flash/HE/decoy kills.
    - Home/End = bots stand up/crouch, Page Up = infinite-ammo cycle.
    - `bullet` / `nade` console toggles, `lana` = `.god`.
    - K / L / Tab / T: same as pracGloria.
  - New keys:
    - **M** switches sides right away with MatchZy `.t`/`.ct`. No team menu (item 9b).
    - **P** turns third person on and off (item 12).
    - **F6** re-applies the server rules.
  - Exec it while connected: it applies everything at once. Exec it before connecting: the binds load, then
    press F6 once you're in.
  - Known limitation: M remembers which side it last picked. If something else moved you to the other team, the
    first press does nothing. Phase B fixes this with a server command.
- **Your real Nihil.cfg in the CS2 folder is untouched.** To use the new ones, copy both files into
  `…/game/csgo/cfg/`.
- **Q:** The app's "Start CS2 with 1.6 sounds" runs `+exec Nihil` (index.ts:217). Should it exec NihilPrac when that
  file exists? I'd say yes.

## Phase B: quick fixes and small features (items 2, 9, 10, 11, 5, 7)

Small server-side work. I'd do this first.

1. **Bots not holding their weapons (2).** The last fix (empty hands, give the guns 0.1 s later) didn't help in
   game. On the server the bot always held the gun, so the bug is in what the client is shown.
   - Next attempts, in order:
     1. Give the guns at spawn inside GiveNamedItem (before the client ever sees the default ones), instead of
        swapping 0.2 s later.
     2. After giving, re-send `m_hActiveWeapon` and the weapon's owner/`m_iState` a few ticks later.
     3. Do a bot "slot switch" the way the engine does it (`SelectItem`) rather than setting the handle.
   - Test each on 27115 with a human client watching.
   - **Q:** Does it happen with MatchZy `.bot` bots, bots from `bot_add`, or both?
2. **Molotov follows you to CT (9).** When the team changes, swap `weapon_molotov` ↔ `weapon_incgrenade`. Lineups.cs
   already does this for "Go". Same idea for other T/CT-only weapons (e.g. a Galil kept as CT).
3. **M = instant side switch (9b).** New command `css_side`: reads your real team, switches, respawns you where you
   stood. The team menu (`teammenu`) is client-side, so the cfg's M bind is the only way to replace it (already done
   in NihilPrac). The command then replaces the `.t`/`.ct` toggle.
4. **Back to spawn (10).**
   - Remember each player's "practice spawn":
     - the last spawn marker they teleported to (`.spawn n` or E on a marker),
     - else the spot `.back` would use,
     - else their round spawn.
   - Trigger: E when nothing usable is in front of you (trace: no door, weapon or button within use range), so doors
     still open normally. Also a command `css_backspawn` / `.bs` for any key.
   - "Assign a key in the UI": the server only sees game buttons (E, R, Shift …), not keys. So the app's Play page gets
     a key picker, and the app writes the bind into NihilPrac.cfg (`bind <key> css_backspawn`). The E behaviour is a
     separate on/off setting.
   - **Q:** Is E-when-nothing-to-use OK, or would you rather never touch E?
5. **.a / .b / .mid (11).**
   - A and B: the game knows each site's centre (`CCSPlayerResource.m_bombsiteCenterA/B`). Teleport you to the ground
     next to the centre, facing the site entrance from your team's side.
   - Mid: no entity for it, so a table of curated points for the active-duty maps, plus `.setmid` to save your own
     (per map, in configs/plugins/PracSkins).
   - Check first that MatchZy has nothing named `.a`/`.b`/`.mid`. It doesn't today (its list: css_t, css_ct,
     css_back …).
6. **Random graffiti (5).**
   - New choice "Random" in the K window's graffiti tab (and in the app). Every spray rolls a graffiti and a tint.
   - A banner shows the graffiti name plus a tint dot: a center HTML message for 2 s (same technique as the movement
     banner), plus one chat line.
7. **Welcome message (7).**
   - When you join (player_connect_full, after the first round_start):
     - a center HTML card: server name in a gradient, map, mode, 3–4 key hints (K skins, L settings, M side, .a/.b),
     - a coloured chat block,
     - a short sound (client-side `play` through ExecuteClientCommand, if the client accepts it, otherwise
       EmitSound).
   - Optionally a real Panorama splash in our custom layout (fade in, fade out after 6 s).
   - **Q:** Which do you want: center HTML (quick), the Panorama splash (nicer, needs a layout rebuild and a CS2
     restart), or both?

## Phase C: random craft (item 6)

- On the K window's held/selected weapon, a "🎲 Random craft" button (and in the app's Loadout page). It rolls:
  - a paint kit for that weapon, wear and seed,
  - sometimes StatTrak,
  - 0–5 stickers with random slots, positions, rotation and scale (themed rolls are more fun: all from one capsule
    or tournament, all holo, or "4× same sticker"),
  - sometimes a charm.
- Uses the catalog BotLoadouts.cs already rolls from.
- Banner: the weapon name and skin, wear and float, then each sticker by slot, then the charm. Chat gets a `!gen`
  code so you can keep a craft you like.
- Applied like a K-window pick (RefreshPlayer focusDef).
- **Q:** Should it replace what you have saved for that weapon, or be temporary until you press "Keep"? I'd say
  temporary plus Keep.

## Phase D: crosshair / HUD / viewmodel makers (item 3)

- App pages (React), each with a live preview:
  - **Crosshair:**
    - Draws the crosshair on a map screenshot background, the way the game draws it (styles 0–5, gap, thickness,
      outline, dot, T, colours, alpha, split values).
    - **Share code** encode/decode (`CSGO-xxxxx-…`, the known base-57 format), so you can paste any pro's code.
    - Export cfg lines, copy buttons.
  - **Viewmodel:** fov/offset/presetpos and left hand, with a schematic 2D preview (no real model render at first).
  - **HUD:** colour, scale, radar (scale, rotate, centered, icon scale), telemetry, overhead mode. A schematic
    preview.
- Output: "Copy code", "Copy cfg", "Export .cfg". The client refuses cvars the server sends, so these can't apply live
  from the server.
- **Q:** May the app write the exported file straight into your CS2 cfg folder (e.g. `cs2prac_crosshair.cfg`, then
  `exec` it)? CLAUDE.md says the app only adds HUD files to the client today. Or save to the repo `cfg/` folder only?

## Phase E: game modes inside any map (item 4)

A new `Modes.cs` with a "Modes" tab in the L window. Picking a mode leaves MatchZy practice (`.exitprac`), applies its
cvars, and "Stop" goes back to practice. All modes:
- run on the current map (no game_type change, so no map reload),
- track stats (hits, headshot %, reaction ms, kills/min),
- end with a results banner and a best-score table per map in configs/plugins/PracSkins/modes.json.

| Mode | Idea |
| --- | --- |
| **Deathmatch** | `mp_respawn_on_death_*`, random spawns (`mp_randomspawn 1`), teammates are enemies (FFA) or teams. Settings: bot count (bot_quota), difficulty (bot_difficulty 0–3), weapons (any / rifles / pistols / AWP / one gun), HS only, armour, time or kill limit, bot behaviour (normal, rush, hold, `bot_dont_shoot`). |
| **Aim training** | Bots at random spots in front of you: static, strafing (scripted teleport steps), crouch-spam. Settings: count, time, HS only, target size (head-only hitbox scoring). |
| **AWP reflex** | One bot shows up at a random angle on the current map for 0.4–1.5 s (shrinks as you get better), then vanishes. Score = flick time. |
| **Peek training** | You hold an angle; bots peek from cover (we move them along a short path with velocity teleports) wide / jiggle / shoulder. Reverse mode: you peek, the bot holds and reacts with a difficulty delay. |
| **Prefire** | The old CS:GO prefire maps' idea on real maps: a route of common angles per site. Bots appear in order, you clear them; time and misses counted. Route points recorded in game (like movement spots), then shared as JSON. |
| **Retake** | Bomb planted on A or B (.a/.b positions), 1–5 bots defend, you retake with a random loadout. |
| **Utility challenge** | Your saved lineups as a quiz: teleport to the spot, throw, and we check where the smoke/molly landed against the saved result. |
| **Movement** | Already exists (Movement.cs); it moves into this tab. |

- Bot behaviour in CS2 is limited: cvars like bot_stop, bot_dont_shoot, bot_difficulty, bot_crouch and bot_zombie,
  plus teleports. No custom AI. "Hiding/peeking" bots will be scripted positions, not real thinking.
- **Q:** Which modes come first? My order: Deathmatch, Aim, AWP reflex, Prefire, Peek, Retake, Utility.

## Phase F: third person (item 12)

- First step (done in NihilPrac): P toggles `thirdperson`/`firstperson`. It's a client cheat command, and our server
  has sv_cheats 1. **Please try it in game.**
- If CS2 blocks it, the fallback is the camera we already have (AgentView: `CameraServices.ViewEntity` behind you).
  But the client turns your pawn to the view direction, so playing in that view feels wrong. It's fine for looking
  at your agent, not for playing.

## Phase G: 3D craft in game (item 13)

- The in-game window can't show 3D. The custom-HUD validation only allows Panel/Label/Image/Button, and Panorama's
  model panels are rejected.
- Plan: a "showcase" like the agent preview. A real weapon entity with your skin, stickers and charm floats in front
  of a camera (ViewEntity), turning slowly. The K window's sticker controls (slot, position, rotation) move the
  stickers live. Prop_dynamic with a weapon model gets deleted by the engine (known), so it has to be a dropped
  weapon entity with physics frozen.
- Until then: F (inspect) in game after each change.
- **Q:** OK with "world-space showcase" instead of a 3D panel in the window?

## Phase H: research, custom random maps (item 8)

What I found so far (a quick search, more to do):
- The idea exists. "Aim Rogue Inferno" (a CS:GO map) generates its layout before each match from prefabricated
  rooms, floors and cover spots, with symmetrical/asymmetrical options, bot navigation and shareable seeds.
- In CS2 that's built in Hammer (CS2 Workshop Tools) with **`point_script`** (Valve's JavaScript/TypeScript map
  scripting; API in `maps/editor/zoo/scripts/point_script.d.ts` in the tools install). A config room = buttons
  that run script code (e.g. `UserConfig(...)` for bot count, difficulty, HS only). Random layouts = many pre-built
  room/cover pieces in the map that the script enables, disables or teleports, because geometry can't be generated at
  runtime in Source 2. Bots need a nav mesh covering every variant (`point_hiding_spot` gives them hiding places).
- What it means for us:
  1. **Our way, no map:** Phase E modes run on real maps with server-side randomness (random bot spots from the
     nav-mesh-like spawn/hiding data), and the L window is the "config room".
  2. **Our own workshop map:** a Hammer project in the repo (rooms + script), built with your Workshop Tools, loaded
     from the Workshop browser. Weeks of map work, but doable.
- **Q:** Do you want option 2 as a real project later, or is option 1 enough? Can you send me the video link so I
  can see exactly what they built?

---

## Suggested order

A (done) → B → C → D → E (Deathmatch first) → F check → G → H.

Sources for Phase H:
- [CS:GO gets randomly generated map with 30 million variants (gamepressure)](https://www.gamepressure.com/newsroom/csgo-gets-randomly-generated-map-with-30-million-variants/zd2bcf)
- [CS:GO fan creates procedurally generated Inferno aim map (TheGamer)](https://www.thegamer.com/csgo-fan-creates-procedurally-generated-inferno-aim-map/)
- [CS2 update notes mentioning point_script.d.ts (pricempire)](https://pricempire.com/cs2-updates/counter-strike-2-update-88737092)
- [Workshop map with script-driven config (Steam discussion)](https://steamcommunity.com/sharedfiles/filedetails/comments/3232466864)
- [Co-op Strike / point_hiding_spot (Valve wiki)](https://developer.valvesoftware.com/wiki/CS:GO_Game_Modes/Co-op_Strike)
- [Creating a Classic Counter-Strike Map (CS2) (Valve wiki)](https://developer.valvesoftware.com/wiki/Creating_a_Classic_Counter-Strike_Map_(CS2))
