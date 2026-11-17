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

/** a profile display item: pins, coins, medals, trophies (InventoryServices.Rank[5]) */
export interface CatalogPin {
  defIndex: number
  name: string
  image: string
  rarityColor: string
  /** Pin, Service Medal, Operation Coin … */
  type: string
}

export interface CatalogMusicKit {
  defIndex: number
  /** "Artist, Title" without the "Music Kit | " prefix */
  name: string
  image: string
  rarityColor: string
}

/** a graffiti pattern (sticker kit def index); tinted ones come in GRAFFITI_TINTS colours, each with its own image */
export interface CatalogGraffiti {
  defIndex: number
  /** without the "Sealed Graffiti | " prefix and the tint */
  name: string
  /** untinted image, or the first tint's for tinted graffiti */
  image: string
  rarityColor: string
  /** tint id -> image; empty for graffiti that has no tints */
  tints: Record<string, string>
}

/** graffiti tints (items_game graffiti_tints ids 1-19) */
export const GRAFFITI_TINTS: { id: number; name: string; color: string }[] = [
  { id: 1, name: 'Brick Red', color: '#874444' },
  { id: 2, name: 'Blood Red', color: '#b14d4d' },
  { id: 3, name: 'Tiger Orange', color: '#b87148' },
  { id: 4, name: 'Dust Brown', color: '#8f7d5d' },
  { id: 5, name: 'Desert Amber', color: '#ae833d' },
  { id: 6, name: 'Tracer Yellow', color: '#d4c95b' },
  { id: 7, name: 'Battle Green', color: '#789d53' },
  { id: 8, name: 'Jungle Green', color: '#417a4a' },
  { id: 9, name: 'Frog Green', color: '#488f80' },
  { id: 10, name: 'Cash Green', color: '#a6c4a5' },
  { id: 11, name: 'Wire Blue', color: '#6ba5b2' },
  { id: 12, name: 'Monarch Blue', color: '#4e7fa9' },
  { id: 13, name: 'SWAT Blue', color: '#4c5b98' },
  { id: 14, name: 'Violent Violet', color: '#af92df' },
  { id: 15, name: 'Monster Purple', color: '#6e4f9f' },
  { id: 16, name: 'Bazooka Pink', color: '#ba68b2' },
  { id: 17, name: 'Princess Pink', color: '#9d567a' },
  { id: 18, name: 'War Pig Pink', color: '#e4ccd5' },
  { id: 19, name: 'Shark White', color: '#c1c1c1' }
]

export const CATALOG_VERSION = 6

export interface Catalog {
  version: number
  fetchedAt: number
  weapons: CatalogWeapon[]
  skins: CatalogSkin[]
  agents: CatalogAgent[]
  stickers: CatalogSticker[]
  keychains: CatalogKeychain[]
  pins: CatalogPin[]
  musicKits: CatalogMusicKit[]
  graffiti: CatalogGraffiti[]
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
  /** profile display item def index (scoreboard pin/coin), 0 = none */
  pin: number
  /** music kit def index, 0 = none */
  musicKit: number
  /** graffiti sticker kit def index (0 = none) and tint id (0 = none, 1-19) */
  graffiti: number
  graffitiTint: number
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
  return { id, name, weapons: { t: {}, ct: {} }, knife: { t: null, ct: null }, gloves: { t: null, ct: null }, agents: { t: null, ct: null }, pin: 0, musicKit: 0, graffiti: 0, graffitiTint: 0 }
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
  return {
    ...p,
    weapons: perTeamWeapons(p.weapons),
    agents: p.agents ?? { t: null, ct: null },
    pin: Number.isInteger(p.pin) && p.pin > 0 ? p.pin : 0,
    musicKit: Number.isInteger(p.musicKit) && p.musicKit > 0 ? p.musicKit : 0,
    graffiti: Number.isInteger(p.graffiti) && p.graffiti > 0 ? p.graffiti : 0,
    graffitiTint: Number.isInteger(p.graffitiTint) && p.graffitiTint > 0 && p.graffitiTint <= 19 ? p.graffitiTint : 0
  }
}

export const emptySticker = (defIndex: number): StickerSel => ({ defIndex, wear: 0, scale: 1, rotation: 0, x: 0, y: 0 })
export const emptyKeychain = (defIndex: number): KeychainSel => ({ defIndex, x: 0, y: 0, z: 0, seed: 0 })

/** A weapon selection with nothing on it can be dropped. */
export function isEmptySel(s: SkinSel): boolean {
  return s.paintKit <= 0 && !s.stickers?.some(Boolean) && !s.keychain && s.statTrak == null && !s.nameTag
}
