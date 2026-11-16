/**
 * !gen codes and CS2 inspect links, decoded locally (no inspect API, no game coordinator).
 *
 * - `!gen <def> <paint> <seed> <wear> [<sticker> <wear>]×5 [<charm> <charm seed>]` (also `!g`); sticker 0 = empty slot.
 * - Inspect links that carry the item itself: `…csgo_econ_action_preview <HEX>`. The hex is a CEconItemPreviewDataBlock
 *   protobuf, every byte XORed with the first byte, followed by a 4-byte checksum. Links of the old `S…A…D…` form
 *   only point at an item in someone's inventory; reading those needs the game coordinator, so they are refused.
 *
 * Same rules as plugin/PracSkins/ItemCode.cs (chat `!gen`).
 */
import { MAX_NAMETAG, MAX_SEED, STICKER_SLOTS, type KeychainSel, type Profile, type SkinSel, type StickerSel, type Team } from './skins'

export interface ImportedItem {
  defIndex: number
  paintKit: number
  seed: number
  wear: number
  /** kill count, null = no StatTrak */
  statTrak: number | null
  nameTag: string
  /** STICKER_SLOTS entries, null = empty */
  stickers: (StickerSel | null)[]
  keychain: KeychainSel | null
}

export type ParseResult = { ok: true; item: ImportedItem; kind: 'gen' | 'inspect' } | { ok: false; error: string }

const emptySlots = (): (StickerSel | null)[] => Array.from({ length: STICKER_SLOTS }, () => null)
const round = (v: number, digits = 6) => Number(v.toFixed(digits))

