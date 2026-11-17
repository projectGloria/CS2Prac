import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { botAvatarId, botsHaveAvatars, normalizeBots, type BotsConfig } from '@shared/bots'

/**
 * Bot names and pictures. The app keeps the list in <userData>/bots.json; every server start (and every save while
 * it runs) writes the plugin's configs/plugins/PracSkins/bots.json and the pictures.
 *
 * Pictures use the game's server avatar overrides (`+sv_reliableavatardata 1`): at player_connect_full the server
 * reads csgo/avatars/<steamid64>.png into the ServerAvatarOverrides string table. PracSkins gives each bot with a
 * picture a made-up SteamID (botAvatarId) and fires player_connect_full for it. With the cvar on, real players need
 * their own file too, so the local Steam accounts' pictures are copied from Steam's own avatar cache
 * (<steam>/config/avatarcache/<steamid64>.png). Nothing is fetched from or sent to Steam.
 */

const PLUGIN_FILE = ['addons', 'counterstrikesharp', 'configs', 'plugins', 'PracSkins', 'bots.json']
/** files we write in csgo/avatars carry ids from botAvatarId's range or the local accounts' ids; listed here */
const OURS_FILE = 'cs2prac-avatars.json'
/** the engine's size limit for one csgo/avatars/<steamid64>.png */
export const AVATAR_MAX_BYTES = 16 * 1024

export async function readBots(file: string): Promise<BotsConfig> {
  try {
    return normalizeBots(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return normalizeBots(null)
  }
}

export async function saveBots(file: string, bots: BotsConfig): Promise<BotsConfig> {
  const clean = normalizeBots(bots)
  await writeFile(file + '.tmp', JSON.stringify(clean, null, 2))
  await rename(file + '.tmp', file)
  return clean
}

/** what PracSkins reads: names, clans and whether a picture exists (the picture itself goes to csgo/avatars) */
export function pluginBotsFile(bots: BotsConfig): string {
  const team = (list: BotsConfig['t']) => list.map((e) => ({ name: e.name, clan: e.clan, avatar: !!e.avatar }))
  return JSON.stringify({ schema: 1, t: team(bots.t), ct: team(bots.ct) }, null, 2)
}

/**
 * Writes the plugin's bots.json and csgo/avatars. Returns whether the server needs `+sv_reliableavatardata 1`
 * (only when a bot has a picture: with it on, players without a file might lose their Steam picture).
 */
export async function writeServerBots(
  csgoDir: string,
  bots: BotsConfig,
  steamDir: string,
  localSteamIds: string[],
  /** shrinks a picture to fit AVATAR_MAX_BYTES (index.ts passes Electron's nativeImage; tests leave it out) */
  shrink: (png: Buffer) => Buffer = (png) => png
): Promise<boolean> {
  const pluginFile = join(csgoDir, ...PLUGIN_FILE)
  await mkdir(join(pluginFile, '..'), { recursive: true })
  await writeFile(pluginFile, pluginBotsFile(bots))

  const dir = join(csgoDir, 'avatars')
  // remove what we wrote last time (users never put files there themselves, but only touch our own list)
  let old: string[] = []
  try {
    old = JSON.parse(await readFile(join(dir, OURS_FILE), 'utf8')) as string[]
  } catch {
    /* none yet */
  }
  for (const name of old) if (/^[\w.-]+\.png$/.test(name)) await unlink(join(dir, name)).catch(() => undefined)

  const avatars = botsHaveAvatars(bots)
  const written: string[] = []
  if (avatars) {
    await mkdir(dir, { recursive: true })
    const put = async (name: string, data: Buffer) => {
      // the engine drops override files over 16 KB (Steam's own 184×184 cache files are ~70 KB: the player then
      // showed default.png's grey square)
      const fit = data.length > AVATAR_MAX_BYTES ? shrink(data) : data
      if (fit.length > AVATAR_MAX_BYTES) return
      await writeFile(join(dir, name), fit)
      written.push(name)
    }
    // the server refuses to start the feature without a valid default image
    await put('default.png', solidPng(64, 64, [58, 64, 76]))
    for (const team of ['t', 'ct'] as const)
      for (const [i, e] of bots[team].entries())
        if (e.avatar) await put(`${botAvatarId(team, i)}.png`, Buffer.from(e.avatar.split(',')[1], 'base64'))
    for (const id of localSteamIds) {
      const cached = join(steamDir, 'config', 'avatarcache', `${id}.png`)
      if (/^\d{17}$/.test(id) && existsSync(cached)) await put(`${id}.png`, await readFile(cached))
    }
  }
  if (written.length || old.length) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, OURS_FILE), JSON.stringify(written))
  }
  return avatars
}

/** lists the png files in csgo/avatars (for tests and the log) */
export async function listAvatarFiles(csgoDir: string): Promise<string[]> {
  try {
    return (await readdir(join(csgoDir, 'avatars'))).filter((f) => f.endsWith('.png')).sort()
  } catch {
    return []
  }
}

// ---- a tiny PNG encoder (RGB, one colour) for default.png ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const row = Buffer.alloc(width * 3 + 1)
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
