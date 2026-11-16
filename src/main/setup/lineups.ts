import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseSavedNades, type Lineup, type RawNades } from '@shared/lineups'

/** MatchZy's saved nades: <csgo>/cfg/MatchZy/savednades.json (Server.GameDirectory/csgo/cfg in MatchZy) */
export const savedNadesFile = (csgoDir: string) => join(csgoDir, 'cfg', 'MatchZy', 'savednades.json')

export async function readRawNades(csgoDir: string): Promise<RawNades> {
  try {
    const text = (await readFile(savedNadesFile(csgoDir), 'utf8')).replace(/^﻿/, '')
    const json = JSON.parse(text)
    return json && typeof json === 'object' && !Array.isArray(json) ? (json as RawNades) : {}
  } catch {
    return {}
  }
}

export async function readLineups(csgoDir: string): Promise<Lineup[]> {
  return parseSavedNades(await readRawNades(csgoDir))
}

/** writes the file atomically (MatchZy may read it at any moment) in its own indented style */
export async function writeRawNades(csgoDir: string, raw: RawNades): Promise<Lineup[]> {
  const file = savedNadesFile(csgoDir)
  await mkdir(dirname(file), { recursive: true })
  const tmp = file + '.cs2prac.tmp'
  await writeFile(tmp, JSON.stringify(raw, null, 2), 'utf8')
  await rename(tmp, file)
  return parseSavedNades(raw)
}
