import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The tools shipped inside the installer (scripts/bundle.mjs fills resources/bundle at build time): the pinned
 * Metamod, CounterStrikeSharp and MatchZy zips and a skin data snapshot, so setup works without downloading.
 */
export type BundledTool = 'metamod' | 'counterstrikesharp' | 'matchzy'

interface Manifest {
  versions: Partial<Record<BundledTool, string>>
  catalogDate?: number
}

export function bundleDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'bundle') : join(app.getAppPath(), 'resources', 'bundle')
}

function manifest(): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(bundleDir(), 'manifest.json'), 'utf8')) as Manifest
  } catch {
    return null
  }
}

/** The bundled zip of a tool, if the bundle has exactly that version. */
export function bundledZip(tool: BundledTool, version: string): string | null {
  const file = join(bundleDir(), `${tool}.zip`)
  return manifest()?.versions[tool] === version && existsSync(file) ? file : null
}

/** The bundled skin data snapshot: a gzipped CSGO-API file and when it was taken. */
export function bundledCatalogFile(name: string): string | null {
  const file = join(bundleDir(), 'catalog', name + '.gz')
  return existsSync(file) ? file : null
}

export const bundledCatalogDate = (): number | null => manifest()?.catalogDate ?? null
