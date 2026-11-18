/**
 * Item info pop-ups (2026-11-18 Phase I): one builder shared by the app (right-click on a tile), the item website
 * (scripts/site, bundled for the browser) and the generated docs (docs/items). Facts come from the catalog (ByMykel
 * data: rarity, collections, cases, wear range, flavour text) and weaponStats.json (the game's weapons.vdata, via
 * `npm run build:weaponstats`).
 */
import type { Catalog, CatalogSkin, CatalogWeapon, ItemMeta } from './skins'
import statsJson from './weaponStats.json'

export interface WeaponStats {
  type: string
  price: number
  killAward: number
  damage: number
  bullets: number
  rpm: number
  clip: number
  reserve: number
  /** armour penetration in percent */
  armorPen: number
  headshot: number
  penetration: number
  rangeModifier: number
  speed: number
  fullAuto: boolean
}

export const WEAPON_STATS = statsJson as Record<string, WeaponStats>

export type InfoKind = 'skin' | 'weapon' | 'agent' | 'sticker' | 'keychain' | 'pin' | 'music' | 'graffiti'

/** what to show: a skin by its catalog id, anything else by def index */
export type InfoRef = { kind: 'skin'; id: string } | { kind: Exclude<InfoKind, 'skin'>; def: number }

export interface InfoRow {
  label: string
  value: string
}

export interface RelatedItem {
  name: string
  image: string
  rarityColor: string
  ref: InfoRef
}

export interface ItemInfo {
  kind: InfoKind
  title: string
  subtitle: string
  image: string
  rarityColor: string
  rows: InfoRow[]
  flavor?: string
  related: { title: string; items: RelatedItem[] }[]
}

export const WEARS: { name: string; short: string; min: number; max: number }[] = [
  { name: 'Factory New', short: 'FN', min: 0, max: 0.07 },
  { name: 'Minimal Wear', short: 'MW', min: 0.07, max: 0.15 },
  { name: 'Field-Tested', short: 'FT', min: 0.15, max: 0.38 },
  { name: 'Well-Worn', short: 'WW', min: 0.38, max: 0.45 },
  { name: 'Battle-Scarred', short: 'BS', min: 0.45, max: 1 }
]

/** the wear names a float range covers ("MW–BS") */
export function wearSpan(min: number, max: number): string {
  const hit = WEARS.filter((w) => max > w.min && min < w.max)
  if (hit.length === 0) return '–'
  return hit.length === 1 ? hit[0].short : `${hit[0].short}–${hit[hit.length - 1].short}`
}

/** rarity order, low to high (for sorting related items) */
const RARITY_ORDER = [
  'Consumer Grade', 'Base Grade', 'Industrial Grade', 'Mil-Spec Grade', 'High Grade', 'Restricted', 'Remarkable',
  'Classified', 'Exotic', 'Covert', 'Extraordinary', 'Contraband', 'Distinguished', 'Superior', 'Master'
]
const rarityRank = (m?: ItemMeta) => RARITY_ORDER.indexOf(m?.rarity ?? '')

const GUN_TYPES = new Set(['pistol', 'rifle', 'smg', 'shotgun', 'sniper_rifle', 'machinegun'])
const money = (n: number) => `$${n.toLocaleString('en-US')}`
const MAX_RELATED = 24

export function statsFor(className: string): WeaponStats | null {
  return WEAPON_STATS[className] ?? null
}

/** stat rows for a gun (price, kill award, damage …); grenades and the Zeus get the few that apply */
export function weaponStatRows(className: string): InfoRow[] {
  const s = statsFor(className)
  if (!s) return []
  const rows: InfoRow[] = []
  if (s.price > 0) rows.push({ label: 'Price', value: money(s.price) })
  if (GUN_TYPES.has(s.type) || s.type === 'taser') rows.push({ label: 'Kill award', value: money(s.killAward) })
  if (!GUN_TYPES.has(s.type)) return rows
  rows.push(
    { label: 'Damage', value: s.bullets > 1 ? `${s.damage} × ${s.bullets} pellets` : String(s.damage) },
    { label: 'Fire rate', value: `${s.rpm} RPM${s.fullAuto ? ' (auto)' : ''}` },
    { label: 'Magazine', value: `${s.clip} / ${s.reserve}` },
    { label: 'Armor penetration', value: `${s.armorPen}%` },
    { label: 'Headshot', value: `× ${s.headshot}` },
    { label: 'Range modifier', value: String(s.rangeModifier) },
    { label: 'Move speed', value: `${s.speed} u/s` }
  )
  return rows
}

/** one line for chat ("$2,700 · kill $300 · 36 dmg · 600 RPM · 30/90 · 78% armor pen"), '' when unknown */
export function weaponStatLine(className: string): string {
  const s = statsFor(className)
  if (!s) return ''
  if (!GUN_TYPES.has(s.type)) return s.price > 0 ? money(s.price) : ''
  const dmg = s.bullets > 1 ? `${s.damage}×${s.bullets}` : String(s.damage)
  return `${money(s.price)} · kill ${money(s.killAward)} · ${dmg} dmg · ${s.rpm} RPM · ${s.clip}/${s.reserve} · ${s.armorPen}% armor pen`
}

