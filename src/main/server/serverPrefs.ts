import { readFile, rename, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { emptyPrefs, normalizePrefs, type ServerPrefs } from '@shared/serverSettings'
import { pluginConfigDir } from '../skins/loadoutStore'

/** server_prefs.json, shared with the in-game settings window (plugin/PracSkins/SettingsHud.cs). */
export const SERVER_PREFS_FILE = 'server_prefs.json'
/** workshop maps the L window's Map tab offers (SettingsHud.cs MapChoices) */
export const WORKSHOP_MAPS_FILE = 'maps.json'
/** how many recently started workshop maps are remembered */
export const RECENT_WORKSHOP = 10

export async function readServerPrefs(csgoDir: string): Promise<ServerPrefs> {
  try {
    return normalizePrefs(JSON.parse(await readFile(join(pluginConfigDir(csgoDir), SERVER_PREFS_FILE), 'utf8')))
  } catch {
    return emptyPrefs()
  }
}

async function writeAtomic(path: string, text: string) {
  const tmp = path + '.tmp'
  await writeFile(tmp, text)
  await rename(tmp, path)
}

export async function writeServerPrefs(csgoDir: string, prefs: ServerPrefs): Promise<ServerPrefs> {
  const dir = pluginConfigDir(csgoDir)
  await mkdir(dir, { recursive: true })
  const clean = normalizePrefs(prefs)
  await writeAtomic(join(dir, SERVER_PREFS_FILE), JSON.stringify(clean, null, 2))
  return clean
}

/** Puts a started workshop map first in the recent list (no duplicates, at most RECENT_WORKSHOP). */
export function addRecentWorkshop(list: string[] | undefined, id: string): string[] {
  return [id, ...(list ?? []).filter((x) => x !== id)].slice(0, RECENT_WORKSHOP)
}

/** maps.json for the L window's Map tab; `titles` = names from the workshop cache (else "Workshop <id>"). */
export async function writeWorkshopMaps(csgoDir: string, ids: string[], titles: Record<string, string> = {}) {
  const dir = pluginConfigDir(csgoDir)
  await mkdir(dir, { recursive: true })
  const maps = ids.filter((id) => /^\d{5,20}$/.test(id)).map((id) => ({ id, name: titles[id] || `Workshop ${id}` }))
  await writeAtomic(join(dir, WORKSHOP_MAPS_FILE), JSON.stringify(maps, null, 2))
}
