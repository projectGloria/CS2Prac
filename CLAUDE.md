# CS2Prac: guidance for Claude Code

## What this is
CS2Prac is a personal Windows desktop app (Electron + React + TypeScript) that runs a **local CS2 practice server**. The user picks any map, starts the server, connects from their own CS2 client, and is admin there. Skins (weapons, knives, gloves, and later agents, stickers and keychains) are applied **server-side** by our CounterStrikeSharp plugin `PracSkins`. MatchZy provides the practice features.
The app never touches the game client's memory; the only files it adds to the client install are the skin window's two Panorama files (see "Skin window"). Everything happens on a private `-insecure` + `sv_lan 1` server, so there is no VAC risk.

## Working rules
- **Commit only when the user says so**, then push directly to `main`. No branches, no PRs. During UI work the user watches changes live in `npm run dev` and decides when a section is done; run typecheck + tests, leave the changes uncommitted and wait. Never push a `v*` release tag unless asked.
- Work **phase by phase from `todo.md`**. Tick boxes as items land and keep the file current, since it is the source of truth for what's left.
- The user tests each phase in game later and reports problems; fix them as they come in.
- Keep `plugin/PracSkins/Loadout.cs` and `src/main/skins/loadoutStore.ts` (the loadout.json schema) in sync. Bump the schema number when the shape changes.

## Architecture
```
src/main/            Electron main process (Node). Does all the real work.
  index.ts           bootstrap + IPC handlers (setup, server start/stop, loadout, settings)
  paths.ts           settings.json in userData; layout(installDir) gives server/cs2.exe/csgo paths
  logger.ts          <userData>/logs/main.log (rotates at 5 MB to main.old.log); setup, server output, errors
  updater.ts         electron-updater against GitHub Releases (packaged builds only)
  steam/library.ts   finds the Steam CS2 install (registry SteamPath, libraryfolders.vdf, appmanifest_730.acf)
  steam/accounts.ts  steamPath + local SteamID64/persona from loginusers.vdf
  setup/mirror.ts    hard-link mirror of the client CS2 install into <installDir>/server
  setup/steamcmd.ts  alternative: full dedicated server via SteamCMD (~60 GB)
  setup/plugins.ts   downloads Metamod 2.x + CounterStrikeSharp (with-runtime) into game/csgo
  setup/gameinfo.ts  patches gameinfo.gi with `Game csgo/addons/metamod` (re-applied every start)
  setup/cssConfig.ts sets CSS core.json FollowCS2ServerGuidelines=false (required for skins)
  setup/matchzy.ts   pinned MatchZy (MATCHZY_VERSION) install; every start writes cfg/MatchZy/config_override.cfg
                     (matchzy_autostart_mode from settings.matchzyMode), prac_override.cfg and MatchZy admins.json
  setup/unzip.ts     extractZip via C:\Windows\System32	ar.exe (extract-zip hung on some zips; don't bring it back)
  setup/pracskins.ts copies the prebuilt PracSkins plugin and ensures the CSS config
  setup/serverConfig.ts  every start: CSS admins.json (all local Steam accounts = @css/root, entries prefixed cs2prac_),
                     copies %APPDATA%/CS2Prac/cfg into server cfg/, writes cs2prac_defaults.cfg (sv_cheats 1 ...)
  server/serverManager.ts  spawns cs2.exe, pipes its output to the UI, waits for RCON, stop/kill
  server/launchArgs.ts     builds the cs2.exe arguments
  server/rcon.ts     minimal Source RCON client
  server/maps.ts     official map list + workshop handling
  skins/catalog.ts   builds the catalog from ByMykel/CSGO-API (cached 7 days): weapons, skins, agents
                     (model_player), stickers (~11k), keychains; bump CATALOG_VERSION when the shape changes
  skins/loadoutStore.ts  profiles in userData; exports loadout.json for the plugin
src/preload/         contextBridge typed API (window.api)
src/shared/          ipc.ts (IPC contract + types), skins.ts (catalog/loadout types)
src/renderer/        React UI: pages/Setup, Play, Loadout, Console (tab icons from lucide-react)
plugin/PracSkins/    C# CounterStrikeSharp plugin (PracSkins.cs, Loadout.cs). Built to resources/plugin/
```

## How it runs
1. **Server files.** The default source is `client`. `syncMirror` hard-links every file of the user's Steam CS2 install into `<installDir>/server`, which needs the **same NTFS drive**. Some files are handled differently:
   - `gameinfo.gi` and `cfg/` are copied, not linked. The server modifies them and the client must stay untouched.
   - `game/csgo/addons`, `console.log` and `*.mdmp` are skipped.
   - The mirror re-syncs before every start. It takes ~10 s the first time and under 1 s after.
   - `cs2prac-mirror.json` records the links so stale ones can be removed.
   - Before a SteamCMD install the mirror is deleted, so SteamCMD never writes through hard links into the game.
2. **Plugins.** Metamod and CSS go into `game/csgo/addons`, the versions are recorded in `addons/cs2prac-versions.json`, and PracSkins is copied from `resources/plugin`.
3. **Start.** `cs2.exe -dedicated -insecure -usercon -ip 127.0.0.1 -port 27015 +sv_lan 1 +rcon_password <pw> +map …`. Stdout and stderr are piped and streamed to the Console page. The server counts as ready once RCON connects.
4. **Skins.** The Loadout page saves a profile. The app writes `addons/counterstrikesharp/configs/plugins/PracSkins/loadout.json` and sends `css_prac_reload` over RCON. The plugin applies skins on GiveNamedItem, spawn and entity creation, using WeaponPaints' technique: fallback paint kit, `SetOrAddAttributeValueByName`, knife subclass and glove attributes.

## Gotchas learned the hard way
- **Always read cs2.exe's stdout and stderr.** An unread pipe fills up and freezes the server. With piped stdio the server writes nothing to `console.log`. Filter out `CTextConsoleWin::GetLine` spam.
- **cs2.exe opens its own console window** ("Counter-Strike 2", ConsoleWindowClass) even with windowsHide or a hidden
  parent console: it allocates the console itself, and hiding it afterwards flashes. server/hiddenLaunch.ts starts cs2
  on an invisible desktop ("CS2PracHidden"): a hidden PowerShell (script via -EncodedCommand, exe/cmdline/cwd via env
  vars it removes) calls CreateProcess with lpDesktop and our pipes as std handles, waits and exits with cs2's code.
  The Node child is that launcher; `taskkill /T` on it also kills cs2. Verified: no window, RCON and output work.
