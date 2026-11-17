// Builds assets/sounds/1.6/cs2map.json: which CS2 sound file (sounds/…/x.vsnd) gets which 1.6 wav.
//   node scripts/sounds/build-cs16-map.mjs <cs2_events.json> <talker dir>
// <cs2_events.json> = every CS2 sound event [{ event, files: [vsnd…] }] (agent voices included), decoded from the
// player's pak01 with ValveResourceFormat (see docs/sounds/README.md). The targets come from the last column of
// docs/sounds/cs16-sound-files.tsv. When several 1.6 takes cover the same CS2 files they take turns, so a gun with
// three CS2 shot files and two 1.6 takes plays both.
// <talker dir> = the agents' response rules as KV3 text (ModelExport kv3dump <csgo> <out> vrr_c scripts/talker/, then
// <out>/scripts/talker): a target part `talker <Concept> / …` takes every agent's lines for that radio concept (the
// group "<Concept><set>", e.g. Radio.Roger + balkan; * globs). Parts of a target are joined with " + ".
// Paths in the map are relative to the language folder (english/…); the app takes turkish/<same path> when it
// exists for the TR pack (radio and hostage only), english otherwise.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const [eventsPath, talkerDir] = process.argv.slice(2)
if (!eventsPath || !talkerDir) {
  console.error('usage: node scripts/sounds/build-cs16-map.mjs <cs2_events.json> <talker dir>')
  process.exit(1)
}
const events = JSON.parse(readFileSync(eventsPath, 'utf8'))
const byName = new Map()
for (const e of events) byName.set(e.event.toLowerCase(), e)

// talker: concept (lower case) -> group names; group name (lower case) -> response values (events or other groups)
const groupValues = new Map()
const conceptGroups = new Map()
for (const n of readdirSync(talkerDir).filter((n) => n.endsWith('.vrr'))) {
  const set = n.slice(0, -4)
  for (const g of readFileSync(join(talkerDir, n), 'utf8').split(/\n\t\t\{\n\t\t\tm_name = /).slice(1)) {
    const name = /^"([^"]+)"/.exec(g)?.[1]
    if (!name) continue
    const values = [...g.matchAll(/m_value = "([^"]+)"/g)].map((m) => m[1])
    groupValues.set(name.toLowerCase(), [...(groupValues.get(name.toLowerCase()) ?? []), ...values])
    if (!name.toLowerCase().endsWith(set.toLowerCase())) continue
    const concept = name.slice(0, -set.length).toLowerCase()
    if (!conceptGroups.has(concept)) conceptGroups.set(concept, [])
    conceptGroups.get(concept).push(name.toLowerCase())
  }
}
/** a talker response value -> events (values naming another group follow it) */
function talkerEvents(value, add, depth = 0) {
  const e = byName.get(value.toLowerCase())
  if (e) return add(e)
  if (depth > 4) return
  for (const v of groupValues.get(value.toLowerCase()) ?? []) talkerEvents(v, add, depth + 1)
}

const rows = readFileSync(join(root, 'docs', 'sounds', 'cs16-sound-files.tsv'), 'utf8')
  .split(/\r?\n/)
  .slice(1)
  .filter(Boolean)
  .map((l) => l.split('\t'))
  .map((c) => ({ path: c[0], target: c[c.length - 1] }))
  .filter((r) => r.path.startsWith('english/') && r.path.endsWith('.wav'))

const SKIP = /^(none|map ambience|generic|shotgun reload|Land_\*)/i
const reEsc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
const globRe = (g) => new RegExp('^' + g.split('*').map(reEsc).join('.*') + '$', 'i')

/** One suggestion (parts joined with " + ") -> the CS2 events it names. */
function resolve(target) {
  return [...new Set(target.split(' + ').flatMap(resolvePart))]
}

