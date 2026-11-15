import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { bundledCatalogFile } from '../setup/bundle'
import {
  CATALOG_VERSION,
  type Catalog,
  type CatalogAgent,
  type CatalogKeychain,
  type CatalogSkin,
  type CatalogSticker,
  type CatalogWeapon,
  type WeaponKind
} from '@shared/skins'

const API = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/'
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Subset of the CSGO-API shapes we rely on. */
export interface ApiSkin {
  id: string
  name: string
  weapon: { id: string; weapon_id: number; name: string }
  category: { name: string }
  pattern?: { name: string } | null
  phase?: string | null
  min_float: number | null
  max_float: number | null
  rarity?: { color: string } | null
  stattrak: boolean
  legacy_model?: boolean
  paint_index: string | null
  image: string
}

export interface ApiBaseWeapon {
  id: string // "base_weapon-weapon_ak47"
  name: string
  def_index: number | string
  category: { name: string }
  image: string
}

export interface ApiAgent {
  name: string
  def_index: string | number
  team?: { id: string } | null
  model_player?: string | null
  image: string
  rarity?: { color: string } | null
}

export interface ApiSticker {
  name: string
  def_index: string | number
  type?: string | null
  tournament?: { name: string } | null
  image: string
  rarity?: { color: string } | null
}

export interface ApiKeychain {
  name: string
  def_index: string | number
  image: string
  rarity?: { color: string } | null
}

export interface ApiExtras {
  agents: ApiAgent[]
  stickers: ApiSticker[]
  keychains: ApiKeychain[]
}

const defOf = (v: string | number) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}
const GREY = '#b0c3d9'

