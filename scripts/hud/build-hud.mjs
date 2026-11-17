// Builds the in-game skin window (custom_hud_layout) into resources/hud/:
//   cs2prac_skins.vxml_c  (layout)   cs2prac_skins.vcss_c  (styles + one image rule per skin)
//
// Needs Counter-Strike 2 Workshop Tools (game/bin/win64/resourcecompiler.exe). Run after changing the layout or
// after a CS2 update with new skins:  npm run build:hud   (override the game folder with CS2_DIR=...)
//
// Images: CS2 ships every skin's inventory icon in its VPK as
//   panorama/images/econ/default_generated/<item>_<paint kit codename>_light_png.vtex
// The plugin only knows def index + paint index, so this script reads scripts/items/items_game.txt for the
// def -> item name and paint index -> codename mapping and writes a CSS class per combination:
//   .pk-img.b<def>            base weapon icon (econ/weapons/base_weapons/<item>_png)
//   .pk-img.s<def>_<paint>    skin icon (after the base rules, so it wins when both classes are set)
//   .pk-bar.s<def>_<paint>    rarity colour
//   .pk-img.p<def>            pin/coin/medal (items' image_inventory econ/status_icons/…)
//   .pk-img.m<def>            music kit (music_definitions' image_inventory econ/music_kits/…)
//   .pk-img.g<def>            graffiti (sticker_kits spray_* and *_graffiti: econ/stickers/<sticker_material>_png)
//   .pk-img.a<def>            agent portrait (econ/characters/customplayer_<model>[_square]_png)
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readVpkDir, readVpkFile } from './vpk.mjs'
import { parseKv, all, get } from './keyvalues.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
// Test variants for bisecting what CS2's client rejects (it drops a bad layout silently, see CLAUDE.md):
// HUD_VARIANT=x writes cs2prac_skins_x.*; HUD_XML / HUD_CSS / HUD_SIDE_ROWS / HUD_GRID_ROWS override the sources.
const VARIANT = process.env.HUD_VARIANT ?? ''
const NAME = 'cs2prac_skins' + (VARIANT ? '_' + VARIANT : '')
const XML_SRC = process.env.HUD_XML ?? join(here, 'cs2prac_skins.xml')
const CSS_SRC = process.env.HUD_CSS ?? join(here, 'cs2prac_skins.css')
const ADDON = 'cs2prac'

// Keep in sync with plugin/PracSkins/Hud.cs (SideRows, GridCols, GridRows).
const SIDE_ROWS = Number(process.env.HUD_SIDE_ROWS ?? 36)
const GRID_COLS = 4
const GRID_ROWS = Number(process.env.HUD_GRID_ROWS ?? 32)
// Keep in sync with plugin/PracSkins/SettingsHud.cs (SetRows, RowChips).
const SET_ROWS = 48
const SET_CHIPS = 6
const SET_XML_SRC = join(here, 'cs2prac_settings.xml')
const SET_CSS_SRC = join(here, 'cs2prac_settings.css')

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

const RARITY = {
  common: '#b0c3d9',
  uncommon: '#5e98d9',
  rare: '#4b69ff',
  mythical: '#8847ff',
  legendary: '#d32ce6',
  ancient: '#eb4b4b',
  unusual: '#e4ae39'
}

