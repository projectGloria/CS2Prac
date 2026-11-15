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
- [ ] **User check in game:** the floor squares look right everywhere (T spawn slope), `.glow` outline visible through walls and back after a bot respawns, E still opens doors / defuses when not aiming at a square.

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
- [ ] **User check in game:** stickers/charm look right (slot positions, scrape, the Position offsets), agent model and arms, instant refresh keeps ammo and active weapon.

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
- [ ] **User check in game:** `bind k css_menu`, navigation feel (W/S/A/D/E/R, hold to scroll), freeze/unfreeze, every page applies instantly, the app's Loadout tab follows the menu's picks.

## Phase 6: Hardening and v1.0
- [x] Pin known-good versions of Metamod, CSS and MatchZy. "Check for plugin updates" becomes an explicit button, so a bad upstream release can't break a start.
- [x] Detect a CS2 update (the buildid changes) and broken plugins (CSS missing from `meta list`, or a signature failure in `css_prac_status`). Show a clear banner with a Repair button.
- [x] Crash recovery: detect when the server dies and offer a restart. On app launch, clean up a stale cs2.exe.
- [x] Tests: catalog parsing, loadout v2 migration, the admins.json and MatchZy cfg writers, and the plugin JSON round-trip.
- [ ] Tag `v1.0.0`, which publishes the installer.
- [x] Verified live: health check is clean on a good server; leftover-process cleanup kills only `<installDir>\server\...\cs2.exe`.
### Own client cfg on the server (asked for during testing)
- [x] The user's `pracNihil` (client cfg `Nihil.cfg`) only half worked: on a dedicated server the client refuses replicated cvars and the server rejects bot_kick/ent_fire/mp_warmup_end from players (6× ent_fire per DEL press got them kicked for "too many failed console commands").
- [x] Fix, at the user's request, inside their own `Nihil.cfg` (no second cfg, no app-generated copy; an app-side "cfg bridge" was tried and reverted): a `pracGloria` section with `gloria_*` aliases that mirror pracNihil but send every server command as `css_cmd <command>`. pracNihil stays for offline practice.
- [ ] **User check in game:** `exec Nihil`, connect, `pracGloria`; the bot/clear/ammo/impact/nade keys; no kick on spamming DEL. Bind K to `css_menu` (the user does this). Each `css_cmd` echoes one "[CS2Prac] ran: …" console line; make it quiet if the user finds it noisy.

### Bundle and server name (asked for before v1.0)
- [x] Everything in the installer: Metamod, CounterStrikeSharp (with runtime) and MatchZy at the pinned versions, a skin
  data snapshot and the third-party licenses (`npm run build:bundle` → `resources/bundle`). Setup and Repair install from
  it with no download. Verified offline (network blocked): all three install; the installer is ~207 MB.
- [x] Server name setting (Play → Options, default "Nihil Prac Server"): MatchZy chat prefix, hostname and PracSkins
  messages show `[Nihil Prac Server]`. Verified live on a test server.
- [ ] **User check in game:** MatchZy and CS2Prac chat messages show `[Nihil Prac Server]`; a fresh Setup works offline.

### Movement mode (asked for before v1.0; `plugin/PracSkins/Movement.cs`)
- [x] `.movement` (or `!movement`) toggles it per player. Spots are recorded in game: `.movement save <name>` at the jump
  start (position + view direction), `.movement fail` on the floor you'd fall onto (default: 64 units below the start),
  `.movement delete <name>`, `.movement list`, `.movement <name>`. Saved per map in
  `configs/plugins/PracSkins/movement/<map>.json`; green squares + names mark them while anyone is in the mode.
- [x] Landing below the fail height teleports back to the start (a miss); landing over 80 units from the start and above
  it counts as made. Center banner "Made it!" / "Missed" with made/attempts per spot. `.next`/`.prev`/`.reset` (only
  while on). No fall damage (sv_falldamage_scale 0 while anyone is in the mode, restored after).
- [x] Verified on a test server: plugin loads, spot file is read, markers spawn, no engine asserts. Needs a player for the rest.
- [ ] **User check in game:** record Mirage window → short, fall into mid (auto back + "Missed"), make it ("Made it!"),
  counter, no fall damage, markers visible, `.next`/`.prev` with two spots.
- [ ] Maybe later: movement spots in the K menu; E on a green square to go there.

### UI polish (asked for before v1.0)
- [x] No extra window on server start, not even a flash: cs2.exe runs on an invisible desktop
  (server/hiddenLaunch.ts). Verified on a test server: no window, RCON connects, output streams, quit works.
- [x] Icons next to the tab names (Play, Loadout, Console, Setup) and Logs (lucide-react).
- [x] Frameless window: our own title bar (icon, tabs, status, logs, version, minimize/maximize/close; drag to move,
  double-click to maximize). Thin overlay scrollbars that only show on hover instead of the classic Windows ones.
- [ ] **User check:** start the server and see no window at all; the icons look right; the title bar and scrollbars feel right.

## Next
- [ ] User tests Phases 1–6 in game and reports issues. Done so far: Phase 1, Phase 2, Phase 3 (glow pending). Pending too: pracGloria (own cfg on the server). Next: Phase 4 (stickers, charms, agents, live refresh), then Phase 5 (K menu), then Phase 6 notices.
- [ ] When happy: bump `version` to 1.0.0, commit, and push tag `v1.0.0` (the user asks for it; it publishes a public release).
