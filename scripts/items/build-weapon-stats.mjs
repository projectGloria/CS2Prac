// npm run build:weaponstats: reads the game's scripts/weapons.vdata_c (through ModelExport kv3dump, so `npm run
// build:modeltool` first) and writes src/shared/weaponStats.json: price, kill award, damage, fire rate, magazine …
// per weapon class. Used by the item info pop-up (app), the item site/docs and the plugin's !info. Re-run after CS2
// updates that change weapon balance. Override the game folder with CS2_DIR=...
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..')

function findCs2() {
  if (process.env.CS2_DIR) return process.env.CS2_DIR
  const roots = ['C:\\Program Files (x86)\\Steam']
  const vdf = join(roots[0], 'steamapps', 'libraryfolders.vdf')
  if (existsSync(vdf))
    for (const m of readFileSync(vdf, 'utf8').matchAll(/"path"\s+"(.+?)"/g)) roots.push(m[1].replace(/\\\\/g, '\\'))
  for (const r of roots) {
    const c = join(r, 'steamapps', 'common', 'Counter-Strike Global Offensive')
    if (existsSync(join(c, 'game', 'csgo', 'pak01_dir.vpk'))) return c
  }
  throw new Error('Counter-Strike 2 not found; set CS2_DIR')
}

/** top-level blocks of the KV3 text: name -> { key: raw value } (depth-2 lines only) */
export function parseVdata(text) {
  const blocks = new Map()
  const lines = text.replace(/\r/g, '').split('\n')
  let cur = null
  for (const line of lines) {
    const top = /^\t([A-Za-z0-9_]+) = $/.exec(line)
    if (top) {
      cur = {}
      blocks.set(top[1], cur)
      continue
    }
    if (line === '\t}') {
      cur = null
      continue
    }
    const kv = cur && /^\t\t([A-Za-z0-9_]+) = (.+)$/.exec(line)
    if (kv) cur[kv[1]] = kv[2]
  }
  return blocks
}

const first = (v) => {
  if (v == null) return undefined
  const m = /^\[\s*([-\d.]+)/.exec(v)
  return Number(m ? m[1] : v.replace(/^"|"$/g, ''))
}

export function weaponStats(blocks) {
  const field = (name, key, depth = 0) => {
    const b = blocks.get(name)
    if (!b || depth > 8) return undefined
    return b[key] ?? (b._base ? field(b._base.replace(/"/g, ''), key, depth + 1) : undefined)
  }
  const out = {}
  for (const [name, b] of blocks) {
    if (!name.startsWith('weapon_') || b._not_pickable) continue
    const cls = String(field(name, 'm_szName') ?? name).replace(/"/g, '')
    if (cls !== name) continue
    const num = (k) => first(field(name, k))
    const price = num('m_nPrice')
    const cycle = num('m_flCycleTime')
    const clip = num('m_iMaxClip1')
    const reserve = num('m_nPrimaryReserveAmmoMax')
    const asClips = field(name, 'm_bReserveAmmoAsClips') === 'true'
    const type = String(field(name, 'm_WeaponType') ?? '').replace(/"|WEAPONTYPE_/g, '').toLowerCase()
    out[name] = {
      type,
      price: price ?? 0,
      killAward: num('m_nKillAward') ?? 0,
      damage: num('m_nDamage') ?? 0,
      bullets: num('m_nNumBullets') ?? 1,
      rpm: cycle > 0 ? Math.round(60 / cycle) : 0,
      clip: clip ?? 0,
      reserve: reserve == null ? 0 : asClips ? reserve * Math.max(clip ?? 0, 1) : reserve,
      armorPen: Math.round((num('m_flArmorRatio') ?? 0) * 50),
      headshot: num('m_flHeadshotMultiplier') ?? 4,
      penetration: num('m_flPenetration') ?? 0,
      rangeModifier: num('m_flRangeModifier') ?? 0,
      speed: Math.round(num('m_flMaxSpeed') ?? 250),
      fullAuto: field(name, 'm_bIsFullAuto') === 'true'
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

if (import.meta.main ?? process.argv[1]?.endsWith('build-weapon-stats.mjs')) {
  const csgo = join(findCs2(), 'game', 'csgo')
  const tool = join(root, 'resources', 'modeltool', 'ModelExport.dll')
  if (!existsSync(tool)) throw new Error('resources/modeltool missing: npm run build:modeltool')
  const tmp = mkdtempSync(join(tmpdir(), 'cs2prac-vdata-'))
  try {
    execFileSync('dotnet', [tool, 'kv3dump', csgo, tmp, 'vdata_c', 'scripts/weapons'], { stdio: 'inherit' })
    const stats = weaponStats(parseVdata(readFileSync(join(tmp, 'scripts', 'weapons.vdata'), 'utf8')))
    const file = join(root, 'src', 'shared', 'weaponStats.json')
    writeFileSync(file, JSON.stringify(stats, null, 1) + '\n')
    console.log(`weapon stats: ${Object.keys(stats).length} weapons -> ${file}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
