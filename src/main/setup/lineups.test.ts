import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addLineups,
  deleteLineup,
  importCode,
  parseSavedNades,
  parseShareFile,
  parseTriple,
  toShareFile,
  updateLineup,
  type RawNades
} from '@shared/lineups'
import { readLineups, readRawNades, savedNadesFile, writeRawNades } from './lineups'

// shape as MatchZy writes it (.savenade, plus an .importnade entry without Type)
const RAW: RawNades = {
  '76561198000000001': {
    xbox: { LineupPos: '-300.5 1400.25 -120', LineupAng: '-45.2 90 0', Desc: 'jump throw', Map: 'de_dust2', Type: 'Smoke' },
    ctflash: { LineupPos: '10,5 20 30', LineupAng: '0 180 0', Desc: '', Map: 'de_mirage', Type: 'Flash', Extra: 'kept' }
  },
  default: {
    window: { LineupPos: '1, 2, 3', LineupAng: '4, 5, 6', Desc: '', Map: 'de_mirage' },
    broken: { LineupPos: 'a b c', LineupAng: '0 0 0', Desc: '', Map: 'de_mirage' }
  }
}

describe('lineup parsing', () => {
  it('reads triples in all the forms MatchZy has written', () => {
    expect(parseTriple('1 2 3')).toEqual([1, 2, 3])
    expect(parseTriple('1, 2, 3')).toEqual([1, 2, 3])
    expect(parseTriple('10,5 20 30')).toEqual([10.5, 20, 30])
    expect(parseTriple('1 2')).toBeNull()
  })

  it('lists every readable lineup, sorted by map and name', () => {
    const l = parseSavedNades(RAW)
    expect(l.map((x) => `${x.map}/${x.name}`)).toEqual(['de_dust2/xbox', 'de_mirage/ctflash', 'de_mirage/window'])
    expect(l[0]).toEqual({
      owner: '76561198000000001',
      name: 'xbox',
      map: 'de_dust2',
      desc: 'jump throw',
      type: 'Smoke',
      pos: [-300.5, 1400.25, -120],
      ang: [-45.2, 90, 0]
    })
    expect(l[2].type).toBe('')
  })
})

describe('lineup edits', () => {
  it('renames in place, keeps unknown keys, avoids taken names', () => {
    let r = updateLineup(RAW, '76561198000000001', 'ctflash', { name: 'ct flash', desc: 'pop' })
    expect(Object.keys(r['76561198000000001'])).toEqual(['xbox', 'ct_flash'])
    expect(r['76561198000000001'].ct_flash).toMatchObject({ Desc: 'pop', Extra: 'kept', LineupPos: '10.5 20 30', Type: 'Flash' })
    r = updateLineup(r, '76561198000000001', 'ct_flash', { name: 'xbox' })
    expect(Object.keys(r['76561198000000001'])).toEqual(['xbox', 'xbox_2'])
    expect(RAW['76561198000000001'].ctflash).toBeDefined() // not mutated
  })

  it('sets and clears the type, deletes', () => {
    const r = updateLineup(RAW, 'default', 'window', { type: 'Molly' })
    expect(r.default.window.Type).toBe('Molly')
    expect(updateLineup(r, 'default', 'window', { type: '' }).default.window.Type).toBeUndefined()
    expect(deleteLineup(RAW, 'default', 'window').default.window).toBeUndefined()
    expect(deleteLineup(RAW, 'default', 'nope')).toBe(RAW)
  })

  it('makes the MatchZy import code', () => {
    const l = parseSavedNades(RAW)[0]
    expect(importCode(l)).toBe('.importnade xbox -300.5, 1400.25, -120, -45.2, 90, 0')
  })
})

describe('share files', () => {
  it('round-trips our file and adds with free names', () => {
    const list = parseSavedNades(RAW)
    const parsed = parseShareFile(toShareFile(list), 'default', '')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.lineups.every((l) => l.owner === 'default')).toBe(true)
    const { raw, added } = addLineups(RAW, parsed.lineups)
    expect(added.map((a) => a.name)).toEqual(['xbox', 'ctflash', 'window_2'])
    expect(parseSavedNades(raw)).toHaveLength(6)
  })

  it('takes a raw savednades.json and .importnade lines', () => {
    const r1 = parseShareFile(JSON.stringify(RAW), 'default', '')
    expect(r1.ok && r1.lineups).toHaveLength(3)
    const r2 = parseShareFile('.importnade a 1, 2, 3, 4, 5, 6\njunk\nb 1 2 3 4 5 6', 'default', 'de_nuke')
    expect(r2.ok && r2.lineups.map((l) => `${l.map}/${l.name}/${l.pos[2]}`)).toEqual(['de_nuke/a/3', 'de_nuke/b/3'])
    expect(parseShareFile('a 1 2 3 4 5 6', 'default', '').ok).toBe(false)
    expect(parseShareFile('{bad', 'default', 'x').ok).toBe(false)
  })
})

describe('savednades.json on disk', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cs2prac-nades-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('reads a missing or broken file as empty and writes atomically', async () => {
    expect(await readLineups(dir)).toEqual([])
    await mkdir(dirname(savedNadesFile(dir)), { recursive: true })
    await writeFile(savedNadesFile(dir), '﻿{"x":')
    expect(await readRawNades(dir)).toEqual({})
    const list = await writeRawNades(dir, RAW)
    expect(list).toHaveLength(3)
    expect(JSON.parse(await readFile(savedNadesFile(dir), 'utf8'))).toEqual(RAW)
  })
})
