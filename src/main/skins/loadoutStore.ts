import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  emptyProfile,
  MAX_NAMETAG,
  MAX_SEED,
  type GloveSel,
  type KnifeSel,
  type LoadoutStore,
  type Profile,
  type SkinSel,
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
    if (s.profiles?.length) return s
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
  schema: 1
  owner: string | null
  weapons: Record<string, PaintOut>
  knife: Record<Team, (PaintOut & { defIndex: number; className: string }) | null>
  gloves: Record<Team, GloveOut | null>
}
interface PaintOut {
  paintKit: number
  wear: number
  seed: number
  /** -1 means no StatTrak */
  statTrak: number
  nameTag: string
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
    nameTag: (s.nameTag ?? '').slice(0, MAX_NAMETAG)
  }
}

const knife = (k: KnifeSel | null) =>
  k && /^weapon_(knife|bayonet)/.test(k.className) ? { ...paint(k), defIndex: k.defIndex, className: k.className } : null

const glove = (g: GloveSel | null): GloveOut | null =>
  g && g.paintKit > 0
    ? { defIndex: g.defIndex, paintKit: int(g.paintKit, 1, 100_000), wear: clamp(g.wear, 0, 1), seed: int(g.seed, 0, MAX_SEED) }
    : null

export function toLoadoutFile(profile: Profile, owner: string | null): LoadoutFile {
  const weapons: LoadoutFile['weapons'] = {}
  for (const [def, sel] of Object.entries(profile.weapons)) {
    if (/^\d+$/.test(def) && sel.paintKit > 0) weapons[def] = paint(sel)
  }
  return {
    schema: 1,
    owner: owner && /^\d{17}$/.test(owner) ? owner : null,
    weapons,
    knife: { t: knife(profile.knife.t), ct: knife(profile.knife.ct) },
    gloves: { t: glove(profile.gloves.t), ct: glove(profile.gloves.ct) }
  }
}

export const pluginConfigDir = (csgoDir: string) =>
  join(csgoDir, 'addons', 'counterstrikesharp', 'configs', 'plugins', 'PracSkins')

/** Writes loadout.json for the active profile. Returns false when CounterStrikeSharp isn't installed yet. */
export async function exportLoadout(csgoDir: string, store: LoadoutStore): Promise<boolean> {
  if (!existsSync(join(csgoDir, 'addons', 'counterstrikesharp'))) return false
  const profile = store.profiles.find((p) => p.id === store.activeId) ?? store.profiles[0]
  const dir = pluginConfigDir(csgoDir)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'loadout.json'), JSON.stringify(toLoadoutFile(profile, store.owner), null, 2))
  return true
}
