import { app } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Settings } from '@shared/ipc'

const DEFAULT_SETTINGS: Omit<Settings, 'rconPassword'> = { installDir: null, serverSource: 'client', matchzyMode: 'practice' }

const settingsFile = () => join(app.getPath('userData'), 'settings.json')

export async function loadSettings(): Promise<Settings> {
  let stored: Partial<Settings> & { autoConnect?: unknown } = {}
  try {
    stored = JSON.parse(await readFile(settingsFile(), 'utf8'))
  } catch {
    /* first run */
  }
  delete stored.autoConnect // removed setting
  const s: Settings = { ...DEFAULT_SETTINGS, rconPassword: '', ...stored }
  if (!/^[a-z0-9]{8,}$/i.test(s.rconPassword)) {
    // Created once and kept: the user types it into the game console
    s.rconPassword = randomBytes(8).toString('hex')
    await saveSettings(s)
  }
  return s
}

/** The app's own cfg folder; its files are copied into the server's cfg/ before every start. */
export const userCfgDir = () => join(app.getPath('userData'), 'cfg')

export async function saveSettings(s: Settings): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(settingsFile(), JSON.stringify(s, null, 2))
}

export function layout(installDir: string) {
  const server = join(installDir, 'server')
  return {
    steamcmdDir: join(installDir, 'steamcmd'),
    steamcmdExe: join(installDir, 'steamcmd', 'steamcmd.exe'),
    serverDir: server,
    cs2Exe: join(server, 'game', 'bin', 'win64', 'cs2.exe'),
    csgoDir: join(server, 'game', 'csgo')
  }
}

export const isInstalled = (p: string) => existsSync(p)
