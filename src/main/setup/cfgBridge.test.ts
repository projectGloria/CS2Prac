import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bridgeCfg, isServerCommand, splitCommands, tokenize, writeCfgBridge } from './cfgBridge'

const bodyLine = (text: string, alias: string) => text.split('\r\n').find((l) => l.startsWith(`alias "${alias}"`))

describe('cfg parsing', () => {
  it('splits commands, keeps quoted semicolons and drops comments', () => {
    expect(splitCommands('bind "F3" "buy awp; buy deagle;"   // buy')).toEqual(['bind "F3" "buy awp; buy deagle;"'])
    expect(splitCommands('sv_cheats 1; bot_kick ;; say hi // x')).toEqual(['sv_cheats 1', 'bot_kick', 'say hi'])
    expect(tokenize('alias "a b"   "c; d"')).toEqual(['alias', 'a b', 'c; d'])
  })

  it('classifies server commands', () => {
    expect(isServerCommand(['sv_infinite_ammo', '1'])).toBe(true)
    expect(isServerCommand(['ent_fire', 'inferno', 'kill'])).toBe(true)
    expect(isServerCommand(['toggle', 'sv_showimpacts', '0', '1'])).toBe(true)
    expect(isServerCommand(['toggle', 'cl_draw_only_deathnotices', '0', '1'])).toBe(false)
    for (const c of ['bind', 'say', 'play', 'god', 'noclip', 'cl_crosshairstyle', 'r_drawworld']) expect(isServerCommand([c])).toBe(false)
  })
})

describe('bridgeCfg', () => {
  const cfg = [
    'unbindall                // clears binds',
    'alias "pracNihil_cvars1"   "sv_cheats 1; cl_disable_ragdolls 1; bot_quota 0; bot_kick"',
    'alias "local_bot"          "bot_add_t; play sounds/buttons/blip1.vsnd"',
    'alias "local_clear"        "ent_fire inferno kill; ent_fire decoy_projectile kill; stopsound"',
    'alias "infAmmo1"           "sv_infinite_ammo 1; say Infinite ammo: 1 (no reload); alias infAmmoToggle infAmmo2"',
    'alias "binds"              "bind kp_plus local_bot; bind ins sv_rethrow_last_grenade; bind N noclip"',
    'bind "h"                   "toggle cl_draw_only_deathnotices 0 1"',
    'mp_warmup_end',
    'exec other'
  ].join('\n')
  const r = bridgeCfg('Nihil.cfg', cfg, new Set(['nihil', 'other']))

  it('replaces runs of server commands with a helper alias', () => {
    expect(bodyLine(r.text, 'pracNihil_cvars1')).toBe('alias "pracNihil_cvars1" "cs2prac_Nihil_0; cl_disable_ragdolls 1; cs2prac_Nihil_1"')
    expect(r.segments.Nihil_0).toEqual(['sv_cheats 1'])
    expect(r.segments.Nihil_1).toEqual(['bot_quota 0', 'bot_kick'])
    expect(bodyLine(r.text, 'local_clear')).toBe('alias "local_clear" "cs2prac_Nihil_3; stopsound"')
    expect(r.segments.Nihil_3).toEqual(['ent_fire inferno kill', 'ent_fire decoy_projectile kill'])
  })

  it('keeps the client side: say text, nested alias toggles, nested binds', () => {
    expect(bodyLine(r.text, 'infAmmo1')).toBe(
      'alias "infAmmo1" "cs2prac_Nihil_4; say Infinite ammo: 1 (no reload); alias infAmmoToggle infAmmo2"'
    )
    expect(bodyLine(r.text, 'binds')).toBe('alias "binds" "bind kp_plus local_bot; bind ins cs2prac_Nihil_5; bind N noclip"')
    expect(r.text).toContain('bind "h"                   "toggle cl_draw_only_deathnotices 0 1"')
    expect(r.text).toContain('unbindall                // clears binds')
  })

  it('defines the helpers first and bridges top-level server commands and exec', () => {
    const lines = r.text.split('\r\n')
    expect(lines).toContain('alias cs2prac_Nihil_0 "css_cfgrun Nihil_0"')
    expect(lines.indexOf('alias cs2prac_Nihil_0 "css_cfgrun Nihil_0"')).toBeLessThan(lines.findIndex((l) => l.includes('pracNihil_cvars1')))
    expect(lines).toContain('cs2prac_Nihil_6')
    expect(r.segments.Nihil_6).toEqual(['mp_warmup_end'])
    expect(lines).toContain('exec cs2prac/other')
    for (const l of lines) expect(l.split('"').length - 1).toBeLessThanOrEqual(4) // no nested quotes added
  })
})

describe('writeCfgBridge', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cs2prac-bridge-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('writes bridged copies and cfgbridge.json, skips game cfgs and removes stale copies', async () => {
    const cfg = join(dir, 'cfg')
    const plugin = join(dir, 'plugin')
    await mkdir(join(cfg, 'cs2prac'), { recursive: true })
    await writeFile(join(cfg, 'Nihil.cfg'), '﻿alias "x" "bot_kick; echo hi"\r\n')
    await writeFile(join(cfg, 'gamemode_casual.cfg'), 'mp_roundtime 5')
    await writeFile(join(cfg, 'cs2prac', 'gone.cfg'), 'old')

    const s = await writeCfgBridge(cfg, plugin)
    expect(s.cfgs).toEqual([{ name: 'Nihil', steps: 1 }])
    expect(await readFile(join(cfg, 'cs2prac', 'Nihil.cfg'), 'utf8')).toContain('alias "x" "cs2prac_Nihil_0; echo hi"')
    expect(existsSync(join(cfg, 'cs2prac', 'gamemode_casual.cfg'))).toBe(false)
    expect(existsSync(join(cfg, 'cs2prac', 'gone.cfg'))).toBe(false)
    expect(JSON.parse(await readFile(join(plugin, 'cfgbridge.json'), 'utf8'))).toEqual({ segments: { Nihil_0: ['bot_kick'] } })
  })
})
