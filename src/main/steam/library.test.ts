import { describe, expect, it } from 'vitest'
import { libraryPathsFromVdf, parseAppManifest } from './library'

describe('steam library', () => {
  it('lists library folders, the one with CS2 first', () => {
    const vdf = `"libraryfolders"
{
	"0" { "path" "C:\\Program Files (x86)\\Steam" "apps" { "228980" "1" } }
	"1" { "path" "D:\\SteamLibrary" "apps" { "730" "74265067316" } }
}`
    expect(libraryPathsFromVdf(vdf)).toEqual(['D:\SteamLibrary', 'C:\Program Files (x86)\Steam'])
  })

  it('reads installdir and buildid from an app manifest', () => {
    const acf = `"AppState" { "appid" "730" "installdir" "Counter-Strike Global Offensive" "buildid" "26598758" }`
    expect(parseAppManifest(acf)).toEqual({ installDir: 'Counter-Strike Global Offensive', buildId: '26598758' })
  })
})
