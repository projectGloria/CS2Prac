// The item site (GitHub Pages): tabs per item kind, search, a tile grid and the same info pop-up as the app
// (src/shared/itemInfo.ts). Data: data/catalog.json, written by scripts/site/gen.ts.
import { itemInfo, type InfoRef } from '../../../src/shared/itemInfo'
import type { Catalog } from '../../../src/shared/skins'

interface Tile {
  name: string
  search: string
  image: string
  color: string
  ref: InfoRef
  group: string
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const PAGE = 120

let catalog: Catalog
let tab = 'skins'
let filter = ''
let shown = PAGE
const tiles = new Map<string, Tile[]>()

const TABS: { id: string; label: string; build: (c: Catalog) => Tile[] }[] = [
  {
    id: 'skins',
    label: 'Weapon skins',
    build: (c) => {
      const weapons = new Map(c.weapons.map((w) => [w.defIndex, w]))
      return c.skins
        .filter((s) => weapons.get(s.defIndex)?.kind === 'weapon')
        .map((s) => {
          const w = weapons.get(s.defIndex)!
          const name = `${w.name} | ${s.name}`
          return { name, search: `${name} ${s.meta?.collections?.join(' ') ?? ''} ${s.meta?.rarity ?? ''}`, image: s.image, color: s.rarityColor, ref: { kind: 'skin', id: s.id }, group: w.category }
        })
    }
  },
  {
    id: 'knives',
    label: 'Knives',
    build: (c) => {
      const knives = c.weapons.filter((w) => w.kind === 'knife')
      const ids = new Set(knives.map((k) => k.defIndex))
      const name = (def: number) => (knives.find((k) => k.defIndex === def)?.name ?? '').replace(/^★\s*/, '')
      return [
        ...knives.map((k) => ({ name: name(k.defIndex), search: name(k.defIndex), image: k.image ?? '', color: '#8847ff', ref: { kind: 'weapon', def: k.defIndex } as InfoRef, group: name(k.defIndex) })),
        ...c.skins
          .filter((s) => ids.has(s.defIndex))
          .map((s) => ({ name: `${name(s.defIndex)} | ${s.name}`, search: `${name(s.defIndex)} ${s.name}`, image: s.image, color: s.rarityColor, ref: { kind: 'skin', id: s.id } as InfoRef, group: name(s.defIndex) }))
      ]
    }
  },
  {
    id: 'gloves',
    label: 'Gloves',
    build: (c) => {
      const gloves = new Map(c.weapons.filter((w) => w.kind === 'glove').map((w) => [w.defIndex, w.name.replace(/^★\s*/, '')]))
      return c.skins
        .filter((s) => gloves.has(s.defIndex))
        .map((s) => ({ name: `${gloves.get(s.defIndex)} | ${s.name}`, search: `${gloves.get(s.defIndex)} ${s.name}`, image: s.image, color: s.rarityColor, ref: { kind: 'skin', id: s.id }, group: gloves.get(s.defIndex)! }))
    }
  },
  {
    id: 'agents',
    label: 'Agents',
    build: (c) => c.agents.map((a) => ({ name: a.name, search: a.name, image: a.image, color: a.rarityColor, ref: { kind: 'agent', def: a.defIndex }, group: a.team === 't' ? 'T' : 'CT' }))
  },
  {
    id: 'stickers',
    label: 'Stickers',
    build: (c) => c.stickers.map((s) => ({ name: s.name, search: `${s.name} ${s.event ?? ''}`, image: s.image, color: s.rarityColor, ref: { kind: 'sticker', def: s.defIndex }, group: s.type }))
  },
  {
    id: 'charms',
    label: 'Charms',
    build: (c) => c.keychains.map((k) => ({ name: k.name, search: k.name, image: k.image, color: k.rarityColor, ref: { kind: 'keychain', def: k.defIndex }, group: k.meta?.rarity ?? '' }))
  },
  {
    id: 'pins',
    label: 'Pins',
    build: (c) => c.pins.map((p) => ({ name: p.name, search: p.name, image: p.image, color: p.rarityColor, ref: { kind: 'pin', def: p.defIndex }, group: p.type }))
  },
  {
    id: 'music',
    label: 'Music kits',
    build: (c) => c.musicKits.map((m) => ({ name: m.name, search: m.name, image: m.image, color: m.rarityColor, ref: { kind: 'music', def: m.defIndex }, group: m.meta?.rarity ?? '' }))
  },
  {
    id: 'graffiti',
    label: 'Graffiti',
    build: (c) => c.graffiti.map((g) => ({ name: g.name, search: g.name, image: g.image, color: g.rarityColor, ref: { kind: 'graffiti', def: g.defIndex }, group: g.meta?.rarity ?? '' }))
  }
]

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...kids)
  return e
}

