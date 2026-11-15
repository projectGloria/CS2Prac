// ---------- catalog (built from ByMykel/CSGO-API) ----------

export type WeaponKind = 'weapon' | 'knife' | 'glove'

export interface CatalogWeapon {
  defIndex: number
  /** e.g. weapon_ak47, weapon_knife_karambit, sporty_gloves */
  className: string
  name: string
  /** Pistols, Rifles, SMGs, Heavy, Equipment, Knives, Gloves */
  category: string
  kind: WeaponKind
  image: string | null
}

export interface CatalogSkin {
  id: string
  defIndex: number
  /** finish name, including Doppler phase if any, e.g. "Doppler (Phase 2)" */
  name: string
  paintKit: number
  minFloat: number
  maxFloat: number
  rarityColor: string
  image: string
  stattrak: boolean
  /** uses the old CS:GO model, which needs a different body group in-game */
  legacyModel: boolean
}

export const CATALOG_VERSION = 2

export interface Catalog {
  version: number
  fetchedAt: number
  weapons: CatalogWeapon[]
  skins: CatalogSkin[]
}

// ---------- loadout (what the user picks) ----------

export interface SkinSel {
  paintKit: number
  wear: number
  seed: number
  /** kill count, or null for no StatTrak */
  statTrak: number | null
  nameTag: string
  legacyModel?: boolean
}

export interface KnifeSel extends SkinSel {
  defIndex: number
  className: string
}

export interface GloveSel {
  defIndex: number
  paintKit: number
  wear: number
  seed: number
}

export type Team = 't' | 'ct'

export interface Profile {
  id: string
  name: string
  /** keyed by weapon def index */
  weapons: Record<string, SkinSel>
  knife: Record<Team, KnifeSel | null>
  gloves: Record<Team, GloveSel | null>
}

export interface LoadoutStore {
  activeId: string
  /** SteamID64 that gets the skins, or null for every player (bots included) */
  owner: string | null
  profiles: Profile[]
}

export interface SteamAccount {
  steamId: string
  personaName: string
  mostRecent: boolean
}

// ---------- helpers ----------

export const WEARS = [
  { name: 'Factory New', short: 'FN', max: 0.07 },
  { name: 'Minimal Wear', short: 'MW', max: 0.15 },
  { name: 'Field-Tested', short: 'FT', max: 0.38 },
  { name: 'Well-Worn', short: 'WW', max: 0.45 },
  { name: 'Battle-Scarred', short: 'BS', max: 1 }
] as const

export const wearName = (w: number) => (WEARS.find((x) => w < x.max) ?? WEARS[WEARS.length - 1]).name

export const MAX_SEED = 1000
export const MAX_NAMETAG = 20

export function emptyProfile(id: string, name: string): Profile {
  return { id, name, weapons: {}, knife: { t: null, ct: null }, gloves: { t: null, ct: null } }
}
