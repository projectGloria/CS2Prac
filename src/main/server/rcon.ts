import { Socket } from 'node:net'

/** Minimal Source RCON client (https://developer.valvesoftware.com/wiki/Source_RCON_Protocol). */
const SERVERDATA_AUTH = 3
const SERVERDATA_AUTH_RESPONSE = 2
const SERVERDATA_EXECCOMMAND = 2

export function encodePacket(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8')
  const buf = Buffer.alloc(14 + payload.length)
  buf.writeInt32LE(10 + payload.length, 0) // size excludes the size field itself
  buf.writeInt32LE(id, 4)
  buf.writeInt32LE(type, 8)
  payload.copy(buf, 12)
  // two trailing null bytes are already zero from Buffer.alloc
  return buf
}

export interface Packet {
  id: number
  type: number
  body: string
}

/** Extracts complete packets from a buffer; returns them plus any leftover bytes. */
export function decodePackets(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = []
  let off = 0
  while (buf.length - off >= 4) {
    const size = buf.readInt32LE(off)
    if (buf.length - off - 4 < size) break
    packets.push({
      id: buf.readInt32LE(off + 4),
      type: buf.readInt32LE(off + 8),
      body: buf.toString('utf8', off + 12, off + 4 + size - 2)
    })
    off += 4 + size
  }
  return { packets, rest: buf.subarray(off) }
}

export class Rcon {
  private socket: Socket | null = null
  private buf: Buffer = Buffer.alloc(0)
  private nextId = 1
  private pending = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

  constructor(
    private host: string,
    private port: number,
    private password: string
  ) {}

  get connected() {
    return this.socket !== null
  }

  connect(timeoutMs = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = new Socket()
      const fail = (e: Error) => {
        s.destroy()
        this.socket = null
        reject(e)
      }
      s.setTimeout(timeoutMs, () => fail(new Error('RCON connect timed out')))
      s.once('error', fail)
      s.connect(this.port, this.host, () => {
        s.setTimeout(0)
        const authId = this.nextId++
        const onAuth = (data: Buffer) => {
          this.buf = Buffer.concat([this.buf, data])
          const { packets, rest } = decodePackets(this.buf)
          this.buf = rest
          const resp = packets.find((p) => p.type === SERVERDATA_AUTH_RESPONSE)
          if (!resp) return
          s.off('data', onAuth)
          s.off('error', fail)
          if (resp.id === -1) return fail(new Error('RCON authentication failed'))
          this.socket = s
          s.on('data', (d: Buffer) => this.onData(d))
          s.on('error', () => this.close())
          s.on('close', () => this.close())
          resolve()
        }
        s.on('data', onAuth)
        s.write(encodePacket(authId, SERVERDATA_AUTH, this.password))
      })
    })
  }

  private onData(data: Buffer) {
    this.buf = Buffer.concat([this.buf, data])
    const { packets, rest } = decodePackets(this.buf)
    this.buf = rest
    for (const p of packets) {
      const req = this.pending.get(p.id)
      if (!req) continue
      clearTimeout(req.timer)
      this.pending.delete(p.id)
      req.resolve(p.body)
    }
  }

  exec(command: string, timeoutMs = 5000): Promise<string> {
    const s = this.socket
    if (!s) return Promise.reject(new Error('RCON not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RCON command timed out: ${command}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      s.write(encodePacket(id, SERVERDATA_EXECCOMMAND, command))
    })
  }

  close() {
    this.socket?.destroy()
    this.socket = null
    this.buf = Buffer.alloc(0)
    for (const [, req] of this.pending) {
      clearTimeout(req.timer)
      req.reject(new Error('RCON connection closed'))
    }
    this.pending.clear()
  }
}