export function buildAgents(raw: ApiAgent[]): CatalogAgent[] {
  const out: CatalogAgent[] = []
  for (const a of raw) {
    const defIndex = defOf(a.def_index)
    const team = a.team?.id === 'terrorists' ? 't' : a.team?.id === 'counter-terrorists' ? 'ct' : null
    if (!defIndex || !team || !a.model_player?.endsWith('.vmdl')) continue
    out.push({ defIndex, name: a.name, team, model: a.model_player, image: a.image, rarityColor: a.rarity?.color ?? GREY })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function buildStickers(raw: ApiSticker[]): CatalogSticker[] {
  const out: CatalogSticker[] = []
  for (const s of raw) {
    const defIndex = defOf(s.def_index)
    if (!defIndex || !s.image) continue
    out.push({
      defIndex,
      name: s.name.replace(/^Sticker \| /, ''),
      image: s.image,
      rarityColor: s.rarity?.color ?? GREY,
      type: s.type ?? 'Other',
      event: s.tournament?.name ?? null
    })
  }
  return out
}

export function buildKeychains(raw: ApiKeychain[]): CatalogKeychain[] {
  const out: CatalogKeychain[] = []
  for (const k of raw) {
    const defIndex = defOf(k.def_index)
    if (!defIndex || !k.image) continue
    out.push({ defIndex, name: k.name.replace(/^Charm \| /, ''), image: k.image, rarityColor: k.rarity?.color ?? GREY })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

const kindOf = (category: string): WeaponKind =>
  category === 'Knives' ? 'knife' : category === 'Gloves' ? 'glove' : 'weapon'

/** Default knives every player has; they are the "no custom knife" option, not something to pick. */
const DEFAULT_KNIVES = new Set(['weapon_knife', 'weapon_knife_t'])

export function buildCatalog(
  skinsRaw: ApiSkin[],
  baseRaw: ApiBaseWeapon[],
  fetchedAt = Date.now(),
  extras: ApiExtras = { agents: [], stickers: [], keychains: [] }
): Catalog {
  const skins: CatalogSkin[] = []
  for (const s of skinsRaw) {
    const paintKit = Number(s.paint_index)
    // Vanilla knife entries have no paint index; vanilla is offered as paint kit 0 instead.
    if (!s.paint_index || !Number.isInteger(paintKit) || paintKit <= 0) continue
    const finish = s.pattern?.name ?? s.name.split('|')[1]?.trim() ?? s.name
    skins.push({
      id: s.id,
      defIndex: s.weapon.weapon_id,
      name: s.phase ? `${finish} (${s.phase})` : finish,
      paintKit,
      minFloat: s.min_float ?? 0,
      maxFloat: s.max_float ?? 1,
      rarityColor: s.rarity?.color ?? '#b0c3d9',
      image: s.image,
      stattrak: s.stattrak,
      legacyModel: !!s.legacy_model
    })
  }
  const skinned = new Set(skins.map((s) => s.defIndex))

  const weapons = new Map<number, CatalogWeapon>()
  for (const b of baseRaw) {
    const defIndex = Number(b.def_index)
    const className = b.id.replace(/^base_weapon-/, '')
    if (!Number.isInteger(defIndex) || DEFAULT_KNIVES.has(className)) continue
    const kind = kindOf(b.category.name)
    // Skip things that can't wear a skin (C4, grenades) – knives stay since they can be vanilla.
    if (kind !== 'knife' && !skinned.has(defIndex)) continue
    weapons.set(defIndex, { defIndex, className, name: b.name, category: b.category.name, kind, image: b.image ?? null })
  }

  // Gloves (and anything else missing from base_weapons) come only from the skins list.
  for (const s of skinsRaw) {
    const defIndex = s.weapon.weapon_id
    if (weapons.has(defIndex) || !skinned.has(defIndex)) continue
    if (s.weapon.id.startsWith('sfui_')) continue // HUD alias ids; never a real class name
    weapons.set(defIndex, {
      defIndex,
      className: s.weapon.id,
      name: s.weapon.name,
      category: s.category.name,
      kind: kindOf(s.category.name),
      image: s.image
    })
  }

  const sortedWeapons = [...weapons.values()].sort(
    (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)
  )
  skins.sort((a, b) => a.name.localeCompare(b.name))
  return {
    version: CATALOG_VERSION,
    fetchedAt,
    weapons: sortedWeapons,
    skins,
    agents: buildAgents(extras.agents),
    stickers: buildStickers(extras.stickers),
    keychains: buildKeychains(extras.keychains)
  }
}

const cacheFile = () => join(app.getPath('userData'), 'catalog-cache.json')

async function readCache(): Promise<Catalog | null> {
  try {
    const c = JSON.parse(await readFile(cacheFile(), 'utf8')) as Catalog
    return c.version === CATALOG_VERSION ? c : null
  } catch {
    return null
  }
}

async function fetchJson<T>(file: string): Promise<T> {
  const res = await fetch(API + file)
  if (!res.ok) throw new Error(`Skin data download failed (${res.status}) for ${file}`)
  return (await res.json()) as T
}

let memo: Catalog | null = null

/** The catalog without any download: memory, then the disk cache (may be stale or missing). */
export async function cachedCatalog(): Promise<Catalog | null> {
  return memo ?? (await readCache())
}

/** Returns the cached catalog, refreshing it when it's older than a week (or when forced). */
export async function getCatalog(refresh = false): Promise<Catalog> {
  if (memo && !refresh && Date.now() - memo.fetchedAt < CACHE_TTL_MS) return memo
  const cached = refresh ? null : await readCache()
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return (memo = cached)
  try {
    const [skins, base, agents, stickers, keychains] = await Promise.all([
      fetchJson<ApiSkin[]>('skins.json'),
      fetchJson<ApiBaseWeapon[]>('base_weapons.json'),
      fetchJson<ApiAgent[]>('agents.json'),
      fetchJson<ApiSticker[]>('stickers.json'),
      fetchJson<ApiKeychain[]>('keychains.json')
    ])
    memo = buildCatalog(skins, base, Date.now(), { agents, stickers, keychains })
    await writeFile(cacheFile(), JSON.stringify(memo))
    return memo
  } catch (e) {
    const stale = memo ?? (await readCache())
    if (stale) return stale // offline: use the old data rather than failing
    const bundled = await bundledCatalog()
    if (bundled) return (memo = bundled)
    throw e
  }
}

/**
 * The skin data snapshot shipped with the app, for a first start without internet. It counts as an hour from
 * expiring, so the app tries to download fresh data again soon.
 */
async function bundledCatalog(): Promise<Catalog | null> {
  const files = ['skins.json', 'base_weapons.json', 'agents.json', 'stickers.json', 'keychains.json'].map(bundledCatalogFile)
  if (files.some((f) => !f)) return null
  try {
    const [skins, base, agents, stickers, keychains] = await Promise.all(
      files.map(async (f) => JSON.parse(gunzipSync(await readFile(f!)).toString('utf8')))
    )
    const c = buildCatalog(skins, base, Date.now() - CACHE_TTL_MS + 60 * 60 * 1000, { agents, stickers, keychains })
    await writeFile(cacheFile(), JSON.stringify(c))
    return c
  } catch {
    return null
  }
}
