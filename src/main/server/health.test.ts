import { describe, expect, it } from 'vitest'
import { matchingPids, parseHealth } from './health'

const META = '  [01] CounterStrikeSharp (1.0.380) by Roflmuffin'
const PLUGINS = '  [#1:LOADED]: "MatchZy" (0.9.3)\n  [#2:LOADED]: "PracSkins" (0.2.0)'
const STATUS = '[PracSkins] owner everyone, 0 weapon skins, attribute function ok'

describe('parseHealth', () => {
  it('is quiet when everything loaded', () => {
    expect(parseHealth(META, PLUGINS, STATUS, true)).toEqual([])
  })
  it('reports a missing CounterStrikeSharp only', () => {
    expect(parseHealth('Unknown command "meta"', '', '', true)).toHaveLength(1)
  })
  it('reports missing plugins and a missing signature', () => {
    const p = parseHealth(META, '  [#1:LOADED]: "PracSkins"', '[PracSkins] attribute function MISSING', true)
    expect(p.join(' ')).toMatch(/MatchZy/)
    expect(p.join(' ')).toMatch(/game function/)
    expect(parseHealth(META, '  [#1:LOADED]: "PracSkins"', STATUS, false)).toEqual([])
  })
})

describe('matchingPids', () => {
  it('matches only our server executable', () => {
    const lines = [
      '100|C:\\CS2Prac\\server\\game\\bin\\win64\\cs2.exe',
      '200|C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe',
      '300|',
      'junk'
    ].join('\r\n')
    expect(matchingPids(lines, 'c:\\cs2prac\\server\\game\\bin\\win64\\cs2.exe')).toEqual([100])
  })
})
