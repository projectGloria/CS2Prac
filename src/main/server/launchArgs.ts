import type { GameMode, StartOptions } from '@shared/ipc'

/** game_type / game_mode pairs, per Valve's gamemodes.txt */
export const GAME_MODES: Record<GameMode, { type: number; mode: number }> = {
  casual: { type: 0, mode: 0 },
  competitive: { type: 0, mode: 1 },
  wingman: { type: 0, mode: 2 },
  deathmatch: { type: 1, mode: 2 }
}

const MAP_NAME = /^[a-z0-9_]+$/i
const WORKSHOP_ID = /^\d{1,20}$/

export function buildLaunchArgs(opts: StartOptions & { port: number; rconPassword: string; authKey?: string }): string[] {
  const gm = GAME_MODES[opts.mode]
  if (!gm) throw new Error(`Unknown game mode: ${opts.mode}`)

  const args = [
    '-dedicated',
    '-insecure', // required: plugin-modified servers must not run VAC-secured
    '-usercon', // enables RCON on Windows
    // Without this, RCON (TCP) listens only on the LAN address, not 127.0.0.1. The game port (UDP) still
    // listens on all addresses, and RCON stays unreachable from the network.
    '-ip',
    '127.0.0.1',
    '-port', String(opts.port),
    '+sv_lan', '1',
    '+rcon_password', opts.rconPassword,
    '+game_type', String(gm.type),
    '+game_mode', String(gm.mode)
  ]

  if (opts.map.kind === 'workshop') {
    if (!WORKSHOP_ID.test(opts.map.id)) throw new Error('Workshop ID must be numeric')
    if (opts.authKey) args.push('-authkey', opts.authKey)
    args.push('+host_workshop_map', opts.map.id)
  } else {
    if (!MAP_NAME.test(opts.map.name)) throw new Error(`Invalid map name: ${opts.map.name}`)
    args.push('+map', opts.map.name)
  }
  return args
}

/** The console command to switch map on a running server. */
export function changeMapCommand(map: StartOptions['map']): string {
  if (map.kind === 'workshop') {
    if (!WORKSHOP_ID.test(map.id)) throw new Error('Workshop ID must be numeric')
    return `host_workshop_map ${map.id}`
  }
  if (!MAP_NAME.test(map.name)) throw new Error(`Invalid map name: ${map.name}`)
  return `changelevel ${map.name}`
}
