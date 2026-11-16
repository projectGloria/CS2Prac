import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  emptyProfile,
  MAX_NAMETAG,
  MAX_SEED,
  normalizeProfile,
  perTeamWeapons,
  STICKER_SLOTS,
  type AgentSel,
  type GloveSel,
  type KeychainSel,
  type KnifeSel,
  type LoadoutStore,
  type Profile,
  type SkinSel,
  type StickerSel,
  type Team
} from '@shared/skins'

const storeFile = () => join(app.getPath('userData'), 'loadouts.json')

export function defaultStore(owner: string | null): LoadoutStore {
  const p = emptyProfile(randomUUID(), 'Default')
  return { activeId: p.id, owner, profiles: [p] }
}

export async function loadStore(defaultOwner: () => Promise<string | null>): Promise<LoadoutStore> {
  try {
    const s = JSON.parse(await readFile(storeFile(), 'utf8')) as LoadoutStore
    if (s.profiles?.length) return { ...s, profiles: s.profiles.map(normalizeProfile) }
  } catch {
    /* first run */
  }
  return defaultStore(await defaultOwner())
}

export async function saveStore(s: LoadoutStore): Promise<void> {
  if (!s.profiles.length) throw new Error('At least one profile is required')
  if (!s.profiles.some((p) => p.id === s.activeId)) s.activeId = s.profiles[0].id
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(storeFile(), JSON.stringify(s, null, 2))
}

// ---------- export for the PracSkins server plugin ----------

/** The file the C# plugin reads. Keep in sync with plugin/PracSkins. */
export interface LoadoutFile {
  /** 3: weapons per team. 2 (read only): one weapon map for both teams. */
  schema: 3
  owner: string | null
  weapons: Record<Team, Record<string, WeaponOut>>
  knife: Record<Team, (PaintOut & { defIndex: number; className: string }) | null>
  gloves: Record<Team, GloveOut | null>
  agents: Record<Team, AgentSel | null>
  /** every agent model, precached by the plugin at map load */
  precache: string[]
}
interface WeaponOut extends PaintOut {
  /** always STICKER_SLOTS entries; null = empty slot */
  stickers: (StickerSel | null)[]
  keychain: KeychainSel | null
}
interface PaintOut {
  paintKit: number
  wear: number
  seed: number
  /** -1 means no StatTrak */
  statTrak: number
  nameTag: string
  legacyModel: boolean
}
interface GloveOut {
  defIndex: number
  paintKit: number
  wear: number
  seed: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo))
const int = (v: number, lo: number, hi: number) => Math.round(clamp(v, lo, hi))

function paint(s: SkinSel): PaintOut {
  return {
    paintKit: int(s.paintKit, 0, 100_000),
    wear: clamp(s.wear, 0, 1),
    seed: int(s.seed, 0, MAX_SEED),
    statTrak: s.statTrak == null ? -1 : int(s.statTrak, 0, 999_999),
    nameTag: (s.nameTag ?? '').slice(0, MAX_NAMETAG),
    legacyModel: !!s.legacyModel
  }
}

function sticker(s: StickerSel | null | undefined): StickerSel | null {
  if (!s || !(s.defIndex > 0)) return null
  return {
    defIndex: int(s.defIndex, 1, 1_000_000),
    wear: clamp(s.wear, 0, 1),
    scale: clamp(s.scale ?? 1, 0.1, 3),
    rotation: clamp(s.rotation ?? 0, -360, 360),
    x: clamp(s.x ?? 0, -2, 2),
    y: clamp(s.y ?? 0, -2, 2)
  }
}

function keychain(k: KeychainSel | null | undefined): KeychainSel | null {
  if (!k || !(k.defIndex > 0)) return null
  return {
    defIndex: int(k.defIndex, 1, 1_000_000),
    x: clamp(k.x ?? 0, -10, 10),
    y: clamp(k.y ?? 0, -10, 10),
    z: clamp(k.z ?? 0, -10, 10),
    seed: int(k.seed ?? 0, 0, 100_000)
  }
}

function weapon(s: SkinSel): WeaponOut | null {
  const stickers = Array.from({ length: STICKER_SLOTS }, (_, i) => sticker(s.stickers?.[i]))
  const out = { ...paint(s), stickers, keychain: keychain(s.keychain) }
  return out.paintKit > 0 || stickers.some(Boolean) || out.keychain ? out : null
}

const agent = (a: AgentSel | null | undefined): AgentSel | null =>
  a && a.defIndex > 0 && MODEL.test(a.model) ? { defIndex: a.defIndex, model: a.model } : null

