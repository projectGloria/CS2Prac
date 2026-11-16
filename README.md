# CS2Prac

A Windows desktop app that runs a local CS2 practice server: any map, MatchZy practice mode, you as admin, and every
weapon skin, knife, glove, agent, sticker and charm, picked in the app or live in game.

- **Start a server** on any official or workshop map, then join with the `connect` line the app shows.
- **You are admin.** Every Steam account on the PC gets full rights: run any command with `!cmd <command>`
  (or `rcon <command>` after pasting the app's rcon line), and your own cfgs from the app's server cfg folder.
- **MatchZy** practice mode by default (`.bot`, `.rethrow`, `.savenade`, `.noflash` …), or match mode, or neither.
- **Movement practice.** `.movement` in chat: record jump spots per map (`.movement save window-short` where the jump
  starts, `.movement end` where it lands), get put back at the start whenever you fall, land on the end square to
  make it, and see made/attempts. `.next`/`.prev` switch spots, `.reset` goes
  back. No fall damage while it's on.
- **Skins everywhere.** Use the Loadout tab, or press K in game (`bind k css_menu`) for a menu: W/S move, A/D page, E select,
  R back. In chat, `!skin`, `!knife`, `!gloves`, `!agent`, `!sticker` and `!charm` search by name. Picks apply at once and stay in sync with the app.

It sets up a CS2 server with Metamod:Source, CounterStrikeSharp, MatchZy and its own plugin (**PracSkins**).
The server's game files come from one of two places:

- **Your CS2 installation (default).** The server folder is made of hard links to the CS2 game you already
  have, so it takes almost no extra space. It must be on the same NTFS drive as CS2. Files the server
  changes (`gameinfo.gi`, `cfg/`) are copied instead, so your game install is never modified and Metamod
  never loads into your game client. The links are refreshed before every server start, which follows CS2 updates.
- **A separate dedicated server** downloaded with SteamCMD (~60 GB), for any drive.
 Skins are applied server-side only: the game client is never modified.
The server runs as a LAN `-insecure` server, so it is only meant for practising on your own machine.

## Install

1. Download `CS2Prac-Setup-<version>.exe` from the [latest release](https://github.com/projectGloria/CS2Prac/releases/latest) and run it.
   It is not code-signed, so Windows SmartScreen warns the first time: **More info → Run anyway**.
2. Open CS2Prac and click **Set up**. When CS2 is installed through Steam, everything else is automatic.
   Metamod:Source, CounterStrikeSharp, MatchZy and a skin data snapshot come inside the installer, so setup needs no
   downloads (only the SteamCMD server option and **Update plugins to latest** go online).

The app updates itself: new releases are downloaded in the background and a **Restart to update** banner appears.
Settings, loadouts and logs are in `%APPDATA%\CS2Prac` and are kept across updates and reinstalls (the **Logs** link
in the top bar opens the log folder).

Requirements: Windows 10/11, and CS2 installed through Steam (or ~60 GB free for the separate dedicated server).

## Releasing

Bump `version` in `package.json`, commit, then push a matching tag:

```sh
git tag v0.2.0
git push origin v0.2.0
```

GitHub Actions (`.github/workflows/release.yml`) type-checks, runs the tests, builds the plugin from source and
publishes the installer plus `latest.yml` (used by auto-update) as a GitHub Release.

## Building from source

Needs Node.js 24+ and, for the plugin, the .NET 10 SDK (`winget install Microsoft.DotNet.SDK.10`).

```sh
npm install
npm run dev            # start the app
npm test               # unit tests (vitest)
npm run typecheck
npm run build:plugin   # rebuild plugin/PracSkins -> resources/plugin/PracSkins/PracSkins.dll
npm run build:bundle   # download the pinned Metamod/CSS/MatchZy zips + skin data into resources/bundle (git-ignored)
npm run dist           # build:bundle, then the local Windows installer -> dist/CS2Prac-Setup-<version>.exe (not published)
```

npm 11 runs package install scripts only when they are approved. Electron's (which downloads the Electron
binary) is approved in `package.json` (`allowScripts`). If `npm run dev` fails with `Electron uninstall`, run
`node node_modules/electron/install.js`.

The prebuilt `PracSkins.dll` is committed, so `npm run dev` works without the .NET SDK; release builds compile it fresh.

## How it fits together

| Part | Where |
| --- | --- |
| Electron main process: setup, server control, RCON, skin catalog | `src/main` |
| React UI: Play, Loadout, Console, Setup | `src/renderer` |
| Types shared between them | `src/shared` |
| PracSkins CounterStrikeSharp plugin (C#) | `plugin/PracSkins` |

The app writes the active loadout to
`<server>/game/csgo/addons/counterstrikesharp/configs/plugins/PracSkins/loadout.json`, and
PracSkins applies it when weapons are given or picked up and when a player spawns (gloves).
Saving in the app sends `css_prac_reload` to a running server.

## When CS2 updates

1. With your own CS2 install, the game files are re-linked automatically when the server starts. With the
   SteamCMD server, use **Setup → Update / repair**. Either way, **Update / repair** updates Metamod/CounterStrikeSharp and re-patches `gameinfo.gi`.
2. If skins stop showing, the memory signature PracSkins uses may have changed. Put the new one in
   `configs/plugins/PracSkins/signatures.json` (`{ "windows": "…", "linux": "…" }`). The
   cs2-WeaponPaints gamedata (`CAttributeList_SetOrAddAttributeValueByName`) is a good source.

Third-party licenses (Metamod:Source zlib, CounterStrikeSharp GPL-3.0 with a plugin exception, MatchZy MIT,
CSGO-API MIT) are shipped in `resources/bundle/licenses`, next to the bundled copies.

Skin data comes from [ByMykel/CSGO-API](https://github.com/ByMykel/CSGO-API). The skin technique follows
[cs2-WeaponPaints](https://github.com/Nereziel/cs2-WeaponPaints).
