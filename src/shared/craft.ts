/**
 * Random craft for one gun: the app's twin of plugin/PracSkins/Craft.cs (same odds). A finish with wear in its
 * range and a seed, StatTrak 1 in 5, stickers 4 in 5 (1–5 slots, themed: mixed, one sticker several times, one
 * tournament, one finish such as Holo/Gold), a charm 1 in 3.
 */
import { MAX_SEED, STICKER_SLOTS, type CatalogKeychain, type CatalogSkin, type CatalogSticker, type SkinSel, type StickerSel } from './skins'

export interface CraftRoll {
  sel: SkinSel
  /** sticker theme shown to the user ('' = no stickers) */
  theme: string
}

const FINISHES = ['Holo', 'Gold', 'Foil', 'Glitter', 'Lenticular']

export function rollCraft(
  skins: CatalogSkin[],
  stickers: CatalogSticker[],
  keychains: CatalogKeychain[],
  rnd: () => number = Math.random
): CraftRoll | null {
  if (skins.length === 0) return null
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1)) // inclusive
  const pick = <T,>(list: T[]) => list[Math.floor(rnd() * list.length)]
  const skin = pick(skins)
  const wear = Math.round((skin.minFloat + rnd() * Math.max(0, skin.maxFloat - skin.minFloat)) * 1e6) / 1e6
  const sel: SkinSel = {
    paintKit: skin.paintKit,
    wear,
    seed: int(0, MAX_SEED),
    statTrak: int(0, 4) === 0 ? int(0, 2499) : null,
    nameTag: '',
    legacyModel: skin.legacyModel,
    stickers: Array<StickerSel | null>(STICKER_SLOTS).fill(null),
    keychain: null
  }

  let theme = ''
  if (stickers.length > 0 && int(0, 4) !== 0) {
    const count = int(1, STICKER_SLOTS)
    const slots = [...Array(STICKER_SLOTS).keys()].sort(() => rnd() - 0.5).slice(0, count)
    let pool = stickers
    let only: CatalogSticker | null = null
    theme = 'mixed'
    switch (int(0, 3)) {
      case 1:
        only = pick(stickers)
        theme = count > 1 ? `${count}× the same` : 'single'
        break
      case 2: {
        const byEvent = new Map<string, CatalogSticker[]>()
        for (const s of stickers) if (s.event) byEvent.set(s.event, [...(byEvent.get(s.event) ?? []), s])
        const events = [...byEvent].filter(([, l]) => l.length >= 5)
        if (events.length > 0) {
          const [name, list] = pick(events)
          pool = list
          theme = name
        }
        break
      }
      case 3: {
        const finish = pick(FINISHES)
        const list = stickers.filter((s) => s.name.toLowerCase().includes(`(${finish.toLowerCase()})`))
        if (list.length > 0) {
          pool = list
          theme = `all ${finish}`
        }
        break
      }
    }
    const tilted = int(0, 2) === 0
    const nudge = () => (int(0, 2) === 0 ? Math.round((rnd() - 0.5) * 0.06 * 1e4) / 1e4 : 0)
    for (const slot of slots)
      sel.stickers![slot] = {
        defIndex: (only ?? pick(pool)).defIndex,
        wear: int(0, 3) === 0 ? Math.round(rnd() * 0.6 * 1000) / 1000 : 0,
        scale: 1,
        rotation: tilted ? int(-30, 30) : 0,
        x: nudge(),
        y: nudge()
      }
  }
  if (keychains.length > 0 && int(0, 2) === 0) sel.keychain = { defIndex: pick(keychains).defIndex, x: 0, y: 0, z: 0, seed: int(0, 100000) }
  return { sel, theme }
}