export function parseItemCode(text: string): ParseResult {
  const t = text.trim()
  if (!t) return { ok: false, error: 'Paste a !gen code or an inspect link.' }
  if (/csgo_econ_action_preview|^steam:\/\//i.test(t) || /^[0-9a-f]{20,}$/i.test(t)) return parseInspectLink(t)
  return parseGenCode(t)
}

// ---------------------------------------------------------------- !gen

export function parseGenCode(text: string): ParseResult {
  const parts = text.trim().replace(/^[!/.]?(gen|g)\b/i, '').trim().split(/\s+/).filter(Boolean)
  if (parts.length < 4) return { ok: false, error: 'A !gen code needs at least: weapon, paint, seed and wear.' }
  const n = parts.map(Number)
  if (n.some((v) => !Number.isFinite(v))) return { ok: false, error: 'A !gen code holds numbers only.' }
  const [def, paint, seed, wear, ...rest] = n
  if (!Number.isInteger(def) || def <= 0 || !Number.isInteger(paint) || paint < 0)
    return { ok: false, error: 'The weapon and paint numbers are not valid.' }
  if (wear < 0 || wear > 1) return { ok: false, error: 'Wear must be between 0 and 1.' }

  const stickers = emptySlots()
  let i = 0
  for (let slot = 0; slot < STICKER_SLOTS && i + 1 < rest.length; slot++, i += 2) {
    const id = Math.trunc(rest[i])
    if (id > 0) stickers[slot] = { defIndex: id, wear: clamp01(rest[i + 1]), scale: 1, rotation: 0, x: 0, y: 0 }
  }
  const charm = i < rest.length ? Math.trunc(rest[i]) : 0
  const keychain = charm > 0 ? { defIndex: charm, x: 0, y: 0, z: 0, seed: Math.trunc(rest[i + 1] ?? 0) } : null
  return {
    ok: true,
    kind: 'gen',
    item: { defIndex: def, paintKit: paint, seed: Math.trunc(seed), wear: round(wear), statTrak: null, nameTag: '', stickers, keychain }
  }
}

/** `!gen` code for an item (stickers and charm only when there are any) */
export function toGenCode(item: Pick<ImportedItem, 'defIndex' | 'paintKit' | 'seed' | 'wear'> & Partial<ImportedItem>): string {
  const parts: (string | number)[] = ['!gen', item.defIndex, item.paintKit, item.seed, fmt(item.wear)]
  const stickers = item.stickers ?? []
  if (stickers.some(Boolean) || item.keychain) {
    for (let s = 0; s < STICKER_SLOTS; s++) {
      const st = stickers[s]
      parts.push(st?.defIndex ?? 0, fmt(st?.wear ?? 0))
    }
    if (item.keychain) parts.push(item.keychain.defIndex, item.keychain.seed)
  }
  return parts.join(' ')
}

const fmt = (v: number) => String(round(v))
const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

// ---------------------------------------------------------------- inspect links

/** CEconItemPreviewDataBlock field numbers */
const F = { defindex: 3, paintindex: 4, quality: 6, paintwear: 7, paintseed: 8, killeatertype: 9, killeatervalue: 10, customname: 11, stickers: 12, keychains: 20 }
/** CEconItemPreviewDataBlock.Sticker */
const S = { slot: 1, id: 2, wear: 3, scale: 4, rotation: 5, tint: 6, x: 7, y: 8, z: 9, pattern: 10 }

type Field = { no: number; wire: number; num: number; f32: number; bytes: Uint8Array }

export function parseInspectLink(text: string): ParseResult {
  let t = text.trim()
  try {
    t = decodeURIComponent(t)
  } catch {
    /* keep as is */
  }
  // S<owner>A<asset>D<n> / M<market>A<asset>D<n> (hex never contains S or M)
  if (/[SM]\d+A\d+D\d+/.test(t))
    return {
      ok: false,
      error: 'This inspect link points at an item in a Steam inventory; reading it needs the game coordinator. Use a link with the item data (or a !gen code).'
    }
  const hex = t.match(/([0-9a-f]{20,})\s*$/i)?.[1] ?? t.match(/[0-9a-f]{20,}/i)?.[0]
  if (!hex || hex.length % 2) return { ok: false, error: 'No item data found in this link.' }
  const raw = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)))
  const key = raw[0]
  const data = raw.map((b) => b ^ key)
  if (data.length < 6) return { ok: false, error: 'The item data is too short.' }
  let fields: Field[]
  try {
    fields = readMessage(data.subarray(1, data.length - 4))
  } catch {
    return { ok: false, error: 'The item data could not be read.' }
  }
  const one = (no: number) => fields.find((f) => f.no === no)
  const def = one(F.defindex)?.num ?? 0
  if (!def) return { ok: false, error: 'The item data has no weapon.' }

  const stickers = emptySlots()
  for (const f of fields.filter((f) => f.no === F.stickers)) {
    const s = readMessage(f.bytes)
    const get = (no: number) => s.find((x) => x.no === no)
    const slot = get(S.slot)?.num ?? 0
    const id = get(S.id)?.num ?? 0
    if (id <= 0 || slot < 0 || slot >= STICKER_SLOTS) continue
    const scale = get(S.scale)?.f32 ?? 0
    stickers[slot] = {
      defIndex: id,
      wear: round(clamp01(get(S.wear)?.f32 ?? 0)),
      scale: scale > 0 ? round(scale) : 1,
      rotation: round(get(S.rotation)?.f32 ?? 0),
      x: round(get(S.x)?.f32 ?? 0),
      y: round(get(S.y)?.f32 ?? 0)
    }
  }
  let keychain: KeychainSel | null = null
  const kc = fields.find((f) => f.no === F.keychains)
  if (kc) {
    const s = readMessage(kc.bytes)
    const get = (no: number) => s.find((x) => x.no === no)
    const id = get(S.id)?.num ?? 0
    if (id > 0)
      keychain = {
        defIndex: id,
        x: round(get(S.x)?.f32 ?? 0),
        y: round(get(S.y)?.f32 ?? 0),
        z: round(get(S.z)?.f32 ?? 0),
        seed: get(S.pattern)?.num ?? 0
      }
  }
  const wearBits = one(F.paintwear)
  const wear = wearBits ? (wearBits.wire === 5 ? wearBits.f32 : bitsToFloat(wearBits.num)) : 0
  const st = one(F.killeatertype) || one(F.killeatervalue) ? (one(F.killeatervalue)?.num ?? 0) : null
  return {
    ok: true,
    kind: 'inspect',
    item: {
      defIndex: def,
      paintKit: one(F.paintindex)?.num ?? 0,
      seed: one(F.paintseed)?.num ?? 0,
      wear: round(clamp01(wear)),
      statTrak: st,
      nameTag: new TextDecoder().decode(one(F.customname)?.bytes ?? new Uint8Array()).slice(0, 20),
      stickers,
      keychain
    }
  }
}

