import { describe, expect, it } from 'vitest'
import { itemInfo, metaLine, wearSpan, weaponStatLine, weaponStatRows } from './itemInfo'
import { CATALOG_VERSION, type Catalog } from './skins'

const skin = (id: string, defIndex: number, name: string, paintKit: number, collection: string, rarity: string) => ({
  id,
  defIndex,
  name,
  paintKit,
  minFloat: 0.1,
  maxFloat: 0.7,
  rarityColor: '#eb4b4b',
  image: `${id}.png`,
  stattrak: true,
  legacyModel: false,
  meta: { rarity, collections: [collection], flavor: 'A quote' }
})

const catalog: Catalog = {
  version: CATALOG_VERSION,
  fetchedAt: 0,
  weapons: [
    { defIndex: 7, className: 'weapon_ak47', name: 'AK-47', category: 'Rifles', kind: 'weapon', image: 'ak.png' },
    { defIndex: 9, className: 'weapon_awp', name: 'AWP', category: 'Sniper Rifles', kind: 'weapon', image: 'awp.png' }
  ],
  skins: [
    skin('a', 7, 'Redline', 282, 'The Phoenix Collection', 'Classified'),
    skin('b', 9, 'Asiimov', 279, 'The Phoenix Collection', 'Covert'),
    skin('c', 7, 'Safari Mesh', 72, 'The Safehouse Collection', 'Industrial Grade')
  ],
  agents: [],
  stickers: [],
  keychains: [],
  pins: [],
  musicKits: [
    { defIndex: 3, name: 'Daniel Sadowski, Crimson Assault', image: '', rarityColor: '#4b69ff' },
    { defIndex: 4, name: 'Daniel Sadowski, Total Domination', image: '', rarityColor: '#4b69ff' },
    { defIndex: 5, name: 'Noisia, Sharpened', image: '', rarityColor: '#4b69ff' }
  ],
  graffiti: []
} as unknown as Catalog

describe('item info', () => {
  it('names the wear grades a float range covers', () => {
    expect(wearSpan(0, 0.07)).toBe('FN')
    expect(wearSpan(0.1, 0.7)).toBe('MW–BS')
    expect(wearSpan(0, 1)).toBe('FN–BS')
  })

  it('reads weapon stats from the game data', () => {
    const rows = weaponStatRows('weapon_ak47')
    expect(rows.find((r) => r.label === 'Price')?.value).toBe('$2,700')
    expect(rows.find((r) => r.label === 'Magazine')?.value).toBe('30 / 90')
    expect(weaponStatLine('weapon_ak47')).toContain('36 dmg')
    expect(weaponStatLine('weapon_nothing')).toBe('')
  })

  it('builds a skin pop-up with its collection mates and other finishes', () => {
    const info = itemInfo(catalog, { kind: 'skin', id: 'a' })!
    expect(info.title).toBe('AK-47 | Redline')
    expect(info.flavor).toBe('A quote')
    expect(info.rows.find((r) => r.label === 'Collection')?.value).toBe('The Phoenix Collection')
    expect(info.rows.find((r) => r.label === 'Wear range')?.value).toContain('MW–BS')
    expect(info.related.map((g) => g.title)).toEqual(['Also in The Phoenix Collection', 'Other AK-47 finishes'])
    expect(info.related[0].items[0].name).toBe('AWP | Asiimov')
  })

  it('groups music kits by artist and lists a weapon by rarity', () => {
    const m = itemInfo(catalog, { kind: 'music', def: 3 })!
    expect(m.rows[0]).toEqual({ label: 'Artist', value: 'Daniel Sadowski' })
    expect(m.related[0].items.map((i) => i.name)).toEqual(['Daniel Sadowski, Total Domination'])
    const w = itemInfo(catalog, { kind: 'weapon', def: 7 })!
    expect(w.related[0].items.map((i) => i.name)).toEqual(['Redline', 'Safari Mesh'])
    expect(itemInfo(catalog, { kind: 'agent', def: 1 })).toBeNull()
  })

  it('writes the short line the plugin shows', () => {
    expect(metaLine({ rarity: 'Covert', collections: ['The Phoenix Collection'] })).toBe('Covert · The Phoenix Collection')
    expect(metaLine({ crates: ['Gallery Case'] })).toBe('Gallery Case')
    expect(metaLine(undefined)).toBe('')
  })
})
