import { app } from 'electron'
import { existsSync, readdirSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { skyThumbName } from '../skins/models'

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

export const SKY_IMG_DIR = ['panorama', 'images', 'custom_game', 'cs2prac_skies'] as const
const SKY_ADDON = 'cs2prac'

export type SkyInstall = 'installed' | 'unchanged' | 'nocompiler'

/**
 * Sky thumbnails for the L window's Sky tab. Panorama only draws compiled images, and nothing of Valve's ships with
 * the app, so the thumbnails ModelExport renders from the player's own VPK (ModelStore.skyFiles) are compiled here
 * with the player's resourcecompiler (CS2 Workshop Tools): a jpg next to a stylesheet that references it, compiled
 * with -r, gives <stem>_jpg.vtex_c. Those go into the client's panorama/images/custom_game/cs2prac_skies, where
 * the window's .ps-sky-img rules (build-hud.mjs) point. Without Workshop Tools the tiles show names only.
 */
export async function installSkyThumbs(
  cs2Dir: string,
  jpgs: Record<string, string>,
  compile: (exe: string, args: string[]) => Promise<void>
): Promise<SkyInstall> {
  const destDir = join(cs2Dir, 'game', 'csgo', ...SKY_IMG_DIR)
  const todo = Object.entries(jpgs)
    .map(([material, jpg]) => ({ jpg, stem: skyThumbName(material).replace(/\.jpg$/, '') }))
    .filter((t) => !existsSync(join(destDir, `${t.stem}_jpg.vtex_c`)))
  if (todo.length === 0) return 'unchanged'
  const compiler = join(cs2Dir, 'game', 'bin', 'win64', 'resourcecompiler.exe')
  if (!existsSync(compiler)) return 'nocompiler'
  const content = join(cs2Dir, 'content', 'csgo_addons', SKY_ADDON, 'panorama')
  const imgSrc = join(content, 'images', 'custom_game', 'cs2prac_skies')
  const cssSrc = join(content, 'styles', 'custom_game', 'cs2prac_skythumbs.css')
  await mkdir(imgSrc, { recursive: true })
  await mkdir(dirname(cssSrc), { recursive: true })
  const rules: string[] = []
  for (const t of todo) {
    await copyFile(t.jpg, join(imgSrc, `${t.stem}.jpg`))
    rules.push(`.${t.stem}\n{\n\tbackground-image: url("file://{images}/custom_game/cs2prac_skies/${t.stem}.jpg");\n}`)
  }
  await writeFile(cssSrc, rules.join('\n\n') + '\n')
  await compile(compiler, ['-i', cssSrc, '-r'])
  const built = join(cs2Dir, 'game', 'csgo_addons', SKY_ADDON, ...SKY_IMG_DIR)
  await mkdir(destDir, { recursive: true })
  let copied = 0
  for (const t of todo) {
    const f = join(built, `${t.stem}_jpg.vtex_c`)
    if (!existsSync(f)) continue
    await copyFile(f, join(destDir, `${t.stem}_jpg.vtex_c`))
    copied++
  }
  if (copied === 0) throw new Error('resourcecompiler produced no sky images')
  return 'installed'
}

/** Our own window images (build-hud OWN_IMAGES: the 1.6 icon, flags): resources/hud/images -> this client folder. */
export const HUD_IMG_DIR = ['panorama', 'images', 'custom_game', 'cs2prac'] as const

/** Copies the compiled layout + styles (and images) into <cs2>/game/csgo/panorama/... when they differ. */
export async function installClientHud(cs2Dir: string, srcDir = bundledHudDir()): Promise<HudInstall> {
  if (HUD_FILES.some((h) => !existsSync(join(srcDir, h.file)))) return 'missing'
  const imgDir = join(srcDir, 'images')
  const images = existsSync(imgDir) ? readdirSync(imgDir).map((file) => ({ from: join(imgDir, file), file, dir: HUD_IMG_DIR })) : []
  let changed = false
  for (const h of [...HUD_FILES.map((h) => ({ ...h, from: join(srcDir, h.file) })), ...images]) {
    const destDir = join(cs2Dir, 'game', 'csgo', ...h.dir)
    const dest = join(destDir, h.file)
    const src = await readFile(h.from)
    if (existsSync(dest) && src.equals(await readFile(dest))) continue
    await mkdir(destDir, { recursive: true })
    await copyFile(h.from, dest)
    changed = true
  }
  return changed ? 'installed' : 'unchanged'
}
