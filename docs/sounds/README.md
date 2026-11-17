# Sound map: CS2 vs. the CS 1.6 pack

Research for an optional "1.6 sounds" setting in the L window. Nothing here is wired into the app yet.

## How CS2 plays a sound
CS2 never plays a file directly. Code fires a **sound event** by name, for example `Weapon_AK47.Single`, `Event.BombPlanted` or
`balkan.radio_letsgo01`. The event lives in a `soundevents/**/*.vsndevts_c` file (binary KV3) and points to one or more
`sounds/**/*.vsnd` files through keys like `vsnd_files_track_01`, picking one at random when it has several.
So "replacing a sound" means one of two things:
- point an event at our file, or
- stop the game's event and play our own.

Both need the sound on the **client**, as a compiled `.vsnd_c` file. CS2 doesn't download sounds from a server.

Source: the user's own `game/csgo/pak01_dir.vpk`, decoded with ValveResourceFormat 20.1.7467. That's the same library tools/ModelExport uses.

## Files in this folder
| File | Rows | What |
|---|---|---|
| `cs2-sound-events.tsv` | 5,383 | Every CS2 sound event except music kits and agent voices: event file, event, type, base, volume, vsnd files |
| `cs2-agent-voice.tsv` | 413 | Agent voice lines (28 agent sets, 14,229 events) grouped by line name, with which agents have the line, plus an example event and file |
| `cs2-sound-files.tsv` | 4,746 | Every `sounds/` file except `vo/agents` and `music`, with the events that use it (up to 12) |
| `cs16-sound-files.tsv` | 457 | The 1.6 pack: format, rate, channels, bits, seconds and a **suggested CS2 target** |

The TSVs open in Excel, or read them with any text tool.

## CS2 at a glance
CS2 has 20,511 files under `sounds/` and 21,550 events in 183 event files.

Biggest sound folders:
| Folder | Files |
|---|---|
| `vo/agents` | 14,168 |
| `music` | 1,597 |
| `ambient` | 1,405 |
| `physics` | 551 |
| `player/footsteps` | 409 |
| `ui` | 388 |
| `vo/commander` | 296 |
| `weapons/knife` | 223 |
| `vo/announcer` | 116 |
| `vo/hostage` | 19 |

Event files that matter for 1.6:
| Event file | Events | What |
|---|---|---|
| `game_sounds_weapons` | 747 | Guns, grenades, C4 and knife |
| `game_sounds_ui` | 455 | UI sounds |
| `game_sounds_physics` | 227 | Impacts and shells |
| `game_sounds_footsteps` | 155 | `CT_/T_/Land_<Material>.StepLeft/Right` |
| `game_sounds_player` | 101 | Death, damage, headshot and fall damage |
| `vo/announcer/game_sounds_cs2_classic` | 105 | `Event.BombPlanted`, `Event.CTWin`, and others |
| `vo/hostage` | 8 | `Hostage.Pain`, `Hostage.StartFollowCT`, and others |
| `vo/agents/*` | 14,229 | Radio and bot chatter, one set per agent |

**Radio is per agent.** CS2 has no shared radio voice. Every agent set carries its own lines, and the naming differs between sets:
- The classic sets (balkan, fbihrt, gsg9, leet, phoenix, professional, sas, seal, swat …) use `<set>.radio_letsgo01`, `affirmative01`, `coverme01`.
- The `_epic` sets use other names (`affirmation_01`, `takingfire_01`, `goto_mid_01` …).
- Not every set has every line: `radio_letsgo` exists in 6 sets, `coverme` in 9.

So replacing radio means covering every agent set, or muting the agent line and playing ours. See `cs2-agent-voice.tsv`.

## The 1.6 pack (`assets/sounds/1.6`)
The pack has 457 files. They're all PCM WAV, mono, mostly 22,050 Hz (some 11,025 Hz) and 8-bit, so they need converting and compiling before CS2 can use them.

| Folder | Files | CS2 counterpart |
|---|---|---|
| `english/weapons` | 165 | Weapon events (`Weapon_<gun>.Single/Clipin/Clipout/Draw/Bolt…`), grenades, C4, knife |
| `english/player` | 75 | Footsteps by material, death, pain, headshot, fall damage, shells |
| `english/radio` | 45 | Agent radio lines + announcer round/bomb events |
| `turkish/radio` | 68 | Same names as `english/radio` (+ 22 alternative takes in `custom/`) |
| `english/hostage`, `turkish/hostage` | 5 + 5 | `Hostage.Pain` / `Hostage.StartFollowCT` |
| `english/items` | 5 | `Player.EquipArmor_CT/_T`; night vision has no CS2 counterpart |
| `english/events` | 4 | Kill sound (`UI.DeathNotice`); the tutor sounds have none |
| `english/misc` | 5 | `Chicken.Death`; the animals and plane are map ambience |
| `english/ambience`, `de_torn`, `plats`, `storm` | 57 + 11 + 9 + 1 | No direct equivalent (1.6 map ambience) |
| `english/sentences.txt`, `materials.txt` | 2 | 1.6 data: radio sentence → wav, texture → footstep material |

## Suggested replacements (verify in game)
Each row of `cs16-sound-files.tsv` has a suggested target. These are educated guesses from names, not tested. Every event
named there exists in CS2 (checked against the decoded list); entries starting with "agent" are agent voice line names.

