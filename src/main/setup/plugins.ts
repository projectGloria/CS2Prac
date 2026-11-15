import { extractZip } from './unzip'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginVersions, SetupProgress } from '@shared/ipc'
import { layout } from '../paths'
import { downloadFile } from './steamcmd'
import { ensureGameinfoPatched } from './gameinfo'

const MMS_BASE = 'https://mms.alliedmods.net/mmsdrop/2.0/'
const CSS_RELEASE_API = 'https://api.github.com/repos/roflmuffin/CounterStrikeSharp/releases/latest'

const versionsFile = (csgoDir: string) => join(csgoDir, 'addons', 'cs2prac-versions.json')

export async function readPluginVersions(csgoDir: string): Promise<PluginVersions> {
  try {
    return JSON.parse(await readFile(versionsFile(csgoDir), 'utf8'))
  } catch {
    return {}
  }
}

export async function writePluginVersions(csgoDir: string, v: PluginVersions): Promise<void> {
  await writeFile(versionsFile(csgoDir), JSON.stringify(v, null, 2))
}

async function latestMetamod(): Promise<{ version: string; url: string }> {
  const res = await fetch(MMS_BASE + 'mmsource-latest-windows')
  if (!res.ok) throw new Error(`Could not look up the latest Metamod build (${res.status})`)
  const file = (await res.text()).trim()
  return { version: file.replace(/^mmsource-|-windows\.zip$/g, ''), url: MMS_BASE + file }
}

async function latestCounterStrikeSharp(): Promise<{ version: string; url: string }> {
  const res = await fetch(CSS_RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`Could not look up the latest CounterStrikeSharp release (${res.status})`)
  const rel = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] }
  const asset = rel.assets.find((a) => /^counterstrikesharp-with-runtime-windows-.*\.zip$/.test(a.name))
  if (!asset) throw new Error(`CounterStrikeSharp ${rel.tag_name} has no Windows with-runtime build`)
  return { version: rel.tag_name, url: asset.browser_download_url }
}

export async function installZip(url: string, csgoDir: string, label: string, report: (p: SetupProgress) => void) {
  const tmp = join(csgoDir, `.cs2prac-${label}.zip`)
  try {
    await downloadFile(url, tmp, (pct) =>
      report({ phase: 'plugins', percent: pct, message: `Downloading ${label}…` })
    )
    report({ phase: 'plugins', percent: null, message: `Extracting ${label}…` })
    // Both archives contain a top-level addons/ folder meant for game/csgo/.
    await extractZip(tmp, csgoDir)
  } finally {
    await rm(tmp, { force: true })
  }
}

/** Installs or updates Metamod:Source and CounterStrikeSharp, then patches gameinfo.gi. */
export async function ensurePlugins(installDir: string, report: (p: SetupProgress) => void): Promise<PluginVersions> {
  const { csgoDir } = layout(installDir)
  if (!existsSync(csgoDir)) throw new Error('Install the CS2 server before installing plugins')
  await mkdir(join(csgoDir, 'addons'), { recursive: true })

  const installed = await readPluginVersions(csgoDir)
  const [mms, css] = await Promise.all([latestMetamod(), latestCounterStrikeSharp()])

  const metamodPresent = existsSync(join(csgoDir, 'addons', 'metamod'))
  if (!metamodPresent || installed.metamod !== mms.version) {
    await installZip(mms.url, csgoDir, 'Metamod', report)
    installed.metamod = mms.version
  }
  const cssPresent = existsSync(join(csgoDir, 'addons', 'counterstrikesharp'))
  if (!cssPresent || installed.counterstrikesharp !== css.version) {
    // Note: extracting over an existing install keeps user configs; files are overwritten in place.
    await installZip(css.url, csgoDir, 'CounterStrikeSharp', report)
    installed.counterstrikesharp = css.version
  }

  await writePluginVersions(csgoDir, installed)
  await ensureGameinfoPatched(csgoDir)
  return installed
}
