// 3D skin editor (Phase 14): weapon model files exported from the local CS2 install by resources/modeltool, and the
// math that maps the game's sticker / charm offsets onto them.
//
// Stickers: CS2 does not project stickers, it composites them in the weapon's second UV set (TEXCOORD_1, three.js
// `uv1`). A slot's anchor comes from the model's StickerMarkup (same Index, same body): the sticker is centred at
//   u = anchor.offset[0] + x + 0.5,  v = anchor.offset[1] + y + 0.5
// spans scale / anchor.scale of the unwrap and is turned by -rotation degrees. Polygons are the slot's allowed region
// (triangle soup in the same "offset space", uv1 − 0.5).
// Charms: keychain offset x/y/z are absolute Source inches in the weapon's model frame (x muzzle, y left, z up), the
// same frame as the KeychainMarkup corners. The exported .glb is that frame swizzled to glTF (Y up) and in metres.

/** a StickerMarkup entry */
export interface StickerAnchor {
  index: number
  /** body_hd or body_legacy */
  mesh: string
  /** uv1 − 0.5 of the slot's default centre */
  offset: [number, number]
  scale: number
  rotation: number
  special: string
  /** triangle soup (x, y pairs) in offset space */
  polygons: number[][]
}

/** a KeychainMarkup entry: a quad (4 corners × xyz, Source inches) a charm may hang from */
export interface KeychainQuad {
  mesh: string
  bone: string
  default: boolean
  corners: number[]
}

/** <name>.json written by ModelExport */
export interface ModelMarkup {
  model: string
  glb: string
  meshes: string[]
  texture: string | null
  stickers: StickerAnchor[]
  keychains: KeychainQuad[]
}

/** what models.get hands the renderer */
export interface WeaponModelData {
  markup: ModelMarkup
  glb: Uint8Array
  /** base colour texture as a data URL */
  texture: string | null
}

export type ModelResult = { ok: true; model: WeaponModelData } | { ok: false; error: string }

/** model filenames that are attachments or variants, not the weapon itself */
const NOT_A_WEAPON = /_(mag|ag2|dropped|world|display|broken_glass)/

/** classnames whose model folder isn't the classname minus "weapon_" */
const MODEL_FOLDER: Record<string, string> = {
  weapon_m4a1: 'm4a4',
  weapon_knife: 'knife_default_ct',
  weapon_knife_t: 'knife_default_t',
  weapon_bayonet: 'knife_bayonet',
  weapon_knife_m9_bayonet: 'knife_m9',
  weapon_knife_survival_bowie: 'knife_bowie',
  weapon_knife_gypsy_jackknife: 'knife_navaja',
  weapon_knife_widowmaker: 'knife_talon'
}

/** The weapon's model in the VPK listing (`ModelExport list`), or null (gloves, unknown items). */
export function modelPathFor(className: string, list: string[]): string | null {
  const folder = MODEL_FOLDER[className] ?? className.replace(/^weapon_/, '')
  if (!folder || folder === className) return null
  for (const p of list) {
    const parts = p.split('/')
    if (parts[parts.length - 2] === folder && !NOT_A_WEAPON.test(parts[parts.length - 1])) return p
  }
  return null
}

export const SOURCE_TO_METRES = 0.0254

/** Source model frame (inches, z up) → glTF frame of the exported model (metres, y up) */
export function sourceToGltf(x: number, y: number, z: number): [number, number, number] {
  return [y * SOURCE_TO_METRES, z * SOURCE_TO_METRES, x * SOURCE_TO_METRES]
}

export function gltfToSource(gx: number, gy: number, gz: number): [number, number, number] {
  return [gz / SOURCE_TO_METRES, gx / SOURCE_TO_METRES, gy / SOURCE_TO_METRES]
}

/** The body mesh a weapon is drawn with: legacy finishes use the old CS:GO body. */
export function bodyMesh(markup: ModelMarkup, legacy: boolean): string {
  const want = legacy ? 'body_legacy' : 'body_hd'
  if (markup.meshes.includes(want)) return want
  return markup.meshes.find((m) => !m.includes('legacy')) ?? markup.meshes[0] ?? want
}

