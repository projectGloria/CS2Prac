import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MatchZyMode, SetupProgress } from '@shared/ipc'
import { installZip, needsInstall, readPluginVersions, writePluginVersions, type PluginMode } from './plugins'

/**
 * MatchZy (https://github.com/shobhit-pathak/MatchZy): practice mode (.prac, .bot, .rethrow, .savenade …) and
 * match mode. Pinned, so an upstream release can't break a working setup; bump after testing a new one.
 */
export const MATCHZY_VERSION = '0.9.3'
const matchZyUrl = (v: string) => `https://github.com/shobhit-pathak/MatchZy/releases/download/${v}/MatchZy-${v}.zip`

export const matchZyDll = (csgoDir: string) =>
  join(csgoDir, 'addons', 'counterstrikesharp', 'plugins', 'MatchZy', 'MatchZy.dll')

async function latestMatchZy(): Promise<string> {
  const res = await fetch('https://api.github.com/repos/shobhit-pathak/MatchZy/releases/latest', {
    headers: { Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) throw new Error(`Could not look up the latest MatchZy release (${res.status})`)
  return ((await res.json()) as { tag_name: string }).tag_name
}

/** Installs MatchZy (plugin-only zip: addons/ + cfg/MatchZy): the pinned version if missing, or the latest. */
export async function ensureMatchZy(csgoDir: string, report: (p: SetupProgress) => void, mode: PluginMode = 'pinned'): Promise<boolean> {
  const versions = await readPluginVersions(csgoDir)
  const target = mode === 'latest' ? await latestMatchZy() : MATCHZY_VERSION
  if (!needsInstall(existsSync(matchZyDll(csgoDir)), versions.matchzy, target, mode)) return false
  // MatchZy's own cfgs (config.cfg, prac.cfg …) are replaced; our *_override.cfg files are not in the zip.
  await installZip(matchZyUrl(target), csgoDir, 'MatchZy', report)
  await writePluginVersions(csgoDir, { ...(await readPluginVersions(csgoDir)), matchzy: target })
  return true
}

const AUTOSTART: Record<MatchZyMode, number> = { off: 0, match: 1, practice: 2 }

/** cfg/MatchZy/config_override.cfg, executed by MatchZy right after its config.cfg. */
export function configOverride(mode: MatchZyMode): string {
  return `// Written by CS2Prac before every start; changes here are overwritten. Use the app's Mode setting.
matchzy_autostart_mode ${AUTOSTART[mode]}
matchzy_hostname_format "CS2Prac"
matchzy_show_credits_on_match_start false
matchzy_kick_when_no_match_loaded false
`
}

/** cfg/MatchZy/prac_override.cfg, executed after MatchZy's prac.cfg whenever practice mode starts. */
export const PRAC_OVERRIDE = `// Written by CS2Prac before every start; changes here are overwritten.
// Put your own practice settings in cs2prac_server.cfg (app: Play > Open server cfg folder) or run them with !cmd.
sv_cheats 1
sv_hibernate_when_empty 0
`

/**
 * MatchZy admins: an empty flag string grants every MatchZy admin command. Keeps admins the user added and
 * replaces the ones we added before (remembered in a sidecar file, since MatchZy's format has no room for a marker).
 */
export function mergeMatchZyAdmins(text: string | null, ours: string[], previous: string[]): string {
  let admins: Record<string, string> = {}
  if (text?.trim()) {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) admins = parsed as Record<string, string>
  }
  for (const id of previous) if (!ours.includes(id) && admins[id] === '') delete admins[id]
  for (const id of ours) admins[id] = ''
  return JSON.stringify(admins, null, 2)
}

export async function writeMatchZyConfig(csgoDir: string, mode: MatchZyMode, steamIds: string[]): Promise<void> {
  const dir = join(csgoDir, 'cfg', 'MatchZy')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'config_override.cfg'), configOverride(mode))
  await writeFile(join(dir, 'prac_override.cfg'), PRAC_OVERRIDE)

  const file = join(dir, 'admins.json')
  const sidecar = join(dir, 'cs2prac-admins.json')
  const current = existsSync(file) ? await readFile(file, 'utf8') : null
  let previous: string[] = []
  try {
    previous = JSON.parse(await readFile(sidecar, 'utf8'))
  } catch {
    /* first time */
  }
  let next: string
  try {
    next = mergeMatchZyAdmins(current, steamIds, previous)
  } catch {
    if (current != null) await writeFile(file + '.broken', current)
    next = mergeMatchZyAdmins(null, steamIds, [])
  }
  await writeFile(file, next)
  await writeFile(sidecar, JSON.stringify(steamIds))
}
