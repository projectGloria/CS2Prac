import { app } from 'electron'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The in-game skin window (PracSkins Hud.cs) is a Panorama layout the CS2 *client* has to have. It is built by
 * `npm run build:hud` into resources/hud and copied into the game's own panorama folder, where the client loads
 * loose files (the user chose this over a Workshop addon; it only adds two new files under custom_game).
 * A changed layout needs a CS2 restart: Panorama caches layouts.
 */
export const HUD_FILES = [
  { file: 'cs2prac_skins.vxml_c', dir: ['panorama', 'layout', 'custom_game'] },
  { file: 'cs2prac_skins.vcss_c', dir: ['panorama', 'styles', 'custom_game'] }
] as const

export function bundledHudDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'hud') : join(app.getAppPath(), 'resources', 'hud')
}

export type HudInstall = 'installed' | 'unchanged' | 'missing'

/**
 * graffiti.json (sticker kit def -> spray decal textures, from `npm run build:hud`) goes into the plugin's config
 * folder: PracSkins precaches those textures, else the client draws a sprayed decal as the missing-texture checkerboard.
 */
export async function installGraffitiTextures(pluginConfigDir: string, srcDir = bundledHudDir()): Promise<boolean> {
  const src = join(srcDir, 'graffiti.json')
  if (!existsSync(src)) return false
  await mkdir(pluginConfigDir, { recursive: true })
  await copyFile(src, join(pluginConfigDir, 'graffiti.json'))
  return true
}

/** Copies the compiled layout + styles into <cs2>/game/csgo/panorama/... when they differ. */
export async function installClientHud(cs2Dir: string, srcDir = bundledHudDir()): Promise<HudInstall> {
  if (HUD_FILES.some((h) => !existsSync(join(srcDir, h.file)))) return 'missing'
  let changed = false
  for (const h of HUD_FILES) {
    const destDir = join(cs2Dir, 'game', 'csgo', ...h.dir)
    const dest = join(destDir, h.file)
    const src = await readFile(join(srcDir, h.file))
    if (existsSync(dest) && src.equals(await readFile(dest))) continue
    await mkdir(destDir, { recursive: true })
    await copyFile(join(srcDir, h.file), dest)
    changed = true
  }
  return changed ? 'installed' : 'unchanged'
}