/** "Classified · The Phoenix Collection" for chat and the K window heading */
export function metaLine(m?: ItemMeta): string {
  if (!m) return ''
  return [m.rarity, m.collections?.[0] ?? m.crates?.[0]].filter(Boolean).join(' · ')
}

const metaRows = (m: ItemMeta | undefined, rows: InfoRow[]) => {
  if (!m) return
  if (m.rarity) rows.push({ label: 'Rarity', value: m.rarity })
  if (m.effect) rows.push({ label: 'Effect', value: m.effect })
  if (m.collections?.length) rows.push({ label: m.collections.length > 1 ? 'Collections' : 'Collection', value: m.collections.join(', ') })
  if (m.crates?.length) rows.push({ label: m.crates.length > 1 ? 'Found in' : 'Found in', value: m.crates.join(', ') })
}

const weaponName = (w: CatalogWeapon | undefined) => (w?.name ?? 'Unknown').replace(/^★\s*/, '')

function skinRelated(c: Catalog, skin: CatalogSkin): ItemInfo['related'] {
  const weapons = new Map(c.weapons.map((w) => [w.defIndex, w]))
  const asItem = (s: CatalogSkin): RelatedItem => ({
    name: `${weaponName(weapons.get(s.defIndex))} | ${s.name}`,
    image: s.image,
    rarityColor: s.rarityColor,
    ref: { kind: 'skin', id: s.id }
  })
  const out: ItemInfo['related'] = []
  const col = skin.meta?.collections?.[0]
  if (col) {
    const same = c.skins.filter((s) => s.id !== skin.id && s.meta?.collections?.includes(col))
    same.sort((a, b) => rarityRank(b.meta) - rarityRank(a.meta) || a.name.localeCompare(b.name))
    if (same.length) out.push({ title: `Also in ${col}`, items: same.slice(0, MAX_RELATED).map(asItem) })
  }
  const other = c.skins.filter((s) => s.defIndex === skin.defIndex && s.id !== skin.id)
  other.sort((a, b) => rarityRank(b.meta) - rarityRank(a.meta) || a.name.localeCompare(b.name))
  if (other.length) out.push({ title: `Other ${weaponName(weapons.get(skin.defIndex))} finishes`, items: other.slice(0, MAX_RELATED).map(asItem) })
  return out
}

function sameGroup<T extends { defIndex: number; name: string; image: string; rarityColor: string }>(
  list: T[],
  self: T,
  match: (x: T) => boolean,
  kind: Exclude<InfoKind, 'skin'>,
  title: string
): ItemInfo['related'] {
  const items = list
    .filter((x) => x.defIndex !== self.defIndex && match(x))
    .slice(0, MAX_RELATED)
    .map((x) => ({ name: x.name, image: x.image, rarityColor: x.rarityColor, ref: { kind, def: x.defIndex } as InfoRef }))
  return items.length ? [{ title, items }] : []
}

