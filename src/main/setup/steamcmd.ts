import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import extract from 'extract-zip'
import type { SetupProgress } from '@shared/ipc'
import { layout } from '../paths'

const STEAMCMD_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip'
/** The CS2 dedicated server is distributed under the game's own app id. */
const CS2_APP_ID = 730

type Report = (p: SetupProgress) => void
type Log = (line: string) => void

export async function downloadFile(url: string, dest: string, onPct: (pct: number | null) => void) {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`)
  const total = Number(res.headers.get('content-length')) || 0
  let got = 0
  const body = Readable.fromWeb(res.body as any)
  body.on('data', (c: Buffer) => {
    got += c.length
    onPct(total ? (got / total) * 100 : null)
  })
  await pipeline(body, createWriteStream(dest))
}

export async function ensureSteamCmd(installDir: string, report: Report) {
  const { steamcmdDir, steamcmdExe } = layout(installDir)
  if (existsSync(steamcmdExe)) return
  await mkdir(steamcmdDir, { recursive: true })
  const zip = join(steamcmdDir, 'steamcmd.zip')
  await downloadFile(STEAMCMD_URL, zip, (pct) =>
    report({ phase: 'steamcmd', percent: pct, message: 'Downloading SteamCMD…' })
  )
  await extract(zip, { dir: steamcmdDir })
  await rm(zip, { force: true })
}

/** Parses lines like: "Update state (0x61) downloading, progress: 42.17 (123 / 456)" */
export function parseProgress(line: string): { state: string; percent: number } | null {
  const m = /Update state \(0x[0-9a-f]+\) ([\w ]+?), progress: ([\d.]+)/i.exec(line)
  return m ? { state: m[1].trim(), percent: parseFloat(m[2]) } : null
}

export function installOrUpdateServer(installDir: string, report: Report, log: Log): Promise<void> {
  const { steamcmdExe, steamcmdDir, serverDir, cs2Exe } = layout(installDir)
  const args = [
    '+force_install_dir', serverDir, // must come before +login
    '+login', 'anonymous',
    '+app_update', String(CS2_APP_ID), 'validate',
    '+quit'
  ]
  report({ phase: 'server', percent: null, message: 'Starting SteamCMD (it may update itself first)…' })

  return new Promise((resolve, reject) => {
    const child = spawn(steamcmdExe, args, { cwd: steamcmdDir, windowsHide: true })
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString()
      const lines = buf.split(/\r?\n|\r/)
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        log(line)
        const p = parseProgress(line)
        if (p) report({ phase: 'server', percent: p.percent, message: `CS2 server: ${p.state}` })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', reject)
    child.on('close', (code) => {
      // SteamCMD exit codes are unreliable (e.g. right after it updates itself), so check the files on disk.
      if (existsSync(cs2Exe)) resolve()
      else reject(new Error(`SteamCMD exited with code ${code} and cs2.exe was not found. Check the log, then retry.`))
    })
  })
}
