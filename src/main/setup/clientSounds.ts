import { app } from 'electron'
import { existsSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

/**
 * CS 1.6 sounds (the L window's Server tab "Sounds", setting `sounds`: off / tr / uk). The retail client resolves
 * addons only through the Workshop, so the pack is a local addon `cs2prac16` that CS2 mounts only when started in
 * tools mode (`cs2.exe -steam -tools -addon cs2prac16`, the Play page's "Start CS2 with 1.6 sounds"); a normal start
 * never sees it. The addon holds:
 *   - sounds/cs2prac16/<name>.wav → .vsnd_c: one file per 1.6 wav (stable names for both packs, so switching TR/UK
 *     only changes wav contents, which tools mode hot-reloads while the game runs)
 *   - soundevents/soundevents_addon.vsndevts(_c): a copy of every stock sound event that plays a CS2 file
 *     assets/sounds/1.6/cs2map.json maps, its vsnd paths swapped for ours (events come from the player's own VPK
 *     through ModelExport `soundevents`; nothing of Valve's ships). Off writes an empty events file.
 * Sources go to <cs2>/content/csgo_addons/cs2prac16, the compiled files (loose, never a VPK: tools mode then fails with
 * "pak01.vpk Failed to load file") to <cs2>/game/csgo_addons/cs2prac16. The game's own folders are never written.
 */
export type SoundPack = 'off' | 'tr' | 'uk'
export const SOUND_PACKS: SoundPack[] = ['off', 'tr', 'uk']
export const SOUND_ADDON = 'cs2prac16'
const PACK_RECORD = 'cs2prac16.json'
/** the old loose-file install (game/csgo/sounds/… + this record) and its compile workspace; removed on sight */
const LEGACY_RECORD = 'cs2prac-sounds.json'
const LEGACY_ADDON = 'cs2prac_sounds'
const KV3_HEADER =
  '<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->'

export interface SoundMap {
  schema: 1
  /** CS2 file (sounds/…/x.vsnd) -> 1.6 wav relative to the language folder (radio/bombpl.wav) */
  files: Record<string, string>
}

export function bundledSoundsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'sounds16') : join(app.getAppPath(), 'assets', 'sounds', '1.6')
}

export function toSoundPack(v: string | undefined): SoundPack {
  return SOUND_PACKS.includes(v as SoundPack) ? (v as SoundPack) : 'off'
}

/** The addon's name for a 1.6 wav (same for both packs): radio/Bomb Pl.WAV -> radio_bomb_pl */
export function soundName(src: string): string {
  return src
    .replace(/\.wav$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** Which wav each addon sound takes: the TR pack uses turkish/<path> where the Turkish pack has it (radio, hostage). */
export function packWavs(
  pack: Exclude<SoundPack, 'off'>,
  map: SoundMap,
  hasTurkish: (path: string) => boolean
): Map<string, { lang: 'english' | 'turkish'; src: string }> {
  const out = new Map<string, { lang: 'english' | 'turkish'; src: string }>()
  for (const src of Object.values(map.files))
    out.set(soundName(src), { lang: pack === 'tr' && hasTurkish(src) ? 'turkish' : 'english', src })
  return out
}

/** Top-level `Name = { … }` blocks of a KV3 text file (strings with braces inside are skipped over). */
export function eventBlocks(text: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = []
  const open = text.indexOf('{', text.indexOf('-->') + 1)
  if (open < 0) return out
  let i = open + 1
  while (i < text.length) {
    const m = /\s*(?:"([^"]+)"|([^\s=}]+))\s*=\s*/y
    m.lastIndex = i
    const k = m.exec(text)
    if (!k) break
    const name = k[1] ?? k[2]
    let j = m.lastIndex
    if (text[j] !== '{') {
      // a plain value at the top level (none in the game's files): skip the line
      const nl = text.indexOf('\n', j)
      i = nl < 0 ? text.length : nl + 1
      continue
    }
    let depth = 0
    let inStr = false
    for (; j < text.length; j++) {
      const c = text[j]
      if (inStr) {
        if (c === '\\') j++
        else if (c === '"') inStr = false
      } else if (c === '"') inStr = true
      else if (c === '{' || c === '[') depth++
      else if ((c === '}' || c === ']') && --depth === 0) break
    }
    out.push({ name, body: text.slice(m.lastIndex, j + 1) })
    i = j + 1
  }
  return out
}

/**
 * soundevents_addon.vsndevts text: every event that plays a mapped CS2 file, with those paths swapped for the addon's
 * sounds (sounds/cs2prac16/<name>.vsnd). The first definition of a name wins.
 */
export function addonEvents(files: string[], map: SoundMap): { text: string; events: number } {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const text of files)
    for (const { name, body } of eventBlocks(text)) {
      if (seen.has(name)) continue
      let hit = false
      const swapped = body.replace(/"(sounds\/[^"]+\.vsnd)"/g, (all, path: string) => {
        const src = map.files[path]
        if (!src) return all
        hit = true
        return `"sounds/${SOUND_ADDON}/${soundName(src)}.vsnd"`
      })
      if (!hit) continue
      seen.add(name)
      parts.push(`\t${/^[A-Za-z0-9_.]+$/.test(name) ? name : JSON.stringify(name)} = ${swapped}`)
    }
  return { text: `${KV3_HEADER}\n{\n${parts.join('\n')}\n}\n`, events: parts.length }
}

