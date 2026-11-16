# CS2Prac roadmap

We work through this one phase at a time. Each phase ends the same way: test it in game, tick the boxes, then commit and push to `main`.
The goal is a stable, solid personal tool: install it, start a server, connect by hand, be admin, use MatchZy and use every skin.

Done: M1–M5. That covers the hard-link server mirror, Metamod and CounterStrikeSharp, PracSkins (weapon, knife and glove skins), profiles, and an NSIS installer built locally.

---

## Phase 1: Installer and release pipeline (req 0: easy setup)
- [x] Add an app icon (`build/icon.png`), bump package.json to 0.2.0, and show the version in the app.
- [x] Release builds compile the plugin from source with the existing `npm run build:plugin`, so they never ship a stale DLL.
- [x] Add `.github/workflows/release.yml`. On a `v*` tag it runs on windows-latest: setup-node, setup-dotnet 10, `npm ci`, `npm test`, `build:plugin`, then `electron-builder --win --publish always`. The NSIS exe is attached to a GitHub Release.
- [x] Auto-update with `electron-updater` from GitHub Releases. Check on launch and offer "Restart to update".
- [x] Make the first-run wizard one click. It auto-detects CS2, suggests `<drive>\CS2Prac`, and a single **Set up** button runs everything. Reuse `findCs2Install` and `syncMirror`.
- [x] Settings and logs live in `%APPDATA%\CS2Prac` and survive reinstalls. Add a rotating `main.log` and an "Open logs folder" button.
- [x] Update the README. Installing means downloading the latest release. Building from source gets its own section.

## Phase 2: Manual connect, admin, any command (req 1, 2)
- [x] Remove `steam://connect` and the `autoConnect` setting (in `src/main/index.ts`, `src/main/paths.ts` and `Play.tsx`). When the server runs, show a copyable `connect 127.0.0.1:27015` and a LAN IP variant.
- [x] Keep one RCON password in settings instead of a random one per start. Show a copyable `rcon_password <pw>` line, so client-side `rcon <cmd>` works. **Verify** that CS2 client rcon works. If it doesn't, the plugin command below is the main route.
- [x] Admin: on every start, write CSS `configs/admins.json` with your SteamID64 (from `accounts.ts`, which reads loginusers.vdf) and `@css/root`. Keep any other entries in the file.
- [x] Add a PracSkins command `css_cmd <command…>` (also `!cmd`; not `css_rcon`, which MatchZy uses), limited to `@css/root`. It runs `Server.ExecuteCommand`, so any server command or `exec <cfg>` works from chat or the console.
- [x] Cfgs: the mirror already copies the client `game/csgo/cfg/`. Add an app-managed server cfg folder (`%APPDATA%\CS2Prac\cfg`) that is synced into the server `cfg/` on start. An optional `autoexec_server.cfg` runs after the map loads.
- [x] Set default server cvars on start: `sv_cheats 1`, `sv_lan 1`, `sv_hibernate_when_empty 0`.
- [x] **User check in game:** `!cmd` and console `css_cmd` work (exec of a client cfg, sv_gravity). CS2 client `rcon` never reaches the server, so the rcon line was removed from the Play page. `play` in a cfg crashed the server; fixed by swallowing sound commands.

