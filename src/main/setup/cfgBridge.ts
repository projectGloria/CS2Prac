import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Makes the user's own client cfgs (aliases, binds) work on the dedicated server.
 *
 * On a dedicated server a client can't run server commands: the client refuses replicated cvars itself
 * (sv_cheats, sv_infinite_ammo, mp_* …) and the server rejects the rest (bot_kick, ent_fire, mp_warmup_end …;
 * too many of those and the player is kicked). Neither path can be hooked by a server plugin.
 *
 * So for every user cfg in the client's cfg folder we write a bridged copy to cfg/cs2prac/<name>.cfg. It is the
 * same file, except each run of server commands is replaced by a helper alias `cs2prac_<id>` that sends
 * `css_cfgrun <id>` to the server; PracSkins looks the id up in cfgbridge.json and runs those commands as the
 * server (root admins only). Everything client-side (binds, crosshair, play, echo, alias toggles) is untouched.
 * Usage in game: `exec cs2prac/<name>` instead of `exec <name>`.
 */

export const BRIDGE_DIR = 'cs2prac'
export const BRIDGE_JSON = 'cfgbridge.json'
export const RUN_COMMAND = 'css_cfgrun'

const SERVER_PREFIXES = ['sv_', 'mp_', 'bot_', 'ent_', 'ammo_', 'custom_bot_', 'weapon_', 'cash_', 'ff_damage_', 'healthshot_']
const SERVER_NAMES = new Set(['endround', 'changelevel', 'host_timescale', 'script', 'script_reload'])
/** Commands that change a cvar given as their first argument. */
const CVAR_SETTERS = new Set(['toggle', 'incrementvar'])

/** Cfgs that ship with CS2; they are not the user's. */
const isGameCfg = (file: string) =>
  /^gamemode_/i.test(file) || ['server.cfg', 'server_default.cfg', 'perftest.cfg'].includes(file.toLowerCase())

const isServerName = (name: string) => SERVER_NAMES.has(name) || SERVER_PREFIXES.some((p) => name.startsWith(p))

