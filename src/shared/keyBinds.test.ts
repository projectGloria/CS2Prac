import { describe, expect, it } from 'vitest'
import { cleanKeyBinds, cs2KeyFromCode, cs2KeyFromMouse, keysCfg } from './keyBinds'

describe('keyBinds', () => {
  it('maps browser key codes to CS2 key names', () => {
    expect(cs2KeyFromCode('KeyJ')).toBe('j')
    expect(cs2KeyFromCode('Digit4')).toBe('4')
    expect(cs2KeyFromCode('F7')).toBe('F7')
    expect(cs2KeyFromCode('NumpadAdd')).toBe('kp_plus')
    expect(cs2KeyFromCode('PageDown')).toBe('pgdn')
    expect(cs2KeyFromCode('Escape')).toBeNull()
    expect(cs2KeyFromCode('Backquote')).toBeNull()
    expect(cs2KeyFromMouse(3)).toBe('mouse4')
    expect(cs2KeyFromMouse(0)).toBeNull()
  })

  it('drops unknown actions and unsafe keys', () => {
    expect(cleanKeyBinds({ backspawn: 'j', side: 'x"; quit', nope: 'k' })).toEqual({ backspawn: 'j' })
    expect(cleanKeyBinds(null)).toEqual({})
  })

  it('writes one bind per key', () => {
    const cfg = keysCfg({ backspawn: 'j', side: 'j', placeA: 'kp_end' })
    expect(cfg).toContain('bind "j" "css_backspawn"')
    expect(cfg).not.toContain('css_side')
    expect(cfg).toContain('bind "kp_end" "css_place a"')
  })
})
