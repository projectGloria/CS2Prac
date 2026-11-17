import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '', getPath: () => '' } }))

import { HUD_FILES, installClientHud, installSkyThumbs } from './clientHud'

let tmp: string
let src: string
let cs2: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'cs2prac-hud-'))
  src = join(tmp, 'hud')
  cs2 = join(tmp, 'cs2')
  await mkdir(src)
  for (const h of HUD_FILES) await writeFile(join(src, h.file), `compiled ${h.file}`)
})

afterEach(() => rm(tmp, { recursive: true, force: true }))

describe('installClientHud', () => {
  it('copies the layout and styles into the game panorama folder, then reports unchanged', async () => {
    expect(await installClientHud(cs2, src)).toBe('installed')
    const layout = join(cs2, 'game', 'csgo', 'panorama', 'layout', 'custom_game', 'cs2prac_skins.vxml_c')
    const styles = join(cs2, 'game', 'csgo', 'panorama', 'styles', 'custom_game', 'cs2prac_skins.vcss_c')
    expect(await readFile(layout, 'utf8')).toBe('compiled cs2prac_skins.vxml_c')
    expect(await readFile(styles, 'utf8')).toBe('compiled cs2prac_skins.vcss_c')
    expect(await installClientHud(cs2, src)).toBe('unchanged')
  })

  it('replaces an outdated copy', async () => {
    await installClientHud(cs2, src)
    await writeFile(join(src, 'cs2prac_skins.vcss_c'), 'newer')
    expect(await installClientHud(cs2, src)).toBe('installed')
  })

  it('does nothing when the build is missing', async () => {
    await rm(join(src, 'cs2prac_skins.vxml_c'))
    expect(await installClientHud(cs2, src)).toBe('missing')
  })
})

describe('installSkyThumbs', () => {
  const mat = 'materials/skybox/sky_de_dust2.vmat'
  let jpg: string
  beforeEach(async () => {
    jpg = join(tmp, 'sky_sky_de_dust2.jpg')
    await writeFile(jpg, 'jpeg')
  })

  it('needs Workshop Tools', async () => {
    expect(await installSkyThumbs(cs2, { [mat]: jpg }, async () => {})).toBe('nocompiler')
  })

  it('compiles the thumbnails once and copies them into the client', async () => {
    const bin = join(cs2, 'game', 'bin', 'win64')
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'resourcecompiler.exe'), '')
    const compile = vi.fn(async (_exe: string, args: string[]) => {
      const css = await readFile(args[1], 'utf8')
      expect(css).toContain('file://{images}/custom_game/cs2prac_skies/sky_sky_de_dust2.jpg')
      const out = join(cs2, 'game', 'csgo_addons', 'cs2prac', 'panorama', 'images', 'custom_game', 'cs2prac_skies')
      await mkdir(out, { recursive: true })
      await writeFile(join(out, 'sky_sky_de_dust2_jpg.vtex_c'), 'vtex')
    })
    expect(await installSkyThumbs(cs2, { [mat]: jpg }, compile)).toBe('installed')
    const dest = join(cs2, 'game', 'csgo', 'panorama', 'images', 'custom_game', 'cs2prac_skies', 'sky_sky_de_dust2_jpg.vtex_c')
    expect(await readFile(dest, 'utf8')).toBe('vtex')
    expect(await installSkyThumbs(cs2, { [mat]: jpg }, compile)).toBe('unchanged')
    expect(compile).toHaveBeenCalledTimes(1)
  })
})
