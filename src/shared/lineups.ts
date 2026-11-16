/**
 * Lineups = MatchZy's saved nades (game/csgo/cfg/MatchZy/savednades.json, written by .savenade in practice mode).
 * File shape: { "<steamid64>" | "default": { "<name>": { LineupPos: "x y z", LineupAng: "pitch yaw roll", Desc, Map,
 * Type? } } }. "default" = saved as global (everyone sees them); a name is unique per owner across all maps. MatchZy
 * reads the file on every command, so the app may edit it while the server runs. Unknown keys are kept.
 */

export type NadeType = 'Smoke' | 'Flash' | 'HE' | 'Molly' | 'Decoy' | ''

export interface Lineup {
  /** steamid64, or "default" for global lineups */
  owner: string
  name: string
  map: string
  desc: string
  type: NadeType
  pos: [number, number, number]
  ang: [number, number, number]
}

type RawEntry = Record<string, string>
export type RawNades = Record<string, Record<string, RawEntry>>

export const GLOBAL_OWNER = 'default'
export const NADE_TYPES: NadeType[] = ['Smoke', 'Flash', 'HE', 'Molly', 'Decoy']

/** "x y z" as MatchZy writes it; also takes "x, y, z" and decimal commas from older culture-dependent saves */
export function parseTriple(s: string | undefined): [number, number, number] | null {
  if (!s) return null
  let parts = s.trim().split(/[\s;]+/).map((p) => p.replace(/,$/, ''))
  if (parts.length === 1) parts = parts[0].split(',')
  if (parts.length !== 3) return null
  const n = parts.map((p) => Number(p.replace(',', '.')))
  return n.every(Number.isFinite) ? (n as [number, number, number]) : null
}

const num = (n: number) => String(Math.round(n * 1000) / 1000)
export const formatTriple = (t: readonly number[]) => t.map(num).join(' ')

const asType = (t: string | undefined): NadeType => (NADE_TYPES.includes(t as NadeType) ? (t as NadeType) : '')

/** every readable lineup in the file (broken ones are skipped, not thrown) */
export function parseSavedNades(json: unknown): Lineup[] {
  const out: Lineup[] = []
  if (!json || typeof json !== 'object') return out
  for (const [owner, list] of Object.entries(json as RawNades)) {
    if (!list || typeof list !== 'object') continue
    for (const [name, e] of Object.entries(list)) {
      if (!e || typeof e !== 'object') continue
      const pos = parseTriple(e.LineupPos)
      const ang = parseTriple(e.LineupAng)
      if (!pos || !ang) continue
      out.push({ owner, name, map: String(e.Map ?? ''), desc: String(e.Desc ?? ''), type: asType(e.Type), pos, ang })
    }
  }
  return out.sort((a, b) => a.map.localeCompare(b.map) || a.name.localeCompare(b.name))
}

