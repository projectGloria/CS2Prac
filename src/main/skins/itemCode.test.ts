import { describe, expect, it } from 'vitest'
import { emptyProfile } from '@shared/skins'
import {
  applyImported,
  encodeInspectData,
  inspectLink,
  itemOf,
  parseGenCode,
  parseItemCode,
  toGenCode,
  type ImportedItem
} from '@shared/itemCode'

const item: ImportedItem = {
  defIndex: 7,
  paintKit: 801,
  seed: 661,
  wear: 0.0712,
  statTrak: 1337,
  nameTag: 'gloria',
  stickers: [
    { defIndex: 4757, wear: 0.25, scale: 1.2, rotation: 45, x: 0.1, y: -0.05 },
    null,
    { defIndex: 5000, wear: 0, scale: 1, rotation: 0, x: 0, y: 0 },
    null,
    null
  ],
  keychain: { defIndex: 12, x: 1.5, y: 0, z: -2, seed: 77 }
}

/** masks an unmasked hex like real links do: every byte XOR key (the first byte then holds the key) */
const mask = (hex: string, key: number) =>
  hex
    .match(/../g)!
    .map((h) => (parseInt(h, 16) ^ key).toString(16).padStart(2, '0'))
    .join('')

describe('!gen codes', () => {
  it('reads weapon, paint, seed, wear, sticker pairs and a charm', () => {
    const r = parseGenCode('!gen 7 801 661 0.0712 4757 0.25 0 0 5000 0 0 0 0 0 12 77')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.item).toMatchObject({ defIndex: 7, paintKit: 801, seed: 661, wear: 0.0712 })
    expect(r.item.stickers[0]).toEqual({ defIndex: 4757, wear: 0.25, scale: 1, rotation: 0, x: 0, y: 0 })
    expect(r.item.stickers[1]).toBeNull()
    expect(r.item.stickers[2]?.defIndex).toBe(5000)
    expect(r.item.keychain).toEqual({ defIndex: 12, x: 0, y: 0, z: 0, seed: 77 })
  })

  it('takes !g, no prefix, and fewer sticker pairs', () => {
    expect(parseItemCode('!g 60 430 1 0.1').ok).toBe(true)
    const r = parseItemCode('16 309 5 0.2 76 0.5')
    expect(r.ok && r.item.stickers[0]?.defIndex).toBe(76)
  })

  it('rejects junk', () => {
    expect(parseGenCode('!gen 7 801').ok).toBe(false)
    expect(parseGenCode('!gen 7 x 1 0.1').ok).toBe(false)
    expect(parseGenCode('!gen 7 801 1 1.5').ok).toBe(false)
  })

  it('round-trips through toGenCode', () => {
    const r = parseGenCode(toGenCode(item))
    expect(r.ok && r.item.keychain?.defIndex).toBe(12)
    expect(r.ok && r.item.stickers.map((s) => s?.defIndex ?? 0)).toEqual([4757, 0, 5000, 0, 0])
    expect(toGenCode({ defIndex: 7, paintKit: 44, seed: 1, wear: 0.15 })).toBe('!gen 7 44 1 0.15')
  })
})

describe('inspect links', () => {
  it('decodes an unmasked and a masked preview block', () => {
    const hex = encodeInspectData(item)
    expect(hex.startsWith('00')).toBe(true)
    for (const h of [hex, mask(hex, 0xa7).toUpperCase()]) {
      const r = parseItemCode(`steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20${h}`)
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      expect(r.kind).toBe('inspect')
      expect(r.item).toMatchObject({ defIndex: 7, paintKit: 801, seed: 661, statTrak: 1337, nameTag: 'gloria' })
      expect(r.item.wear).toBeCloseTo(0.0712, 5)
      expect(r.item.stickers[0]).toMatchObject({ defIndex: 4757, scale: 1.2, rotation: 45 })
      expect(r.item.stickers[0]!.x).toBeCloseTo(0.1, 5)
      expect(r.item.stickers[2]).toMatchObject({ defIndex: 5000, scale: 1 })
      expect(r.item.keychain).toMatchObject({ defIndex: 12, seed: 77, x: 1.5, z: -2 })
    }
  })

  it('takes the bare hex and the console command', () => {
    const hex = encodeInspectData({ ...item, statTrak: null, nameTag: '', keychain: null })
    expect(parseItemCode(hex).ok).toBe(true)
    const r = parseItemCode(`csgo_econ_action_preview ${hex}`)
    expect(r.ok && r.item.statTrak).toBeNull()
    expect(inspectLink(item)).toContain(encodeInspectData(item))
  })

  it('refuses inventory links (they need the game coordinator)', () => {
    const r = parseItemCode('steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20S76561198000000000A123456789D987654321')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/game coordinator/)
  })
})

describe('applyImported', () => {
  const lookup = (def: number) =>
    def === 7
      ? { kind: 'weapon' as const, name: 'AK-47', className: 'weapon_ak47' }
      : def === 507
        ? { kind: 'knife' as const, name: 'Karambit', className: 'weapon_knife_karambit' }
        : def === 5030
          ? { kind: 'glove' as const, name: 'Sport Gloves', className: 'sporty_gloves' }
          : null

  it('fills a weapon with stickers and charm for one team', () => {
    const p = applyImported(emptyProfile('a', 'A'), 't', item, lookup, () => false)
    expect(p.weapons.t['7']).toMatchObject({ paintKit: 801, seed: 661, statTrak: 1337, nameTag: 'gloria' })
    expect(p.weapons.t['7'].stickers?.[0]?.defIndex).toBe(4757)
    expect(p.weapons.ct['7']).toBeUndefined()
    expect(itemOf(p, 't', 'weapon', 7)).toEqual(item)
  })

  it('fills knives and gloves, ignores unknown items', () => {
    let p = applyImported(emptyProfile('a', 'A'), 'ct', { ...item, defIndex: 507 }, lookup, () => true)
    expect(p.knife.ct).toMatchObject({ defIndex: 507, className: 'weapon_knife_karambit', legacyModel: true })
    expect(p.knife.ct?.stickers).toBeUndefined()
    p = applyImported(p, 'ct', { ...item, defIndex: 5030, paintKit: 10018 }, lookup, () => false)
    expect(p.gloves.ct).toEqual({ defIndex: 5030, paintKit: 10018, wear: item.wear, seed: 661 })
    expect(applyImported(p, 'ct', { ...item, defIndex: 99999 }, lookup, () => false)).toBe(p)
  })
})
