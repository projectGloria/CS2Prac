import { describe, expect, it, vi } from 'vitest'
import { emptyProfile } from '@shared/skins'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))
const { toLoadoutFile } = await import('./loadoutStore')

describe('toLoadoutFile', () => {
  const p = emptyProfile('id', 'Test')
  p.weapons['7'] = { paintKit: 282, wear: 0.15, seed: 661, statTrak: 1337, nameTag: 'x'.repeat(40) }
  p.weapons['1'] = { paintKit: 0, wear: 0, seed: 0, statTrak: null, nameTag: '' } // "default" must be dropped
  p.weapons['bad'] = { paintKit: 1, wear: 0, seed: 0, statTrak: null, nameTag: '' }
  p.knife.t = { defIndex: 507, className: 'weapon_knife_karambit', paintKit: 0, wear: 0, seed: 5000, statTrak: null, nameTag: '' }
  p.knife.ct = { defIndex: 7, className: 'weapon_ak47', paintKit: 1, wear: 0, seed: 0, statTrak: null, nameTag: '' }
  p.gloves.ct = { defIndex: 5030, paintKit: 10048, wear: 2, seed: -3 }

  const f = toLoadoutFile(p, '76561198000000000')

  it('exports weapon paints, clamps values and trims name tags', () => {
    expect(Object.keys(f.weapons)).toEqual(['7'])
    expect(f.weapons['7']).toEqual({ paintKit: 282, wear: 0.15, seed: 661, statTrak: 1337, nameTag: 'x'.repeat(20) })
  })

  it('keeps vanilla knives, rejects non-knife classes, clamps seeds', () => {
    expect(f.knife.t).toMatchObject({ className: 'weapon_knife_karambit', paintKit: 0, seed: 1000, statTrak: -1 })
    expect(f.knife.ct).toBeNull()
  })

  it('clamps glove wear and seed', () => {
    expect(f.gloves).toEqual({ t: null, ct: { defIndex: 5030, paintKit: 10048, wear: 1, seed: 0 } })
  })

  it('accepts only valid SteamID64 owners', () => {
    expect(f.owner).toBe('76561198000000000')
    expect(toLoadoutFile(p, 'not-an-id').owner).toBeNull()
  })
})
