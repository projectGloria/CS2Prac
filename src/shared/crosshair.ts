/**
 * CS2 crosshair share codes and cvars (Look page). The code layouts follow akiver/csgo-sharecode (MIT, Copyright (c)
 * 2017-present AkiVer): the `CS…` code CS2 produces since its 30/09/2026 update (32 bytes) and the older
 * `CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx` pixel codes (legacy v3/v4, 18 bytes), which are converted on import. Both are
 * base 57 over the same alphabet, least significant character first.
 * Sizes are integers in pixels at `screenHeight` (the game scales them to the real screen height).
 */

export interface Crosshair {
  /** 0 Dynamic Cross … 9 Static Quad (CROSSHAIR_STYLES) */
  style: number
  followRecoil: boolean
  centerDot: boolean
  tStyle: boolean
  red: number
  green: number
  blue: number
  alpha: number
  outlineRed: number
  outlineGreen: number
  outlineBlue: number
  outlineAlpha: number
  /** 0 none, 1 full, 2 half */
  outlineMode: number
  thickness: number
  gap: number
  length: number
  dynamicSpreadLimit: number
  splitDistance: number
  innerSplitAlpha: number
  outerSplitAlpha: number
  splitSizeRatio: number
  scopeDotUseCrosshairColor: boolean
  scopeDotScale: number
  screenHeight: number
}

export const CROSSHAIR_STYLES = [
  'Dynamic Cross',
  'Dynamic Circle',
  'Dynamic Cross (Legacy)',
  'Static Circle',
  'Static Cross',
  'Static Cross (Shot Feedback)',
  'Dot Only',
  'Dynamic Quad',
  'Static Square',
  'Static Quad'
]

export const DEFAULT_CROSSHAIR: Crosshair = {
  style: 4,
  followRecoil: false,
  centerDot: false,
  tStyle: false,
  red: 0,
  green: 255,
  blue: 0,
  alpha: 255,
  outlineRed: 0,
  outlineGreen: 0,
  outlineBlue: 0,
  outlineAlpha: 255,
  outlineMode: 1,
  thickness: 2,
  gap: 2,
  length: 8,
  dynamicSpreadLimit: 64,
  splitDistance: 7,
  innerSplitAlpha: 0,
  outerSplitAlpha: 1,
  splitSizeRatio: 0.3,
  scopeDotUseCrosshairColor: false,
  scopeDotScale: 1,
  screenHeight: 1080
}

const DICTIONARY = 'ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789'
const BASE = BigInt(DICTIONARY.length)
const CS2_CHARS = 44
const CS2_BYTES = 32
const LEGACY_CHARS = 25
const LEGACY_BYTES = 18

export class InvalidShareCode extends Error {
  constructor(message = 'Not a valid crosshair code') {
    super(message)
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo))
const sum = (bytes: number[]) => bytes.reduce((a, b) => a + b, 0)

function charsToBytes(chars: string, byteCount: number): number[] {
  let big = 0n
  for (const c of [...chars].reverse()) {
    const i = DICTIONARY.indexOf(c)
    if (i < 0) throw new InvalidShareCode(`'${c}' can't appear in a crosshair code`)
    big = big * BASE + BigInt(i)
  }
  const hex = big.toString(16).padStart(byteCount * 2, '0')
  if (hex.length > byteCount * 2) throw new InvalidShareCode()
  return Array.from({ length: byteCount }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16))
}

function bytesToChars(bytes: number[], charCount: number): string {
  let big = BigInt('0x' + (bytes.map((b) => b.toString(16).padStart(2, '0')).join('') || '0'))
  let out = ''
  for (let i = 0; i < charCount; i++) {
    out += DICTIONARY[Number(big % BASE)]
    big /= BASE
  }
  return out
}

