import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseVdf, steamPath } from './accounts'

export const CS2_APP_ID = '730'

type Vdf = ReturnType<typeof parseVdf>

const child = (v: Vdf, key: string) => {
  const k = Object.keys(v).find((x) => x.toLowerCase() === key.toLowerCase())
  return k === undefined ? undefined : v[k]
}

/** Library folders from steamapps/libraryfolders.vdf, those that contain CS2 first. */
export function libraryPathsFromVdf(text: string): string[] {
  const root = child(parseVdf(text), 'libraryfolders')
  if (!root || typeof root === 'string') return []
  const libs = Object.values(root).flatMap((lib) => {
    if (typeof lib === 'string') return []
    const path = child(lib, 'path')
    const apps = child(lib, 'apps')
    if (typeof path !== 'string') return []
    return [{ path, hasCs2: typeof apps === 'object' && CS2_APP_ID in apps }]
  })
  return libs.sort((a, b) => Number(b.hasCs2) - Number(a.hasCs2)).map((l) => l.path)
}

export function parseAppManifest(text: string): { installDir?: string; buildId?: string } {
  const state = child(parseVdf(text), 'AppState')
  if (!state || typeof state === 'string') return {}
  const get = (k: string) => {
    const v = child(state, k)
    return typeof v === 'string' ? v : undefined
  }
  return { installDir: get('installdir'), buildId: get('buildid') }
}

export interface Cs2Install {
  /** game root, e.g. ...\steamapps\common\Counter-Strike Global Offensive */
  dir: string
  buildId: string | null
}

/** Finds the CS2 game installed through Steam, or null. */
export async function findCs2Install(): Promise<Cs2Install | null> {
  const steam = await steamPath()
  let libs = [steam]
  try {
    libs = [...libraryPathsFromVdf(await readFile(join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8')), steam]
  } catch {
    /* only the default library */
  }
  for (const lib of libs) {
    const steamapps = join(lib, 'steamapps')
    let manifest: ReturnType<typeof parseAppManifest> = {}
    try {
      manifest = parseAppManifest(await readFile(join(steamapps, `appmanifest_${CS2_APP_ID}.acf`), 'utf8'))
    } catch {
      /* not in this library */
    }
    const dir = join(steamapps, 'common', manifest.installDir ?? 'Counter-Strike Global Offensive')
    if (existsSync(join(dir, 'game', 'bin', 'win64', 'cs2.exe'))) return { dir, buildId: manifest.buildId ?? null }
  }
  return null
}