/** The StickerMarkup anchor of a slot on a body (falls back to the body's lowest index, as the game does). */
export function anchorFor(markup: ModelMarkup, mesh: string, slot: number): StickerAnchor | null {
  const onBody = markup.stickers.filter((s) => s.mesh === mesh)
  return onBody.find((s) => s.index === slot) ?? [...onBody].sort((a, b) => a.index - b.index)[0] ?? null
}

/** sticker slots this body has */
export function stickerSlots(markup: ModelMarkup, mesh: string): number {
  return new Set(markup.stickers.filter((s) => s.mesh === mesh).map((s) => s.index)).size
}

export const STICKER_ROT_SIGN = -1

/** where and how big a sticker is in uv1 */
export interface StickerUv {
  u: number
  v: number
  /** side length in uv1 units */
  size: number
  /** radians, already with the game's sign */
  rot: number
}

export function stickerUv(anchor: StickerAnchor, st: { x: number; y: number; scale: number; rotation: number }): StickerUv {
  return {
    u: anchor.offset[0] + st.x + 0.5,
    v: anchor.offset[1] + st.y + 0.5,
    size: (st.scale > 0 ? st.scale : 1) / (anchor.scale || 1),
    rot: (STICKER_ROT_SIGN * st.rotation * Math.PI) / 180
  }
}

/** sticker x/y for a uv1 point (the inverse of stickerUv's centre) */
export function uvToStickerOffset(anchor: StickerAnchor, u: number, v: number): { x: number; y: number } {
  return { x: round4(u - 0.5 - anchor.offset[0]), y: round4(v - 0.5 - anchor.offset[1]) }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000

/** Is (px, py) (offset space) inside one of the region's triangles? */
export function insideRegion(region: number[], px: number, py: number): boolean {
  for (let t = 0; t + 5 < region.length; t += 6) {
    const [ax, ay, bx, by, cx, cy] = region.slice(t, t + 6)
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (Math.abs(d) < 1e-12) continue
    const w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d
    const w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d
    if (w0 >= -1e-6 && w1 >= -1e-6 && 1 - w0 - w1 >= -1e-6) return true
  }
  return false
}

/** The point of the anchor's polygons closest to (px, py) in offset space; (px, py) itself when inside or when the
 *  anchor has no region. */
export function clampToRegion(anchor: StickerAnchor, px: number, py: number): [number, number] {
  const tris = anchor.polygons.filter((p) => p.length >= 6)
  if (!tris.length || tris.some((r) => insideRegion(r, px, py))) return [px, py]
  let best: [number, number] = [px, py]
  let bestD = Infinity
  for (const r of tris)
    for (let t = 0; t + 5 < r.length; t += 6)
      for (let e = 0; e < 3; e++) {
        const ax = r[t + e * 2], ay = r[t + e * 2 + 1]
        const bx = r[t + ((e + 1) % 3) * 2], by = r[t + ((e + 1) % 3) * 2 + 1]
        const dx = bx - ax, dy = by - ay
        const l2 = dx * dx + dy * dy
        const f = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0
        const qx = ax + dx * f, qy = ay + dy * f
        const d = (qx - px) ** 2 + (qy - py) ** 2
        if (d < bestD) {
          bestD = d
          best = [qx, qy]
        }
      }
  return best
}

/** Centre of a keychain quad (Source inches). */
export function quadCentre(q: KeychainQuad): [number, number, number] {
  const c: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 4; i++) for (let a = 0; a < 3; a++) c[a] += q.corners[i * 3 + a] / 4
  return c
}

/** Where an unplaced charm (offsets 0,0,0) hangs: the default quad, else the first one of the body. */
export function defaultCharmPoint(markup: ModelMarkup, mesh: string): [number, number, number] | null {
  const quads = markup.keychains.filter((k) => k.mesh === mesh)
  const q = quads.find((k) => k.default) ?? quads[0]
  return q ? quadCentre(q) : null
}

/** A placed charm point (Source inches), rounded the way it is stored. */
export function charmOffset(p: [number, number, number]): { x: number; y: number; z: number } {
  const r = (n: number) => Math.round(n * 100) / 100
  return { x: r(p[0]), y: r(p[1]), z: r(p[2]) }
}
