import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULTS_CFG, USER_SERVER_CFG, ensureAdmins, mergeAdmins, syncServerCfgs } from './serverConfig'
import { DEFAULT_SERVER_NAME, cleanServerName } from '@shared/ipc'

describe('mergeAdmins', () => {
  it('adds root admins and keeps entries the user wrote', () => {
    const before = JSON.stringify({ friend: { identity: '76561190000000001', flags: ['@css/generic'] } })
    const out = JSON.parse(mergeAdmins(before, ['76561198000000000']))
    expect(out.friend.flags).toEqual(['@css/generic'])
    expect(out.cs2prac_76561198000000000).toEqual({ identity: '76561198000000000', flags: ['@css/root'] })
  })

  it('removes our entries for accounts that are gone', () => {
    const first = mergeAdmins(null, ['76561198000000000', '76561198000000001'])
    const out = JSON.parse(mergeAdmins(first, ['76561198000000001']))
    expect(Object.keys(out)).toEqual(['cs2prac_76561198000000001'])
  })
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cs2prac-cfg-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('ensureAdmins', () => {
  it('replaces a broken admins.json and keeps a copy', async () => {
    const dir = join(root, 'addons', 'counterstrikesharp', 'configs')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'admins.json'), '{ not json')
    await ensureAdmins(root, ['76561198000000000'])
    expect(JSON.parse(await readFile(join(dir, 'admins.json'), 'utf8')).cs2prac_76561198000000000).toBeTruthy()
    expect(await readFile(join(dir, 'admins.json.broken'), 'utf8')).toBe('{ not json')
  })
})

describe('syncServerCfgs', () => {
  it('creates the template, writes defaults and copies user cfgs', async () => {
    const user = join(root, 'appcfg')
    const csgo = join(root, 'csgo')
    await mkdir(join(user, 'sub'), { recursive: true })
    await writeFile(join(user, 'prac.cfg'), 'sv_infinite_ammo 1')
    await writeFile(join(user, 'sub', 'x.cfg'), 'x')
    const n = await syncServerCfgs(user, csgo)
    expect(n).toBe(3) // prac.cfg, sub/x.cfg and the new template
    expect(existsSync(join(user, USER_SERVER_CFG))).toBe(true)
    expect(await readFile(join(csgo, 'cfg', 'prac.cfg'), 'utf8')).toBe('sv_infinite_ammo 1')
    expect(await readFile(join(csgo, 'cfg', 'sub', 'x.cfg'), 'utf8')).toBe('x')
    expect(await readFile(join(csgo, 'cfg', DEFAULTS_CFG), 'utf8')).toMatch(/sv_cheats 1/)
  })

  it('writes the server name into the defaults cfg', async () => {
    const csgo = join(root, 'csgo2')
    await syncServerCfgs(join(root, 'appcfg2'), csgo, 'Nihil Prac Server')
    const text = await readFile(join(csgo, 'cfg', DEFAULTS_CFG), 'utf8')
    expect(text).toMatch(/^hostname "Nihil Prac Server"$/m)
    expect(text).toMatch(/^css_prac_chat_prefix "Nihil Prac Server"$/m)
  })
})

describe('cleanServerName', () => {
  it('drops characters that would break a cfg line and falls back to the default', () => {
    expect(cleanServerName('My "Prac"; quit')).toBe('My Prac quit')
    expect(cleanServerName('{Red}X')).toBe('RedX')
    expect(cleanServerName('   ')).toBe(DEFAULT_SERVER_NAME)
    expect(cleanServerName(undefined)).toBe(DEFAULT_SERVER_NAME)
  })
})
