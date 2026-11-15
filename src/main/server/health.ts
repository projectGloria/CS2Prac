import { execFile } from 'node:child_process'
import { resolve } from 'node:path'

/**
 * Problems worth a banner, from the server's own answers to `meta list`, `css_plugins list` and `css_prac_status`.
 * Empty means everything we rely on is loaded.
 */
export function parseHealth(meta: string, plugins: string, status: string, expectMatchZy: boolean): string[] {
  const problems: string[] = []
  if (!/CounterStrikeSharp/i.test(meta)) {
    problems.push(
      'CounterStrikeSharp did not load, so skins and MatchZy are off. This usually follows a CS2 update: use Setup → Update plugins to latest.'
    )
    return problems
  }
  if (!/"PracSkins"/.test(plugins)) problems.push('The PracSkins plugin did not load, so skins are off. Try Setup → Update / repair.')
  if (expectMatchZy && !/"MatchZy"/.test(plugins)) problems.push('MatchZy did not load. Try Setup → Update plugins to latest.')
  if (/attribute function MISSING/.test(status))
    problems.push(
      'PracSkins could not find a game function it needs (a CS2 update changed it), so finishes may not show. Update plugins, or see README → When CS2 updates.'
    )
  return problems
}

/** Parses `pid|path` lines into processes whose executable is exactly `exe`. */
export function matchingPids(lines: string, exe: string): number[] {
  const want = resolve(exe).toLowerCase()
  return lines
    .split(/\r?\n/)
    .map((l) => l.trim().split('|'))
    .filter(([pid, path]) => /^\d+$/.test(pid ?? '') && path && resolve(path).toLowerCase() === want)
    .map(([pid]) => Number(pid))
}

/**
 * Kills cs2.exe processes started from our server folder (left over after the app crashed or was killed).
 * Never touches the player's own game, which runs from the Steam folder.
 */
export async function killStaleServers(exe: string): Promise<number[]> {
  const script = `Get-CimInstance Win32_Process -Filter "Name='cs2.exe'" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`
  const out = await new Promise<string>((res) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 }, (_e, stdout) =>
      res(stdout ?? '')
    )
  )
  const pids = matchingPids(out, exe)
  for (const pid of pids) {
    await new Promise<void>((res) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => res()))
  }
  return pids
}