/** Splits one cfg line into commands at `;`, ignoring `//` comments; quotes are respected. */
export function splitCommands(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') quoted = !quoted
    else if (!quoted && c === '/' && line[i + 1] === '/') break
    else if (!quoted && c === ';') {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** Splits a command into arguments; quoted arguments lose their quotes. */
export function tokenize(cmd: string): string[] {
  return [...cmd.matchAll(/"([^"]*)"?|(\S+)/g)].map((m) => m[1] ?? m[2])
}

export function isServerCommand(tokens: string[]): boolean {
  const name = tokens[0]?.toLowerCase() ?? ''
  if (CVAR_SETTERS.has(name)) return !!tokens[1] && isServerName(tokens[1].toLowerCase())
  return isServerName(name)
}

/** The id stem for a cfg file name: `Nihil.cfg` → `Nihil`. */
export const cfgStem = (file: string) => file.replace(/\.cfg$/i, '').replace(/[^A-Za-z0-9_]/g, '_')

export interface BridgeResult {
  /** the bridged cfg text */
  text: string
  /** id → the server commands it stands for */
  segments: Record<string, string[]>
}

/**
 * Rewrites one cfg. `bridged` holds the lower-case stems of every cfg that gets a bridge, so `exec <name>`
 * inside it can point to the bridged copy.
 */
export function bridgeCfg(file: string, source: string, bridged: Set<string> = new Set()): BridgeResult {
  const stem = cfgStem(file)
  const segments: Record<string, string[]> = {}
  let n = 0

  const segment = (cmds: string[]) => {
    const id = `${stem}_${n++}`
    segments[id] = cmds
    return `cs2prac_${id}`
  }

  /**
   * Rewrites a list of commands. `nested` is true inside a quoted alias/bind body, where no quotes can be added,
   * so nested alias and bind bodies are written unquoted (they are single words there anyway).
   */
  function rewrite(cmds: string[], nested: boolean): { out: string[]; changed: boolean } {
    const out: string[] = []
    let changed = false
    let pending: string[] = []
    const flush = () => {
      if (!pending.length) return
      out.push(segment(pending))
      pending = []
      changed = true
    }
    for (const raw of cmds) {
      const t = tokenize(raw)
      if (isServerCommand(t)) {
        pending.push(raw)
        continue
      }
      flush()
      const name = t[0]?.toLowerCase()
      if ((name === 'alias' || name === 'bind') && t.length >= 3) {
        const body = rewrite(splitCommands(t.slice(2).join(' ')), true)
        if (body.changed) {
          const b = body.out.join('; ')
          out.push(nested ? `${t[0]} ${t[1]} ${b}` : `${t[0]} "${t[1]}" "${b}"`)
          changed = true
          continue
        }
      } else if (name === 'exec' && t[1]) {
        const target = t[1].replace(/\.cfg$/i, '')
        if (bridged.has(cfgStem(target).toLowerCase()) && !target.includes('/')) {
          out.push(`exec ${BRIDGE_DIR}/${target}`)
          changed = true
          continue
        }
      }
      out.push(raw)
    }
    flush()
    return { out, changed }
  }

  const lines = source.replace(/^﻿/, '').split(/\r?\n/)
  const body = lines.map((line) => {
    const r = rewrite(splitCommands(line), false)
    return r.changed ? r.out.join('; ') : line
  })
  const helpers = Object.keys(segments).map((id) => `alias cs2prac_${id} "${RUN_COMMAND} ${id}"`)
  const header = [
    `// Written by CS2Prac from ${file} before every server start. Don't edit it: edit ${file} instead.`,
    `// On the CS2Prac server run  exec ${BRIDGE_DIR}/${file.replace(/\.cfg$/i, '')}  instead of  exec ${file.replace(/\.cfg$/i, '')}.`,
    `// Server commands (sv_, mp_, bot_, ent_ …) are sent to the server as ${RUN_COMMAND} <id> and run there.`,
    ...helpers,
    ''
  ]
  return { text: [...header, ...body].join('\r\n'), segments }
}

export interface CfgBridgeSummary {
  /** cfg names (without .cfg) that have a bridged copy, with how many server steps each has */
  cfgs: { name: string; steps: number }[]
}

/**
 * Writes cfg/cs2prac/<name>.cfg next to the user's cfgs in the client's cfg folder, and cfgbridge.json for
 * PracSkins. Bridged copies whose source is gone are removed.
 */
export async function writeCfgBridge(clientCfgDir: string, pluginDir: string): Promise<CfgBridgeSummary> {
  if (!existsSync(clientCfgDir)) return { cfgs: [] }
  const files = (await readdir(clientCfgDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && /\.cfg$/i.test(e.name) && !isGameCfg(e.name))
    .map((e) => e.name)
  const stems = new Set(files.map((f) => cfgStem(f).toLowerCase()))
  const outDir = join(clientCfgDir, BRIDGE_DIR)
  await mkdir(outDir, { recursive: true })

  const segments: Record<string, string[]> = {}
  const cfgs: CfgBridgeSummary['cfgs'] = []
  for (const file of files) {
    const r = bridgeCfg(file, await readFile(join(clientCfgDir, file), 'utf8'), stems)
    Object.assign(segments, r.segments)
    const target = join(outDir, file)
    const current = existsSync(target) ? await readFile(target, 'utf8') : null
    if (current !== r.text) await writeFile(target, r.text)
    cfgs.push({ name: file.replace(/\.cfg$/i, ''), steps: Object.keys(r.segments).length })
  }
  const keep = new Set(files.map((f) => f.toLowerCase()))
  for (const e of await readdir(outDir, { withFileTypes: true }))
    if (e.isFile() && /\.cfg$/i.test(e.name) && !keep.has(e.name.toLowerCase())) await rm(join(outDir, e.name))

  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, BRIDGE_JSON), JSON.stringify({ segments }, null, 2))
  return { cfgs }
}
