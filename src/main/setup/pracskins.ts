import { app } from 'electron'
import { existsSync } from 'node:fs'
import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Where the prebuilt plugin lives: resources/plugin/PracSkins in dev, <resources>/plugin/PracSkins when packaged. */
export function bundledPluginDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'plugin', 'PracSkins')
    : join(app.getAppPath(), 'resources', 'plugin', 'PracSkins')
}

export const installedPluginDir = (csgoDir: string) =>
  join(csgoDir, 'addons', 'counterstrikesharp', 'plugins', 'PracSkins')

/**
 * Copies the PracSkins plugin into the server. Returns false if the plugin hasn't been built
 * (run `npm run build:plugin`) or CounterStrikeSharp isn't installed yet.
 */
export async function installPracSkins(csgoDir: string): Promise<boolean> {
  const src = bundledPluginDir()
  if (!existsSync(join(src, 'PracSkins.dll'))) return false
  if (!existsSync(join(csgoDir, 'addons', 'counterstrikesharp'))) return false
  const dest = installedPluginDir(csgoDir)
  await mkdir(dest, { recursive: true })
  await cp(src, dest, { recursive: true, force: true })
  return true
}
