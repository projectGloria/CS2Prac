import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const METAMOD_SEARCH_PATH = 'csgo/addons/metamod'

/**
 * Adds `Game csgo/addons/metamod` as the first entry of the SearchPaths block so
 * Metamod loads before the game. Idempotent. CS2 updates overwrite gameinfo.gi,
 * so this is re-applied before every server start.
 */
export function patchGameinfo(text: string): { text: string; changed: boolean } {
  if (new RegExp(`^\\s*Game\\s+${METAMOD_SEARCH_PATH}\\s*$`, 'm').test(text)) return { text, changed: false }

  const m = /(SearchPaths\s*\{[^\S\r\n]*\r?\n)([ \t]*)/.exec(text)
  if (!m) throw new Error('gameinfo.gi: SearchPaths block not found; the file format may have changed')

  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const indent = m[2] || '\t\t\t'
  const insertAt = m.index + m[1].length
  const line = `${indent}Game\t${METAMOD_SEARCH_PATH}${eol}`
  return { text: text.slice(0, insertAt) + line + text.slice(insertAt), changed: true }
}

export async function ensureGameinfoPatched(csgoDir: string): Promise<boolean> {
  const file = join(csgoDir, 'gameinfo.gi')
  const { text, changed } = patchGameinfo(await readFile(file, 'utf8'))
  if (changed) await writeFile(file, text)
  return changed
}