function buildLayout() {
  let xml = readFileSync(XML_SRC, 'utf8').replace('custom_game/cs2prac_skins.vcss_c', `custom_game/${NAME}.vcss_c`)
  const t5 = '\t\t\t\t\t'
  const t4 = '\t\t\t\t'
  const rows = []
  for (let i = 0; i < SIDE_ROWS; i++)
    rows.push(
      `${t4}\t<Button id="pk_side_${i}" class="pk-row">\n` +
        `${t4}\t\t<Panel id="pk_side_${i}_img" class="pk-img pk-row-img" hittest="false" />\n` +
        `${t4}\t\t<Panel class="pk-row-text" hittest="false">\n` +
        `${t4}\t\t\t<Label id="pk_side_${i}_name" class="pk-row-name" text="{s:text}" hittest="false" />\n` +
        `${t4}\t\t\t<Label id="pk_side_${i}_sub" class="pk-row-sub" text="{s:text}" hittest="false" />\n` +
        `${t4}\t\t</Panel>\n` +
        `${t4}\t</Button>`
    )
  const grid = []
  for (let r = 0; r < GRID_ROWS; r++) {
    grid.push(`${t5}\t<Panel id="pk_grow_${r}" class="pk-grid-row" hittest="false">`)
    for (let c = 0; c < GRID_COLS; c++) {
      const i = r * GRID_COLS + c
      grid.push(
        `${t5}\t\t<Button id="pk_tile_${i}" class="pk-tile">\n` +
          `${t5}\t\t\t<Panel id="pk_tile_${i}_img" class="pk-img" hittest="false" />\n` +
          `${t5}\t\t\t<Panel id="pk_tile_${i}_bar" class="pk-bar" hittest="false" />\n` +
          `${t5}\t\t\t<Label id="pk_tile_${i}_name" class="pk-name" text="{s:text}" hittest="false" />\n` +
          `${t5}\t\t</Button>`
      )
    }
    grid.push(`${t5}\t</Panel>`)
  }
  xml = xml.replace('<!--SIDE_ROWS-->', rows.join('\n')).replace('<!--GRID_ROWS-->', grid.join('\n'))
  xml = xml.replace('<!--SETTINGS_WINDOW-->', buildSettings())
  if (/<!--(SIDE_ROWS|GRID_ROWS|SETTINGS_WINDOW|PS_ROWS)-->/.test(xml)) throw new Error('layout markers missing')
  return xml
}

// The server settings window (L): its own source, inside the same layout (one entity, one input capture).
function buildSettings() {
  const t = '\t\t\t\t'
  const rows = []
  for (let i = 0; i < SET_ROWS; i++) {
    const chips = []
    for (let j = 0; j < SET_CHIPS; j++)
      chips.push(
        `${t}\t\t\t<Button id="ps_row_${i}_opt_${j}" class="pk-chip ps-chip">` +
          `<Panel id="ps_row_${i}_opt_${j}_ic" class="ps-ic ps-chip-ic" hittest="false" />` +
          `<Label id="ps_row_${i}_opt_${j}_text" class="pk-chip-text" text="{s:text}" hittest="false" /></Button>`
      )
    rows.push(
      `${t}<Panel id="ps_row_${i}" class="ps-row" hittest="false">\n` +
        `${t}\t<Panel id="ps_row_${i}_ic" class="ps-ic ps-row-ic" hittest="false" />\n` +
        `${t}\t<Panel class="ps-row-text" hittest="false">\n` +
        `${t}\t\t<Label id="ps_row_${i}_name" class="ps-row-name" text="{s:text}" hittest="false" />\n` +
        `${t}\t\t<Label id="ps_row_${i}_sub" class="ps-row-sub" text="{s:text}" hittest="false" />\n` +
        `${t}\t</Panel>\n` +
        `${t}\t<Panel class="ps-chips" hittest="false">\n${chips.join('\n')}\n${t}\t</Panel>\n` +
        `${t}</Panel>`
    )
  }
  return readFileSync(SET_XML_SRC, 'utf8').replace('<!--PS_ROWS-->', rows.join('\n'))
}