export type SoundInstall =
  | { status: 'installed'; pack: SoundPack; sounds: number; events: number }
  | { status: 'unchanged'; pack: SoundPack }
  | { status: 'nocompiler' | 'missing' }

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await listFiles(p)))
    else if (e.name.endsWith('.vsndevts')) out.push(p)
  }
  return out.sort()
}

/** The old loose-file install wrote into game/csgo/sounds; remove exactly the files its record lists. */
async function removeLegacy(cs2Dir: string) {
  const csgo = join(cs2Dir, 'game', 'csgo')
  const rec = join(csgo, LEGACY_RECORD)
  if (existsSync(rec)) {
    let files: string[] = []
    try {
      const r = JSON.parse(await readFile(rec, 'utf8'))
      if (Array.isArray(r?.files)) files = r.files.filter((f: unknown) => typeof f === 'string' && !f.includes('..'))
    } catch {
      /* unreadable record: nothing to remove */
    }
    for (const relPath of files) {
      const f = join(csgo, relPath)
      if (!relative(csgo, f).startsWith('sounds')) continue
      try {
        await unlink(f)
        for (let d = dirname(f); d.length > csgo.length + 1 && existsSync(d) && readdirSync(d).length === 0; d = dirname(d)) rmdirSync(d)
      } catch {
        /* gone or in use */
      }
    }
    await unlink(rec).catch(() => {})
  }
  for (const root of ['content', 'game'])
    await rm(join(cs2Dir, root, 'csgo_addons', LEGACY_ADDON), { recursive: true, force: true }).catch(() => {})
}

async function sameFile(a: string, b: string): Promise<boolean> {
  if (!existsSync(b) || statSync(a).size !== statSync(b).size) return false
  return (await readFile(a)).equals(await readFile(b))
}

/**
 * Builds the addon for the pack. `eventsDir` gives the dumped stock sound events (only asked for TR/UK).
 * Only changed sources are copied; the compiler skips up-to-date files, so a switch recompiles just what changed.
 */
export async function installSoundPack(
  cs2Dir: string,
  pack: SoundPack,
  compile: (exe: string, args: string[]) => Promise<void>,
  eventsDir: () => Promise<string>,
  srcDir = bundledSoundsDir()
): Promise<SoundInstall> {
  await removeLegacy(cs2Dir)
  const compiler = join(cs2Dir, 'game', 'bin', 'win64', 'resourcecompiler.exe')
  if (!existsSync(compiler)) return { status: 'nocompiler' }
  const content = join(cs2Dir, 'content', 'csgo_addons', SOUND_ADDON)
  const game = join(cs2Dir, 'game', 'csgo_addons', SOUND_ADDON)
  const evSrc = join(content, 'soundevents', 'soundevents_addon.vsndevts')
  await mkdir(dirname(evSrc), { recursive: true })
  await mkdir(game, { recursive: true })

  let sounds = 0
  let events = 0
  let changed = 0
  let evText = `${KV3_HEADER}\n{\n}\n`
  if (pack !== 'off') {
    const mapFile = join(srcDir, 'cs2map.json')
    if (!existsSync(mapFile)) return { status: 'missing' }
    const map = JSON.parse(await readFile(mapFile, 'utf8')) as SoundMap
    const wavs = packWavs(pack, map, (p) => existsSync(join(srcDir, 'turkish', p)))
    const sndDir = join(content, 'sounds', SOUND_ADDON)
    await mkdir(sndDir, { recursive: true })
    for (const [name, w] of wavs) {
      const from = join(srcDir, w.lang, w.src)
      const to = join(sndDir, name + '.wav')
      if (!existsSync(from) || (await sameFile(from, to))) continue
      await copyFile(from, to)
      changed++
    }
    if (changed > 0 || !existsSync(join(game, 'sounds', SOUND_ADDON)))
      await compile(compiler, ['-i', join(sndDir, '*.wav')])
    sounds = wavs.size
    const ev = addonEvents(await Promise.all((await listFiles(await eventsDir())).map((f) => readFile(f, 'utf8'))), map)
    if (ev.events === 0) throw new Error('no CS2 sound event uses a mapped sound (sound event dump empty?)')
    events = ev.events
    evText = ev.text
  }
  const evOut = join(game, 'soundevents', 'soundevents_addon.vsndevts_c')
  if (!existsSync(evSrc) || (await readFile(evSrc, 'utf8')) !== evText || !existsSync(evOut)) {
    await writeFile(evSrc, evText)
    await compile(compiler, ['-i', evSrc, '-f'])
    if (!existsSync(evOut)) throw new Error('the sound events did not compile (resourcecompiler)')
    changed++
  }
  const record = join(game, PACK_RECORD)
  if (changed === 0 && (await installedSoundPack(cs2Dir)) === pack) return { status: 'unchanged', pack }
  await writeFile(record, JSON.stringify({ pack, sounds, events }, null, 1))
  return { status: 'installed', pack, sounds, events }
}

/** the old loose-file install's record (its files are removed by the next install) */
export function legacySoundRecord(cs2Dir: string): string {
  return join(cs2Dir, 'game', 'csgo', LEGACY_RECORD)
}

/** The pack the addon holds now ('off' when there is none). */
export async function installedSoundPack(cs2Dir: string): Promise<SoundPack> {
  try {
    return toSoundPack(JSON.parse(await readFile(join(cs2Dir, 'game', 'csgo_addons', SOUND_ADDON, PACK_RECORD), 'utf8')).pack)
  } catch {
    return 'off'
  }
}