- **`-ip 127.0.0.1` is required.** Without it RCON TCP binds only to the LAN IP and connecting to 127.0.0.1 fails with ECONNREFUSED.
- **CSS `FollowCS2ServerGuidelines` must be `false`**, or `m_iEntityQuality`, `m_OriginalOwnerXuidLow` and other fields are blocked and skins silently fail. CSS reads it only at server start.
- **An empty or bots-only server hibernates.** Plugin timers and NextFrame don't run during hibernation, so use `sv_hibernate_when_empty 0` when testing with bots.
- The `Could not PreloadLibrary … Access violation` lines in the server log are harmless.
- npm 11 blocks install scripts. `package.json` has an `allowScripts` entry for Electron. If the Electron binary is missing, run `node node_modules/electron/install.js`.
- Node's type-stripping can't import `rcon.ts` because it uses parameter properties. For live experiments, write a temporary `*.test.ts` and run it with vitest, then delete it.
- Don't write TS or C# source through shell heredocs. They turned `\n` and `\r?\n` into real newlines. Use the Write and Edit tools.
- **Live tests: never use port 27015.** The user's server may be running there; wrong-password RCON attempts get
  127.0.0.1 rcon-banned on it ("Banning 127.0.0.1 for rcon hacking attempts"), which breaks the app until a restart.
  Start test servers on another port (e.g. 27115) and send all commands over one authenticated RCON connection.
- **Never kick a bot MatchZy's `.bot` just placed while it overlaps a player.** `.bot` starts a 0.1 s collision timer
  per (player, bot) that reads the bot until they stop overlapping; kicking it first crashed the server (NRE every tick,
  then 0xC0000005). SafeKick.cs catches every `bot_kick` (AddCommandListener), lifts the bots away and re-runs it 0.35 s
  later; our own kicks of bots known to stand apart use `ExecKickNow`.
- **`play <sound>` crashes the dedicated server** (access violation 0xC0000005; no sound system). Client cfgs run with
  `!cmd exec` often contain it. PracSkins swallows the sound commands with AddCommandListener (`SoundCommands`).
- **Never plain `SetModel` on an entity before `DispatchSpawn`.** It trips an engine assert (EF_IN_STAGING_LIST); the
  minidump write stalls the server ~1 s and connected clients drop with NETWORK_DISCONNECT_OVERFLOW (no crash without a
  client, so test servers miss it). Use `SetModelBeforeSpawn` (Practice.cs; clears that flag first). A "model" spawn
  keyvalue avoids the assert too, but glow props spawned that way never showed on the client.
  Grep the server log for `Assertion Failed` after adding entity code.
- Signatures (`CAttributeList_SetOrAddAttributeValueByName`) can break after CS2 updates. `css_prac_status` reports whether the function was resolved.

## Commands
```
npm install            # first time (then: node node_modules/electron/install.js if Electron is missing)
npm run dev            # run the app with hot reload
npm test               # vitest unit tests
npm run typecheck      # tsc for main + renderer
npm run build:plugin   # dotnet build of PracSkins into resources/plugin/PracSkins (.NET 10 SDK)
npm run dist           # build + NSIS installer into dist/ (never publishes)
```
**Release:** bump `version` in package.json, commit, `git tag vX.Y.Z && git push origin vX.Y.Z`. `.github/workflows/release.yml`
(windows-latest) checks the tag matches, type-checks, tests, builds the plugin and runs `npm run release`, which publishes the
installer + `latest.yml` to GitHub Releases. Installed apps pick it up through auto-update. Only tag when the user asks.
A workflow step creates the draft release first (electron-builder's parallel uploads each created one: v1.0.0 got two
drafts), with notes from `docs/release-notes/<tag>/RELEASE_NOTES.md` via scripts/release-notes.mjs (relative image
paths → raw links pinned to the tag). The release stays a draft until published (`gh release edit <tag> --draft=false
--latest`). Write release bodies with Node/bash, never PowerShell 5.1 Get-Content: it reads UTF-8 as ANSI (mojibake emoji).

## Pins and music kits (Phase 8, loadout schema 4)
- Catalog `pins` (ByMykel collectibles.json: every collectible, `type` = Pin/Service Medal/coins …) and `musicKits`
  (music_kits.json, `_st` StatTrak copies skipped); both optional in the bundle/download (empty when missing).
- loadout.json `pin` / `musicKit` (def index, 0 = none), one per loadout for both teams. ApplyProfileItems (PracSkins.cs):
  `InventoryServices.Rank[5] = (MedalRank_t)pin`, `InventoryServices.MusicID` + controller `MusicKitID`, SetStateChanged
  on `m_pInventoryServices` / `m_iMusicKitID`; on spawn and css_prac_reload; reset to 0 only for slots we set.
- K window tabs `pins`/`music` (tiles, side list hidden; images `.pk-img.p<def>` from items' image_inventory
  econ/status_icons/…, `.pk-img.m<def>` from music_definitions). Text menu: `!pin`, `!music` and root entries.
  Live-tested on 27115 (status shows pin/music per player, survives mp_restartgame).

- ByMykel lacks music kits 32–38: `EXTRA_MUSIC_KITS` (catalog.ts) adds them without an image. The K window grid is
  GridCols × 32 = 128 tiles (build-hud GRID_ROWS 32) so all music kits fit on one page.
- Bot/human avatars in game depend on the client's `cl_hide_avatar_images` (2 = friends only; the user's Nihil.cfg has 2).
- Music previews (MusicPreview.cs): the music tab's side list plays the picked kit's parts (MVP, main menu, round
  start …) as `Music.<Part>.<kit>` sound events (soundevents/music/<kit>/game_sounds_music.vsndevts_c) for the clicking
  player only; a new preview first stops the old one (client stopsound; sv_cheats 1).

## Graffiti (Phase 9, loadout schema 5)
- plugin/PracSkins/Graffiti.cs: `css_spray` (client; bind a key, or `!spray`) traces from the eye (200 units,
  `Masks.PlayerSolidBrushOnly`, rejects angles flatter than dot −0.2) and spawns `player_spray_decal` itself:
  UniqueID = sticker kit def, TintID 1–19 (items_game graffiti_tints; 0 = untinted), EndPos/Normal/Left (left in the
  surface: horizontal on walls, from yaw on floors), AccountID, Player = controller index, Version (default 1, `css_prac_sprayversion`), Start = eye, then DispatchSpawn +
  Teleport to the hit. The decal's `Entity` field clashes with CEntityInstance.Entity (read-only): not set.
- **No GC signing:** the game's own spray asks the Steam GC to sign the decal (account involved); we never touch
  that path. Whether the client draws an unsigned decal is for the user to check in game.
