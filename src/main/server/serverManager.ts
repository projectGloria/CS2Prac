import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { open, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import type { ServerStatus, StartOptions } from '@shared/ipc'
import { layout } from '../paths'
import { ensureGameinfoPatched } from '../setup/gameinfo'
import { buildLaunchArgs, changeMapCommand } from './launchArgs'
import { Rcon } from './rcon'

export const SERVER_PORT = 27015
const READY_TIMEOUT_MS = { official: 120_000, workshop: 600_000 } // workshop maps download first
const STOP_GRACE_MS = 8_000

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '0.0.0.0', () => srv.close(() => resolve(true)))
  })
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface ServerManagerEvents {
  status: [ServerStatus]
  log: [string]
}

export class ServerManager extends EventEmitter<ServerManagerEvents> {
  private child: ChildProcess | null = null
  private rcon: Rcon | null = null
  private tailTimer: NodeJS.Timeout | null = null
  private status: ServerStatus = { state: 'stopped' }

  getStatus() {
    return this.status
  }

  private setStatus(s: ServerStatus) {
    this.status = s
    this.emit('status', s)
  }

  async start(installDir: string, opts: StartOptions, authKey?: string): Promise<void> {
    if (this.status.state !== 'stopped') throw new Error(`Server is ${this.status.state}`)
    const { cs2Exe, csgoDir } = layout(installDir)

    this.setStatus({ state: 'starting', map: opts.map })
    try {
      await ensureGameinfoPatched(csgoDir) // CS2 updates revert this file
      if (!(await portFree(SERVER_PORT))) throw new Error(`Port ${SERVER_PORT} is in use. Is another server running?`)

      const password = randomBytes(12).toString('hex')
      const args = buildLaunchArgs({ ...opts, port: SERVER_PORT, rconPassword: password, authKey })
      const logFile = join(csgoDir, 'console.log')
      await writeFile(logFile, '') // -condebug appends; start each session clean
      this.startTail(logFile)

      this.emit('log', `> cs2.exe ${args.map((a) => (a === password ? '<rcon password>' : a)).join(' ')}`)
      const child = spawn(cs2Exe, args, { cwd: dirname(cs2Exe), windowsHide: true })
      this.child = child
      child.on('exit', (code) => this.onExit(code))
      child.on('error', (e) => this.emit('log', `[cs2prac] failed to launch: ${e.message}`))

      await this.waitForRcon(password, READY_TIMEOUT_MS[opts.map.kind])
      this.setStatus({ state: 'running', map: opts.map })
    } catch (e) {
      this.emit('log', `[cs2prac] ${(e as Error).message}`)
      await this.stop()
      throw e
    }
  }

  private async waitForRcon(password: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.child) throw new Error('Server process exited during startup. See the console log.')
      const r = new Rcon('127.0.0.1', SERVER_PORT, password)
      try {
        await r.connect(2000)
        this.rcon = r
        return
      } catch {
        await delay(2000)
      }
    }
    throw new Error('Server did not become ready in time')
  }

  /** Tails csgo/console.log (written because of -condebug); stdout isn't reliable for Windows CS2. */
  private startTail(file: string) {
    let offset = 0
    let partial = ''
    let reading = false
    this.tailTimer = setInterval(async () => {
      if (reading) return
      reading = true
      try {
        const { size } = await stat(file)
        if (size < offset) offset = 0 // truncated
        if (size === offset) return
        const fh = await open(file, 'r')
        try {
          const buf = Buffer.alloc(size - offset)
          await fh.read(buf, 0, buf.length, offset)
          offset = size
          const lines = (partial + buf.toString('utf8')).split(/\r?\n/)
          partial = lines.pop() ?? ''
          for (const l of lines) if (l.trim()) this.emit('log', l)
        } finally {
          await fh.close()
        }
      } catch {
        /* file not created yet */
      } finally {
        reading = false
      }
    }, 500)
  }

  private onExit(code: number | null) {
    this.emit('log', `[cs2prac] server exited (code ${code})`)
    this.child = null
    this.rcon?.close()
    this.rcon = null
    if (this.tailTimer) clearInterval(this.tailTimer)
    this.tailTimer = null
    this.setStatus({ state: 'stopped' })
  }

  async exec(command: string): Promise<string> {
    if (this.status.state !== 'running' || !this.rcon?.connected) throw new Error('Server is not running')
    return this.rcon.exec(command)
  }

  async changeMap(map: StartOptions['map']) {
    if (this.status.state !== 'running') throw new Error('Server is not running')
    const cmd = changeMapCommand(map)
    // changelevel drops the RCON reply; don't wait for one.
    this.exec(cmd).catch(() => {})
    this.setStatus({ state: 'running', map })
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) {
      if (this.status.state !== 'stopped') this.onExit(null)
      return
    }
    if (this.status.state !== 'stopped') this.setStatus({ state: 'stopping', map: this.status.map })
    const exited = new Promise<void>((r) => child.once('exit', () => r()))
    this.rcon?.exec('quit', 1000).catch(() => {})
    const graceful = await Promise.race([exited.then(() => true), delay(STOP_GRACE_MS).then(() => false)])
    if (!graceful && child.pid) {
      this.emit('log', '[cs2prac] server did not quit in time; killing process')
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      await Promise.race([exited, delay(5000)])
    }
  }
}
