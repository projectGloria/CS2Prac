import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mirrorAction, syncMirror } from './mirror'

let root: string, src: string, dest: string

async function put(base: string, rel: string, text: string) {
  await mkdir(dirname(join(base, rel)), { recursive: true })
  await writeFile(join(base, rel), text)
}
const ino = async (p: string) => (await stat(p, { bigint: true })).ino

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cs2prac-mirror-'))
  src = join(root, 'game-install')
  dest = join(root, 'prac', 'server')
  await put(src, 'game/bin/win64/cs2.exe', 'exe')
  await put(src, 'game/csgo/pak01_000.vpk', 'vpk')
  await put(src, 'game/csgo/gameinfo.gi', 'gameinfo')
  await put(src, 'game/csgo/cfg/server.cfg', 'cfg')
  await put(src, 'game/csgo/addons/foo.dll', 'not ours')
  await put(src, 'game/csgo/console.log', 'client log')
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('mirrorAction', () => {
  it('links game data, copies files the server writes, skips our and log files', () => {
    expect(mirrorAction('game/csgo/pak01_000.vpk')).toBe('link')
    expect(mirrorAction('game/csgo/gameinfo.gi')).toBe('copy')
    expect(mirrorAction('game/csgo/cfg/server.cfg')).toBe('copy')
    expect(mirrorAction('game/csgo/addons/metamod.vdf')).toBe('skip')
    expect(mirrorAction('game/csgo/console.log')).toBe('skip')
    expect(mirrorAction('game/bin/win64/cs2_crash.mdmp')).toBe('skip')
  })
})

describe('syncMirror', () => {
  it('hard-links data, copies gameinfo/cfg and leaves the game install untouched', async () => {
    const r = await syncMirror(src, dest, '1')
    expect(r).toMatchObject({ linked: 2, copied: 2 })
    expect(await ino(join(dest, 'game/csgo/pak01_000.vpk'))).toBe(await ino(join(src, 'game/csgo/pak01_000.vpk')))
    expect(await ino(join(dest, 'game/csgo/gameinfo.gi'))).not.toBe(await ino(join(src, 'game/csgo/gameinfo.gi')))
    expect(existsSync(join(dest, 'game/csgo/addons/foo.dll'))).toBe(false)
    expect(existsSync(join(dest, 'game/csgo/console.log'))).toBe(false)

    await writeFile(join(dest, 'game/csgo/gameinfo.gi'), 'patched')
    expect(await readFile(join(src, 'game/csgo/gameinfo.gi'), 'utf8')).toBe('gameinfo')
  })

  it('is incremental and follows game updates', async () => {
    await syncMirror(src, dest, '1')
    expect(await syncMirror(src, dest, '1')).toMatchObject({ linked: 0, unchanged: 3, copied: 1 })

    // Steam replaces a file and removes another
    await rm(join(src, 'game/csgo/pak01_000.vpk'))
    await put(src, 'game/csgo/pak01_000.vpk', 'vpk v2')
    await rm(join(src, 'game/bin/win64/cs2.exe'))
    const r = await syncMirror(src, dest, '2')
    expect(r).toMatchObject({ linked: 1, removed: 1 })
    expect(await readFile(join(dest, 'game/csgo/pak01_000.vpk'), 'utf8')).toBe('vpk v2')
    expect(existsSync(join(dest, 'game/bin/win64/cs2.exe'))).toBe(false)
  })

  it('refuses a server folder inside the game install', async () => {
    await expect(syncMirror(src, join(src, 'server'), '1')).rejects.toThrow(/inside/)
  })
})