/** Reads a `CS…` or `CSGO-…` code; throws InvalidShareCode (with a reason) otherwise. */
export function decodeCrosshair(code: string): Crosshair {
  const text = code.trim()
  if (/^CSGO(-[A-Za-z0-9]{5}){5}$/.test(text)) return decodeLegacy(charsToBytes(text.slice(4).replace(/-/g, ''), LEGACY_BYTES))
  if (!/^CS[A-Za-z0-9]{44}$/.test(text)) throw new InvalidShareCode('A crosshair code is CS followed by 44 characters (or the older CSGO-xxxxx-…)')
  const b = charsToBytes(text.slice(2), CS2_BYTES)
  if ((sum(b.slice(1)) & 0xff) !== b[0]) throw new InvalidShareCode('The code\'s checksum is wrong (a typo?)')
  if (b[1] !== 1) throw new InvalidShareCode(`Unknown crosshair code version ${b[1]} (newer than this app)`)
  const bits = (b[18] | (b[19] << 8) | (b[20] << 16) | (b[21] << 24)) >>> 0
  const gap = b[14] | (b[15] << 8)
  return {
    screenHeight: b[2] | (b[3] << 8),
    style: b[4] & 0x1f,
    followRecoil: (b[4] & 0x20) !== 0,
    centerDot: (b[4] & 0x40) !== 0,
    tStyle: (b[4] & 0x80) !== 0,
    red: b[5],
    green: b[6],
    blue: b[7],
    alpha: b[8],
    outlineRed: b[9],
    outlineGreen: b[10],
    outlineBlue: b[11],
    outlineAlpha: b[12],
    thickness: b[13] & 0x3f,
    outlineMode: (b[13] >> 6) & 3,
    gap: gap >= 0x8000 ? gap - 0x10000 : gap,
    length: b[16],
    dynamicSpreadLimit: b[17],
    splitDistance: bits & 0x7f,
    innerSplitAlpha: ((bits >>> 7) & 0x7f) / 100,
    outerSplitAlpha: (((bits >>> 14) & 0x7f) + 30) / 100,
    splitSizeRatio: ((bits >>> 21) & 0x7f) / 100,
    scopeDotUseCrosshairColor: ((bits >>> 28) & 1) === 1,
    scopeDotScale: (b[22] + 10) / 100
  }
}

/** Legacy pixel codes (v3 = outline on/off, v4 = outline mode); v1 (CS:GO units) can't be converted reliably. */
function decodeLegacy(b: number[]): Crosshair {
  if ((sum(b.slice(1)) & 0xff) !== b[0]) throw new InvalidShareCode('The code\'s checksum is wrong (a typo?)')
  if (b[1] === 1) throw new InvalidShareCode('This is an old CS:GO-era code: CS2 no longer imports those. Set it up by hand or use a newer CS… code.')
  if (b[1] !== 3 && b[1] !== 4) throw new InvalidShareCode(`Unknown CSGO- code version ${b[1]}`)
  const bits = (b[10] | (b[11] << 8) | (b[12] << 16) | (b[13] << 24)) >>> 0
  return {
    ...DEFAULT_CROSSHAIR,
    style: b[2] & 0xf,
    followRecoil: (b[2] & 0x10) !== 0,
    centerDot: (b[2] & 0x40) !== 0,
    tStyle: (b[2] & 0x80) !== 0,
    outlineMode: b[1] === 3 ? ((b[2] & 0x20) !== 0 ? 1 : 0) : (b[13] >> 4) & 3,
    red: b[3],
    green: b[4],
    blue: b[5],
    alpha: b[6],
    gap: b[7],
    length: b[8],
    dynamicSpreadLimit: b[9],
    splitDistance: bits & 0x7f,
    innerSplitAlpha: ((bits >>> 7) & 0x1f) / 20,
    outerSplitAlpha: (((bits >>> 12) & 0xf) + 6) / 20,
    splitSizeRatio: ((bits >>> 16) & 0x7f) / 100,
    thickness: (bits >>> 23) & 0x1f,
    screenHeight: (b[14] | (b[15] << 8)) || 1080
  }
}

/** The values the game accepts (cleanCrosshair is applied by encode/cvars too). */
export function cleanCrosshair(input: Partial<Crosshair> | null | undefined): Crosshair {
  const c = { ...DEFAULT_CROSSHAIR, ...(input ?? {}) }
  const int = (v: unknown, lo: number, hi: number) => Math.round(clamp(Number(v), lo, hi))
  const pct = (v: unknown, lo: number, hi: number) => Math.round(clamp(Number(v), lo, hi) * 100) / 100
  return {
    style: int(c.style, 0, 9),
    followRecoil: !!c.followRecoil,
    centerDot: !!c.centerDot,
    tStyle: !!c.tStyle,
    red: int(c.red, 0, 255),
    green: int(c.green, 0, 255),
    blue: int(c.blue, 0, 255),
    alpha: int(c.alpha, 0, 255),
    outlineRed: int(c.outlineRed, 0, 255),
    outlineGreen: int(c.outlineGreen, 0, 255),
    outlineBlue: int(c.outlineBlue, 0, 255),
    outlineAlpha: int(c.outlineAlpha, 0, 255),
    outlineMode: int(c.outlineMode, 0, 2),
    thickness: int(c.thickness, 0, 32),
    gap: int(c.gap, -3840, 3840),
    length: int(c.length, 0, 255),
    dynamicSpreadLimit: int(c.dynamicSpreadLimit, 0, 255),
    splitDistance: int(c.splitDistance, 0, 127),
    innerSplitAlpha: pct(c.innerSplitAlpha, 0, 1),
    outerSplitAlpha: pct(c.outerSplitAlpha, 0.3, 1),
    splitSizeRatio: pct(c.splitSizeRatio, 0, 1),
    scopeDotUseCrosshairColor: !!c.scopeDotUseCrosshairColor,
    scopeDotScale: pct(c.scopeDotScale, 0.1, 2),
    screenHeight: int(c.screenHeight, 240, 65535)
  }
}

