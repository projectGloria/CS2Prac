import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Server-side configuration written before every start: who is admin, the cvars a practice server needs,
 * and the user's own cfg files.
 */

/** Admin entries we own in CSS admins.json are named with this prefix; everything else is left alone. */
const ADMIN_PREFIX = 'cs2prac_'

interface CssAdmin {
  identity: string
  flags?: string[]
  [k: string]: unknown
}

/**
 * Makes every given SteamID64 a CounterStrikeSharp root admin (`@css/root`). Entries added earlier for
 * accounts that are no longer given are removed; entries the user added by hand are kept.
 */
export function mergeAdmins(text: string | null, steamIds: string[]): string {
  let admins: Record<string, CssAdmin> = {}
  if (text?.trim()) {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) admins = parsed as Record<string, CssAdmin>
  }
  for (const key of Object.keys(admins)) if (key.startsWith(ADMIN_PREFIX)) delete admins[key]
  for (const id of steamIds) admins[ADMIN_PREFIX + id] = { identity: id, flags: ['@css/root'] }
  return JSON.stringify(admins, null, 2)
}

export async function ensureAdmins(csgoDir: string, steamIds: string[]): Promise<void> {
  const dir = join(csgoDir, 'addons', 'counterstrikesharp', 'configs')
  const file = join(dir, 'admins.json')
  await mkdir(dir, { recursive: true })
  const current = existsSync(file) ? await readFile(file, 'utf8') : null
  let next: string
  try {
    next = mergeAdmins(current, steamIds)
  } catch {
    // A broken admins.json would lock the user out; replace it, keeping a copy.
    if (current != null) await writeFile(file + '.broken', current)
    next = mergeAdmins(null, steamIds)
  }
  if (next !== current) await writeFile(file, next)
}

/** Executed by PracSkins after every map load, before the user's cs2prac_server.cfg. Always overwritten. */
export const DEFAULTS_CFG = 'cs2prac_defaults.cfg'
/** The user's own per-map-load cfg; created once as a template in the app's cfg folder. */
export const USER_SERVER_CFG = 'cs2prac_server.cfg'

export const defaultsCfgText = (serverName = 'CS2Prac') => `// Written by CS2Prac before every server start. Do not edit: put your own settings in ${USER_SERVER_CFG}.
sv_cheats 1
sv_lan 1
sv_hibernate_when_empty 0
hostname "${serverName}"
css_prac_chat_prefix "${serverName}"
`

export const USER_CFG_TEMPLATE = `// CS2Prac runs this on the server after every map load (after ${DEFAULTS_CFG}).
// Put any server commands here, e.g.:
// mp_roundtime_defuse 60
// mp_buy_anywhere 1
// sv_infinite_ammo 1
// Any other .cfg in this folder is copied to the server too: run it in game with  !cmd exec <name>
`

/**
 * Copies every file from the app's cfg folder (%APPDATA%\CS2Prac\cfg) into the server's cfg folder,
 * creating the folder and the cs2prac_server.cfg template the first time. Also writes cs2prac_defaults.cfg.
 */
export async function syncServerCfgs(userCfgDir: string, csgoDir: string, serverName?: string): Promise<number> {
  await mkdir(userCfgDir, { recursive: true })
  const template = join(userCfgDir, USER_SERVER_CFG)
  if (!existsSync(template)) await writeFile(template, USER_CFG_TEMPLATE)

  const dest = join(csgoDir, 'cfg')
  await mkdir(dest, { recursive: true })
  await writeFile(join(dest, DEFAULTS_CFG), defaultsCfgText(serverName))

  let copied = 0
  async function walk(rel: string) {
    for (const e of await readdir(join(userCfgDir, rel), { withFileTypes: true })) {
      const r = join(rel, e.name)
      if (e.isDirectory()) {
        await mkdir(join(dest, r), { recursive: true })
        await walk(r)
      } else if (e.isFile() && e.name !== DEFAULTS_CFG) {
        await copyFile(join(userCfgDir, r), join(dest, r))
        copied++
      }
    }
  }
  await walk('')
  return copied
}
