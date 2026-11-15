import { describe, expect, it, vi } from 'vitest'
import type { ApiBaseWeapon, ApiSkin } from './catalog'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))
const { buildCatalog } = await import('./catalog')

const skin = (over: Partial<ApiSkin> & Pick<ApiSkin, 'weapon'>): ApiSkin => ({
  id: `skin-${Math.random()}`,
  name: 'X | Y',
  category: { name: 'Rifles' },
  pattern: { name: 'Y' },
  min_float: 0,
  max_float: 1,
  rarity: { color: '#eb4b4b' },
  stattrak: true,
  paint_index: '1',
  image: 'img',
  ...over
})

const base: ApiBaseWeapon[] = [
  { id: 'base_weapon-weapon_ak47', name: 'AK-47', def_index: 7, category: { name: 'Rifles' }, image: 'ak' },
  { id: 'base_weapon-weapon_c4', name: 'C4', def_index: 49, category: { name: 'Equipment' }, image: 'c4' },
  { id: 'base_weapon-weapon_knife', name: 'Knife', def_index: 42, category: { name: 'Knives' }, image: 'k' },
  { id: 'base_weapon-weapon_knife_karambit', name: '★ Karambit', def_index: 507, category: { name: 'Knives' }, image: 'kara' }
]

const skins: ApiSkin[] = [
  skin({ weapon: { id: 'weapon_ak47', weapon_id: 7, name: 'AK-47' }, pattern: { name: 'Redline' }, paint_index: '282', min_float: 0.1, max_float: 0.7, legacy_model: true }),
  // HUD-alias weapon id + Doppler phase
  skin({ weapon: { id: 'sfui_wpnhud_knifekaram', weapon_id: 507, name: 'Karambit' }, category: { name: 'Knives' }, pattern: { name: 'Doppler' }, phase: 'Phase 2', paint_index: '419' }),
  // vanilla knife entry: no paint index
  skin({ weapon: { id: 'sfui_wpnhud_knifekaram', weapon_id: 507, name: 'Karambit' }, category: { name: 'Knives' }, paint_index: null }),
  // gloves only exist in skins.json
  skin({ weapon: { id: 'sporty_gloves', weapon_id: 5030, name: 'Sport Gloves' }, category: { name: 'Gloves' }, pattern: { name: 'Vice' }, paint_index: '10048' })
]

describe('buildCatalog', () => {
  const c = buildCatalog(skins, base, 123)

  it('keeps skinnable weapons and knives, drops C4 and default knives', () => {
    expect(c.weapons.map((w) => w.className).sort()).toEqual(['sporty_gloves', 'weapon_ak47', 'weapon_knife_karambit'])
  })

  it('uses the base class name for knives, not the HUD alias', () => {
    expect(c.weapons.find((w) => w.defIndex === 507)).toMatchObject({ className: 'weapon_knife_karambit', kind: 'knife' })
  })

  it('classifies gloves from skins.json', () => {
    expect(c.weapons.find((w) => w.defIndex === 5030)).toMatchObject({ kind: 'glove', category: 'Gloves' })
  })

  it('converts skins, skipping vanilla entries and naming phases', () => {
    expect(c.skins).toHaveLength(3)
    expect(c.skins.find((s) => s.paintKit === 419)?.name).toBe('Doppler (Phase 2)')
    expect(c.skins.find((s) => s.paintKit === 282)).toMatchObject({ defIndex: 7, minFloat: 0.1, maxFloat: 0.7, legacyModel: true })
  })
})

describe('catalog extras', () => {
  const c = buildCatalog([], [], 1, {
    agents: [
      { name: 'Bloody Darryl', def_index: '4613', team: { id: 'terrorists' }, model_player: 'agents/models/tm_professional/tm_professional_varf5.vmdl', image: 'a' },
      { name: 'Seal', def_index: '4619', team: { id: 'counter-terrorists' }, model_player: 'agents/models/ctm_st6/ctm_st6_variantj.vmdl', image: 'b' },
      { name: 'No model', def_index: '1', team: { id: 'terrorists' }, model_player: null, image: 'c' }
    ],
    stickers: [{ name: 'Sticker | Shooter', def_index: '1', type: 'Event', tournament: { name: '2013 DreamHack Winter' }, image: 's' }],
    keychains: [{ name: "Charm | Lil' Ava", def_index: '1', image: 'k' }]
  })

  it('keeps agents with a model and maps their team', () => {
    expect(c.agents.map((a) => [a.defIndex, a.team])).toEqual([[4613, 't'], [4619, 'ct']])
  })

  it('strips the Sticker / Charm prefixes', () => {
    expect(c.stickers[0]).toMatchObject({ defIndex: 1, name: 'Shooter', type: 'Event', event: '2013 DreamHack Winter' })
    expect(c.keychains[0]).toMatchObject({ defIndex: 1, name: "Lil' Ava" })
  })
})