export function encodeCrosshair(input: Crosshair): string {
  const c = cleanCrosshair(input)
  const steps = (v: number) => Math.round(v * 100)
  const bits =
    (c.splitDistance |
      (steps(c.innerSplitAlpha) << 7) |
      ((steps(c.outerSplitAlpha) - 30) << 14) |
      (steps(c.splitSizeRatio) << 21) |
      (Number(c.scopeDotUseCrosshairColor) << 28)) >>>
    0
  const gap = c.gap & 0xffff
  const b = new Array<number>(CS2_BYTES).fill(0)
  b[1] = 1
  b[2] = c.screenHeight & 0xff
  b[3] = c.screenHeight >> 8
  b[4] = c.style | (Number(c.followRecoil) << 5) | (Number(c.centerDot) << 6) | (Number(c.tStyle) << 7)
  ;[b[5], b[6], b[7], b[8]] = [c.red, c.green, c.blue, c.alpha]
  ;[b[9], b[10], b[11], b[12]] = [c.outlineRed, c.outlineGreen, c.outlineBlue, c.outlineAlpha]
  b[13] = c.thickness | (c.outlineMode << 6)
  b[14] = gap & 0xff
  b[15] = gap >> 8
  b[16] = c.length
  b[17] = c.dynamicSpreadLimit
  b[18] = bits & 0xff
  b[19] = (bits >>> 8) & 0xff
  b[20] = (bits >>> 16) & 0xff
  b[21] = (bits >>> 24) & 0xff
  b[22] = Math.max(0, steps(c.scopeDotScale) - 10)
  b[0] = sum(b.slice(1)) & 0xff
  return 'CS' + bytesToChars(b, CS2_CHARS)
}

/** cvar → value, in the order the cfg lists them. */
export function crosshairCvars(input: Crosshair): [string, string][] {
  const c = cleanCrosshair(input)
  const n = (v: boolean) => (v ? '1' : '0')
  return [
    ['cl_crosshairstyle', String(c.style)],
    ['cl_crosshair_screen_height', String(c.screenHeight)],
    ['cl_crosshair_length', String(c.length)],
    ['cl_crosshair_thickness', String(c.thickness)],
    ['cl_crosshair_gap', String(c.gap)],
    ['cl_crosshairdot', n(c.centerDot)],
    ['cl_crosshair_t', n(c.tStyle)],
    ['cl_crosshair_recoil', n(c.followRecoil)],
    ['cl_crosshaircolor_r', String(c.red)],
    ['cl_crosshaircolor_g', String(c.green)],
    ['cl_crosshaircolor_b', String(c.blue)],
    ['cl_crosshaircolor_a', String(c.alpha)],
    ['cl_crosshair_drawoutline', String(c.outlineMode)],
    ['cl_crosshairoutline_r', String(c.outlineRed)],
    ['cl_crosshairoutline_g', String(c.outlineGreen)],
    ['cl_crosshairoutline_b', String(c.outlineBlue)],
    ['cl_crosshairoutline_a', String(c.outlineAlpha)],
    ['cl_crosshair_dynamic_spread_limit', String(c.dynamicSpreadLimit)],
    ['cl_crosshair_dynamic_splitdist', String(c.splitDistance)],
    ['cl_crosshair_dynamic_splitalpha_innermod', String(c.innerSplitAlpha)],
    ['cl_crosshair_dynamic_splitalpha_outermod', String(c.outerSplitAlpha)],
    ['cl_crosshair_dynamic_maxdist_splitratio', String(c.splitSizeRatio)],
    ['cl_ironsight_usecrosshaircolor', n(c.scopeDotUseCrosshairColor)],
    ['cl_ironsight_dot_scale', String(c.scopeDotScale)]
  ]
}
