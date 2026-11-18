import { describe, expect, it } from 'vitest'
import { cleanCrosshair, crosshairCvars, decodeCrosshair, DEFAULT_CROSSHAIR, encodeCrosshair, InvalidShareCode } from './crosshair'
import { cleanLook, lookCfg, lookLine, viewmodelCvars } from './look'

describe('crosshair codes', () => {
  it('round-trips a CS code', () => {
    const c = cleanCrosshair({
      ...DEFAULT_CROSSHAIR,
      style: 9,
      gap: -3,
      length: 12,
      thickness: 1,
      red: 255,
      green: 20,
      blue: 147,
      alpha: 200,
      outlineMode: 2,
      outlineRed: 10,
      centerDot: true,
      tStyle: true,
      followRecoil: true,
      innerSplitAlpha: 0.37,
      outerSplitAlpha: 0.55,
      splitSizeRatio: 0.81,
      scopeDotUseCrosshairColor: true,
      scopeDotScale: 1.5,
      screenHeight: 1440
    })
    const code = encodeCrosshair(c)
    expect(code).toMatch(/^CS[A-Za-z0-9]{44}$/)
    expect(decodeCrosshair(code)).toEqual(c)
    expect(decodeCrosshair(encodeCrosshair(DEFAULT_CROSSHAIR))).toEqual(cleanCrosshair(DEFAULT_CROSSHAIR))
  })

  it('rejects typos and junk', () => {
    const code = encodeCrosshair(DEFAULT_CROSSHAIR)
    const typo = code.slice(0, 10) + (code[10] === 'A' ? 'B' : 'A') + code.slice(11)
    expect(() => decodeCrosshair(typo)).toThrow(InvalidShareCode)
    expect(() => decodeCrosshair('hello')).toThrow(InvalidShareCode)
    expect(() => decodeCrosshair('CSGO-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa')).toThrow(InvalidShareCode)
  })

  it('writes cvars and cfgs', () => {
    const cvars = Object.fromEntries(crosshairCvars({ ...DEFAULT_CROSSHAIR, gap: -2 }))
    expect(cvars.cl_crosshair_gap).toBe('-2')
    expect(cvars.cl_crosshairstyle).toBe('4')
    const look = cleanLook({ viewmodel: { fov: 68, x: 2.5, y: 0, z: -1.5, presetpos: 0, leftHand: true } })
    expect(Object.fromEntries(viewmodelCvars(look.viewmodel))).toMatchObject({ viewmodel_fov: '68', viewmodel_offset_x: '2.5', cl_prefer_lefthanded: '1' })
    expect(lookCfg('hud', look)).toContain('cl_hud_color "0"')
    expect(lookLine('crosshair', look)).toContain('cl_crosshair_length 8; ')
  })
})
