# CS2Prac

A Windows desktop app that runs a local CS2 practice server with any map and any weapon, knife or glove skin.

It sets up a CS2 server, Metamod:Source and CounterStrikeSharp, and its own small skin plugin (**PracSkins**).
The server's game files come from one of two places:

- **Your CS2 installation (default).** The server folder is made of hard links to the CS2 game you already
  have, so it takes almost no extra space. It must be on the same NTFS drive as CS2. Files the server
  changes (`gameinfo.gi`, `cfg/`) are copied instead, so your game install is never modified and Metamod
  never loads into your game client. The links are refreshed before every server start, which follows CS2 updates.
- **A separate dedicated server** downloaded with SteamCMD (~60 GB), for any drive.
 Skins are applied server-side only: the game client is never modified.
The server runs as a LAN `-insecure` server, so it is only meant for practising on your own machine.

## Requirements

- Windows 10/11, Node.js 20+
- CS2 installed through Steam, or ~60 GB free disk space for the dedicated server
- .NET 10 SDK, only if you change the plugin (`winget install Microsoft.DotNet.SDK.10`)

## Development

```sh
npm install
npm run dev            # start the app
npm test               # unit tests (vitest)
npm run typecheck
npm run build:plugin   # rebuild plugin/PracSkins -> resources/plugin/PracSkins/PracSkins.dll
```

The prebuilt `PracSkins.dll` is committed, so the app works without the .NET SDK.

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

Skin data comes from [ByMykel/CSGO-API](https://github.com/ByMykel/CSGO-API). The skin technique follows
[cs2-WeaponPaints](https://github.com/Nereziel/cs2-WeaponPaints).
