import { app } from 'electron'
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Plain-text log in <userData>/logs/main.log. When it grows past MAX_BYTES it is moved to main.old.log,
 * so at most two files (~10 MB) are kept. Writes are synchronous: lines are small and the log must survive crashes.
 */
const MAX_BYTES = 5 * 1024 * 1024

export const logsDir = () => join(app.getPath('userData'), 'logs')

let file: string | null = null
let size = 0

function open(): string {
  if (file) return file
  const dir = logsDir()
  mkdirSync(dir, { recursive: true })
  file = join(dir, 'main.log')
  try {
    size = statSync(file).size
  } catch {
    size = 0
  }
  return file
}

function rotate(path: string) {
  const old = join(logsDir(), 'main.old.log')
  rmSync(old, { force: true })
  renameSync(path, old)
  size = 0
}

export function log(source: string, message: string) {
  try {
    const path = open()
    const line = `${new Date().toISOString()} [${source}] ${message}\n`
    if (size + line.length > MAX_BYTES) rotate(path)
    appendFileSync(path, line)
    size += Buffer.byteLength(line)
  } catch {
    /* logging must never break the app */
  }
}

export function logError(source: string, e: unknown) {
  log(source, `ERROR ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
}
