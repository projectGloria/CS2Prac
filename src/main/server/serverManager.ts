import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import type { Readable } from 'node:stream'
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

/** Printed many times a second when cs2.exe has no console window to read input from. */
const NOISE = /CTextConsoleWin::GetLine/

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface ServerManagerEvents {
  status: [ServerStatus]
  log: [string]
}

export class ServerManager extends EventEmitter<ServerManagerEvents> {
  private child: ChildProcess | null = null
  private rcon: Rcon | null = null
  private status: ServerStatus = { state: 'stopped' }
  /** set by stop(); an exit without it is a crash */
  private stopRequested = false

  getStatus() {
    return this.status
  }

  private setStatus(s: ServerStatus) {
    this.status = s
    this.emit('status', s)
  }

  async start(installDir: string, opts: StartOptions, secrets: { rconPassword: string; authKey?: string }): Promise<void> {
    if (this.status.state !== 'stopped') throw new Error(`Server is ${this.status.state}`)
    const { cs2Exe, csgoDir } = layout(installDir)

    this.stopRequested = false
    this.setStatus({ state: 'starting', map: opts.map })
    try {
      await ensureGameinfoPatched(csgoDir) // CS2 updates revert this file
      if (!(await portFree(SERVER_PORT))) throw new Error(`Port ${SERVER_PORT} is in use. Is another server running?`)

      const password = secrets.rconPassword
      const args = buildLaunchArgs({ ...opts, port: SERVER_PORT, rconPassword: password, authKey: secrets.authKey })
      this.emit('log', `> cs2.exe ${args.map((a) => (a === password ? '<rcon password>' : a)).join(' ')}`)
      // Output must be read continuously: if the pipe fills up, cs2.exe blocks and the server freezes.
      const child = spawn(cs2Exe, args, { cwd: dirname(cs2Exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      this.child = child
      this.pipeLines(child.stdout)
      this.pipeLines(child.stderr)
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

  private pipeLines(stream: Readable) {
    let partial = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      const lines = (partial + chunk).split(/\r?\n/)
      partial = lines.pop() ?? ''
      for (const l of lines) if (l.trim() && !NOISE.test(l)) this.emit('log', l)
    })
  }

  private onExit(code: number | null) {
    const crashed = !this.stopRequested && this.status.state === 'running'
    this.emit('log', crashed ? `[cs2prac] the server stopped unexpectedly (exit code ${code})` : `[cs2prac] server exited (code ${code})`)
    this.child = null
    this.rcon?.close()
    this.rcon = null
    this.setStatus(crashed ? { state: 'stopped', crashed: { code } } : { state: 'stopped' })
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
    this.stopRequested = true
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