export function itemInfo(c: Catalog, ref: InfoRef): ItemInfo | null {
  const rows: InfoRow[] = []
  switch (ref.kind) {
    case 'skin': {
      const s = c.skins.find((x) => x.id === ref.id)
      if (!s) return null
      const w = c.weapons.find((x) => x.defIndex === s.defIndex)
      rows.push({ label: 'Weapon', value: weaponName(w) })
      metaRows(s.meta, rows)
      rows.push({ label: 'Wear range', value: `${s.minFloat.toFixed(2)}–${s.maxFloat.toFixed(2)} (${wearSpan(s.minFloat, s.maxFloat)})` })
      rows.push({ label: 'StatTrak™', value: s.stattrak ? 'Available' : 'No' })
      if (s.meta?.souvenir) rows.push({ label: 'Souvenir', value: 'Available' })
      rows.push({ label: 'Paint kit', value: String(s.paintKit) })
      if (s.legacyModel) rows.push({ label: 'Model', value: 'Legacy (CS:GO) model' })
      if (w) rows.push(...weaponStatRows(w.className))
      return {
        kind: 'skin',
        title: `${weaponName(w)} | ${s.name}`,
        subtitle: [s.meta?.rarity, w?.category].filter(Boolean).join(' · '),
        image: s.image,
        rarityColor: s.rarityColor,
        rows,
        flavor: s.meta?.flavor,
        related: skinRelated(c, s)
      }
    }
    case 'weapon': {
      const w = c.weapons.find((x) => x.defIndex === ref.def)
      if (!w) return null
      const skins = c.skins.filter((s) => s.defIndex === w.defIndex)
      rows.push({ label: 'Category', value: w.category }, { label: 'Class', value: w.className }, { label: 'Finishes', value: String(skins.length) })
      rows.push(...weaponStatRows(w.className))
      skins.sort((a, b) => rarityRank(b.meta) - rarityRank(a.meta) || a.name.localeCompare(b.name))
      return {
        kind: 'weapon',
        title: weaponName(w),
        subtitle: w.category,
        image: w.image ?? skins[0]?.image ?? '',
        rarityColor: '#b0c3d9',
        rows,
        related: skins.length
          ? [{ title: 'Finishes', items: skins.slice(0, MAX_RELATED).map((s) => ({ name: s.name, image: s.image, rarityColor: s.rarityColor, ref: { kind: 'skin', id: s.id } })) }]
          : []
      }
    }
    case 'agent': {
      const a = c.agents.find((x) => x.defIndex === ref.def)
      if (!a) return null
      rows.push({ label: 'Side', value: a.team === 't' ? 'Terrorist' : 'Counter-Terrorist' })
      metaRows(a.meta, rows)
      const col = a.meta?.collections?.[0]
      return {
        kind: 'agent', title: a.name, subtitle: [a.meta?.rarity, 'Agent'].filter(Boolean).join(' · '), image: a.image, rarityColor: a.rarityColor, rows,
        flavor: a.meta?.flavor,
        related: col
          ? sameGroup(c.agents, a, (x) => !!x.meta?.collections?.includes(col), 'agent', `Also in ${col}`)
          : sameGroup(c.agents, a, (x) => x.team === a.team, 'agent', 'Same side')
      }
    }
    case 'sticker': {
      const s = c.stickers.find((x) => x.defIndex === ref.def)
      if (!s) return null
      rows.push({ label: 'Type', value: s.type })
      if (s.event) rows.push({ label: 'Event', value: s.event })
      metaRows(s.meta, rows)
      const capsule = s.meta?.crates?.[0]
      return {
        kind: 'sticker', title: s.name, subtitle: ['Sticker', s.meta?.rarity].filter(Boolean).join(' · '), image: s.image, rarityColor: s.rarityColor, rows,
        related: s.event
          ? sameGroup(c.stickers, s, (x) => x.event === s.event, 'sticker', `More from ${s.event}`)
          : capsule
            ? sameGroup(c.stickers, s, (x) => !!x.meta?.crates?.includes(capsule), 'sticker', `Also in ${capsule}`)
            : []
      }
    }
    case 'keychain': {
      const k = c.keychains.find((x) => x.defIndex === ref.def)
      if (!k) return null
      metaRows(k.meta, rows)
      const col = k.meta?.collections?.[0]
      return {
        kind: 'keychain', title: k.name, subtitle: ['Charm', k.meta?.rarity].filter(Boolean).join(' · '), image: k.image, rarityColor: k.rarityColor, rows,
        related: col ? sameGroup(c.keychains, k, (x) => !!x.meta?.collections?.includes(col), 'keychain', `Also in ${col}`) : []
      }
    }
    case 'pin': {
      const p = c.pins.find((x) => x.defIndex === ref.def)
      if (!p) return null
      rows.push({ label: 'Type', value: p.type })
      metaRows(p.meta, rows)
      return {
        kind: 'pin', title: p.name, subtitle: p.type, image: p.image, rarityColor: p.rarityColor, rows, flavor: p.meta?.flavor,
        related: sameGroup(c.pins, p, (x) => x.type === p.type, 'pin', `More: ${p.type}`)
      }
    }
    case 'music': {
      const m = c.musicKits.find((x) => x.defIndex === ref.def)
      if (!m) return null
      const [artist, ...title] = m.name.split(', ')
      rows.push({ label: 'Artist', value: artist }, { label: 'Title', value: title.join(', ') || '–' })
      metaRows(m.meta, rows)
      return {
        kind: 'music', title: m.name, subtitle: ['Music kit', m.meta?.rarity].filter(Boolean).join(' · '), image: m.image, rarityColor: m.rarityColor, rows,
        flavor: m.meta?.flavor,
        related: sameGroup(c.musicKits, m, (x) => x.name.startsWith(artist + ','), 'music', `More by ${artist}`)
      }
    }
    case 'graffiti': {
      const g = c.graffiti.find((x) => x.defIndex === ref.def)
      if (!g) return null
      const tints = Object.keys(g.tints).length
      rows.push({ label: 'Colours', value: tints ? `${tints} tints` : 'Fixed colours' })
      metaRows(g.meta, rows)
      const crate = g.meta?.crates?.[0]
      return {
        kind: 'graffiti', title: g.name, subtitle: ['Graffiti', g.meta?.rarity].filter(Boolean).join(' · '), image: g.image, rarityColor: g.rarityColor, rows,
        related: crate ? sameGroup(c.graffiti, g, (x) => !!x.meta?.crates?.includes(crate), 'graffiti', `Also in ${crate}`) : []
      }
    }
  }
}