function bitsToFloat(bits: number): number {
  const v = new DataView(new ArrayBuffer(4))
  v.setUint32(0, bits >>> 0)
  return v.getFloat32(0)
}

function readMessage(buf: Uint8Array): Field[] {
  const out: Field[] = []
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let p = 0
  const varint = () => {
    let r = 0
    let mul = 1
    for (let i = 0; i < 10; i++) {
      if (p >= buf.length) throw new Error('eof')
      const b = buf[p++]
      r += (b & 0x7f) * mul
      mul *= 128
      if (!(b & 0x80)) return r
    }
    throw new Error('varint')
  }
  while (p < buf.length) {
    const tag = varint()
    const no = Math.floor(tag / 8)
    const wire = tag & 7
    const f: Field = { no, wire, num: 0, f32: 0, bytes: new Uint8Array() }
    if (wire === 0) f.num = varint()
    else if (wire === 5) {
      if (p + 4 > buf.length) throw new Error('eof')
      f.num = dv.getUint32(p, true)
      f.f32 = dv.getFloat32(p, true)
      p += 4
    } else if (wire === 1) {
      if (p + 8 > buf.length) throw new Error('eof')
      p += 8
    } else if (wire === 2) {
      const len = varint()
      if (p + len > buf.length) throw new Error('eof')
      f.bytes = buf.subarray(p, p + len)
      p += len
    } else throw new Error('wire type')
    out.push(f)
  }
  return out
}

// ---- encoding (unmasked, key 0): "Copy inspect link" and tests ----