- Catalog `graffiti` (ByMykel graffiti.json; one entry per def, `tints` = tint id → image from `graffiti-<def>_<tint>`).
  loadout.json `graffiti` / `graffitiTint` (both teams). K window tab `graffiti` (tints in the side list, icons
  `.pk-img.g<def>` from sticker_kits spray_* and tournament *_graffiti kits, `econ/stickers/<sticker_material>_png`; most tiles were
  empty before the *_graffiti ones were added). 3 s cooldown, 5 sprays per player. The game's own T (spray wheel) never
  reaches the plugin: the user's Nihil.cfg binds T to `+cs2prac_spray` (`css_spraywheel open|close`; `css_graffiti` is
  the text menu's `!graffiti`, taken).
- **Checkerboard decal = texture not precached.** build-hud writes resources/hud/graffiti.json (def → spray vtex
  paths from materials/decals/sprays); the app copies it into configs/plugins/PracSkins at start and
  PrecacheGraffiti adds every one to the manifest. Not yet confirmed in game.
- Graffiti wheel (GraffitiWheel.cs, layout fragment scripts/hud/cs2prac_graffiti.xml/.css at `<!--GRAFFITI_WHEEL-->`,
  ids `gw_*` routed from Hud.cs OnHudClicked): tap T sprays (SprayNow, shared with css_spray); held 0.2 s the wheel
  shows (input capture, no freeze); release sprays unless Cancel/"All graffiti"/K/L dismissed it (DismissWheel keeps
  a cancelled held session to swallow the release). Slots = HudPrefs.Graffiti recents (a pick already there keeps
  its place) + the current one + catalog fill. build-hud generates `.gw-tint.gt<id>` and `.pk-img.gw-wash-<id>`
  (wash-color) from items_game graffiti_tints. Panorama :hover is client-only, so a slot is picked by clicking.
- **The client takes the spray texture from `m_nPlayer`** (client.dll: sticker kit by that id → its sticker_material →
  `materials/decals/sprays/%s.vtex` + `_nodrips`, async manifest "AsyncPlayerSprayDecal"), so Spray sets Player = the
  graffiti def. With the player index there the unsigned decal drew as a checkerboard (user, 2026-11-17).
  User-confirmed: the graffiti now draws. Each spray plays `SprayCan.Paint` (server.dll's spray event; `SprayCan.Shake`
  exists too) from the pawn to all players (PlaySpraySound).
- **player_spray_decal drew nothing in game** (user, 2026-11-17, textures precached): the client entity has
  `m_ubSignature` + `m_rtGcTime` (GC-signed), so an unsigned one is most likely dropped. Candidate: `env_decal`
  (networked CEnvDecal: decalmaterial/width/height/depth keyvalues); `css_decaltest` tests it with stock materials.
  The spray textures have no own vmat (playerspraydecal.vmat binds SprayTexture at runtime).
- Server test: `css_prac_spray [def] [tint]` (first live bot; aims down if it looks at the horizon; prints every decal).

## Bot names and pictures (Phase 10)
- App: Play page "Bots" (components/Bots.tsx) → userData/bots.json (src/shared/bots.ts, src/main/setup/bots.ts). Every
  start and every save writes the plugin's `configs/plugins/PracSkins/bots.json` ({schema 1, t/ct: name, clan,
  avatar bool}); a save while running sends `css_prac_bots`. plugin/PracSkins/BotNames.cs matches bots of a team to the
  list in join order (a bot keeps its entry while on the team; stand-ins skipped).
- Pictures = the engine's server avatar overrides: `+sv_reliableavatardata 1` **at launch** (bool cvar; 2 does nothing;
  it only takes effect from the next map load). At player_connect_full the server reads `csgo/avatars/<steamid64>.png`
  into string table `ServerAvatarOverrides` (`dumpstringtable ServerAvatarOverrides sv verbose`). `avatars/default.png`
  must exist (solidPng). A bot with a picture gets SteamID `76561197960265728 + 4e9 (+100 for CT) + index` (far above
  any issued account) and we fire `EventPlayerConnectFull` for it. With the cvar on, humans need a file too: the app
  copies the local accounts' `<steam>/config/avatarcache/<id>.png`. Files written are listed in
  avatars/cs2prac-avatars.json and removed next time. The cvar is only set when some bot has a picture.
