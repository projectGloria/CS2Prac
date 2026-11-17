import { describe, expect, it } from 'vitest'
import { clearMap, effectivePrefs, normalizePrefs, optionLabel, parseInputValue, setGlobal, SETTINGS } from '@shared/serverSettings'
import { addRecentWorkshop } from './serverPrefs'

describe('server prefs', () => {
  it('drops unknown ids, bad values and bad map names', () => {
    const p = normalizePrefs({
      global: { glow: '1', nope: '1', ammo: '7', botradio: 'off', sky: '' },
      maps: { de_mirage: { gravity: '400', glow: 3 }, 'bad map;': { glow: '1' }, de_empty: { x: '1' } }
    })
    expect(p).toEqual({ global: { glow: '1', botradio: 'off', sky: '' }, maps: { de_mirage: { gravity: '400' } } })
    expect(normalizePrefs(null)).toEqual({ global: {}, maps: {} })
  })

  it('takes typed numbers for input settings', () => {
    const p = normalizePrefs({ global: { spraycooldown: '7.5' }, maps: { de_nuke: { spraycooldown: '9999' }, de_inferno: { spraycooldown: 'x' } } })
    expect(p).toEqual({ global: { spraycooldown: '7.5' }, maps: {} })
    const def = SETTINGS.find((s) => s.id === 'spraycooldown')!
    expect(parseInputValue(def, ' 2,505 ')).toBe('2.51')
    expect(parseInputValue(def, '0')).toBe('0')
    expect(parseInputValue(def, '-1')).toBeNull()
    expect(optionLabel('spraycooldown', '7')).toBe('7 s')
    expect(optionLabel('spraycooldown', '0')).toBe('No limit')
  })

  it('puts map values over global ones', () => {
    const p = { global: { glow: '1', gravity: '800' }, maps: { de_nuke: { gravity: '200' } } }
    expect(effectivePrefs(p, 'de_nuke')).toEqual({ glow: '1', gravity: '200' })
    expect(effectivePrefs(p, 'de_dust2')).toEqual({ glow: '1', gravity: '800' })
  })

  it('sets, removes and clears', () => {
    let p = setGlobal({ global: {}, maps: { de_nuke: { glow: '0' } } }, 'glow', '1')
    expect(p.global).toEqual({ glow: '1' })
    p = setGlobal(p, 'glow', null)
    expect(p.global).toEqual({})
    expect(clearMap(p, 'de_nuke').maps).toEqual({})
  })

  it('has unique ids and option values', () => {
    expect(new Set(SETTINGS.map((s) => s.id)).size).toBe(SETTINGS.length)
    for (const s of SETTINGS) expect(new Set(s.options.map((o) => o.value)).size).toBe(s.options.length)
  })

  it('keeps recent workshop maps unique and short', () => {
    expect(addRecentWorkshop(['1', '2'], '2')).toEqual(['2', '1'])
    expect(addRecentWorkshop(Array.from({ length: 12 }, (_, i) => String(i)), 'x')).toHaveLength(10)
  })
})