### Radio and announcer
| 1.6 file | CS2 target |
|---|---|
| `com_go`, `go`, `letsgo`, `moveout` | agent `radio_letsgo` |
| `locknload` | agent `radio_locknload` |
| `ct_affirm`, `roger` | agent `affirmative` / `agree` |
| `negative` | agent `negative` / `disagree` |
| `ct_backup` | agent `radio_needbackup` |
| `ct_coverme` | agent `coverme` |
| `ct_enemys` | agent `radio_enemyspotted` |
| `ct_fireinhole` | agent `t_grenade`, `t_flashbang`, `t_smoke`, `t_molotov`, `t_decoy` |
| `ct_inpos` | agent `inposition` |
| `ct_reportingin` / `com_reportin` | agent `reportingin` / `requestreport` |
| `enemydown` | agent `enemydown` |
| `fallback` | agent `radiobotfallback` |
| `followme`, `com_followcom` | agent `radio_followme` |
| `regroup`, `sticktog` | agent `radiobotregroup` |
| `clear` | agent `clearedarea` / `bombsite_clear` |
| `position`, `com_getinpos` | agent `radiobothold` |
| `fireassis`, `hitassist` | agent `radio_takingfire` |
| `ct_imhit` | agent `help` / `pinned` |
| `blow` | agent `ct_bombexploding` |
| `bombpl` | `Event.BombPlanted` |
| `bombdef` | `Event.BombDefused` |
| `ctwin` | `Event.CTWin` |
| `terwin` | `Event.TERWin` |
| `rounddraw` | `Event.RoundDraw` |
| `rescued` | `Event.HostageRescued` |
| `takepoint`, `ct_point`, `elim`, `matedown` | Closest agent line (no exact match) |
| `circleback`, `flankthem`, `getout`, `meetme`, `hosdown`, `vip`, `stormfront` | None |

The announcer events also have `Announcer.*.CS2_Classic` copies. Both should be covered.

### Weapons
1.6 names map to CS2 weapons like this:

| 1.6 | CS2 |
|---|---|
| `scout` | SSG08 |
| `sg550` | SCAR20 |
| `sg552` | sg556 |
| `p228` | P250 |
| `m3` | Nova |
| `galil` | GalilAR |
| `de_*` | DEagle |
| `m4a1-1` (silenced) | `Weapon_M4A1.Silenced` |
| `m4a1_unsil-*` | `Weapon_M4A4.Single` |
| `usp1/2` | `Weapon_USP.SilencedShot` |
| `usp_unsil-1` | `Weapon_USP.Single` |
| `tmp` | Nothing in CS2; MP9 suggested |

The reload parts map to the gun's own CS2 event (`_clipin` → `.Clipin`, `_boltpull` → `.BoltPull`/`.BoltBack`/`.Boltpull`, `_deploy` → `.Draw` …).

These CS2 weapons have no 1.6 sound:
- MP7, CZ75-Auto, Tec-9, R8, Sawed-Off, MAG-7, Negev, PP-Bizon
- the Zeus, molotov/incendiary and decoy
- MP9, unless the TMP stands in
- M4A4 reloads (its shot can come from `m4a1_unsil`)

Each CS2 gun also has a `.SingleDistant` event (the far-away shot), which 1.6 doesn't have. Reusing `.Single` is the obvious fill.

Other weapon sounds:
| 1.6 file | CS2 target |
|---|---|
| `c4_plant` | `c4.plant` |
| `c4_disarm` | `c4.disarmstart` |
| `c4_disarmed` | `c4.disarmfinish` |
| `c4_explode1` | `c4.explode` |
| `c4_beep1-5` | `C4.PlantSound` / `C4.PlantSoundB` |
| `hegrenade-*` | `BaseGrenade.Explode` |
| `flashbang-*` | `Flashbang.Explode` |
| `sg_explode` | `BaseSmokeEffect.Sound` |
| `knife_*` | `Weapon_Knife.Deploy/Hit/HitWall/Slash/Stab` |
| `dryfire_*` | `Default.ClipEmpty_Pistol/_Rifle` |
| `ric_*` | `FX_RicochetSound.Ricochet` |

### Player
| 1.6 file | CS2 target |
|---|---|
| `pl_step*` | `CT_/T_Concrete.Step*` |
| `pl_dirt`, `pl_duct`, `pl_grate`, `pl_metal`, `pl_snow`, `pl_tile` | `*_<Material>.Step*` |
| `pl_ladder` | `CT_/T_Ladder.Step*` |
| `pl_slosh`, `pl_wade` | `*_Water.Step*` / `*_wade.Step*` |
| `pl_swim` | `Player.Swim` |
| `die*`, `death6`, `pl_die1` | `Player.Death` |
| `pl_pain*`, `bhit_flesh*` | `Player.DamageBody.*` |
| `bhit_kevlar` | `Player.DamageKevlar` |
| `bhit_helmet` | `Player.DamageHeadShotArmor.*` |
| `headshot*` | `Player.DeathHeadShot.*` |
| `pl_fallpain*` | `Player.DamageFall` |
| `pl_shell1` | `Bounce.Shell` |
| `pl_shot1` | `Bounce.ShotgunShell` |
| `sprayer` | `SprayCan.Paint` (our graffiti) |

CS2 footsteps are split per team (`CT_`/`T_`) and add a landing event (`Land_`). One 1.6 file would serve all three.

## Open questions for the feature
- **Delivery.** Like the HUD files, the sounds would have to be compiled into `.vsnd_c` (the user's resourcecompiler) and copied into the client as loose files, together with a soundevents file.
  Whether loose sound files and an overridden `vsndevts` load in CS2 without `-insecure` on the client is untested. That decides between overriding events and playing our own events from the plugin.
- **Radio.** The server sees the radio commands (`go`, `roger` …) and could mute the agent line and play the 1.6 one. The agent lines spoken automatically (bot chatter, "enemy down") would still need event overrides.
- **Per player or server-wide.** The L window is per server. The sounds are per client anyway, since each client has the files or doesn't.
