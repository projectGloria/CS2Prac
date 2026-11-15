import { app } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Settings } from '@shared/ipc'

const DEFAULT_SETTINGS: Settings = { installDir: null, serverSource: 'client', autoConnect: true }

const settingsFile = () => join(app.getPath('userData'), 'settings.json')

export async function loadSettings(): Promise<Settings> {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(await readFile(settingsFile(), 'utf8')) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

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
