import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '' } }))
const { addonEvents, eventBlocks, packWavs, soundName, toSoundPack } = await import('./clientSounds')

const map = {
  schema: 1 as const,
  files: {
    'sounds/weapons/ak47/ak47_01.vsnd': 'weapons/ak47-1.wav',
    'sounds/weapons/ak47/ak47_02.vsnd': 'weapons/ak47-2.wav',
    'sounds/vo/announcer/cs2_classic/bombpl.vsnd': 'radio/bombpl.wav'
  }
}

const H = '<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c} -->'
const weapons = `${H}
{
	Weapon_AK47.Single =
	{
		type = "csgo_mega"
		vsnd_files_track_01 =
		[
			"sounds/weapons/ak47/ak47_01.vsnd",
			"sounds/weapons/ak47/ak47_02.vsnd",
		]
		note = "a { brace } in a string"
	}
	Weapon_M4A1.Single =
	{
		vsnd_files_track_01 = "sounds/weapons/m4a1/m4a1_01.vsnd"
	}
	"Odd Name" =
	{
		vsnd_files = "sounds/vo/announcer/cs2_classic/bombpl.vsnd"
	}
}
`

describe('clientSounds', () => {
  it('names addon sounds the same for both packs', () => {
    expect(soundName('weapons/ak47-1.wav')).toBe('weapons_ak47_1')
    expect(soundName('radio\\Bomb Pl.WAV')).toBe('radio_bomb_pl')
  })

  it('takes Turkish wavs only where the pack has the file', () => {
    const tr = packWavs('tr', map, (p) => p.startsWith('radio/'))
    expect(tr.get('radio_bombpl')).toEqual({ lang: 'turkish', src: 'radio/bombpl.wav' })
    expect(tr.get('weapons_ak47_1')?.lang).toBe('english')
    expect([...packWavs('uk', map, () => true).values()].every((w) => w.lang === 'english')).toBe(true)
  })

  it('splits the top-level events', () => {
    expect(eventBlocks(weapons).map((b) => b.name)).toEqual(['Weapon_AK47.Single', 'Weapon_M4A1.Single', 'Odd Name'])
  })

  it('copies only events that play mapped sounds, with our paths', () => {
    const r = addonEvents([weapons, weapons], map)
    expect(r.events).toBe(2)
    expect(r.text).toContain('"sounds/cs2prac16/weapons_ak47_1.vsnd"')
    expect(r.text).toContain('"sounds/cs2prac16/weapons_ak47_2.vsnd"')
    expect(r.text).toContain('"Odd Name" = ')
    expect(r.text).not.toContain('Weapon_M4A1')
    expect(r.text).not.toContain('sounds/weapons/ak47/')
    expect(r.text).toContain('a { brace } in a string')
  })

  it('reads unknown packs as off', () => {
    expect(toSoundPack('tr')).toBe('tr')
    expect(toSoundPack('de')).toBe('off')
    expect(toSoundPack(undefined)).toBe('off')
  })
})