/** a name MatchZy can take: .loadnade/.delnade split on spaces, so no spaces */
export function cleanLineupName(name: string): string {
  return name.trim().replace(/\s+/g, '_').replace(/["\\;]/g, '').slice(0, 48)
}

const entryOf = (l: Lineup, keep?: RawEntry): RawEntry => {
  const e: RawEntry = { ...(keep ?? {}), LineupPos: formatTriple(l.pos), LineupAng: formatTriple(l.ang), Desc: l.desc, Map: l.map }
  if (l.type) e.Type = l.type
  else delete e.Type
  return e
}

/** a free name for the owner: name, name_2, name_3 … */
export function freeName(raw: RawNades, owner: string, name: string): string {
  const taken = raw[owner] ?? {}
  if (!(name in taken)) return name
  for (let i = 2; ; i++) if (!(`${name}_${i}` in taken)) return `${name}_${i}`
}

/** adds lineups (names made free per owner); returns the new file and the names used */
export function addLineups(raw: RawNades, list: Lineup[]): { raw: RawNades; added: Lineup[] } {
  const next: RawNades = structuredClone(raw)
  const added: Lineup[] = []
  for (const l of list) {
    const name = freeName(next, l.owner, cleanLineupName(l.name) || 'lineup')
    next[l.owner] = { ...(next[l.owner] ?? {}), [name]: entryOf({ ...l, name }) }
    added.push({ ...l, name })
  }
  return { raw: next, added }
}

/** renames/edits one lineup (identified by owner + old name); a taken new name gets a suffix */
export function updateLineup(raw: RawNades, owner: string, oldName: string, patch: Partial<Pick<Lineup, 'name' | 'desc' | 'type'>>): RawNades {
  const list = raw[owner]
  const old = list?.[oldName]
  if (!old) return raw
  const current = parseSavedNades({ [owner]: { [oldName]: old } })[0]
  if (!current) return raw
  const next: RawNades = structuredClone(raw)
  const merged = { ...current, ...patch }
  let name = patch.name !== undefined ? cleanLineupName(patch.name) || oldName : oldName
  // rebuild in order so the renamed entry keeps its place
  const rebuilt: Record<string, RawEntry> = {}
  const others = { ...next[owner] }
  delete others[oldName]
  if (name !== oldName && name in others) name = freeName({ [owner]: others }, owner, name)
  for (const [k, v] of Object.entries(next[owner])) {
    if (k === oldName) rebuilt[name] = entryOf({ ...merged, name }, old)
    else rebuilt[k] = v
  }
  next[owner] = rebuilt
  return next
}

export function deleteLineup(raw: RawNades, owner: string, name: string): RawNades {
  if (!raw[owner]?.[name]) return raw
  const next: RawNades = structuredClone(raw)
  delete next[owner][name]
  return next
}

/** MatchZy's .importnade code: "name x, y, z, pitch, yaw, roll" (7 space-separated parts) */
export const importCode = (l: Lineup) => `.importnade ${l.name} ${[...l.pos, ...l.ang].map(num).join(', ')}`

// ---------------------------------------------------------------- share files

export interface ShareFile {
  kind: 'cs2prac-lineups'
  schema: 1
  lineups: Omit<Lineup, 'owner'>[]
}

export function toShareFile(list: Lineup[]): string {
  const file: ShareFile = { kind: 'cs2prac-lineups', schema: 1, lineups: list.map(({ owner: _o, ...l }) => l) }
  return JSON.stringify(file, null, 2)
}

/**
 * Reads a share file: our JSON, a raw savednades.json, or lines of .importnade codes (those carry no map: `map`
 * is used). Lineups come back owned by `owner`.
 */
export function parseShareFile(text: string, owner: string, map: string): { ok: true; lineups: Lineup[] } | { ok: false; error: string } {
  const t = text.replace(/^\uFEFF/, '').trim()
  if (!t) return { ok: false, error: 'The file is empty.' }
  if (t.startsWith('{')) {
    let json: unknown
    try {
      json = JSON.parse(t)
    } catch {
      return { ok: false, error: 'The file is not valid JSON.' }
    }
    const j = json as Partial<ShareFile>
    if (j.kind === 'cs2prac-lineups' && Array.isArray(j.lineups)) {
      const lineups: Lineup[] = []
      for (const l of j.lineups) {
        const pos = Array.isArray(l?.pos) ? parseTriple(l.pos.join(' ')) : null
        const ang = Array.isArray(l?.ang) ? parseTriple(l.ang.join(' ')) : null
        if (!pos || !ang || !l.map || !l.name) continue
        lineups.push({ owner, name: String(l.name), map: String(l.map), desc: String(l.desc ?? ''), type: asType(l.type), pos, ang })
      }
      return lineups.length ? { ok: true, lineups } : { ok: false, error: 'No lineups in the file.' }
    }
    const lineups = parseSavedNades(json).map((l) => ({ ...l, owner }))
    return lineups.length ? { ok: true, lineups } : { ok: false, error: 'No lineups in the file.' }
  }
  if (!map) return { ok: false, error: 'Pick a map first: .importnade codes carry no map.' }
  const lineups: Lineup[] = []
  for (const line of t.split(/\r?\n/)) {
    const parts = line.trim().replace(/^[.!/]?(importnade|css_importnade)\s+/i, '').split(/\s+/)
    if (parts.length !== 7) continue
    const n = parts.slice(1).map((p) => Number(p.replace(/,$/, '')))
    if (!n.every(Number.isFinite)) continue
    lineups.push({ owner, name: parts[0], map, desc: '', type: '', pos: [n[0], n[1], n[2]], ang: [n[3], n[4], n[5]] })
  }
  return lineups.length ? { ok: true, lineups } : { ok: false, error: 'No lineups found (expected a lineup file or .importnade codes).' }
}
