import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { SteamAccount } from '@shared/skins'

type Vdf = { [k: string]: string | Vdf }

/** Minimal parser for Valve's KeyValues text format (quoted keys/values and braces). */
export function parseVdf(text: string): Vdf {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}]/g) ?? []
  let i = 0
  const unquote = (t: string) => t.slice(1, -1).replace(/\\(.)/g, '$1')
  function obj(): Vdf {
    const out: Vdf = {}
    while (i < tokens.length) {
      const t = tokens[i++]
      if (t === '}') return out
      const key = unquote(t)
      const next = tokens[i++]
      if (next === '{') out[key] = obj()
      else if (next !== undefined) out[key] = unquote(next)
    }
    return out
  }
  return obj()
}

export function accountsFromLoginUsers(text: string): SteamAccount[] {
  const root = parseVdf(text)
  const usersKey = Object.keys(root).find((k) => k.toLowerCase() === 'users')
  const users = (usersKey ? root[usersKey] : {}) as Vdf
  return Object.entries(users)
    .filter(([id, v]) => /^\d{17}$/.test(id) && typeof v === 'object')
    .map(([steamId, v]) => {
      const u = v as Record<string, string>
      const get = (k: string) => Object.entries(u).find(([key]) => key.toLowerCase() === k.toLowerCase())?.[1]
      return { steamId, personaName: get('PersonaName') ?? steamId, mostRecent: get('MostRecent') === '1' }
    })
    .sort((a, b) => Number(b.mostRecent) - Number(a.mostRecent))
}

export async function steamPath(): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], {
      windowsHide: true
    })
    const m = /SteamPath\s+REG_SZ\s+(.+)/.exec(stdout)
    if (m) return m[1].trim()
  } catch {
    /* fall through */
  }
  return 'C:\\Program Files (x86)\\Steam'
}

/** Steam accounts that have logged in on this PC (from config/loginusers.vdf), most recent first. */
export async function listSteamAccounts(): Promise<SteamAccount[]> {
  try {
    return accountsFromLoginUsers(await readFile(join(await steamPath(), 'config', 'loginusers.vdf'), 'utf8'))
  } catch {
    return []
  }
}
