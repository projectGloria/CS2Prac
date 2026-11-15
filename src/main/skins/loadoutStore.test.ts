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
    expect(f.weapons['7']).toEqual({
      paintKit: 282, wear: 0.15, seed: 661, statTrak: 1337, nameTag: 'x'.repeat(20), legacyModel: false,
      stickers: [null, null, null, null, null], keychain: null
    })
  })

  it('exports stickers and keychains, even on a weapon without a finish', () => {
    const q = emptyProfile('q', 'Q')
    q.weapons['9'] = {
      paintKit: 0, wear: 0, seed: 0, statTrak: null, nameTag: '',
      stickers: [null, { defIndex: 4682, wear: 2, scale: 1, rotation: 0, x: 0, y: 0 }, { defIndex: 0, wear: 0, scale: 1, rotation: 0, x: 0, y: 0 }],
      keychain: { defIndex: 12, x: 0, y: 0, z: 0, seed: 7 }
    }
    q.weapons['4'] = { paintKit: 0, wear: 0, seed: 0, statTrak: null, nameTag: '', stickers: [null] }
    const out = toLoadoutFile(q, null)
    expect(Object.keys(out.weapons)).toEqual(['9'])
    expect(out.weapons['9'].stickers).toEqual([null, { defIndex: 4682, wear: 1, scale: 1, rotation: 0, x: 0, y: 0 }, null, null, null])
    expect(out.weapons['9'].keychain).toEqual({ defIndex: 12, x: 0, y: 0, z: 0, seed: 7 })
  })

  it('exports agents with a valid model path only', () => {
    const q = emptyProfile('q', 'Q')
    q.agents.t = { defIndex: 4613, model: 'agents/models/tm_professional/tm_professional_varf5.vmdl' }
    q.agents.ct = { defIndex: 1, model: 'x; quit' }
    expect(toLoadoutFile(q, null).agents).toEqual({ t: q.agents.t, ct: null })
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

describe('fromLoadoutFile', () => {
  it('round-trips a profile through loadout.json', async () => {
    const { fromLoadoutFile } = await import('./loadoutStore')
    const p = emptyProfile('id', 'Mine')
    p.weapons['7'] = {
      paintKit: 282, wear: 0.15, seed: 661, statTrak: 3, nameTag: 'hi', legacyModel: true,
      stickers: [null, { defIndex: 5, wear: 0, scale: 1, rotation: 0, x: 0, y: 0 }, null, null, null], keychain: null
    }
    p.knife.ct = { defIndex: 507, className: 'weapon_knife_karambit', paintKit: 0, wear: 0, seed: 0, statTrak: null, nameTag: '', legacyModel: false }
    p.agents.t = { defIndex: 4613, model: 'agents/models/a.vmdl' }
    const back = fromLoadoutFile(toLoadoutFile(p, null), { ...emptyProfile('id', 'Mine') })
    expect(toLoadoutFile(back, null)).toEqual(toLoadoutFile(p, null))
    expect(back.name).toBe('Mine')
  })
})
