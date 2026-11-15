// Downloads everything the installer ships with, so a fresh install needs no internet for the server tools:
//   resources/bundle/metamod.zip, counterstrikesharp.zip, matchzy.zip   (the pinned versions)
//   resources/bundle/catalog/*.json.gz                                    (skin data snapshot, ByMykel/CSGO-API)
//   resources/bundle/licenses/*                                           (their license texts + notices)
//   resources/bundle/manifest.json                                        (what is in the bundle)
// The pinned versions are read from src/main/setup/plugins.ts and matchzy.ts, so they stay the single source.
// Usage: node scripts/bundle.mjs [--refresh]   (--refresh downloads everything again, incl. the skin data)
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'resources', 'bundle')
const refresh = process.argv.includes('--refresh')

const src = (f) => readFile(join(root, f), 'utf8')
const plugins = await src('src/main/setup/plugins.ts')
const matchzy = await src('src/main/setup/matchzy.ts')
const pick = (text, re, what) => {
  const m = re.exec(text)
  if (!m) throw new Error(`Could not find the pinned ${what} version`)
  return m[1]
}
const versions = {
  metamod: pick(plugins, /metamod:\s*'([^']+)'/, 'Metamod'),
  counterstrikesharp: pick(plugins, /counterstrikesharp:\s*'([^']+)'/, 'CounterStrikeSharp'),
  matchzy: pick(matchzy, /MATCHZY_VERSION\s*=\s*'([^']+)'/, 'MatchZy')
}

const cssNum = versions.counterstrikesharp.replace(/^v/, '')
const zips = {
  metamod: `https://mms.alliedmods.net/mmsdrop/2.0/mmsource-${versions.metamod}-windows.zip`,
  counterstrikesharp: `https://github.com/roflmuffin/CounterStrikeSharp/releases/download/${versions.counterstrikesharp}/counterstrikesharp-with-runtime-windows-${cssNum}.zip`,
  matchzy: `https://github.com/shobhit-pathak/MatchZy/releases/download/${versions.matchzy}/MatchZy-${versions.matchzy}.zip`
}
const CATALOG_API = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/'
const CATALOG_FILES = ['skins.json', 'base_weapons.json', 'agents.json', 'stickers.json', 'keychains.json']
const licenses = {
  'Metamod-Source-LICENSE.txt': 'https://raw.githubusercontent.com/alliedmodders/metamod-source/master/LICENSE.txt',
  'CounterStrikeSharp-LICENSE.txt': `https://raw.githubusercontent.com/roflmuffin/CounterStrikeSharp/${versions.counterstrikesharp}/LICENSE`,
  'CounterStrikeSharp-LICENSE.GPL3.txt': `https://raw.githubusercontent.com/roflmuffin/CounterStrikeSharp/${versions.counterstrikesharp}/LICENSE.GPL3`,
  'CounterStrikeSharp-LICENSE.MIT.txt': `https://raw.githubusercontent.com/roflmuffin/CounterStrikeSharp/${versions.counterstrikesharp}/LICENSE.MIT`,
  'MatchZy-LICENSE.txt': `https://raw.githubusercontent.com/shobhit-pathak/MatchZy/${versions.matchzy}/LICENSE`,
  'CSGO-API-LICENSE.txt': 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/LICENSE'
}

async function get(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`)
  return Buffer.from(await res.arrayBuffer())
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`

let manifest = {}
try {
  manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'))
} catch {
  /* first run */
}
if (refresh) await rm(out, { recursive: true, force: true })
await mkdir(join(out, 'catalog'), { recursive: true })
await mkdir(join(out, 'licenses'), { recursive: true })

const next = { versions: {}, catalogDate: manifest.catalogDate }
for (const [name, url] of Object.entries(zips)) {
  const file = join(out, `${name}.zip`)
  if (!refresh && existsSync(file) && manifest.versions?.[name] === versions[name]) {
    console.log(`${name} ${versions[name]}: already bundled`)
  } else {
    const data = await get(url)
    await writeFile(file, data)
    console.log(`${name} ${versions[name]}: ${mb(data.length)}`)
  }
  next.versions[name] = versions[name]
}

const haveCatalog = CATALOG_FILES.every((f) => existsSync(join(out, 'catalog', f + '.gz')))
if (refresh || !haveCatalog || !manifest.catalogDate) {
  let total = 0
  for (const f of CATALOG_FILES) {
    const gz = gzipSync(await get(CATALOG_API + f), { level: 9 })
    await writeFile(join(out, 'catalog', f + '.gz'), gz)
    total += gz.length
  }
  next.catalogDate = Date.now()
  console.log(`skin data snapshot: ${mb(total)} (gzip)`)
} else {
  console.log(`skin data snapshot: already bundled (${new Date(manifest.catalogDate).toISOString().slice(0, 10)})`)
}

for (const [name, url] of Object.entries(licenses)) {
  if (!refresh && existsSync(join(out, 'licenses', name))) continue
  await writeFile(join(out, 'licenses', name), await get(url))
}
await writeFile(
  join(out, 'licenses', 'THIRD-PARTY-NOTICES.txt'),
  `CS2Prac ships these third-party programs and data unchanged. Their licenses are in this folder.

Metamod:Source ${versions.metamod}
  License: zlib/libpng (Metamod-Source-LICENSE.txt)
  Source:  https://github.com/alliedmodders/metamod-source

CounterStrikeSharp ${versions.counterstrikesharp} (with .NET runtime)
  License: GPL-3.0, with an exception that lets plugins use MIT (CounterStrikeSharp-LICENSE*.txt)
  Source:  https://github.com/roflmuffin/CounterStrikeSharp/tree/${versions.counterstrikesharp}
  The corresponding source code is at that address; it is not modified by CS2Prac.

MatchZy ${versions.matchzy}
  License: MIT (MatchZy-LICENSE.txt)
  Source:  https://github.com/shobhit-pathak/MatchZy/tree/${versions.matchzy}

CSGO-API skin data (ByMykel)
  License: MIT (CSGO-API-LICENSE.txt)
  Source:  https://github.com/ByMykel/CSGO-API

Counter-Strike 2 and all in-game items, names and images are property of Valve Corporation.
CS2Prac is not affiliated with or endorsed by Valve.
`
)
await writeFile(join(out, 'manifest.json'), JSON.stringify(next, null, 2))
console.log(`bundle ready in ${out}`)