- The picked picture is read with FileReader as a data URL (the renderer CSP blocks blob: URLs: that was "Could not
  read that image"), drawn to a canvas and saved as PNG.
- Override files over 16 KB are dropped (the player then shows default.png's grey square): Steam's avatarcache files
  are 184×184 (~70 KB), so `put` shrinks anything larger to 64×64 with nativeImage (`shrinkAvatar`, index.ts).
- **The client draws its own Avatar__Bot picture (and drops the clan tag) for controllers with FL_FAKECLIENT**
  (user-confirmed with a flag-off experiment: our pictures and clan tags on the scoreboard). Server code reads
  the flag too (CSS IsBot; MatchZy respawns practice bots at their spot and kicks untracked bots by it; the engine's
  bot_kick). **Our own code must use `IsBotAny(p)`, never `p.IsBot`** (it misses shown bots).
- **MatchZy's `GetTrackedBotCount()` permanently drops tracked bots that aren't IsBot** (then bot_quota too low, bots
  kicked as untracked, "run .nobots", and a kick during `.bot`'s collision timer crashed the server, 0xC0000005).
  The engine's bot_quota does not count by the flag (live-tested).
- **Flag off only for the snapshot** (BotNames.cs): holding the flag around MatchZy's reads failed both ways (a
  networked hold took every bot's picture away on each `.bot`/death; a memory-only one leaked into the next packed
  snapshot, user test 2026-11-17: clients see whatever m_fFlags holds when the entity is packed). Measured frame
  order (probe on 27115, per tick): pre-entity-think > post-think > timers > OnTick > NextFrame > pre-world-update >
  command buffer (rcon, ExecuteCommand, bot_add, put-in-server, spawn/team events); CheckTransmit only runs with a
  human client (assumed: right before packing). So CheckTransmit clears the flag on `_botShown` bots (SetStateChanged
  only the first time), and OnServerPreEntityThink / pre-world-update / OnTick, Pre listeners for say/say_team/jointeam
  and MatchZy's bot/match css_ commands, connect/put-in-server/disconnect set it back in memory. Shown = team 2/3,
  not a stand-in, has a picture id, not held; OnBotPictureTick (0.1 s) updates the set. HoldBotFlag only remains for
  SafeKick's held bot_kick (engine kick goes by the flag). User-confirmed in game 2026-11-17: pictures right away,
  no reset when another bot joins, kept on respawn, clan tags shown, no "(BOT)" in the kill feed (not even for
  bots without a clan tag).
- **The top bar picks stock vs our picture when it rebuilds (spawns, deaths …), not when the flag changes**, so 0.1 s
  after a bot is first shown AnnounceBotPicture sends its player_spawn again to the human clients only
  (FireEventToClient).
- **The engine adds a SteamID's avatar to ServerAvatarOverrides only the first time it sees that id** (a second bot
  on the same entry showed the stock picture). Each assignment gets a fresh id: CopyAvatar copies `<entry id>.png` to
  `<AvatarCopyBase + seq>.png` (deleted 10 s later; leftovers removed at plugin load). Live-tested on 27115.
- Clan tags: after setting m_szClan, `nextlevel_changed` is fired (RefreshScoreboard) so the scoreboard redraws.
- Possible issue (untested): MatchZy match mode might treat a bot with a SteamID as an unknown player.

## !gen codes and inspect links (Phase 11)
- src/shared/itemCode.ts ↔ plugin/PracSkins/ItemCode.cs (same rules). `!gen def paint seed wear [sticker wear]×5 [charm
  seed]`; inspect hex = CEconItemPreviewDataBlock (3 def, 4 paint, 7 wear float bits, 8 seed, 9/10 kill eater, 11 name,
  12 stickers {1 slot, 2 id, 3 wear, 4 scale, 5 rotation, 7/8/9 offset, 10 pattern}, 20 keychains), every byte XOR the
  first, 4-byte checksum at the end (not checked). `encodeInspectData` (key 0) exists for tests; its checksum formula is
  unverified against the game, so the UI does not offer "copy inspect link".
- App: Loadout bar "Import" (components/ImportItem.tsx). Plugin: `css_gen` / `!gen` (CLIENT_ONLY, CanEdit).

## Loadout schema 3 (weapons per team)
- loadout.json `schema: 3`: `weapons.{t,ct}` = { "<defIndex>": paint } (a skin can differ per faction). Schema 1/2 had one
  flat map; the plugin's TeamWeaponsConverter and the app's `perTeamWeapons` (also for old profiles in loadouts.json)
  copy it to both teams. The menu's weapon pages take the player's team (`FinishPage(team, def)` …).
- Since schema 2: per weapon `stickers[5]` ({defIndex, wear, scale, rotation, x, y} or null) and `keychain`
  ({defIndex, x, y, z, seed}); `agents.{t,ct}` ({defIndex, model}); `precache` = every agent model. The plugin
  precaches those in OnServerPrecacheResources so agents can change without a map change. Schema 1 still loads.
- Sticker/keychain ids and keychain seed go through `BitsAsFloat`; they're written to NetworkedDynamicAttributes only.
- Knife body groups: the Doppler family + Ultraviolet on Paracord/Survival/Nomad/Skeleton need body_legacy although
  nothing flags them (ForceLegacy / forceLegacy); `css_knifebody 0|1` flips the held weapon's body group to test.
- A K-window pick re-gives only the picked weapon (RefreshPlayer focusDef); `css_prac_reload` and glove changes re-give all.
- `css_prac_reload` calls RefreshPlayer: kills and re-gives guns + knife (keeping clip/reserve, re-selecting the active
  weapon), then re-applies agent and gloves.
- `css_prac_status` shows each pawn's model and each weapon's dynamic attribute count (useful to see stickers landed).

## In-game menu (Phase 5)
- plugin/PracSkins/Menu.cs: generic center-HTML menu (PrintToCenterHtml re-sent **every tick**: CS2 shows a center
  message only for a moment whatever the duration, so once a second blinked; the HTML is rebuilt on changes and once
  a second; the movement banner is re-sent per tick for 2 s the same way), input read from
  `player.Buttons` in OnTick (W/S/A/D/E/R, hold-to-repeat), player frozen with MOVETYPE_NONE while open.
- plugin/PracSkins/SkinMenu.cs: pages and commands `css_menu`/`css_skins` (toggle), `css_skin|knife|gloves|agent|sticker|charm <text>`,
  `css_prac_save` (server only; writes loadout.json, for tests).
- The app writes `catalog.json` (src/main/skins/pluginCatalog.ts ↔ plugin/PracSkins/Catalog.cs) at server start and
  whenever the catalog loads. Menu picks are saved by the plugin to loadout.json (camelCase, atomic) and applied at once;
  the app watches that folder (`watchLoadout` in index.ts) and imports into the active profile (`importLoadoutFile`),
  then sends `loadout:changed` so the Loadout tab updates.

## Skin window (plugin/PracSkins/Hud.cs, scripts/hud)
- K = `css_menu` opens a real Panorama window (`custom_hud_layout` entity, CSS API extension methods in
  `CounterStrikeSharp.API.Modules.Extensions`: SetDialogVariableStringForPlayer / SetHasClassForPlayer /
  SetInputCaptureEnabled, `Listeners.OnCustomHudClicked`). `css_skins` / `!skins` is the old text menu (fallback;
  css_menu also falls back to it while the entity doesn't exist yet). Technique and pitfalls from nvmxre/cs2-ui-kit
  (MIT, docs/GOTCHAS.md): root panel without id; only Panel/Label/Image/Button; no inline style; images only as CSS
  backgrounds; entities only after the first round_start; per-slot state outlives a disconnect (reset on put-in-server).
- Layout/CSS sources: scripts/hud/cs2prac_skins.xml + .css. `npm run build:hud` (needs CS2 Workshop Tools'
  resourcecompiler.exe) fills the row/tile markers (counts = SideRows/GridTiles in Hud.cs), appends generated image
  classes from the game's VPK (scripts/hud/vpk.mjs) + items_game.txt (keyvalues.mjs): `.pk-img.b<def>` base weapon,
  `.pk-img.s<def>_<paint>` skin icon (econ/default_generated/<item>_<codename>_light_png; listed after the base rules
  so it wins), `.pk-bar.s<def>_<paint>` rarity colour, `.pk-img.a<def>` agent. Output: resources/hud/*.vxml_c/.vcss_c
  (committed, shipped as <resources>/hud). Rebuild after layout changes or CS2 updates with new skins.
- The app (setup/clientHud.ts, every server start) copies them into the CLIENT's game/csgo/panorama/{layout,styles}/
  custom_game/ (user's choice: local loose files, no Workshop addon/MultiAddonManager). This is the one place the app
  writes into the game client folder (two new files only). Panorama caches layouts: restart CS2 after a change.
- Hud.cs sends only changed texts/classes per slot (HudSent cache); tile images are class "variants" (old one removed).
- Lists scroll (`overflow: squish scroll`, user-confirmed): 36 side rows, 128 tiles (32 rows; empty rows get class
  gone); the pager only shows (class gone otherwise) if a list ever outgrows 128. Side rows carry an icon panel
  (`pk_side_<i>_img`, classes pk-img pk-row-img + the b<def> icon; gloves have no base icon, so the worn finish or the
  type's first finish).
- **The client validates the layout and silently drops a rejected one** ("Layout xml did not pass CustomHud
  validation" in the CLIENT console only): the server still freezes the player and hides HUD bits, but nothing draws.
  The compiler checks nothing (made-up CSS properties compile fine). Known rejection: a full-screen self-closing
  `<Button id="pk_dim" />` backdrop (so no click-outside-to-close; ESC never reaches the server either, so a fresh Tab press,
  IN_SCORE in OnHudTick, closes the window besides K and the close button). To bisect,
  build variants (`HUD_VARIANT=x` + HUD_XML/HUD_CSS/HUD_SIDE_ROWS/HUD_GRID_ROWS env in build-hud.mjs), copy them into
  the client's panorama folders, restart CS2 once and switch the entity's StrLayout per variant.
- `css_prac_hud` also counts the class/text entries sent per slot; `css_prac_hudopen` / `css_prac_hudclick <id>` drive
  the window for the first bot (server tests).
- **The client refuses a server-sent `use`** ("[InputService] Cannot execute concommand 'use', missing required
  FCVAR flag"; a server-side `use` doesn't move the client's predicted weapon either), so UseWeapon (AgentView.cs) sends
  humans the slot key of the weapon's gear slot (slot1…slot5; `lastinv`/slot keys are accepted). Bots keep `use`.
  Clicking a gun equips it (`EquipForHud`): CS2 allows one gun per slot (a second rifle is dropped on the floor) and
  `use` only switches while something is in hand, so: knife out (if the replaced gun is held), 0.15 s, remove the
  slot's gun, GiveNamedItem, `use <DesignerName>` (M4A1-S is weapon_m4a1 there). Bots don't follow `use` reliably, so
  `css_prac_hudequip <def>` (server test on the first bot) only proves the slot swap, not the switch.
  Every gun equips on either side (AK/Glock as CT …). K opens on the held gun (weapons tab, or stickers if that was
  last) or knife; the T/CT switch always starts on the player's own team (a stale switch saved picks to the other
  team). The Zeus is re-given on refresh too, and RefreshPlayer skips while one is pending (`_refreshPending`).
  Reopening on agents with Third person starts the preview (SyncAgentView in OpenHud). Stand-in bots never glow.

## Server settings window (plugin/PracSkins/SettingsHud.cs, Phase 7)
- L = `css_pracmenu` (@css/root). **MatchZy owns `css_settings`/`.settings`** (prints its "Current Settings"), so L must not use it; css_settings stays as a compat alias. The window `ps_win` is part of the skin window's layout (one
  `custom_hud_layout`, one input capture): Hud.cs routes click ids starting `ps_` to OnSettingsClicked; opening one
  window closes the other. Source fragment scripts/hud/cs2prac_settings.xml/.css, inserted by build-hud.mjs at
  `<!--SETTINGS_WINDOW-->` (rows/chips counts = SetRows/RowChips).
- SetDefs (C#) ↔ `src/shared/serverSettings.ts` SETTINGS: same ids, tabs and option values; keep them in sync.
- `configs/plugins/PracSkins/server_prefs.json` `{global:{id:value}, maps:{map:{id:value}}}` (map over global), edited
  by the window (scope chips) and the app's Play page "Server settings" (global only + clear a map). Applied 2.5 s
  after map start, by `css_prac_settings_apply` (prac_override.cfg; the app after saving). The app's loadout watcher
  also watches this file (`server:prefsChanged`). `maps.json` (written by the app) = recent workshop maps for the Map tab.
- Sky: the map's own `env_sky` gets the new material pointer written into `m_hSkyMaterial` and
  `m_hSkyMaterialLightingOnly` (+ SetStateChanged), the pointer from VMaterialSystem2_001's
  FindOrCreateMaterialFromResource (vtable 14, Windows; as CS2-SkyboxChanger). The older ways (a new env_sky with the
  material keyvalue + Disable on the map's, its tint black by default) changed the server state but never the
  client's sky. Materials precached. Not yet confirmed in game.
- The client refuses server-sent HUD cvars AND aliases (ExecuteClientCommand/ReplicateConVar; an alias ack never
  arrived), and **cl_drawhud 0 hides the custom window too** (user-tested): never send it. So the user's Nihil.cfg
  owns it: K/L/Tab binds keep a none/k/l state (cs2prac_k_open/_close/_from_l …) that switches the three
  cl_hud_telemetry_*_show 0/2 + cl_drawhud_force_radar -1/0 and sends `css_menu open|close` / `css_pracmenu
  open|close` (no argument = old toggle). The window's X leaves the HUD off until the next K/L press. SetClientHud
  still tries ReplicateConVar. Windows scaled up 2026-11-17 (pk-win 1475px, ps-win 1610px).
- K and L hide the same HUD parts while open (Hud.cs `HideWindowHud`: `_windowHideBits` added to `pawn.HideHUD`, re-added
  every tick if the game cleared them, only the bits we added are removed on close; HIDEHUD_ALL is avoided; bits 4/5
  added for the money panel, unverified). The telemetry panels are the client's own and stay unless it accepts the cvars.
  `css_prac_hidebits <mask|0xhex|default>` (server; in game via `!cmd`) tries other masks live and prints each player's m_iHideHUD. Panel size: cs2prac_settings.css (1400px), 48 rows (SET_ROWS/SetRows).
- After a server start whose HUD files differ from the client's copy, `ServerHealth.hudUpdated` shows a "restart CS2"
  notice on the Play page (Panorama keeps the old layout cached until then).
- Cvar changes are queued (Server.ExecuteCommand), so the cvar reads the old value for a frame or two: `_pendingSet`
  shows the clicked value for 1 s and the window redraws after the commands ran (the "click doesn't show" bug).
- Round time: mp_roundtime only counts from the next round, so the running round's `GameRules.RoundTime` is set too.
- Icons: row/tab/chip panels `ps-ic` + `ic-<name>` (panorama/images/icons/ui/<name>.vsvg) or `ie-<name>`
  (icons/equipment). build-hud.mjs generates the rules for every such class quoted in cs2prac_settings.xml,
  SettingsHud.cs and Lineups.cs (warns on a missing icon). Row icons: SetIcons (by setting id) / SetRow.Icon; chip
  icons by label (ChipIcons; On/Off/Yes/No/Use/Go show the icon only, class `iconly`).
- Both windows reopen where the player left them (`_setLast` / the skin window's equivalent, keyed by SteamID).
- Live-tested 2026-11-17 on 27115: start and end renames save (`css_prac_botsay <text>` after a Rename click; the window doesn't reopen for bots). Server tests: `css_prac_settings` (live values, saved values, env_skies), `css_prac_set <id> <value>`,
  `css_prac_setopen` (first bot), `css_prac_hudclick ps_…`. Verified live on 27115 (2026-11-16).

## Third-person agent preview (plugin/PracSkins/AgentView.cs)
- Agents tab "Third person" (pref per SteamID in configs/plugins/PracSkins/hud_prefs.json; the app's loadout watcher only
  reacts to loadout.json). A model-less, transparent prop_dynamic becomes `pawn.CameraServices.ViewEntity` (restore with
  `Raw = uint.MaxValue`); `SyncAgentView` runs it exactly while the agents tab shows with Third person picked.
- **The client turns its own pawn to the view direction** (user-tested: through the camera you only ever see your own
  back), so the preview shows a stand-in; the pawn, its weapons and its viewmodel (`predicted_viewmodel` found by owner)
  go alpha 0 meanwhile. Camera (Yaw/Elev/Dist, shifted left by Dist × SideShift, wall trace) stays; the pawn's eye
  angles are teleported to the camera's; turning changes only DollYaw.
- **Stand-in = a bot** (props can't: the engine deletes prop_dynamic(_override) with a weapon model, "has propdata …
  DELETED"; agent models have no sequences, SetAnimation says "no sequence named", their anim graph's params can't be set).
  MatchZy practice kicks every bot it didn't add ("untracked"/"erroneous spawning"), so first `css_bot` is run for the
  player (ExecuteClientCommandFromServer), else `bot_add_ct/t` on the other team (bot_join_after_player 0). The bot:
  MOVETYPE_NONE, TakesDamage false, collision group debris, teleported to the spot, SetModel(player's model),
  `_standInTeam[slot] = player team` (IsTarget true, SkinTeam used by every loadout lookup), EyeAngles/V_angle set each
  tick (teleport angles don't turn a bot). bot_stop 1 while any preview runs (CvarInt: bot_stop isn't a plain int).
  Poses: RemoveWeapons + one GiveNamedItem (a bot with one weapon holds it); the C4 only with the bot briefly a T
  (TeamNum on controller + pawn), a CT drops it. Crouch: CBot.IsCrouching + DuckAmount/Ducked/DesiresDuck every tick
  (MatchZy's crouch bot). Neither alpha/EF_NODRAW on the viewmodel nor a server-side null ActiveWeapon hid the user's
  gloves/held weapon (user tests; the client predicts its own), so the player's weapons are stashed (killed) for the
  preview and re-given on exit (StashWeapons/RestoreWeapons). Even then the client drew its hands at the pawn's eye, so
  the pawn is teleported 140 units behind the camera (PlaceCamera, TakesDamage off) and back to PawnHome on exit.
  **C4 rules (live-tested):** while any C4 lies loose (a kicked carrier's, or the orphan RemoveWeapons leaves) a newly
  given one falls to the floor, so RemoveLooseC4 runs first; a CT gets it only as a T for the give (TeamNum 2 on both);
  and the game's AFK-bomb rule drops a T's C4 ~15 s into a round unless `HasMovedSinceSpawn` (set on the stand-in
  every tick in ApplyStance). **The stand-in must not stand on the player**: MatchZy's
  `.bot` starts TemporarilyDisableCollisions, a repeating timer until the two stop overlapping; kicking the bot while
  it still runs crashed the server (AccessViolation in MatchZy). StandInSpot puts it ~72 units away. Release: bot_kick name, or kickid +
  bot_quota − 1 for the MatchZy one. ≤ 4 requests, then a prop stand-in (UseAnimGraph, idle only).
- Agent voice: `<set>.vo_preview` via pawn.EmitSound with a one-player RecipientFilter. Sets from items_game vo_prefix
  (AgentVoice table) or the model folder (FactionVoice). Event names come from soundevents/vo/agents/*.vsndevts_c (KV3, LZ4).
- Server test: `css_prac_hudopen`, `css_prac_hudclick pk_tab_agents` / `pk_view_third` / `pk_pose_rifle`, `css_prac_view`
  (bot, skins, weapons, eye angles). A throwaway server mirror (syncMirror into a scratch folder + copied addons) lets
  you live-test without touching the user's running server, whose plugin folder hot-reloads.

## Admin and commands (Phase 2)
- No auto-connect: the Play page shows copyable `connect 127.0.0.1:27015` (+ LAN IPs). There is no rcon line:
  CS2's client `rcon` never reaches the server. The RCON password (generated once, settings.json `rconPassword`) is only
  used by the app itself.
- PracSkins `css_cmd <command>` / `!cmd <command>` (needs `@css/root`) runs any server command, e.g. `!cmd exec mycfg`.
  Not named `css_rcon` because MatchZy has `.rcon`.
- PracSkins runs `execifexists cs2prac_defaults.cfg; execifexists cs2prac_server.cfg` 2 s after every map start.

## MatchZy (Phase 3)
- Installed by Setup and, if missing or a different pinned version, on server start. Only edit `*_override.cfg`
  files, never MatchZy's own cfgs (its updates replace them).
- MatchZy registers lots of `css_*` commands (`css_rcon`, `css_t`, `css_ct`, `css_bot` …); check for clashes before
  naming new PracSkins commands (`strings MatchZy.dll | grep css_`).
- In practice mode MatchZy kicks bots added with `bot_add` ("erroneous spawning"); use `.bot` in game. For bot-based
  live tests use MatchZy mode `off`.

## Practice extras (plugin/PracSkins/Practice.cs)
- Spawn markers sit on the floor: `GroundUnder` traces down (CSS `Trace.TraceEndShape`); spawn entities are up to ~60
  units above it on some maps. Teleport still uses the spawn origin.
- Spawn markers: per competitive spawn (MatchZy's GetSpawns filter, so numbers match `.spawn n`) 4 `beam` entities as a
  square, a facing arrow and a `point_worldtext` number. E while looking at one teleports onto it. Toggled with `.spawns`
  (say listener) / `css_spawns`; `css_prac_spawns 1` in prac_override.cfg turns them on when practice starts. Redrawn
  on every round start (restarts remove them).
- Bot glow (user-confirmed working): `.glow` / `css_glow`. A relay prop_dynamic (kRenderNone) bone-merges onto the
  pawn (FollowEntity) and a transparent (Color.Transparent) copy of the bot's model bone-merges onto the relay and
  carries the glow (GlowType 3, GlowTeam -1, fields set after DispatchSpawn). Models go in with `SetModelBeforeSpawn`
  (clears identity flag bit 2, EF_IN_STAGING_LIST, as exkludera's glowing-entities does: SetModel before spawn without
  an assert). With the model as a spawn keyvalue the server state looked identical but the client drew nothing.
  Re-added on bot spawn. Server-side test switches: `css_prac_spawns`, `css_prac_glow` (also logs each glow prop's
  model, origin, parent and glow fields).

## Hardening (Phase 6)
- Plugin versions: `PINNED` in setup/plugins.ts (Metamod, CSS) and `MATCHZY_VERSION` in setup/matchzy.ts. Setup and
  Repair install pinned versions only when missing; "Update plugins to latest" (install mode 'latest') moves to the newest.
  PracSkins is compiled against the pinned CSS (PracSkins.csproj); bump both together after testing.
- After each start, `checkHealth` (index.ts, server/health.ts) runs `meta list`, `css_plugins list`, `css_prac_status`;
  problems go to the Console and a Play-page banner. A clean start stores the CS2 build id (`lastGoodBuildId`); a newer
  build shows a "CS2 has been updated" notice.
- A server exit that wasn't requested sets `status.crashed`. `killStaleServers` (on app launch and before every start)
  kills only cs2.exe processes running from our server folder.

## Bundle and server name
- The installer ships the pinned tools: `npm run build:bundle` (scripts/bundle.mjs, also run by `dist`/`release`) downloads
  Metamod, CSS (with runtime) and MatchZy zips at the versions in `PINNED`/`MATCHZY_VERSION` (read from the source), a
  gzipped ByMykel skin data snapshot and the license texts into `resources/bundle/` (git-ignored, ~85 MB), shipped as
  `<resources>/bundle`. `setup/bundle.ts`: `bundledZip(tool, version)` is used by `installZip` when the version matches;
  other versions ("Update plugins to latest") download. The catalog falls back to the snapshot when the download fails
  and nothing is cached. After bumping a pinned version, `build:bundle` fetches the new zip automatically.
- Settings `serverName` (default "Nihil Prac Server", `cleanServerName` strips cfg-breaking characters) is written as
  `matchzy_chat_prefix "[{Green}<name>{Default}]"` + `matchzy_hostname_format` (config_override.cfg) and `hostname` +
  `css_prac_chat_prefix` (cs2prac_defaults.cfg; PracSkins' `Tag`/`ChatTag`). MatchZy's own server-console log lines
  keep `[MatchZy]`; only chat changes. Verified live on 27115.

## Lineups (Phase 12)
- MatchZy's `.savenade <name> [desc]` (practice mode) writes `<csgo>/cfg/MatchZy/savednades.json`:
  `{ "<steamid64>"|"default": { "<name>": { LineupPos "x y z", LineupAng "p y r", Desc, Map, Type? } } }`. "default"
  = global (listed for everyone); a name is a dict key (unique per owner across maps). `.importnade` entries have no
  Type (`.loadnade` then uses slot8). MatchZy re-reads the file on every command, so edits apply while running.
- App: src/shared/lineups.ts (parse/edit/share file `{kind:'cs2prac-lineups', schema 1}`, import also takes a raw
  savednades.json or `.importnade` lines), src/main/setup/lineups.ts (atomic write), Play page "Lineups"
  (components/Lineups.tsx). Imports land under "default". Names: no spaces (`.loadnade` takes one word).
- Plugin: Lineups.cs, L window tab `nades` (type filter chips, Go = teleport + give/select the grenade; no practice
  check). Server test: `css_prac_lineups [index]` (first human, else bot; with an index it loads that lineup).

## Workshop maps (Phase 13)
- Anonymous and read-only, no Steam account or API key: ids are scraped from the public browse page
  `steamcommunity.com/workshop/browse/?appid=730&browsesort=trend|mostrecent|totaluniquesubscribers|textsearch
  &section=readytouseitems&requiredtags[]=Cs2&requiredtags[]=Map&p=N(&searchtext=…)` (React page: ids sit in escaped
  JSON `publishedfileid\":\"<id>`, 30 per page), details from POST `ISteamRemoteStorage/GetPublishedFileDetails/v1/`
  (itemcount + publishedfileids[i]; no key needed). Thumbnails: preview_url + `?imw=320&imh=180&ima=fit&impolicy=Letterbox…`.
- src/shared/workshop.ts (parse/URL helpers), src/main/server/workshop.ts `WorkshopStore`: cache
  userData/workshop-maps.json (300 entries, 24 h refresh, placeholders offline), `keepThumb` stores a started map's
  thumbnail as a data URL. maps.json for the L window now carries the titles. The server still downloads the map itself.
- Play page: Map card pool "Workshop" (components/WorkshopBrowser.tsx); recent maps = settings.recentWorkshop (× forgets).

## Movement mode (plugin/PracSkins/Movement.cs)
- `.movement` (say listener, like `.spawns`) / `css_movement <sub>`; `.next`/`.prev`/`.reset` only react while the
  player is in the mode (MatchZy has no such commands, but keep them gated). Spots: `configs/plugins/PracSkins/movement/<map>.json`
  (camelCase MoveSpot: name, x, y, z, pitch, yaw, failZ, endX/endY/endZ; end null until `.movement end`), recorded by
  the player in game, not by the app.
- Per tick per player: on the ground below failZ → back to the start (a miss if they had left the ground); on the
  ground on the end square (±24 units, ±32 high) after leaving the ground → made, back to the start 1.5 s later.
  Landing anywhere else above failZ counts as nothing (user: "made" fired too early when any landing >80 units away
  counted). Back within 80 units re-arms.
  L window Spots tab (BuildSpotRows): "Add here" (SaveSpot with NextSpotName spot-N); per spot a start row (Go /
  Rename / Fall floor (SetFailAt) / Delete = whole spot) and an end row (End here (SetEndAt) / Rename / Remove =
  RemoveEnd, start kept); deletes ask once. They use where the player stands when L was opened. Rename: Panorama has
  no text input, so SetSession.Rename swaps the Spots rows for an on-screen keyboard (BuildRenameRows: Save / Cancel /
  Back / Clear (+ Shift / Space for end names) and KeyRows as chips; existing rows/chips, no layout change). A chat
  line or `!name <text>` (css_name) while it is open saves that text (TakeRename). Empty end name = "<spot> end".
  MoveSpot `endName` (null = default label). Not live-tested yet.
  Banner via PrintToCenterHtml (skipped while the K menu is open). Fall damage: `sv_falldamage_scale 0` while anyone
  is in the mode. Server test: `css_prac_movement [markers]` lists the map's spots.
- MoveSpot `crouch`: saved when the player crouched at `save`; GoToSpot then puts them in fully crouched (also when a
  standing hull doesn't fit there, TraceHullShape), else a standing hull ends up inside the wall above (user report:
  "inside something" at Mirage window).
- The L window's Go/On start movement 0.1 s after the window closes (StartMovementLater): teleporting in the tick the
  freeze (MOVETYPE_NONE) is lifted left the user under Mirage without collision. GoToSpot forces MOVETYPE_WALK,
  teleports 1 unit above the saved floor, and a fall 1024 units below failZ puts the player back. Crouch only for spots
  saved crouched: guessing it from StandingRoom faked a duck right after the teleport (ground cleared), the game
  un-ducked "in the air" and dropped the feet 18 units into the floor (under the map / inside things).

## User cfgs with server commands
- A client can't run server commands on our dedicated server: the client refuses replicated cvars (sv_cheats,
  sv_infinite_ammo, mp_* …) and the engine rejects bot_kick/ent_fire/mp_warmup_end before any plugin hook sees them
  (too many rejections kick the player). The working route is `css_cmd <command>` per command in the user's aliases.
- The user's `Nihil.cfg` (client cfg folder) has a `pracGloria` section doing exactly that; `pracNihil` is their
  offline version. They want one cfg: don't generate copies of it from the app (tried and reverted).

## Debugging in game or in the server console
- `meta list` should show CounterStrikeSharp. `css_plugins list` should show PracSkins (and later MatchZy).
- `css_prac_status` prints the loadout summary, whether the attribute function resolved, and per player the steamid, team, glove def and each weapon's def/paint/wear/quality/itemid.
- `css_prac_reload` re-reads loadout.json.
- App data (settings, loadouts, catalog cache, `logs/main.log`) lives in Electron `userData` = `%APPDATA%\CS2Prac` (in dev `%APPDATA%\cs2prac`, the same folder since Windows paths are case-insensitive). The **Logs** link in the top bar opens it.

## 3D skin editor (Phase 14)
- tools/ModelExport (C#, ValveResourceFormat, MIT) → `npm run build:modeltool` → resources/modeltool (shipped; the
  release workflow builds it). `list <csgo>` prints the weapon vmdl_c paths, `export <csgo> <out> <model…>` writes
  `<name>.glb` (no embedded images), `<name>.jpg` (base colour) and `<name>.json` (ModelMarkup: meshes, sticker
  anchors, keychain quads). Runs on `<server>/game/csgo/addons/counterstrikesharp/dotnet/dotnet.exe` (so Setup first).
- src/main/skins/models.ts ModelStore: cache userData/models/<buildId>/ (older builds pruned), one export at a time.
  Nothing of Valve's ships with the app; models come from the user's own VPK at runtime.
- Frames: glTF = (srcY, srcZ, srcX) × 0.0254 (`sourceToGltf`/`gltfToSource`, src/shared/models.ts).
- Stickers live in uv1: centre u = offset[0] + x + 0.5, v = offset[1] + y + 0.5, size = scale / anchor.scale,
  rot = −rotation. Every slot of a body shares one polygon region (drags clamp to it). On the AK slot 0 sits at the
  receiver, slot 3 at the handguard, +u towards the stock. Charm x/y/z = absolute Source inches; 0,0,0 = default quad
  centre.
- Finish (approximation): `ModelExport paint <csgo> <out> <kit…>` reads items_game paint_kits, walks the kit's
  composite material (`weapons/paints/legacy/<name>.vcompmat_c` or its composite_material_path: SPECIFIC_MATERIAL
  vmats + LOOSE_VARIABLES, later ones win; falls back to paints/vmats/<name>.vmat) and writes `paint_<kit>.json`
  (style = vmat F_PAINT_STYLE: 0 solid … 6 custom, 7 patina, 8 gunsmith; colours, pattern scale/rotation/offset,
  brightness) + `paint_<kit>.webp` (g_tPattern, resized to ≤1024: some patterns have no mips). ModelStore.paint caches
  them in <build>/paints. The shader: styles 6/8 = pattern as albedo in uv0; others = pattern channels mixing
  g_vColor0..3 over the base. No wear, masks, roughness or metalness: F-inspect in game for the real look.
- Sky thumbnails: `ModelExport sky <csgo> <out> <material…>` renders each sky material's texture (cubemap faces →
  lat-long via TextureExtract, LDR faces copied to RgbaF32; HDR tone-mapped) to a 320×180 `sky_<name>.jpg` (the
  horizon band). ModelStore.skies (models:skies) renders the missing ones in one run (~37 s for all 22) into
  <build>/skies; the Play page's Server settings shows them as a tile picker. The L window can't show them (Panorama
  images must be compiled resources and nothing of Valve's ships), so it keeps names.
- Renderer CSP blocks blob: URLs and fetches: glb bytes, the jpg and sticker/charm images (`models.image`, only
  steamstatic / raw.githubusercontent) come through main as bytes/data URLs.
- three.js sanitizes node names (dots/slashes dropped, `_1`/`_2` per primitive): match bodies against markup.meshes,
  longest first, walking up the parents.
- K window "stickers" tab (Hud.cs BuildStickerTab): HudSession.Team (T/CT chips `pk_team_t/ct`, weapons + stickers
  tabs only; HudTeam()), Target (0–4 slot, 5 charm), Query (`css_sticker`/`css_charm` route to HudSearch while the
  window is open). No sticker images in the window (11k classes); names only. Tiles: 0–4 slots, 5 charm, [clear
  search], remove, list (server test: `css_prac_hudclick pk_tab_stickers`, `pk_tile_N`).

## Status
See `todo.md` for the phased roadmap and the current phase. v1.0.0 is released; v2 is Phases 7–14 in todo.md
(settings window on L, pins + music kits, graffiti, bot names/pictures, !gen import, lineups, workshop browser, 3D
skin editor). Hard rule for v2: nothing may put the user's Steam account at risk. M1–M5 are done. Phases 1–6 are committed and user-confirmed
in game (2026-11-16: markers, glow, stickers/charms/agents, text menu, K window, agent preview, pracGloria, server name,
offline setup, UI). The movement end point is marked done (the user checks it later; fix if they report problems), sticker scrape untested (they're fine with it),
and the v1.0.0 release only when they ask. Known: every `css_cmd` echoes
"[CS2Prac] ran: …", so pracGloria prints ~40 lines (make it quiet only if they ask). Live-test recipe for bots: set `matchzy_autostart_mode 0`
in cfg/MatchZy/config_override.cfg for the test server, restore it afterwards, and use port 27115.