const knife = (k: KnifeSel | null) =>
  k && /^weapon_(knife|bayonet)/.test(k.className) ? { ...paint(k), defIndex: k.defIndex, className: k.className } : null

const glove = (g: GloveSel | null): GloveOut | null =>
  g && g.paintKit > 0
    ? { defIndex: g.defIndex, paintKit: int(g.paintKit, 1, 100_000), wear: clamp(g.wear, 0, 1), seed: int(g.seed, 0, MAX_SEED) }
    : null

const MODEL = /^[\w/.-]+\.vmdl$/

export function toLoadoutFile(profile: Profile, owner: string | null, precache: string[] = []): LoadoutFile {
  const weapons: LoadoutFile['weapons'] = { t: {}, ct: {} }
  const byTeam = perTeamWeapons(profile.weapons)
  for (const team of ['t', 'ct'] as Team[])
    for (const [def, sel] of Object.entries(byTeam[team])) {
      const w = /^\d+$/.test(def) ? weapon(sel) : null
      if (w) weapons[team][def] = w
    }
  return {
    schema: 3,
    owner: owner && /^\d{17}$/.test(owner) ? owner : null,
    weapons,
    knife: { t: knife(profile.knife.t), ct: knife(profile.knife.ct) },
    gloves: { t: glove(profile.gloves.t), ct: glove(profile.gloves.ct) },
    agents: { t: agent(profile.agents?.t), ct: agent(profile.agents?.ct) },
    precache: [...new Set(precache.filter((m) => MODEL.test(m)))]
  }
}

export const pluginConfigDir = (csgoDir: string) =>
  join(csgoDir, 'addons', 'counterstrikesharp', 'configs', 'plugins', 'PracSkins')

/** Writes loadout.json for the active profile. Returns false when CounterStrikeSharp isn't installed yet. */
export async function exportLoadout(csgoDir: string, store: LoadoutStore, precache: string[] = []): Promise<boolean> {
  if (!existsSync(join(csgoDir, 'addons', 'counterstrikesharp'))) return false
  const profile = store.profiles.find((p) => p.id === store.activeId) ?? store.profiles[0]
  const dir = pluginConfigDir(csgoDir)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'loadout.json'), JSON.stringify(toLoadoutFile(profile, store.owner, precache), null, 2))
  return true
}

// ---------- import (the in-game menu edits loadout.json) ----------

/**
 * Applies a loadout.json written by the plugin's in-game menu to a profile. Only what the file can hold is taken;
 * the profile keeps its id and name.
 */
export function fromLoadoutFile(f: LoadoutFile, profile: Profile): Profile {
  const sel = (w: PaintOut): SkinSel => ({
    paintKit: w.paintKit,
    wear: w.wear,
    seed: w.seed,
    statTrak: w.statTrak >= 0 ? w.statTrak : null,
    nameTag: w.nameTag ?? '',
    legacyModel: w.legacyModel
  })
  const weapons: Profile['weapons'] = { t: {}, ct: {} }
  const byTeam = perTeamWeapons(f.weapons) as unknown as LoadoutFile['weapons'] // schema 2: same map for both teams
  for (const team of ['t', 'ct'] as Team[])
    for (const [def, w] of Object.entries(byTeam[team])) {
      weapons[team][def] = { ...sel(w), stickers: w.stickers ?? undefined, keychain: w.keychain ?? null }
    }
  const knifeIn = (k: LoadoutFile['knife']['t']): KnifeSel | null => (k ? { ...sel(k), defIndex: k.defIndex, className: k.className } : null)
  return {
    ...profile,
    weapons,
    knife: { t: knifeIn(f.knife?.t ?? null), ct: knifeIn(f.knife?.ct ?? null) },
    gloves: { t: f.gloves?.t ?? null, ct: f.gloves?.ct ?? null },
    agents: { t: f.agents?.t ?? null, ct: f.agents?.ct ?? null }
  }
}

/** Reads loadout.json and merges it into the active profile. Returns the new store, or null if nothing changed. */
export async function importLoadoutFile(csgoDir: string, store: LoadoutStore): Promise<LoadoutStore | null> {
  const f = JSON.parse(await readFile(join(pluginConfigDir(csgoDir), 'loadout.json'), 'utf8')) as LoadoutFile
  if ((f.schema as number) !== 2 && f.schema !== 3) return null
  const active = store.profiles.find((p) => p.id === store.activeId) ?? store.profiles[0]
  const next = fromLoadoutFile(f, active)
  if (JSON.stringify(toLoadoutFile(next, store.owner)) === JSON.stringify(toLoadoutFile(active, store.owner))) return null
  return { ...store, profiles: store.profiles.map((p) => (p.id === active.id ? next : p)) }
}