function resolvePart(target) {
  let t = target.trim()
  if (!t || SKIP.test(t)) return []
  const plusRight = /\(\+Right\)/.test(t)
  t = t.replace(/\([^)]*\)/g, '').trim()
  if (!t || t === 'agent') return []
  const out = new Set()
  const add = (e) => out.add(e)
  if (t.startsWith('talker ')) {
    for (const c of t.slice(7).split('/').map((s) => s.trim()).filter(Boolean)) {
      const re = globRe(c)
      const hits = [...conceptGroups.keys()].filter((k) => re.test(k))
      if (hits.length === 0) console.warn(`no talker concept ${c} (${target})`)
      for (const k of hits) for (const g of conceptGroups.get(k)) for (const v of groupValues.get(g)) talkerEvents(v, add)
    }
    return [...out]
  }
  if (t.startsWith('agent ')) {
    // agent line names: every agent set's <set>.<line><nn>; the newer sets (jungle, gendarmerie, *_epic, *_fem) name
    // them <set>.<take prefix>_<line>_<nn>, e.g. jungle_male.afm1_throwing_molotov_04
    for (const line of t.slice(6).split('/').map((s) => s.trim()).filter(Boolean)) {
      const re = new RegExp(`^[a-z0-9_]+\\.(?:[a-z]+\\d_)?${reEsc(line)}_?\\d*$`, 'i')
      for (const e of events) if (e.file.includes('/vo/agents/') && re.test(e.event)) add(e)
    }
    return [...out]
  }
  t = t.replace(/^announcer /, '')
  // "CT_/T_Concrete.StepLeft/Right" -> CT_ and T_, Left and Right
  const m = /^CT_\/T_(\w+)\.StepLeft\/Right$/.exec(t)
  const names = m
    ? ['CT_', 'T_'].flatMap((p) => ['StepLeft', 'StepRight'].map((s) => `${p}${m[1]}.${s}`))
    : t.split(' / ').map((s) => s.trim()).filter((s) => !s.includes(' ')) // "kill sound" is a note, not an event
  // CS2 footsteps have only StepLeft events today; the Right ones are added when they exist
  if (plusRight) names.push(...names.map((n) => n.replace(/StepLeft$/, 'StepRight')))
  for (const n of names) {
    if (n.includes('*')) {
      const re = globRe(n)
      for (const e of events) if (re.test(e.event)) add(e)
      continue
    }
    const e = byName.get(n.toLowerCase())
    if (e) add(e)
    else if (!/StepRight$/.test(n)) console.warn(`no CS2 event ${n} (${target})`)
    // the far-away shot: 1.6 has none, so the near one stands in
    if (/\.Single$/i.test(n)) {
      const d = byName.get((n + 'Distant').toLowerCase())
      if (d) add(d)
    }
    if (/^Event\./.test(n)) {
      // the announcer's CS2_Classic copies
      const a = byName.get(`announcer.${n.slice(6)}.cs2_classic`.toLowerCase())
      if (a) add(a)
    }
  }
  return [...out]
}

/** vsnd file -> 1.6 sources (relative to english/) */
const sourcesOf = new Map()
let unmapped = 0
for (const r of rows) {
  const evs = resolve(r.target)
  if (evs.length === 0) {
    unmapped++
    continue
  }
  const src = r.path.slice('english/'.length)
  for (const e of evs)
    for (const f of e.files) {
      if (!f.endsWith('.vsnd')) continue
      if (!sourcesOf.has(f)) sourcesOf.set(f, new Set())
      sourcesOf.get(f).add(src)
    }
}

// files with the same source set take turns through it
const groups = new Map()
for (const [file, srcs] of sourcesOf) {
  const key = [...srcs].sort().join('|')
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(file)
}
const files = {}
for (const [key, list] of groups) {
  const srcs = key.split('|')
  list.sort().forEach((f, i) => (files[f] = srcs[i % srcs.length]))
}
const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
const out = join(root, 'assets', 'sounds', '1.6', 'cs2map.json')
writeFileSync(out, JSON.stringify({ schema: 1, files: sorted }, null, 1) + '\n')
const used = new Set(Object.values(sorted))
console.log(`${Object.keys(sorted).length} CS2 files from ${used.size} 1.6 wavs (${unmapped} wavs without a target) -> ${out}`)
