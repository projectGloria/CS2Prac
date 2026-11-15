import { describe, expect, it } from 'vitest'
import { configOverride, mergeMatchZyAdmins } from './matchzy'

describe('configOverride', () => {
  it('maps the mode to matchzy_autostart_mode', () => {
    expect(configOverride('practice')).toMatch(/^matchzy_autostart_mode 2$/m)
    expect(configOverride('match')).toMatch(/^matchzy_autostart_mode 1$/m)
    expect(configOverride('off')).toMatch(/^matchzy_autostart_mode 0$/m)
  })

  it('uses the server name for the chat prefix and hostname', () => {
    const cfg = configOverride('practice', 'Nihil Prac Server')
    expect(cfg).toMatch(/^matchzy_chat_prefix "\[\{Green\}Nihil Prac Server\{Default\}\]"$/m)
    expect(cfg).toMatch(/^matchzy_hostname_format "Nihil Prac Server"$/m)
  })
})

describe('mergeMatchZyAdmins', () => {
  it('adds our accounts with full rights and keeps the user’s own admins', () => {
    const out = JSON.parse(mergeMatchZyAdmins('{"76561190000000001":"@css/chat"}', ['76561198000000000'], []))
    expect(out).toEqual({ '76561190000000001': '@css/chat', '76561198000000000': '' })
  })

  it('removes accounts we added before that are gone, but not ones the user changed', () => {
    const text = JSON.stringify({ a1: '', a2: '@css/map' })
    const out = JSON.parse(mergeMatchZyAdmins(text, ['b'], ['a1', 'a2']))
    expect(out).toEqual({ a2: '@css/map', b: '' })
  })
})

describe('needsInstall', async () => {
  const { needsInstall } = await import('./plugins')
  it('pinned mode only installs what is missing; latest mode follows the version', () => {
    expect(needsInstall(false, undefined, 'a', 'pinned')).toBe(true)
    expect(needsInstall(true, 'old', 'a', 'pinned')).toBe(false)
    expect(needsInstall(true, 'old', 'a', 'latest')).toBe(true)
    expect(needsInstall(true, 'a', 'a', 'latest')).toBe(false)
  })
})
