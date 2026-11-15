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
- [ ] Remove `steam://connect` and the `autoConnect` setting (in `src/main/index.ts`, `src/main/paths.ts` and `Play.tsx`). When the server runs, show a copyable `connect 127.0.0.1:27015` and a LAN IP variant.
- [ ] Keep one RCON password in settings instead of a random one per start. Show a copyable `rcon_password <pw>` line, so client-side `rcon <cmd>` works. **Verify** that CS2 client rcon works. If it doesn't, the plugin command below is the main route.
- [ ] Admin: on every start, write CSS `configs/admins.json` with your SteamID64 (from `accounts.ts`, which reads loginusers.vdf) and `@css/root`. Keep any other entries in the file.
- [ ] Add a PracSkins command `css_rcon <command…>` (also `!rcon`), limited to `@css/root`. It runs `Server.ExecuteCommand`, so any server command or `exec <cfg>` works from chat or the console.
- [ ] Cfgs: the mirror already copies the client `game/csgo/cfg/`. Add an app-managed server cfg folder (`%APPDATA%\CS2Prac\cfg`) that is synced into the server `cfg/` on start. An optional `autoexec_server.cfg` runs after the map loads.
- [ ] Set default server cvars on start: `sv_cheats 1`, `sv_lan 1`, `sv_hibernate_when_empty 0`.

## Phase 3: MatchZy (req 3)
- [ ] Add `src/main/setup/matchzy.ts`. It installs the pinned `MatchZy-<ver>.zip` (plugin only; latest is 0.9.3) from GitHub Releases into `game/csgo/`, using the same `installZip` and versions-file pattern as `setup/plugins.ts`. MatchZy needs CSS v369 or newer.
- [ ] Write `cfg/MatchZy/admins.json` with `{ "<your steamid>": "" }`. An empty flags string grants all MatchZy admin commands.
- [ ] Write `cfg/MatchZy/config_override.cfg` with `matchzy_autostart_mode` from the UI: Practice is 2 (default), Match is 1, Off is 0. Put our practice defaults in `prac_override.cfg`. Never edit MatchZy's own cfgs, because its updates replace them.
- [ ] On the Play page, add a Mode selector (Practice / Match / Plain) and show the MatchZy version in the status.
- [ ] Check that PracSkins and MatchZy work together. Skins must survive `.prac`, `.bot`, `.rethrow` and round restarts, and MatchZy bots must not get your skins.
- [ ] Add a quick-reference panel in the app for MatchZy commands (`.prac`, `.bot`, `.spawn`, `.rethrow`, `.noflash`, `.clear`, `.god`, `.savenade`…).

## Phase 4: Full item catalog (req 5: all skins, agents, stickers, keychains)
- [ ] **Data spike first.** Find numeric ids for agents (with model paths), stickers and keychains.
  - Try ByMykel `inventory.json` / `all.json` first.
  - Fallback: read `scripts/items/items_game.txt` from the local CS2 `pak01_dir.vpk` with a small TS VPK and KeyValues reader. This always matches the installed game.
  - Decide based on what the data actually contains.
- [ ] Extend `catalog.ts` and `shared/skins.ts`:
  - agents: per team, with model path
  - stickers: id, name, image
  - keychains: id, name, image

  Then bump `CATALOG_VERSION`.
- [ ] Loadout schema 2 (`loadoutStore.ts` ↔ `plugin/PracSkins/Loadout.cs`):
  - each weapon: `stickers[5]` `{id, wear, scale, rotation, x, y}` and `keychain {id, x, y, z, seed}`
  - `agent {t, ct}`
  - migrate schema 1 files
- [ ] Plugin, using the WeaponPaints technique:
  - stickers: `sticker slot N id/wear/scale/rotation/offset x/offset y`, with the id passed through `BitConverter.Int32BitsToSingle`
  - keychain: `keychain slot 0 id/offset x/y/z/seed`
  - agent: `pawn.SetModel("agents/models/<model>.vmdl")` on spawn, in NextFrame
- [ ] Loadout page: an agent picker per team, and a sticker-slot and keychain editor per weapon with search and images.
- [ ] Live refresh: `css_prac_reload` re-gives the current weapons (keeping ammo and the active slot) and re-applies gloves and agent, with no respawn needed.

## Phase 5: In-game menu (req 4: press K, pick skins live)
- [ ] The app exports a compact `catalog.json` next to `loadout.json` for the plugin. It holds names and ids for weapons, knives, gloves, agents, stickers and keychains.
- [ ] Build a center-screen HTML menu in PracSkins with no extra dependency. Controls: W/S move, A/D page, E select, R back. Read buttons in `OnTick` and freeze movement while the menu is open.
- [ ] `css_menu` (also `!skins`) opens the menu with these sections:
  - Weapon skins, current weapon first
  - Knife
  - Gloves
  - Agent
  - Stickers and Keychain for the current weapon

  After picking a finish, choose a wear preset (FN/MW/FT/WW/BS) and StatTrak on or off.
- [ ] Search for big lists: `!skin <text>`, `!sticker <text>` and `!knife <text>` open the menu filtered.
- [ ] The plugin writes choices back to `loadout.json` (atomic write) and applies them at once. The app watches the file (`fs.watch`) and updates the active profile, so the menu and the app stay in sync.
- [ ] The app shows the bind line to paste into your autoexec: `bind k css_menu`.

## Phase 6: Hardening and v1.0
- [ ] Pin known-good versions of Metamod, CSS and MatchZy. "Check for plugin updates" becomes an explicit button, so a bad upstream release can't break a start.
- [ ] Detect a CS2 update (the buildid changes) and broken plugins (CSS missing from `meta list`, or a signature failure in `css_prac_status`). Show a clear banner with a Repair button.
- [ ] Crash recovery: detect when the server dies and offer a restart. On app launch, clean up a stale cs2.exe.
- [ ] Tests: catalog parsing, loadout v2 migration, the admins.json and MatchZy cfg writers, and the plugin JSON round-trip.
- [ ] Tag `v1.0.0`, which publishes the installer.
