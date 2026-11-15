import { describe, expect, it } from 'vitest'
import { mapNamesFromFiles } from './maps'

describe('mapNamesFromFiles', () => {
  it('keeps playable maps and drops helper vpks', () => {
    const files = ['de_dust2.vpk', 'de_dust2_vanity.vpk', 'cs_office.vpk', 'lobby_mapveto.vpk', 'de_nuke.vpk', 'readme.txt', 'graphics_settings.vpk']
    expect(mapNamesFromFiles(files)).toEqual(['cs_office', 'de_dust2', 'de_nuke'])
  })
})
