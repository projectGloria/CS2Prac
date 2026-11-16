import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { botAvatarId, normalizeBots } from '@shared/bots'
import { listAvatarFiles, pluginBotsFile, readBots, saveBots, solidPng, writeServerBots } from './bots'

const PNG = 'data:image/png;base64,' + solidPng(4, 4, [255, 0, 0]).toString('base64')

describe('shared bots helpers', () => {
  it('makes avatar ids far above issued accounts, T from 0 and CT from 100', () => {
    expect(botAvatarId('t', 0)).toBe('76561201960265728')
    expect(botAvatarId('ct', 0)).toBe('76561201960265828')
    expect(botAvatarId('t', 9)).toBe('76561201960265737')
  })

  it('normalizes names, clans, pictures and list length', () => {
    const b = normalizeBots({
      t: [{ name: '  s1"mple\\\n  ', clan: 'NAVI-but-very-long-clan', avatar: PNG }, { name: 'x', avatar: 'data:image/jpeg;base64,AAAA' }],
      ct: Array.from({ length: 15 }, (_, i) => ({ name: 'b' + i }))
    })
    expect(b.t[0]).toEqual({ name: 's1mple', clan: 'NAVI-but-very-l', avatar: PNG })
    expect(b.t[1].avatar).toBe('')
    expect(b.ct).toHaveLength(10)
    expect(normalizeBots(null)).toEqual({ t: [], ct: [] })
  })
})

describe('solidPng', () => {
  it('writes a PNG with the right size', () => {
    const p = solidPng(64, 32, [1, 2, 3])
    expect([...p.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(p.readUInt32BE(16)).toBe(64)
    expect(p.readUInt32BE(20)).toBe(32)
  })
})

describe('writeServerBots', () => {
  let dir: string
  let csgo: string
  let steam: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cs2prac-bots-'))
    csgo = join(dir, 'csgo')
    steam = join(dir, 'steam')
    await mkdir(join(steam, 'config', 'avatarcache'), { recursive: true })
    await writeFile(join(steam, 'config', 'avatarcache', '76561198000000001.png'), 'me')
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('writes names only without pictures and leaves avatars alone', async () => {
    const r = await writeServerBots(csgo, normalizeBots({ t: [{ name: 'A' }] }), steam, ['76561198000000001'])
    expect(r).toBe(false)
    const file = JSON.parse(await readFile(join(csgo, 'addons/counterstrikesharp/configs/plugins/PracSkins/bots.json'), 'utf8'))
    expect(file).toEqual({ schema: 1, t: [{ name: 'A', clan: '', avatar: false }], ct: [] })
    expect(await listAvatarFiles(csgo)).toEqual([])
  })

  it('writes default, bot and local account pictures, then cleans them up', async () => {
    const bots = normalizeBots({ t: [{ name: 'A' }], ct: [{ name: 'B', avatar: PNG }] })
    expect(await writeServerBots(csgo, bots, steam, ['76561198000000001', 'bad'])).toBe(true)
    expect(await listAvatarFiles(csgo)).toEqual(['76561198000000001.png', `${botAvatarId('ct', 0)}.png`, 'default.png'])
    expect((await readFile(join(csgo, 'avatars', `${botAvatarId('ct', 0)}.png`))).toString('base64')).toBe(PNG.split(',')[1])
    expect(JSON.parse(pluginBotsFile(bots)).ct[0].avatar).toBe(true)

    // a user file in avatars stays
    await writeFile(join(csgo, 'avatars', 'mine.png'), 'x')
    expect(await writeServerBots(csgo, normalizeBots({ t: [{ name: 'A' }] }), steam, [])).toBe(false)
    expect(await listAvatarFiles(csgo)).toEqual(['mine.png'])
  })

  it('round-trips the app file', async () => {
    const f = join(dir, 'bots.json')
    expect(await readBots(f)).toEqual({ t: [], ct: [] })
    const saved = await saveBots(f, { t: [{ name: ' A ', clan: '', avatar: '' }], ct: [] })
    expect(saved.t[0].name).toBe('A')
    expect(await readBots(f)).toEqual(saved)
  })
})
