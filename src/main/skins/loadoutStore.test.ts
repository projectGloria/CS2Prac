import { describe, expect, it, vi } from 'vitest'
import { emptyProfile } from '@shared/skins'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))
const { toLoadoutFile } = await import('./loadoutStore')

describe('toLoadoutFile', () => {
  const p = emptyProfile('id', 'Test')
  p.weapons.t['7'] = { paintKit: 282, wear: 0.15, seed: 661, statTrak: 1337, nameTag: 'x'.repeat(40) }
  p.weapons.t['1'] = { paintKit: 0, wear: 0, seed: 0, statTrak: null, nameTag: '' } // "default" must be dropped
  p.weapons.t['bad'] = { paintKit: 1, wear: 0, seed: 0, statTrak: null, nameTag: '' }
  p.knife.t = { defIndex: 507, className: 'weapon_knife_karambit', paintKit: 0, wear: 0, seed: 5000, statTrak: null, nameTag: '' }
  p.knife.ct = { defIndex: 7, className: 'weapon_ak47', paintKit: 1, wear: 0, seed: 0, statTrak: null, nameTag: '' }
  p.gloves.ct = { defIndex: 5030, paintKit: 10048, wear: 2, seed: -3 }

  const f = toLoadoutFile(p, '76561198000000000')

  it('exports weapon paints, clamps values and trims name tags', () => {
    expect(Object.keys(f.weapons.t)).toEqual(['7'])
    expect(f.weapons.t['7']).toEqual({
      paintKit: 282, wear: 0.15, seed: 661, statTrak: 1337, nameTag: 'x'.repeat(20), legacyModel: false,
      stickers: [null, null, null, null, null], keychain: null
    })
  })

  it('exports stickers and keychains, even on a weapon without a finish', () => {
    const q = emptyProfile('q', 'Q')
    q.weapons.t['9'] = {
      paintKit: 0, wear: 0, seed: 0, statTrak: null, nameTag: '',
      stickers: [null, { defIndex: 4682, wear: 2, scale: 1, rotation: 0, x: 0, y: 0 }, { defIndex: 0, wear: 0, scale: 1, rotation: 0, x: 0, y: 0 }],
      keychain: { defIndex: 12, x: 0, y: 0, z: 0, seed: 7 }
    }
    q.weapons.t['4'] = { paintKit: 0, wear: 0, seed: 0, statTrak: null, nameTag: '', stickers: [null] }
    const out = toLoadoutFile(q, null)
    expect(Object.keys(out.weapons.t)).toEqual(['9'])
    expect(out.weapons.t['9'].stickers).toEqual([null, { defIndex: 4682, wear: 1, scale: 1, rotation: 0, x: 0, y: 0 }, null, null, null])
    expect(out.weapons.t['9'].keychain).toEqual({ defIndex: 12, x: 0, y: 0, z: 0, seed: 7 })
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
    p.weapons.ct['7'] = {
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

describe('normalizeProfile', () => {
  it('adds the agents of profiles saved before agents existed', async () => {
    const { normalizeProfile } = await import('@shared/skins')
    const old = { id: 'a', name: 'Old', weapons: {}, knife: { t: null, ct: null }, gloves: { t: null, ct: null } }
    expect(normalizeProfile(old as never).agents).toEqual({ t: null, ct: null })
  })

  it('copies a pre-team weapon map to both teams', async () => {
    const { normalizeProfile } = await import('@shared/skins')
    const sel = { paintKit: 282, wear: 0.1, seed: 1, statTrak: null, nameTag: '' }
    const old = { ...emptyProfile('a', 'Old'), weapons: { '7': sel } }
    const p = normalizeProfile(old as never)
    expect(p.weapons).toEqual({ t: { '7': sel }, ct: { '7': sel } })
    p.weapons.t['7'].paintKit = 1
    expect(p.weapons.ct['7'].paintKit).toBe(282) // independent copies
  })
})

describe('per-team weapons', () => {
  it('exports T and CT skins separately', () => {
    const p = emptyProfile('id', 'Teams')
    p.weapons.t['7'] = { paintKit: 282, wear: 0.1, seed: 0, statTrak: null, nameTag: '' }
    p.weapons.ct['7'] = { paintKit: 44, wear: 0.1, seed: 0, statTrak: null, nameTag: '' }
    const f = toLoadoutFile(p, null)
    expect(f.schema).toBe(3)
    expect(f.weapons.t['7'].paintKit).toBe(282)
    expect(f.weapons.ct['7'].paintKit).toBe(44)
  })

  it('imports a schema 2 file (one map) into both teams', async () => {
    const { fromLoadoutFile } = await import('./loadoutStore')
    const w = { paintKit: 282, wear: 0.1, seed: 0, statTrak: -1, nameTag: '', legacyModel: false, stickers: [], keychain: null }
    const v2 = { schema: 2, owner: null, weapons: { '7': w }, knife: { t: null, ct: null }, gloves: { t: null, ct: null }, agents: { t: null, ct: null }, precache: [] }
    const back = fromLoadoutFile(v2 as never, emptyProfile('id', 'x'))
    expect(back.weapons.t['7'].paintKit).toBe(282)
    expect(back.weapons.ct['7'].paintKit).toBe(282)
  })
})
