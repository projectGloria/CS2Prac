import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Shown before the server is installed or if the maps folder can't be read. */
export const FALLBACK_MAPS = [
  'de_ancient', 'de_anubis', 'de_dust2', 'de_inferno', 'de_mirage', 'de_nuke',
  'de_overpass', 'de_train', 'de_vertigo', 'cs_italy', 'cs_office'
]

const PLAYABLE = /^(de|cs|ar)_[a-z0-9_]+$/
const NOT_A_MAP = /(_vanity|_preview|_skybox|_dir)$/

export function mapNamesFromFiles(files: string[]): string[] {
  return files
    .filter((f) => f.endsWith('.vpk'))
    .map((f) => f.slice(0, -4))
    .filter((n) => PLAYABLE.test(n) && !NOT_A_MAP.test(n))
    .sort()
}

/** Lists the maps actually shipped with the installed server (game/csgo/maps/*.vpk). */
export async function listInstalledMaps(csgoDir: string): Promise<string[]> {
  try {
    const maps = mapNamesFromFiles(await readdir(join(csgoDir, 'maps')))
    return maps.length ? maps : FALLBACK_MAPS
  } catch {
    return FALLBACK_MAPS
  }
}