// Icons of the settings window: every ic-<name> (panorama/images/icons/ui/<name>.vsvg) and ie-<name>
// (icons/equipment/<name>.vsvg) class named in its sources, plus the grenades Lineups.cs builds as "ie-" + weapon.
function buildIconCss(has) {
  const sources = [SET_XML_SRC, join(root, 'plugin', 'PracSkins', 'SettingsHud.cs'), join(root, 'plugin', 'PracSkins', 'Lineups.cs')]
  const names = new Set(['ie-smokegrenade', 'ie-flashbang', 'ie-hegrenade', 'ie-molotov', 'ie-decoy'])
  for (const f of sources) for (const m of readFileSync(f, 'utf8').matchAll(/"(i[ce]-[a-z0-9_]+)"/g)) names.add(m[1])
  for (const m of readFileSync(SET_XML_SRC, 'utf8').matchAll(/\b(i[ce]-[a-z0-9_]+)\b/g)) names.add(m[1])
  const rules = []
  for (const cls of [...names].sort()) {
    const path = `panorama/images/icons/${cls.startsWith('ic-') ? 'ui' : 'equipment'}/${cls.slice(3)}.vsvg`
    if (!has(path)) {
      console.warn(`icon missing in the VPK: ${path}`)
      continue
    }
    rules.push(`.ps-ic.${cls}\n{\n\tbackground-image: url("s2r://${path}");\n}`)
  }
  console.log(`icons: ${rules.length}`)
  return rules
}

function buildImageCss(cs2) {
  const vpk = join(cs2, 'game', 'csgo', 'pak01_dir.vpk')
  const files = readVpkDir(vpk)
  const has = (p) => files.has(p + '_c')
  const icons = buildIconCss(has)
  const ig = parseKv(readVpkFile(vpk, files.get('scripts/items/items_game.txt')).toString('utf8'))
  const game = get(ig, 'items_game')

  const items = new Map() // def -> { name, model }
  for (const section of all(game, 'items'))
    for (const [def, body] of section) {
      if (!Array.isArray(body) || !/^\d+$/.test(def)) continue
      const name = get(body, 'name')
      if (name) items.set(Number(def), { name, model: get(body, 'model_player'), image: get(body, 'image_inventory') })
    }
  const paints = new Map() // codename -> index
  for (const section of all(game, 'paint_kits'))
    for (const [idx, body] of section) {
      const name = Array.isArray(body) ? get(body, 'name') : null
      if (name && /^\d+$/.test(idx) && Number(idx) > 0) paints.set(name.toLowerCase(), Number(idx))
    }
  const rarity = new Map()
  for (const section of all(game, 'paint_kits_rarity')) for (const [k, v] of section) rarity.set(k.toLowerCase(), v)

  const base = []
  const skins = []
  const agents = []
  const extras = []
  const itemByName = new Map([...items].map(([def, it]) => [it.name, def]))

  for (const [def, it] of items) {
    const b = `panorama/images/econ/weapons/base_weapons/${it.name}_png.vtex`
    if (has(b)) base.push(`.pk-img.b${def}\n{\n\tbackground-image: url("s2r://${b}");\n}`)
    if (it.model?.endsWith('.vmdl')) {
      const m = it.model.split('/').pop().replace(/\.vmdl$/, '')
      const sq = `panorama/images/econ/characters/customplayer_${m}_square_png.vtex`
      const full = `panorama/images/econ/characters/customplayer_${m}_png.vtex`
      const img = has(sq) ? sq : has(full) ? full : null
      if (img) agents.push(`.pk-img.a${def}\n{\n\tbackground-image: url("s2r://${img}");\n}`)
    }
    const pin = `panorama/images/${it.image}_png.vtex`
    if (it.image?.startsWith('econ/status_icons/') && has(pin)) extras.push(`.pk-img.p${def}\n{\n\tbackground-image: url("s2r://${pin}");\n}`)
  }
  for (const section of all(game, 'music_definitions'))
    for (const [def, body] of section) {
      const image = Array.isArray(body) ? get(body, 'image_inventory') : null
      const img = image && `panorama/images/${image}_png.vtex`
      if (img && /^\d+$/.test(def) && has(img)) extras.push(`.pk-img.m${def}\n{\n\tbackground-image: url("s2r://${img}");\n}`)
    }
  for (const section of all(game, 'sticker_kits'))
    for (const [def, body] of section) {
      if (!Array.isArray(body)) continue
      // graffiti kits: the standard ones are spray_*, tournament ones <event>_team_<x>_graffiti (material too)
      const name = String(get(body, 'name') ?? '')
      const mat = get(body, 'sticker_material')
      const graffiti = name.startsWith('spray_') || String(get(body, 'item_name') ?? '').startsWith('#SprayKit')
        || /graffiti/i.test(name) || /graffiti/i.test(String(mat ?? ''))
      if (!graffiti) continue
      const img = mat && `panorama/images/econ/stickers/${mat}_png.vtex`
      if (img && /^\d+$/.test(def) && has(img)) extras.push(`.pk-img.g${def}\n{\n\tbackground-image: url("s2r://${img}");\n}`)
    }

  // default_generated/<item>_<codename>_light_png: split at the longest item name that leaves a known codename
  const names = [...itemByName.keys()].sort((a, b) => b.length - a.length)
  let unmatched = 0
  for (const path of files.keys()) {
    const m = /^panorama\/images\/econ\/default_generated\/(.+)_light_png\.vtex_c$/.exec(path)
    if (!m) continue
    const stem = m[1]
    let done = false
    for (const n of names) {
      if (!stem.startsWith(n + '_')) continue
      const code = stem.slice(n.length + 1).toLowerCase()
      const paint = paints.get(code)
      if (!paint) continue
      const def = itemByName.get(n)
      const cls = `s${def}_${paint}`
      const knifeOrGlove = /knife|bayonet|gloves|handwraps/.test(n)
      const color = knifeOrGlove ? RARITY.unusual : RARITY[rarity.get(code)] ?? RARITY.common
      skins.push(
        `.pk-img.${cls}\n{\n\tbackground-image: url("s2r://${path.slice(0, -2)}");\n}\n` +
          `.pk-bar.${cls}\n{\n\tbackground-color: ${color};\n}`
      )
      done = true
      break
    }
    if (!done) unmatched++
  }
  console.log(`images: ${base.length} base weapons, ${skins.length} skins, ${agents.length} agents, ${extras.length} pins/music kits (${unmatched} icons unmatched)`)
  // base first: a tile carries b<def> and s<def>_<paint>; the skin rule comes later and wins when it exists
  return [...icons, ...base, ...agents, ...extras, ...skins].join('\n\n') + '\n'
}

