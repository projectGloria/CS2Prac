import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Extracts a .zip with Windows' built-in bsdtar (Windows 10 1803+). Replaces the extract-zip package, which
 * silently stalls forever on some archives (e.g. MatchZy's) with current Node versions.
 * The System32 path is used explicitly so another tar on PATH (e.g. Git's) is never picked.
 */
export async function extractZip(zip: string, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  await new Promise<void>((resolve, reject) => {
    execFile(tar, ['-xf', zip, '-C', dir], { windowsHide: true, timeout: 10 * 60_000 }, (err, _out, stderr) => {
      if (err) reject(new Error(`Could not extract ${zip}: ${stderr.trim() || err.message}`))
      else resolve()
    })
  })
}
