// npm run build:site  -> site/ (the GitHub Pages item site: scripts/site/app bundled with vite + data/catalog.json)
// npm run build:docs  -> docs/items/*.md (generated item docs)
// Both build the catalog the way the app does (src/main/skins/catalog.ts, bundled for Node with `electron` stubbed).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..', '..')
const want = process.argv.slice(2)
const doSite = want.length === 0 || want.includes('site')
const doDocs = want.length === 0 || want.includes('docs')
const alias = { '@shared': join(root, 'src', 'shared') }
const siteDir = join(root, 'site')

if (doSite)
  await build({
    configFile: false,
    root: join(root, 'scripts', 'site', 'app'),
    base: './',
    logLevel: 'warn',
    resolve: { alias },
    build: { outDir: siteDir, emptyOutDir: true }
  })

const tmp = mkdtempSync(join(tmpdir(), 'cs2prac-site-'))
try {
  await build({
    configFile: false,
    logLevel: 'warn',
    resolve: { alias: { ...alias, electron: join(root, 'scripts', 'site', 'electron-stub.ts') } },
    build: {
      ssr: join(root, 'scripts', 'site', 'gen.ts'),
      outDir: tmp,
      emptyOutDir: true,
      rollupOptions: { output: { format: 'es', entryFileNames: 'gen.mjs' } }
    },
    ssr: { noExternal: true }
  })
  const gen = await import(pathToFileURL(join(tmp, 'gen.mjs')).href)
  await gen.main(root, doSite ? siteDir : null, doDocs ? join(root, 'docs', 'items') : null)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