const cs2 = findCs2()
const compiler = join(cs2, 'game', 'bin', 'win64', 'resourcecompiler.exe')
if (!existsSync(compiler)) {
  console.error('resourcecompiler.exe missing: install CS2 Workshop Tools (CS2 > Settings > "Install Counter-Strike Workshop Tools").')
  process.exit(1)
}

const content = join(cs2, 'content', 'csgo_addons', ADDON, 'panorama')
const layoutSrc = join(content, 'layout', 'custom_game', `${NAME}.xml`)
const styleSrc = join(content, 'styles', 'custom_game', `${NAME}.css`)
mkdirSync(dirname(layoutSrc), { recursive: true })
mkdirSync(dirname(styleSrc), { recursive: true })
writeFileSync(layoutSrc, buildLayout())
let css = readFileSync(CSS_SRC, 'utf8') + '\n' + readFileSync(SET_CSS_SRC, 'utf8')
writeFileSync(styleSrc, css + '\n' + buildImageCss(cs2))

for (const src of [layoutSrc, styleSrc]) {
  const out = execFileSync(compiler, ['-i', src, '-r'], { encoding: 'utf8' })
  if (/error/i.test(out)) {
    console.error(out)
    process.exit(1)
  }
}

const game = join(cs2, 'game', 'csgo_addons', ADDON, 'panorama')
const outDir = join(root, 'resources', 'hud')
mkdirSync(outDir, { recursive: true })
for (const [sub, ext] of [['layout', 'vxml_c'], ['styles', 'vcss_c']]) {
  const built = join(game, sub, 'custom_game', `${NAME}.${ext}`)
  if (!existsSync(built)) throw new Error(`compiler produced no ${built}`)
  copyFileSync(built, join(outDir, `${NAME}.${ext}`))
  console.log(`resources/hud/${NAME}.${ext}`)
}