const tilesOf = (id: string) => {
  if (!tiles.has(id)) tiles.set(id, TABS.find((t) => t.id === id)!.build(catalog))
  return tiles.get(id)!
}

function renderTabs() {
  $('tabs').replaceChildren(
    ...TABS.map((t) =>
      el('button', {
        className: t.id === tab ? 'active' : '',
        textContent: `${t.label} (${tilesOf(t.id).length})`,
        onclick: () => {
          tab = t.id
          filter = ''
          shown = PAGE
          location.hash = t.id
          render()
        }
      })
    )
  )
}

function tileButton(t: { name: string; image: string; color: string; ref: InfoRef }, onClick: () => void) {
  const b = el('button', { className: 'tile', title: t.name, onclick: onClick })
  b.style.borderBottomColor = t.color
  b.append(t.image ? el('img', { src: t.image, loading: 'lazy', alt: '' }) : el('div', { className: 'ph' }), el('span', { textContent: t.name }))
  return b
}

function render() {
  renderTabs()
  const all = tilesOf(tab)
  const groups = [...new Set(all.map((t) => t.group).filter(Boolean))].sort()
  const sel = el('select', { onchange: () => ((filter = sel.value), (shown = PAGE), render()) })
  sel.append(el('option', { value: '', textContent: 'All' }), ...groups.map((g) => el('option', { value: g, textContent: g, selected: g === filter })))
  $('filters').replaceChildren(...(groups.length > 1 ? [sel] : []))
  const words = ($<HTMLInputElement>('q').value || '').toLowerCase().split(/\s+/).filter(Boolean)
  const hits = all.filter((t) => (!filter || t.group === filter) && words.every((w) => t.search.toLowerCase().includes(w)))
  $('count').textContent = `${hits.length} items`
  $('grid').replaceChildren(...hits.slice(0, shown).map((t) => tileButton(t, () => openInfo([t.ref]))))
  $('more').hidden = hits.length <= shown
}

function openInfo(stack: InfoRef[]) {
  const info = itemInfo(catalog, stack[stack.length - 1])
  if (!info) return
  const d = $<HTMLDialogElement>('info')
  const rows = el('table')
  for (const r of info.rows) rows.append(el('tr', {}, el('th', { textContent: r.label }), el('td', { textContent: r.value })))
  const head = el('div', { className: 'head' })
  head.style.borderColor = info.rarityColor
  const side = el('div', {})
  if (stack.length > 1) side.append(el('button', { className: 'link', textContent: '← Back', onclick: () => openInfo(stack.slice(0, -1)) }))
  const sub = el('div', { className: 'sub', textContent: info.subtitle })
  sub.style.color = info.rarityColor
  side.append(sub, rows)
  head.append(info.image ? el('img', { src: info.image, alt: '' }) : el('div', { className: 'ph' }), side)
  const body: Node[] = [
    el('div', { className: 'bar' }, el('h2', { textContent: info.title }), el('button', { className: 'x', textContent: '×', title: 'Close', onclick: () => d.close() })),
    head
  ]
  if (info.flavor) body.push(el('p', { className: 'flavor', textContent: `“${info.flavor}”` }))
  for (const g of info.related) {
    const grid = el('div', { className: 'grid small' })
    grid.append(...g.items.map((it) => tileButton(it, () => openInfo([...stack, it.ref]))))
    body.push(el('h3', { textContent: g.title }), grid)
  }
  d.replaceChildren(...body)
  if (!d.open) d.showModal()
  d.scrollTop = 0
}

async function start() {
  $('grid').textContent = 'Loading items…'
  catalog = (await (await fetch('./data/catalog.json')).json()) as Catalog
  $('updated').textContent = ` · data from ${new Date(catalog.fetchedAt).toISOString().slice(0, 10)}`
  const h = location.hash.slice(1)
  if (TABS.some((t) => t.id === h)) tab = h
  let t: ReturnType<typeof setTimeout>
  $<HTMLInputElement>('q').addEventListener('input', () => {
    clearTimeout(t)
    t = setTimeout(() => ((shown = PAGE), render()), 120)
  })
  $('more').addEventListener('click', () => ((shown += PAGE * 2), render()))
  const d = $<HTMLDialogElement>('info')
  d.addEventListener('click', (e) => e.target === d && d.close())
  render()
}

start().catch((e) => ($('grid').textContent = `Could not load the item data: ${(e as Error).message}`))
