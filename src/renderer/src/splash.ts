/**
 * The start-up splash (static markup in index.html, so it shows before this script runs).
 * App.tsx calls warmUp() while the app renders underneath, then hideSplash() once everything is in place.
 */

import splashArt from '../../../assets/CS2Prac.png'

const MIN_MS = 4000 // the user wants to see it and let everything load
const MAX_MS = 10000 // never wait longer than this (e.g. a slow first skin download)

const started = performance.now()

// The art goes in through an import so Vite serves it in dev and bundles it in builds; the window is shown
// (main, app:splashReady) only once it has decoded, so the splash never appears without it.
const art = document.getElementById('splash-img') as HTMLImageElement | null
if (art) {
  art.src = splashArt
  art
    .decode()
    .catch(() => undefined)
    .then(() => requestAnimationFrame(() => window.api.app.splashReady()))
} else window.api.app.splashReady()

export function splashText(text: string) {
  const el = document.getElementById('splash-text')
  if (el) el.textContent = text
}

/** Decodes an image so it shows at once when its page opens. Failures don't matter here. */
function preloadImage(url: string): Promise<void> {
  const img = new Image()
  img.src = url
  return img.decode().catch(() => undefined)
}

const ICONS = [
  ...Object.values(import.meta.glob('../../../assets/map-icons/*.png', { eager: true, query: '?url', import: 'default' })),
  ...Object.values(import.meta.glob('../../../assets/cs-icons/*.svg', { eager: true, query: '?url', import: 'default' }))
] as string[]

/** Loads what the pages need up front: images, the map list, settings and the skin catalog (cached in main). */
export async function warmUp(): Promise<void> {
  const steps = (async () => {
    splashText('Loading images…')
    await Promise.all(ICONS.map(preloadImage))
    splashText('Loading settings…')
    await Promise.all([window.api.settings.get(), window.api.server.listMaps(), window.api.server.connectInfo()]).catch(() => undefined)
    splashText('Loading skins…')
    await window.api.skins.getCatalog().catch(() => undefined) // the Loadout tab shows its own error if this failed
    splashText('Ready')
  })()
  await Promise.race([steps, new Promise((r) => setTimeout(r, MAX_MS))])
}

export async function hideSplash() {
  const el = document.getElementById('splash')
  if (!el) return
  const wait = MIN_MS - (performance.now() - started)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  // two frames so the app underneath has laid out before it is revealed
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  el.classList.add('done')
  setTimeout(() => el.remove(), 400)
}
