import { createServer, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { decodePackets, encodePacket, Rcon } from './rcon'

describe('rcon packets', () => {
  it('round-trips and handles split buffers', () => {
    const a = encodePacket(7, 2, 'status')
    const b = encodePacket(8, 0, 'héllo')
    const all = Buffer.concat([a, b])
    const first = decodePackets(all.subarray(0, a.length + 3))
    expect(first.packets).toEqual([{ id: 7, type: 2, body: 'status' }])
    const second = decodePackets(Buffer.concat([first.rest, all.subarray(a.length + 3)]))
    expect(second.packets).toEqual([{ id: 8, type: 0, body: 'héllo' }])
    expect(second.rest.length).toBe(0)
  })
})

describe('Rcon client', () => {
  let close: (() => void) | undefined
  afterEach(() => close?.())

  /** Fake server: accepts password "pw" and echoes commands back. */
  async function fakeServer() {
    const srv = createServer((sock) => {
      let buf: Buffer = Buffer.alloc(0)
      sock.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d])
        const { packets, rest } = decodePackets(buf)
        buf = rest
        for (const p of packets) {
          if (p.type === 3) sock.write(encodePacket(p.body === 'pw' ? p.id : -1, 2, ''))
          else sock.write(encodePacket(p.id, 0, `echo:${p.body}`))
        }
      })
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    close = () => srv.close()
    return (srv.address() as AddressInfo).port
  }

  it('authenticates and executes commands', async () => {
    const port = await fakeServer()
    const r = new Rcon('127.0.0.1', port, 'pw')
    await r.connect()
    expect(await r.exec('changelevel de_nuke')).toBe('echo:changelevel de_nuke')
    r.close()
  })

  it('rejects a wrong password', async () => {
    const port = await fakeServer()
    await expect(new Rcon('127.0.0.1', port, 'nope').connect()).rejects.toThrow(/authentication/)
  })
})