function writeVarint(out: number[], v: number) {
  let n = Math.max(0, Math.trunc(v))
  while (n >= 0x80) {
    out.push((n % 128) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
}

function writeFloat(out: number[], no: number, v: number) {
  writeVarint(out, no * 8 + 5)
  const b = new Uint8Array(4)
  new DataView(b.buffer).setFloat32(0, v, true)
  out.push(...b)
}

function writeUint(out: number[], no: number, v: number) {
  writeVarint(out, no * 8)
  writeVarint(out, v)
}

function writeBytes(out: number[], no: number, bytes: number[] | Uint8Array) {
  writeVarint(out, no * 8 + 2)
  writeVarint(out, bytes.length)
  out.push(...bytes)
}

const floatBits = (v: number) => {
  const dv = new DataView(new ArrayBuffer(4))
  dv.setFloat32(0, v)
  return dv.getUint32(0)
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf: number[]) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** hex of an unmasked preview block (the game accepts these in `csgo_econ_action_preview`) */
export function encodeInspectData(item: ImportedItem): string {
  const proto: number[] = []
  writeUint(proto, F.defindex, item.defIndex)
  writeUint(proto, F.paintindex, item.paintKit)
  writeUint(proto, F.quality, item.statTrak !== null ? 9 : 4)
  writeUint(proto, F.paintwear, floatBits(item.wear))
  writeUint(proto, F.paintseed, item.seed)
  if (item.statTrak !== null) {
    writeUint(proto, F.killeatertype, 0)
    writeUint(proto, F.killeatervalue, item.statTrak)
  }
  if (item.nameTag) writeBytes(proto, F.customname, new TextEncoder().encode(item.nameTag))
  item.stickers.forEach((s, slot) => {
    if (!s) return
    const m: number[] = []
    writeUint(m, S.slot, slot)
    writeUint(m, S.id, s.defIndex)
    if (s.wear) writeFloat(m, S.wear, s.wear)
    if (s.scale !== 1) writeFloat(m, S.scale, s.scale)
    if (s.rotation) writeFloat(m, S.rotation, s.rotation)
    if (s.x) writeFloat(m, S.x, s.x)
    if (s.y) writeFloat(m, S.y, s.y)
    writeBytes(proto, F.stickers, m)
  })
  if (item.keychain) {
    const k = item.keychain
    const m: number[] = []
    writeUint(m, S.slot, 0)
    writeUint(m, S.id, k.defIndex)
    if (k.x) writeFloat(m, S.x, k.x)
    if (k.y) writeFloat(m, S.y, k.y)
    if (k.z) writeFloat(m, S.z, k.z)
    writeUint(m, S.pattern, k.seed)
    writeBytes(proto, F.keychains, m)
  }
  const buf = [0, ...proto]
  const crc = crc32(buf)
  const x = ((crc & 0xffff) ^ Math.imul(proto.length, crc)) >>> 0
  buf.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255)
  return buf.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}

export const inspectLink = (item: ImportedItem) =>
  `steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20${encodeInspectData(item)}`

// ---- applying to a profile ----

export type ImportTarget = { kind: 'weapon' | 'knife' | 'glove'; name: string; className: string }

/**
 * Puts an imported item into the profile for one team. `weapon` looks the def index up in the catalog (null = unknown
 * item); `legacy` says whether the finish uses the old model. Knives and gloves take no stickers or charm.
 */
export function applyImported(
  profile: Profile,
  team: Team,
  item: ImportedItem,
  weapon: (def: number) => ImportTarget | null,
  legacy: (def: number, paint: number) => boolean
): Profile {
  const w = weapon(item.defIndex)
  if (!w) return profile
  const seed = Math.min(MAX_SEED, Math.max(0, item.seed))
  if (w.kind === 'glove')
    return {
      ...profile,
      gloves: { ...profile.gloves, [team]: { defIndex: item.defIndex, paintKit: item.paintKit, wear: item.wear, seed } }
    }
  const base: SkinSel = {
    paintKit: item.paintKit,
    wear: item.wear,
    seed,
    statTrak: item.statTrak,
    nameTag: item.nameTag.slice(0, MAX_NAMETAG),
    legacyModel: legacy(item.defIndex, item.paintKit)
  }
  if (w.kind === 'knife')
    return { ...profile, knife: { ...profile.knife, [team]: { ...base, defIndex: item.defIndex, className: w.className } } }
  const sel: SkinSel = { ...base, stickers: item.stickers.map((s) => (s ? { ...s } : null)), keychain: item.keychain ? { ...item.keychain } : null }
  return { ...profile, weapons: { ...profile.weapons, [team]: { ...profile.weapons[team], [item.defIndex]: sel } } }
}

/** the import shape of what the profile holds for a weapon/knife/glove def (for "Copy !gen") */
export function itemOf(profile: Profile, team: Team, kind: 'weapon' | 'knife' | 'glove', def: number): ImportedItem | null {
  if (kind === 'glove') {
    const g = profile.gloves[team]
    return g ? { defIndex: g.defIndex, paintKit: g.paintKit, seed: g.seed, wear: g.wear, statTrak: null, nameTag: '', stickers: emptySlots(), keychain: null } : null
  }
  const sel = kind === 'knife' ? profile.knife[team] : profile.weapons[team][def]
  if (!sel) return null
  const d = kind === 'knife' ? (profile.knife[team]?.defIndex ?? def) : def
  return {
    defIndex: d,
    paintKit: sel.paintKit,
    seed: sel.seed,
    wear: sel.wear,
    statTrak: sel.statTrak,
    nameTag: sel.nameTag,
    stickers: Array.from({ length: STICKER_SLOTS }, (_, i) => sel.stickers?.[i] ?? null),
    keychain: sel.keychain ?? null
  }
}
