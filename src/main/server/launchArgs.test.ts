import { describe, expect, it } from 'vitest'
import { buildLaunchArgs, changeMapCommand } from './launchArgs'

const base = { port: 27015, rconPassword: 'pw' }

describe('buildLaunchArgs', () => {
  it('builds an official-map competitive launch', () => {
    const a = buildLaunchArgs({ ...base, mode: 'competitive', map: { kind: 'official', name: 'de_mirage' } })
    expect(a).toEqual(expect.arrayContaining(['-dedicated', '-insecure', '-usercon', '+sv_lan', '1']))
    expect(a.slice(a.indexOf('+game_type'), a.indexOf('+game_type') + 4)).toEqual(['+game_type', '0', '+game_mode', '1'])
    expect(a.slice(-2)).toEqual(['+map', 'de_mirage'])
  })

  it('uses host_workshop_map and passes the auth key for workshop maps', () => {
    const a = buildLaunchArgs({ ...base, authKey: 'KEY', mode: 'deathmatch', map: { kind: 'workshop', id: '3070284539' } })
    expect(a).toEqual(expect.arrayContaining(['-authkey', 'KEY', '+host_workshop_map', '3070284539']))
    expect(a).not.toContain('+map')
  })

  it('turns on server avatar overrides only when asked (bot pictures)', () => {
    const map = { kind: 'official', name: 'de_mirage' } as const
    expect(buildLaunchArgs({ ...base, mode: 'competitive', map })).not.toContain('+sv_reliableavatardata')
    const a = buildLaunchArgs({ ...base, mode: 'competitive', map, avatars: true })
    expect(a.slice(a.indexOf('+sv_reliableavatardata'), a.indexOf('+sv_reliableavatardata') + 2)).toEqual(['+sv_reliableavatardata', '1'])
    expect(a.indexOf('+sv_reliableavatardata')).toBeLessThan(a.indexOf('+map'))
  })

  it('rejects injected map names and bad workshop ids', () => {
    expect(() => buildLaunchArgs({ ...base, mode: 'casual', map: { kind: 'official', name: 'de_dust2; quit' } })).toThrow()
    expect(() => buildLaunchArgs({ ...base, mode: 'casual', map: { kind: 'workshop', id: '12a' } })).toThrow()
  })
})

describe('changeMapCommand', () => {
  it('returns changelevel or host_workshop_map', () => {
    expect(changeMapCommand({ kind: 'official', name: 'de_nuke' })).toBe('changelevel de_nuke')
    expect(changeMapCommand({ kind: 'workshop', id: '123' })).toBe('host_workshop_map 123')
  })
})
