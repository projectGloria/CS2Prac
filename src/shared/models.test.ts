import { describe, expect, it } from 'vitest'
import {
  anchorFor,
  bodyMesh,
  clampToRegion,
  defaultCharmPoint,
  gltfToSource,
  insideRegion,
  modelPathFor,
  sourceToGltf,
  stickerUv,
  uvToStickerOffset,
  type ModelMarkup,
  type StickerAnchor
} from './models'

const LIST = [
  'weapons/models/ak47/weapon_rif_ak47.vmdl_c',
  'weapons/models/ak47/weapon_rif_ak47_mag.vmdl_c',
  'weapons/models/m4a4/weapon_rif_m4a4.vmdl_c',
  'weapons/models/m4a1_silencer/weapon_rif_m4a1_silencer.vmdl_c',
  'weapons/models/knife/knife_m9/weapon_knife_m9.vmdl_c',
  'weapons/models/knife/knife_default_ct/weapon_knife_default_ct.vmdl_c',
  'weapons/models/grenade/molotov/weapon_molotov_broken_glass.vmdl_c',
  'weapons/models/grenade/molotov/weapon_molotov.vmdl_c'
]

const anchor = (o: Partial<StickerAnchor> = {}): StickerAnchor => ({
  index: 0,
  mesh: 'body_hd',
  offset: [0.148, -0.434],
  scale: 14.1,
  rotation: 0,
  special: '',
  polygons: [[0, 0, 1, 0, 0, 1]],
  ...o
})

describe('modelPathFor', () => {
  it('maps classnames to model files', () => {
    expect(modelPathFor('weapon_ak47', LIST)).toBe('weapons/models/ak47/weapon_rif_ak47.vmdl_c')
    expect(modelPathFor('weapon_m4a1', LIST)).toBe('weapons/models/m4a4/weapon_rif_m4a4.vmdl_c')
    expect(modelPathFor('weapon_m4a1_silencer', LIST)).toBe('weapons/models/m4a1_silencer/weapon_rif_m4a1_silencer.vmdl_c')
    expect(modelPathFor('weapon_knife_m9_bayonet', LIST)).toBe('weapons/models/knife/knife_m9/weapon_knife_m9.vmdl_c')
    expect(modelPathFor('weapon_knife', LIST)).toBe('weapons/models/knife/knife_default_ct/weapon_knife_default_ct.vmdl_c')
    expect(modelPathFor('weapon_molotov', LIST)).toBe('weapons/models/grenade/molotov/weapon_molotov.vmdl_c')
  })
  it('returns null for unknown items', () => {
    expect(modelPathFor('sporty_gloves', LIST)).toBeNull()
    expect(modelPathFor('weapon_awp', LIST)).toBeNull()
  })
})

describe('frames', () => {
  it('round-trips Source inches and glTF metres', () => {
    const g = sourceToGltf(10, 1, 2)
    expect(g[2]).toBeCloseTo(0.254)
    expect(g[0]).toBeCloseTo(0.0254)
    expect(g[1]).toBeCloseTo(0.0508)
    const s = gltfToSource(...g)
    expect(s[0]).toBeCloseTo(10)
    expect(s[1]).toBeCloseTo(1)
    expect(s[2]).toBeCloseTo(2)
  })
})

describe('stickers', () => {
  it('places a sticker relative to its anchor and inverts it', () => {
    const a = anchor()
    const uv = stickerUv(a, { x: 0.01, y: -0.02, scale: 1, rotation: 90 })
    expect(uv.u).toBeCloseTo(0.658)
    expect(uv.v).toBeCloseTo(0.046)
    expect(uv.size).toBeCloseTo(1 / 14.1)
    expect(uv.rot).toBeCloseTo(-Math.PI / 2)
    expect(uvToStickerOffset(a, uv.u, uv.v)).toEqual({ x: 0.01, y: -0.02 })
  })
  it('uses scale as a multiplier and treats 0 as 1', () => {
    expect(stickerUv(anchor(), { x: 0, y: 0, scale: 2, rotation: 0 }).size).toBeCloseTo(2 / 14.1)
    expect(stickerUv(anchor(), { x: 0, y: 0, scale: 0, rotation: 0 }).size).toBeCloseTo(1 / 14.1)
  })
  it('finds the anchor per body and slot', () => {
    const m: ModelMarkup = {
      model: '',
      glb: '',
      meshes: ['body_legacy', 'body_hd'],
      texture: null,
      stickers: [anchor({ index: 1 }), anchor({ index: 0, mesh: 'body_legacy', scale: 15 }), anchor({ index: 2 })],
      keychains: [
        { mesh: 'body_hd', bone: '', default: false, corners: [0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 0] },
        { mesh: 'body_hd', bone: '', default: true, corners: [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4] }
      ]
    }
    expect(bodyMesh(m, false)).toBe('body_hd')
    expect(bodyMesh(m, true)).toBe('body_legacy')
    expect(anchorFor(m, 'body_hd', 2)?.index).toBe(2)
    expect(anchorFor(m, 'body_hd', 4)?.index).toBe(1)
    expect(anchorFor(m, 'body_legacy', 3)?.scale).toBe(15)
    expect(defaultCharmPoint(m, 'body_hd')).toEqual([4, 4, 4])
    expect(defaultCharmPoint(m, 'body_legacy')).toBeNull()
  })
  it('clamps to the slot region', () => {
    const a = anchor()
    expect(insideRegion(a.polygons[0], 0.2, 0.2)).toBe(true)
    expect(insideRegion(a.polygons[0], 0.8, 0.8)).toBe(false)
    expect(clampToRegion(a, 0.2, 0.2)).toEqual([0.2, 0.2])
    const [x, y] = clampToRegion(a, 1, 1)
    expect(x).toBeCloseTo(0.5)
    expect(y).toBeCloseTo(0.5)
    expect(clampToRegion(anchor({ polygons: [] }), 5, 5)).toEqual([5, 5])
  })
})
