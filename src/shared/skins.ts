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

export interface CatalogAgent {
  defIndex: number
  name: string
  team: Team
  /** e.g. agents/models/tm_professional/tm_professional_varf5.vmdl */
  model: string
  image: string
  rarityColor: string
}

export interface CatalogSticker {
  defIndex: number
  /** without the "Sticker | " prefix */
  name: string
  image: string
  rarityColor: string
  /** Event, Team, Autograph, Other */
  type: string
  /** tournament name, if any */
  event: string | null
}

export interface CatalogKeychain {
  defIndex: number
  /** without the "Charm | " prefix */
  name: string
  image: string
  rarityColor: string
}

export const CATALOG_VERSION = 3

export interface Catalog {
  version: number
  fetchedAt: number
  weapons: CatalogWeapon[]
  skins: CatalogSkin[]
  agents: CatalogAgent[]
  stickers: CatalogSticker[]
  keychains: CatalogKeychain[]
}

// ---------- loadout (what the user picks) ----------

export const STICKER_SLOTS = 5

export interface StickerSel {
  defIndex: number
  /** 0 = pristine, 1 = fully scraped */
  wear: number
  /** 1 = default size */
  scale: number
  /** degrees */
  rotation: number
  /** placement offsets; 0,0 = the slot's default spot */
  x: number
  y: number
}

export interface KeychainSel {
  defIndex: number
  /** attachment offsets; 0 = default */
  x: number
  y: number
  z: number
  /** pattern seed */
  seed: number
}

export interface AgentSel {
  defIndex: number
  model: string
}

export interface SkinSel {
  paintKit: number
  wear: number
  seed: number
  /** kill count, or null for no StatTrak */
  statTrak: number | null
  nameTag: string
  legacyModel?: boolean
  /** STICKER_SLOTS entries, null = empty slot (weapons only) */
  stickers?: (StickerSel | null)[]
  /** weapons only */
  keychain?: KeychainSel | null
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
  /** per team, keyed by weapon def index (a skin can differ between T and CT) */
  weapons: Record<Team, Record<string, SkinSel>>
  knife: Record<Team, KnifeSel | null>
  gloves: Record<Team, GloveSel | null>
  agents: Record<Team, AgentSel | null>
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
  return { id, name, weapons: { t: {}, ct: {} }, knife: { t: null, ct: null }, gloves: { t: null, ct: null }, agents: { t: null, ct: null } }
}

/**
 * Old profiles kept one weapon map for both teams ({ "7": sel }); it now lives per team. A flat map is copied to
 * both teams, so nothing changes in game until one side is edited.
 */
export function perTeamWeapons(w: unknown): Record<Team, Record<string, SkinSel>> {
  const o = (w && typeof w === 'object' ? w : {}) as Record<string, unknown>
  const isMap = (v: unknown): v is Record<string, SkinSel> => !!v && typeof v === 'object'
  if ('t' in o || 'ct' in o) return { t: isMap(o.t) ? o.t : {}, ct: isMap(o.ct) ? o.ct : {} }
  const flat = o as Record<string, SkinSel>
  return { t: structuredClone(flat), ct: structuredClone(flat) }
}

/** Fills in fields added after a profile was saved. */
export function normalizeProfile(p: Profile): Profile {
  return { ...p, weapons: perTeamWeapons(p.weapons), agents: p.agents ?? { t: null, ct: null } }
}

export const emptySticker = (defIndex: number): StickerSel => ({ defIndex, wear: 0, scale: 1, rotation: 0, x: 0, y: 0 })
export const emptyKeychain = (defIndex: number): KeychainSel => ({ defIndex, x: 0, y: 0, z: 0, seed: 0 })

/** A weapon selection with nothing on it can be dropped. */
export function isEmptySel(s: SkinSel): boolean {
  return s.paintKit <= 0 && !s.stickers?.some(Boolean) && !s.keychain && s.statTrak == null && !s.nameTag
}