## Phase 3: MatchZy (req 3)
- [x] Add `src/main/setup/matchzy.ts`. It installs the pinned `MatchZy-<ver>.zip` (plugin only; latest is 0.9.3) from GitHub Releases into `game/csgo/`, using the same `installZip` and versions-file pattern as `setup/plugins.ts`. MatchZy needs CSS v369 or newer.
- [x] Write `cfg/MatchZy/admins.json` with `{ "<your steamid>": "" }`. An empty flags string grants all MatchZy admin commands.
- [x] Write `cfg/MatchZy/config_override.cfg` with `matchzy_autostart_mode` from the UI: Practice is 2 (default), Match is 1, Off is 0. Put our practice defaults in `prac_override.cfg`. Never edit MatchZy's own cfgs, because its updates replace them.
- [x] On the Play page, add a Mode selector (Practice / Match / Plain) and show the MatchZy version in the status.
- [x] (Server-side verified: both load; knife skin applies to bots with MatchZy loaded and survives `mp_restartgame`. MatchZy kicks `bot_add` bots in practice mode, so `.bot` bots need an in-game check.) Check that PracSkins and MatchZy work together. Skins must survive `.prac`, `.bot`, `.rethrow` and round restarts, and MatchZy bots must not get your skins.
- [x] Add a quick-reference panel in the app for MatchZy commands (`.prac`, `.bot`, `.spawn`, `.rethrow`, `.noflash`, `.clear`, `.god`, `.savenade` …).
- [x] Replaced `extract-zip` (it hung forever on MatchZy's zip) with Windows' built-in `tar.exe` (`src/main/setup/unzip.ts`).
- [x] **User check in game:** practice mode on join, `.bot`, `.cbot`, `.nobots`, nade trajectories, `.rethrow`, `.clear` work; skins survive `.exitprac` / `.prac`; bots don't get your skins.

### Practice extras (asked for during testing, Leetify-style; `plugin/PracSkins/Practice.cs`)
- [x] Spawn markers: a square in team colour, a facing arrow and a number per competitive spawn (numbers match `.spawn n`). On automatically in practice (`css_prac_spawns 1` in prac_override.cfg), `.spawns` toggles them. Look at one and press E to stand on it.
- [x] Squares lie on the floor (ground trace; spawn entities sit up to ~60 units above it on Dust2). **User-confirmed** that markers show and E teleports.
- [x] `.glow`: bots outlined through walls (red T, blue CT), re-added on respawn.
  - Fixed: the first version dropped the client with NETWORK_DISCONNECT_OVERFLOW (SetModel before spawn → engine assert + minidump stall).
  - Fixed: the second version showed nothing (glow props at 0,0,0, glow never switched on). Server-side verified the props now sit on and follow the bots.
  - Fixed: still nothing on the client with the model as a spawn keyvalue. Now SetModel with the staging flag cleared + transparent bone-merged copy. **User-confirmed** the outline shows through walls.
- [x] **User check in game:** the floor squares look right everywhere (T spawn slope), `.glow` back after a bot respawns, E still opens doors / defuses when not aiming at a square.

## Phase 4: Full item catalog (req 5: all skins, agents, stickers, keychains)
- [x] **Data spike first.** Find numeric ids for agents (with model paths), stickers and keychains.
  - Try ByMykel `inventory.json` / `all.json` first.
  - Fallback: read `scripts/items/items_game.txt` from the local CS2 `pak01_dir.vpk` with a small TS VPK and KeyValues reader. This always matches the installed game.
  - Decide based on what the data actually contains.
- [x] Extend `catalog.ts` and `shared/skins.ts`:
  - agents: per team, with model path
  - stickers: id, name, image
  - keychains: id, name, image

  Then bump `CATALOG_VERSION`.
- [x] Loadout schema 2 (`loadoutStore.ts` â†” `plugin/PracSkins/Loadout.cs`):
  - each weapon: `stickers[5]` `{id, wear, scale, rotation, x, y}` and `keychain {id, x, y, z, seed}`
  - `agent {t, ct}`
  - migrate schema 1 files
- [x] Plugin, using the WeaponPaints technique:
  - stickers: `sticker slot N id/wear/scale/rotation/offset x/offset y`, with the id passed through `BitConverter.Int32BitsToSingle`
  - keychain: `keychain slot 0 id/offset x/y/z/seed`
  - agent: `pawn.SetModel("agents/models/<model>.vmdl")` on spawn, in NextFrame
- [x] Loadout page: an agent picker per team, and a sticker-slot and keychain editor per weapon with search and images.
- [x] Live refresh: `css_prac_reload` re-gives the current weapons (keeping ammo and the active slot) and re-applies gloves and agent, with no respawn needed.
- [x] Result of the data spike: ByMykel has `def_index` for agents, stickers (11k) and keychains, and `model_player` for agents (`agents/models/...vmdl`, confirmed in pak01_dir.vpk). No VPK reader needed.
- [x] Server-side verified with bots: agents applied, sticker/keychain attributes set (also on a default-finish weapon), `css_prac_reload` swaps finishes live.
- [x] **User check in game (confirmed; scrape not tried, user is fine with it):** stickers/charm look right (slot positions, scrape, the Position offsets), agent model and arms, instant refresh keeps ammo and active weapon.

## Phase 5: In-game menu (req 4: press K, pick skins live)
- [x] The app exports a compact `catalog.json` next to `loadout.json` for the plugin. It holds names and ids for weapons, knives, gloves, agents, stickers and keychains.
- [x] Build a center-screen HTML menu in PracSkins with no extra dependency. Controls: W/S move, A/D page, E select, R back. Read buttons in `OnTick` and freeze movement while the menu is open.
- [x] `css_menu` (also `!skins`) opens the menu with these sections:
  - Weapon skins, current weapon first
  - Knife
  - Gloves
  - Agent
  - Stickers and Keychain for the current weapon

  After picking a finish, choose a wear preset (FN/MW/FT/WW/BS) and StatTrak on or off.
- [x] Search for big lists: `!skin <text>`, `!sticker <text>` and `!knife <text>` open the menu filtered.
- [x] The plugin writes choices back to `loadout.json` (atomic write) and applies them at once. The app watches the file (`fs.watch`) and updates the active profile, so the menu and the app stay in sync.
- [x] The app shows the bind line to paste into your autoexec: `bind k css_menu`.
- [x] Extra chat commands: `!agent`, `!charm`; `css_menu` toggles. Menu pages: finish (+ wear presets), knife model â†’ finish, gloves type â†’ finish, agent, sticker slots (scrape, remove), charm, StatTrak toggle.
- [x] Verified server-side: plugin loads catalog.json (63 weapons, 63 agents, 11134 stickers, 78 charms); plugin-written loadout.json round-trips through the app's import unchanged (`css_prac_save`).
- [x] **User check in game:** `bind k css_menu`, navigation feel (W/S/A/D/E/R, hold to scroll), freeze/unfreeze, every page applies instantly, the app's Loadout tab follows the menu's picks.
- [x] Fix: the text menu blinked (re-sent once a second; CS2 shows a center message only briefly) → re-sent every tick.

### Phase 5b: Skin window (real Panorama HUD, user's request "bigger, better UI")
- [x] `custom_hud_layout` window (plugin/PracSkins/Hud.cs): dimmed backdrop, mouse cursor, tabs Weapons/Knives/Gloves/Agents, list on the left, 4×3 tiles with the game's own skin icons, pages, wear presets + StatTrak, status line. K (`css_menu`) opens it; `!skins` keeps the text menu.
- [x] `npm run build:hud` (scripts/hud): reads CS2's VPK + items_game.txt, generates one CSS image class per skin/agent/base weapon, compiles with the Workshop Tools resource compiler into resources/hud.
- [x] The app copies the two compiled files into the client's `game/csgo/panorama/.../custom_game/` on every server start (user chose local files over a Workshop addon).
- [x] Server-side check on 27115: entity created at the first round, kept across restarts, replaced on plugin reload, recreated after a map change; 0 asserts.
- [x] **User-confirmed** in game: window opens with K, images show, clicks apply ("Impressive!").
- [x] User feedback round 1: clicking a gun in the list equips it at once (replaces the gun of that slot; slot swap verified on a bot, `css_prac_hudequip`); AWP & co. were on page 2 → list and grid now scroll with the mouse wheel (36 rows / 64 tiles, no paging); click outside the window closes it (ESC can't reach the server).
- [x] The round-1 layout didn't show at all: CS2's client rejected the clickable (Button) backdrop. Bisected with 4 layout variants in game; backdrop is a Panel again (no click-outside close). **User-confirmed:** window shows, mouse-wheel scrolling works.
- [x] User feedback round 2: weapon icons in the left list (knives too; gloves show a finish); pager hidden while everything fits.
- [x] **User check in game:** restart CS2 (layout changed), icons in the left list, the gun you click lands in your hands.
- [ ] Later: stickers and charms in the window; T/CT switch. (Moved to v2 Phase 14.)

### Phase 5c: Third-person agent preview (user's request "like choosing a fighter")
- [x] Agents tab: First person / Third person toggle, remembered per SteamID (`configs/plugins/PracSkins/hud_prefs.json`, also pose, zoom, height).
- [x] Round 1 (user-tested): camera prop as the pawn's `CameraServices.ViewEntity` works and the window docks left, but the client turns its own pawn to the camera's view direction: turning the camera turned the agent, only its back showed. The Zeus pose gave the next gun without switching to it.
- [x] Round 2 (plugin/PracSkins/AgentView.cs): a stand-in prop_dynamic with the agent's model on the player's spot faces the camera; the real pawn and its weapons are made invisible meanwhile. Turning (A/D, Turn buttons, Mouse1/Mouse2 in mouse look, mouse movement if the client reports it) rotates only the stand-in; the camera stays. Weapon poses bone-merge a weapon world model onto the stand-in (no more handing out real guns, so the Zeus problem is gone). Crouch removed (a prop can't crouch).
- [x] Clicking an agent plays its `<voice>.vo_preview` (the random line the game's inventory plays) for that player only; voice set from items_game `vo_prefix`, else the faction (model folder).
- [x] `css_prac_anim <input> [value]` sends an input to the stand-ins (try `!cmd css_prac_anim SetAnimation cu_t_pose01`; inventory poses cu_t_pose01-05 / cu_ct_pose01-05). Not live-tested (the user's server was running from the same folder).
- [x] (superseded by later rounds) **User check in game:** restart the server from the app and restart CS2. Agents → Third person: agent faces you, A/D/Turn rotate only the agent, voice line on click, does the stand-in stand idle or T-pose, does the pose weapon sit in its hand, is your own body gone? If the stand-in T-poses, try the css_prac_anim line above.
- [x] Round 2 user test: works, but the own gloves still show on screen, weapon poses show nothing, the pose never changes.
- [x] Round 3 findings (live on a throwaway mirror server, port 27115): the engine deletes any prop_dynamic(_override) with a weapon model ("has propdata … DELETED"), so pose weapons never existed; agent models have no named sequences (SetAnimation "no sequence named"), their animation is the animgraph only, whose parameters a server plugin can't set. Fixed so far: first-person viewmodel (arms/gloves) hidden while the preview runs (untested: bots have none); stand-in uses its anim graph (UseAnimGraph).
- [x] User decision: a bot as the stand-in. Round 4 (plugin/PracSkins/AgentView.cs): MatchZy's `.bot` (run for the player; practice mode kicks any other bot as "untracked"), else `bot_add` on the other team (no name over its head); frozen (MOVETYPE_NONE, `bot_stop 1` while a preview runs, old value restored), no damage, no collision, on the player's spot with their agent model, gloves and skins (`_standInTeam` → `SkinTeam`); eye angles set every tick so it faces the camera and turns. Poses strip it and give one weapon. Kicked when the preview ends (`bot_kick`, or `kickid` + bot_quota − 1 for the MatchZy bot). Max 4 bot requests, then the prop stand-in (idle, no weapons). Weapon props removed.
- [x] Live on the throwaway mirror server (27115, no MatchZy): bot joins, frozen, invulnerable, player's agent model; Rifle → M4A1-S with the CT skin, Zeus, Knife → the user's bayonet with its finish; T player gets AK skin + butterfly; agent click swaps the bot's model; Turn ◀ turns it (eye yaw −11 → −41); leaving kicks it, bot_stop and bot_quota restored; 0 asserts. With MatchZy practice: plain bot_add bots are kicked at once (confirmed), so in game the MatchZy `.bot` path is the one that matters; untested (needs a real player).
- [x] User test round 4: the bot works, but (1) own gloves and the held C4 still on screen, (2) C4 pose dropped a C4 on the floor (the bot was a CT), (3) no crouch.
- [x] Round 5: the player's active weapon is taken out of hand while the preview runs (nothing in hand = no viewmodel at all; restored on exit, kept null every tick); the C4 is given with the bot briefly a T (controller + pawn TeamNum, put back right after); new Stance row Stand / Crouch (pref `crouch`), MatchZy's crouch-bot technique (CBot.IsCrouching + DuckAmount/Ducked/DesiresDuck every tick). Live on 27115: CT stand-in holds the C4, duck 1.00 crouched / 0 standing, player has nothing in hand during the preview; 0 asserts.
- [x] User test round 5: gloves + C4 still on screen (the client predicts its active weapon, a server-side null doesn't reach it); **server crash** (0xC0000005): MatchZy's `.bot` runs TemporarilyDisableCollisions, a repeating timer until player and bot no longer overlap; the stand-in stood on the player's spot, so it never ended, and after our kick it read the freed pawn (NullReference ×12, then AccessViolation in Marshal.ReadInt32).
- [x] Round 6: the stand-in stands ~72 units away (StandInSpot: behind, then sides/front; line traces at 16/38/64 and floor within 24 units), so MatchZy's timer ends at once; the player's weapons are stashed (killed) for the preview and given back on exit (clip/reserve, then `use` the one that was in hand). Live on 27115 (no MatchZy): gap 72, nothing in hand, knife/glock/C4 back after; 0 asserts. The MatchZy path needs a real player.
- [x] Round 6 user check: no crash, bot next to you; but gloves/C4 still showed and the C4 kept dropping.
- [x] Round 7: the client draws its own hands at the pawn's eye whatever the server does, so the pawn is teleported 140 units behind the camera (out of view; no damage meanwhile) and back to its spot on exit. C4 drops had two causes: loose C4s (a kicked carrier's, or what RemoveWeapons leaves) make a new one fall (RemoveLooseC4 before the give, at bot kick, before restoring the player's), and the game's AFK-bomb rule drops a T's C4 ~15 s into a round when it hasn't moved since spawn (stand-in gets HasMovedSinceSpawn = true every tick). A check re-gives it if it still falls. Live on 27115: T and CT stand-ins keep it across rifle→C4 for a whole round; 0 asserts.
- [x] **User-confirmed (round 7), works as intended:** restart the server from the app. Gloves/C4 out of the picture? C4 pose holds the bomb (also late in the round, as T and CT)? Exit puts you back where you stood with your weapons?
- [ ] Not possible server-side: mouse-wheel zoom (the wheel only switches weapons, the server never sees it); the agents' menu idle/celebration animations run on UI anim graphs (animation/graphs/ui/*) in the client only.

## Phase 6: Hardening and v1.0
- [x] Pin known-good versions of Metamod, CSS and MatchZy. "Check for plugin updates" becomes an explicit button, so a bad upstream release can't break a start.
- [x] Detect a CS2 update (the buildid changes) and broken plugins (CSS missing from `meta list`, or a signature failure in `css_prac_status`). Show a clear banner with a Repair button.
- [x] Crash recovery: detect when the server dies and offer a restart. On app launch, clean up a stale cs2.exe.
- [x] Tests: catalog parsing, loadout v2 migration, the admins.json and MatchZy cfg writers, and the plugin JSON round-trip.
- [x] Official icon `assets/CS2Prac.ico` (exe, installer, uninstaller, window); `assets/CS2Prac.png` as splash art.
- [x] Start-up splash (static in index.html, window shown once it paints): splash art + spinner while images, settings,
  maps and the skin catalog load (4 s min, 10 s max), then fades into the app. Fix: the art didn't show in dev (a
  relative src in index.html isn't served there); now set from an import, and the window only shows once it decoded.
- [x] "Server starting" overlay on the Play page (splash art, spinner, map, last console line, Cancel) from the Start
  click until the server runs or fails.
- [x] Version 1.0.0 in package.json.
- [ ] **User check:** `npm run dev` restart: splash, then Start server shows the overlay.
- [x] Tag `v1.0.0`: first public release, notes in docs/release-notes/v1.0.0 (user asked, 2026-11-16).
- [x] Verified live: health check is clean on a good server; leftover-process cleanup kills only `<installDir>\server\...\cs2.exe`.
### Own client cfg on the server (asked for during testing)
- [x] The user's `pracNihil` (client cfg `Nihil.cfg`) only half worked: on a dedicated server the client refuses replicated cvars and the server rejects bot_kick/ent_fire/mp_warmup_end from players (6× ent_fire per DEL press got them kicked for "too many failed console commands").
- [x] Fix, at the user's request, inside their own `Nihil.cfg` (no second cfg, no app-generated copy; an app-side "cfg bridge" was tried and reverted): a `pracGloria` section with `gloria_*` aliases that mirror pracNihil but send every server command as `css_cmd <command>`. pracNihil stays for offline practice.
- [x] **User check in game:** `exec Nihil`, connect, `pracGloria`; the bot/clear/ammo/impact/nade keys; no kick on spamming DEL. Bind K to `css_menu` (the user does this). Each `css_cmd` echoes one "[CS2Prac] ran: …" console line; make it quiet if the user finds it noisy.

### Bundle and server name (asked for before v1.0)
- [x] Everything in the installer: Metamod, CounterStrikeSharp (with runtime) and MatchZy at the pinned versions, a skin
  data snapshot and the third-party licenses (`npm run build:bundle` → `resources/bundle`). Setup and Repair install from
  it with no download. Verified offline (network blocked): all three install; the installer is ~207 MB.
- [x] Server name setting (Play → Options, default "Nihil Prac Server"): MatchZy chat prefix, hostname and PracSkins
  messages show `[Nihil Prac Server]`. Verified live on a test server.
- [x] **User check in game:** MatchZy and CS2Prac chat messages show `[Nihil Prac Server]`; a fresh Setup works offline.

### Movement mode (asked for before v1.0; `plugin/PracSkins/Movement.cs`)
- [x] `.movement` (or `!movement`) toggles it per player. Spots are recorded in game: `.movement save <name>` at the jump
  start (position + view direction), `.movement fail` on the floor you'd fall onto (default: 64 units below the start),
  `.movement delete <name>`, `.movement list`, `.movement <name>`. Saved per map in
  `configs/plugins/PracSkins/movement/<map>.json`; green squares + names mark them while anyone is in the mode.
- [x] Landing below the fail height teleports back to the start (a miss); landing over 80 units from the start and above
  it counts as made. Center banner "Made it!" / "Missed" with made/attempts per spot. `.next`/`.prev`/`.reset` (only
  while on). No fall damage (sv_falldamage_scale 0 while anyone is in the mode, restored after).
- [x] Verified on a test server: plugin loads, spot file is read, markers spawn, no engine asserts. Needs a player for the rest.
- [x] User check: recording a start works; but "Made it!" fired too early (any landing 80+ units from the start counted).
- [x] End point: `.movement end` (stand where the jump lands) saves a gold end square per spot; only landing on it counts
  as made, then back to the start after 1.5 s. Other landings above the fail height count as nothing. Re-saving a
  start keeps its end. Built; not live-tested (needs a player).
- [x] (marked done by the user; they'll check it later) **User check in game:** restart the server from the app; `.movement end` on the landing spot, gold square shows,
  "Made it!" only on it, back to the start after, misses still put you back, `.next`/`.prev` with two spots.
- [ ] Maybe later: movement spots in the K menu; E on a green square to go there. (Moved to v2 Phase 7, L window.)

### UI polish (asked for before v1.0)
- [x] No extra window on server start, not even a flash: cs2.exe runs on an invisible desktop
  (server/hiddenLaunch.ts). Verified on a test server: no window, RCON connects, output streams, quit works.
- [x] Icons next to the tab names (Play, Loadout, Console, Setup) and Logs (lucide-react).
- [x] Frameless window: our own title bar (icon, tabs, status, logs, version, minimize/maximize/close; drag to move,
  double-click to maximize). Thin overlay scrollbars that only show on hover instead of the classic Windows ones.
- [x] **User check:** start the server and see no window at all; the icons look right; the title bar and scrollbars feel right.

### Loadout page (asked for before v1.0)
- [x] Two columns like Play: slots left as cards with official CS2 icons (assets/cs-icons, weapon silhouettes from the
  game's panorama images), skin picker right. Profile and owner pickers are app-style dropdowns.
- [x] Counter-Terrorist / Terrorist dropdown: every slot, weapons included, is per faction (loadout schema 3; old files
  and profiles copy their weapon skins to both teams). "Copy to CT/T" per weapon. The K menu saves to the player's team.
- [x] Top row order: Agent, Knife, Gloves, Zeus.
- [x] Wear, pattern, StatTrak, name tag, stickers and charm open as a pop-up on right-click; a left click only selects.
- [x] **User-confirmed** in game: per-faction skins, stickers and charms.

## Next
- [x] User tests Phases 1–6 in game (confirmed 2026-11-16; the movement end point was marked done, the user checks it later).
- [x] When happy: bump `version` to 1.0.0, commit, and push tag `v1.0.0` (released 2026-11-16).

---

# v2 roadmap (planned 2026-11-16)

Same rules as v1: one phase at a time, typecheck + tests, the user tests in game, commit only when asked.
**Account-safety rule (hard):** nothing may put the user's Steam account at risk. Everything stays on the local
`-insecure` + `sv_lan 1` server; no client memory, no GC/Steam spoofing with the user's account, and client-folder
writes are limited to new Panorama/resource files like the skin window's. Risky items start with a **spike**.

## Phase 7: Server settings window (L key) (req 1)
- [x] `plugin/PracSkins/SettingsHud.cs`: the settings window (`ps_win`) lives in the same `custom_hud_layout` as the
  skin window (one entity, one input capture; `ps_` click ids are routed to it, opening one closes the other). Layout
  fragment `scripts/hud/cs2prac_settings.xml/.css`, merged by `npm run build:hud` at `<!--SETTINGS_WINDOW-->`.
  `css_settings` / `.settings` toggles it (`bind l css_settings`; text-menu fallback while the entity doesn't exist
  yet). Tab closes it, as do death and K.
- [x] Toggles: bot glow, spawn markers, bot radio (`bot_chatter`), infinite ammo, buy anywhere, grenade trajectory,
  impacts, no-flash, god mode, auto bunnyhop, friendly fire, fall damage.
- [x] Choices: bot difficulty, bots shoot, round/freeze time, gravity, timescale, bot stop/crouch.
- [x] Skybox: our own `env_sky` with the picked material, the map's skies disabled; 22 sky materials precached in
  OnServerPrecacheResources. Verified on a test server (entity state); **user check:** the sky looks right in game.
  Fog/lighting not done (later if wanted).
- [x] Map tab: official maps (csgo/maps/*.vpk) + the app's recent workshop maps (maps.json), restart round; Bots tab:
  place a bot (`css_bot`), kick bots.
- [x] Settings persist in `configs/plugins/PracSkins/server_prefs.json` (global + per map, "Every map"/"This map"
  chips, reset); applied 2.5 s after map start and on practice start (prac_override.cfg). Play page "Server settings"
  edits the global values and clears per-map ones; changes made in game show up live (watcher).
- [x] Spots tab: movement mode on/off and "Go" per movement spot of the map (v1 "maybe later"). The lineup page
  comes with Phase 12.
- [ ] **User check:** restart CS2 (new layout), `bind l css_settings`, every tab and setting, This map vs Every map.

## Phase 8: Pins and music kits (req 3 + extra)
- [x] Data spike: pins (ByMykel collectibles) and music kits with def_index + images; extend `catalog.ts` /
  `pluginCatalog.ts`, bump CATALOG_VERSION (4; all 667 collectibles incl. coins/medals as pins, 95 music kits, `_st` copies skipped).
- [x] Loadout schema 4 (`Loadout.cs` ↔ `loadoutStore.ts`): `pin`, `musicKit` (global, not per team).
- [x] Plugin: pin via `InventoryServices.Rank[5]`, music kit via `MusicID` (WeaponPaints technique), applied on
  connect/spawn and by `css_prac_reload`; `css_prac_status` prints both.
- [x] App Loadout page: Pin and Music kit slots. K window: Pins and Music tabs (icons via build:hud classes `p<def>`/`m<def>`). Text menu: root entries + `!pin` / `!music`.
- [ ] **User check in game:** pin on the scoreboard, music kit at round end / MVP.

## Phase 9: Graffiti (req 2)
- [x] **Spike:** the server spawns `player_spray_decal` itself at the aim point (eye trace, PlayerSolidBrushOnly)
  with UniqueID = sticker kit def, TintID, EndPos/Normal/Left, AccountID, Player. Live-tested on 27115: fields land,
  survives mp_restartgame, no asserts. The game's own spray key asks the Steam GC to sign the decal, so we don't use
  it: `bind <key> css_spray` (or `!spray`). No GC or account involved.
- [ ] **User check in game:** does the client draw the unsigned decal? (If not: look at which field it checks.)
- [x] Catalog: graffiti + tints (ByMykel graffiti.json, grouped by def, tint from the id suffix); loadout schema 5
  `graffiti` + `graffitiTint`.
- [x] App Loadout slot (tile grid + tint chips) + K window Graffiti tab (tints in the side list, `.pk-img.g<def>`
  icons from the VPK); `css_graffiti`, text-menu entry; 3 s cooldown, last 5 sprays per player kept;
  `css_prac_spray [def] [tint]` server test.

## Phase 10: Custom bot names and pictures (app UI only) (req 4)
- [x] Names: a "Bots" panel in the app (Play page) with a name list per team (+ optional clan tag); the plugin
  (BotNames.cs) renames bots on team join and spawn (controller PlayerName + clan, SetStateChanged), for MatchZy `.bot`
  and `bot_add` bots; the agent-preview stand-in is skipped.
- [x] Pictures **spike**: route 1 works. CS2 still has `sv_reliableavatardata` (server.dll CAvatarOverrideMgr): with
  it on at launch the server reads `csgo/avatars/<steamid64>.png` at player_connect_full into the
  ServerAvatarOverrides string table. Each bot with a picture gets a made-up SteamID (account ids from 4,000,000,000:
  never a real account) and the plugin fires player_connect_full for it. Live-verified server-side on 27115. Routes 2
  and 3 not needed.
- [x] App: avatar picker per bot (image → 64×64 PNG, stored in userData/bots.json, written to csgo/avatars on start).
- [ ] User check in game: scoreboard shows the bot names and pictures; your own Steam picture still shows.

## Phase 11: Inspect link / !gen import (extra)
- [x] Parse `!gen`/`!g` codes and CS2 inspect links (masked `CEconItemPreviewDataBlock` protobuf in the link hex;
  decoded locally, no third-party inspect API) → paint, seed, wear, StatTrak, name tag, stickers (slot, wear, scale,
  rotation, offset), charm (offset, seed). `S…A…D…` inventory links are refused (they need the game coordinator).
  Unit tests (round trip through an encoder, masked and unmasked); the C# decoder checked against the same hex.
- [x] App: "Import" on the Loadout page (paste → preview → apply to T, CT or both); it also shows the selected
  slot's `!gen` code with a copy button.
- [x] Chat: `!gen <code or inspect link>` applies it for the player's team; `!gen` alone prints the held weapon's code.
- [ ] User check: import a real inspect link from the market/inventory (the hex kind) and compare in game.

## Phase 12: Lineup library (extra)
- [x] Read MatchZy's saved nades (`cfg/MatchZy/savednades.json`, steamid|"default" → name → LineupPos/LineupAng/Desc/
  Map/Type) into the app: Play page "Lineups" lists per map, rename, describe, set the type, delete, copy the
  `.importnade` code, export/import a share file (our JSON, a raw savednades.json or `.importnade` lines).
- [x] In game: L window "Nades" tab (this map, own + global, type filter); Go teleports onto the spot with the saved
  angles and puts the grenade in hand. Live-tested on 27115 (teleport lands on the saved position).
- [ ] Throw replay not done: MatchZy's `.rethrow` only replays your last grenade; recording throws per lineup would
  need our own projectile capture (later, if wanted).
- [ ] **User check:** `.savenade` in practice, the Lineups panel in the app, the Nades tab (restart CS2: new layout).

## Phase 13: Workshop map browser (extra)
- [x] App: search the Steam Workshop (public web API; or paste an ID/URL), thumbnails, start on a map via
  `host_workshop_map` (existing `maps.ts`), recent maps list, one-click start. Map card pool "Workshop"
  (components/WorkshopBrowser.tsx): Popular/Newest/Most subscribed, text search, More pages, paste ID/link;
  click selects, double-click starts or changes the map. Live-checked against Steam; the UI still needs a user look.
- [x] Remember workshop map names and thumbnails locally (userData/workshop-maps.json; the L window's Map tab
  shows titles too).

## Phase 14: 3D skin editor (req 5; largest, last)
- [ ] **Spike 1 (models):** export weapon models + base textures to glTF with the ValveResourceFormat CLI (MIT),
  `npm run build:models` like build:hud, shipped in resources or extracted from the local VPK on first run. Decide on
  size and whether the paint-kit look can be approximated, or only shown live in game.
- [ ] **Spike 2 (placement):** map a raycast hit on the model to the game's sticker offset x/y + rotation (calibrate
  per weapon against known offsets in game); charm offset x/y/z too.
- [ ] three.js viewer in the app: orbit/zoom, drag stickers anywhere, rotate/scale, scrape per sticker, charm
  position, name tag, wear/seed. Every change is written to loadout.json and pushed with `css_prac_reload`
  (debounced), so inspecting (F) in game shows the exact result.
- [ ] In-game counterpart: stickers and charms in the K window + T/CT switch (moved from Phase 5b "Later").
