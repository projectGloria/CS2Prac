import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CATALOG_VERSION, type Catalog, type CatalogSkin, type CatalogWeapon, type WeaponKind } from '@shared/skins'

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

const kindOf = (category: string): WeaponKind =>
  category === 'Knives' ? 'knife' : category === 'Gloves' ? 'glove' : 'weapon'

/** Default knives every player has; they are the "no custom knife" option, not something to pick. */
const DEFAULT_KNIVES = new Set(['weapon_knife', 'weapon_knife_t'])

export function buildCatalog(skinsRaw: ApiSkin[], baseRaw: ApiBaseWeapon[], fetchedAt = Date.now()): Catalog {
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
  return { version: CATALOG_VERSION, fetchedAt, weapons: sortedWeapons, skins }
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

/** Returns the cached catalog, refreshing it when it's older than a week (or when forced). */
export async function getCatalog(refresh = false): Promise<Catalog> {
  if (memo && !refresh && Date.now() - memo.fetchedAt < CACHE_TTL_MS) return memo
  const cached = refresh ? null : await readCache()
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return (memo = cached)
  try {
    const [skins, base] = await Promise.all([
      fetchJson<ApiSkin[]>('skins.json'),
      fetchJson<ApiBaseWeapon[]>('base_weapons.json')
    ])
    memo = buildCatalog(skins, base)
    await writeFile(cacheFile(), JSON.stringify(memo))
    return memo
  } catch (e) {
    const stale = memo ?? (await readCache())
    if (stale) return stale // offline: use the old data rather than failing
    throw e
  }
}
