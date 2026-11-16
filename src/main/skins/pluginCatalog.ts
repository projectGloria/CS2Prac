import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Catalog } from '@shared/skins'
import { pluginConfigDir } from './loadoutStore'

/**
 * Compact item list for the PracSkins in-game menu (configs/plugins/PracSkins/catalog.json).
 * Mirrors PluginCatalog in plugin/PracSkins/Catalog.cs. Keep both in sync.
 */
export interface PluginCatalog {
  fetchedAt: number
  weapons: { def: number; cls: string; name: string; kind: 'weapon' | 'knife' | 'glove' }[]
  /** by weapon def index */
  skins: Record<string, { paint: number; name: string; min: number; max: number; legacy: boolean }[]>
  agents: { def: number; name: string; team: 't' | 'ct'; model: string }[]
  stickers: { def: number; name: string }[]
  keychains: { def: number; name: string }[]
  pins: { def: number; name: string }[]
  musicKits: { def: number; name: string }[]
}

export function toPluginCatalog(c: Catalog): PluginCatalog {
  const skins: PluginCatalog['skins'] = {}
  for (const s of c.skins)
    (skins[s.defIndex] ??= []).push({ paint: s.paintKit, name: s.name, min: s.minFloat, max: s.maxFloat, legacy: s.legacyModel })
  return {
    fetchedAt: c.fetchedAt,
    weapons: c.weapons.map((w) => ({ def: w.defIndex, cls: w.className, name: w.name.replace(/^★\s*/, ''), kind: w.kind })),
    skins,
    agents: (c.agents ?? []).map((a) => ({ def: a.defIndex, name: a.name, team: a.team, model: a.model })),
    stickers: (c.stickers ?? []).map((s) => ({ def: s.defIndex, name: s.event && !s.name.includes(s.event) ? `${s.name} (${s.event})` : s.name })),
    keychains: (c.keychains ?? []).map((k) => ({ def: k.defIndex, name: k.name })),
    pins: (c.pins ?? []).map((p) => ({ def: p.defIndex, name: p.name })),
    musicKits: (c.musicKits ?? []).map((m) => ({ def: m.defIndex, name: m.name }))
  }
}

/** Writes catalog.json unless the same catalog version is already there. */
export async function exportPluginCatalog(csgoDir: string, c: Catalog): Promise<boolean> {
  if (!existsSync(join(csgoDir, 'addons', 'counterstrikesharp'))) return false
  const dir = pluginConfigDir(csgoDir)
  const file = join(dir, 'catalog.json')
  try {
    const head = (await readFile(file, 'utf8')).slice(0, 40)
    if (head.includes(`"fetchedAt":${c.fetchedAt}`)) return false
  } catch {
    /* not written yet */
  }
  await mkdir(dir, { recursive: true })
  await writeFile(file, JSON.stringify(toPluginCatalog(c)))
  return true
}
