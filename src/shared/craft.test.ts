import { describe, expect, it } from 'vitest'
import { rollCraft } from './craft'
import type { CatalogKeychain, CatalogSkin, CatalogSticker } from './skins'

const skin = (paintKit: number, minFloat = 0, maxFloat = 1): CatalogSkin => ({
  id: `s${paintKit}`, defIndex: 7, name: `Skin ${paintKit}`, paintKit, minFloat, maxFloat, rarityColor: '', image: '', stattrak: true, legacyModel: false
})
const sticker = (defIndex: number, name: string, event: string | null = null): CatalogSticker => ({
  defIndex, name, image: '', rarityColor: '', type: 'Other', event
})
const keychains: CatalogKeychain[] = [{ defIndex: 9, name: 'Charm', image: '', rarityColor: '' }]

describe('rollCraft', () => {
  it('returns null without skins', () => {
    expect(rollCraft([], [], [])).toBeNull()
  })

  it('keeps wear inside the skin range and fills five sticker slots', () => {
    const stickers = Array.from({ length: 12 }, (_, i) => sticker(i + 1, i % 2 ? `s${i} (Holo)` : `s${i}`, i < 6 ? 'Katowice 2014' : null))
    for (let n = 0; n < 200; n++) {
      const r = rollCraft([skin(44, 0.06, 0.8)], stickers, keychains)!
      expect(r.sel.paintKit).toBe(44)
      expect(r.sel.wear).toBeGreaterThanOrEqual(0.06)
      expect(r.sel.wear).toBeLessThanOrEqual(0.8)
      expect(r.sel.seed).toBeGreaterThanOrEqual(0)
      expect(r.sel.seed).toBeLessThanOrEqual(1000)
      expect(r.sel.stickers).toHaveLength(5)
      const used = r.sel.stickers!.filter(Boolean)
      if (r.theme === '') expect(used).toHaveLength(0)
      else expect(used.length).toBeGreaterThan(0)
      if (r.theme === 'Katowice 2014') for (const s of used) expect(s!.defIndex).toBeLessThanOrEqual(6)
      if (r.theme === 'all Holo') for (const s of used) expect(s!.defIndex % 2).toBe(0)
    }
  })
})
