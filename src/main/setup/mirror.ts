import { copyFile, link, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

/**
 * Builds a CS2 server folder out of hard links to the player's own CS2 install, so the server
 * needs almost no extra disk space. Files the server modifies (gameinfo.gi gets the Metamod
 * patch, cfg files can be written) are copied instead, so the game install is never changed.
 */

export type MirrorAction = 'link' | 'copy' | 'skip'

/** What to do with a file, by its path relative to the game root ('/'-separated). */
export function mirrorAction(rel: string): MirrorAction {
  const p = rel.toLowerCase()
  if (p.startsWith('game/csgo/addons/')) return 'skip' // ours: Metamod, CSS, PracSkins
  if (p === 'game/csgo/console.log' || p.endsWith('.mdmp')) return 'skip'
  if (p === 'game/csgo/gameinfo.gi' || p.startsWith('game/csgo/cfg/')) return 'copy'
  return 'link'
}

export const MIRROR_MARKER = 'cs2prac-mirror.json'

interface Marker {
  source: string
  buildId: string | null
  /** files hard-linked last time, so links to files the game no longer has can be removed */
  linked: string[]
}

export interface MirrorResult {
  linked: number
  copied: number
  unchanged: number
  removed: number
}

const isInside = (child: string, parent: string) => {
  const r = relative(parent, child)
  return r === '' || (!r.startsWith('..') && !r.startsWith(sep) && !/^[a-z]:/i.test(r))
}

/** Same drive is required for hard links. Compares drive roots, so it works before the folder exists. */
export const sameDrive = (a: string, b: string) => resolve(a).slice(0, 3).toLowerCase() === resolve(b).slice(0, 3).toLowerCase()

async function listFiles(root: string, dir = root, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) await listFiles(root, full, out)
    else if (e.isFile()) out.push(relative(root, full).split(sep).join('/'))
  }
  return out
}

function explain(e: NodeJS.ErrnoException): Error {
  if (e.code === 'EXDEV') return new Error('The server folder must be on the same drive as your CS2 install')
  if (e.code === 'EPERM' || e.code === 'ENOTSUP' || e.code === 'EACCES')
    return new Error(`Couldn't create a hard link (${e.code}). The drive must be NTFS. ${e.message}`)
  return e
}

export async function syncMirror(
  source: string,
  dest: string,
  buildId: string | null,
  onProgress?: (done: number, total: number) => void
): Promise<MirrorResult> {
  source = resolve(source)
  dest = resolve(dest)
  if (isInside(dest, source) || isInside(source, dest))
    throw new Error('The server folder must not be inside your CS2 install (or the other way round)')
  if (!sameDrive(source, dest)) throw new Error('The server folder must be on the same drive as your CS2 install')

  let previous: string[] = []
  try {
    previous = (JSON.parse(await readFile(join(dest, MIRROR_MARKER), 'utf8')) as Marker).linked ?? []
  } catch {
    /* first sync */
  }

  const files = await listFiles(source)
  const result: MirrorResult = { linked: 0, copied: 0, unchanged: 0, removed: 0 }
  const linked: string[] = []
  const dirs = new Set<string>()

  for (let i = 0; i < files.length; i++) {
    const rel = files[i]
    const action = mirrorAction(rel)
    if (action === 'skip') continue
    const from = join(source, rel)
    const to = join(dest, rel)
    const dir = join(to, '..')
    if (!dirs.has(dir)) {
      await mkdir(dir, { recursive: true })
      dirs.add(dir)
    }
    const [s, d] = await Promise.all([stat(from, { bigint: true }), stat(to, { bigint: true }).catch(() => null)])

    if (action === 'link') {
      linked.push(rel)
      if (d && d.ino === s.ino && d.dev === s.dev) result.unchanged++
      else {
        // Never write into the existing file: if it were a link, that would change the game's copy.
        await rm(to, { force: true })
        await link(from, to).catch((e) => {
          throw explain(e)
        })
        result.linked++
      }
    } else {
      // gameinfo.gi is always refreshed (the server patches it afterwards); cfg files when the game's is newer
      const always = rel.toLowerCase() === 'game/csgo/gameinfo.gi'
      if (!always && d && d.ino !== s.ino && d.mtimeMs >= s.mtimeMs) result.unchanged++
      else {
        await rm(to, { force: true })
        await copyFile(from, to)
        result.copied++
      }
    }
    if (i % 100 === 0) onProgress?.(i, files.length)
  }

  const current = new Set(linked)
  for (const rel of previous) {
    if (current.has(rel) || mirrorAction(rel) !== 'link') continue
    await rm(join(dest, rel), { force: true })
    result.removed++
  }

  const marker: Marker = { source, buildId, linked }
  await writeFile(join(dest, MIRROR_MARKER), JSON.stringify(marker))
  onProgress?.(files.length, files.length)
  return result
}
