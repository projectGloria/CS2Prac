// Minimal reader for Valve VPK v2 directories (pak01_dir.vpk + pak01_NNN.vpk archives).
// Used by build-hud.mjs to find the stock skin images and read scripts/items/items_game.txt.
import { openSync, readSync, closeSync, readFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'

/** @returns {Map<string, {crc:number, preload:Buffer, archive:number, offset:number, length:number}>} */
export function readVpkDir(dirFile) {
  const buf = readFileSync(dirFile)
  if (buf.readUInt32LE(0) !== 0x55aa1234) throw new Error(`${dirFile} is not a VPK`)
  const version = buf.readUInt32LE(4)
  const treeSize = buf.readUInt32LE(8)
  const headerSize = version === 2 ? 28 : 12
  const treeEnd = headerSize + treeSize
  let p = headerSize
  const str = () => {
    const end = buf.indexOf(0, p)
    const s = buf.toString('utf8', p, end)
    p = end + 1
    return s
  }
  const files = new Map()
  for (;;) {
    const ext = str()
    if (!ext) break
    for (;;) {
      const path = str()
      if (!path) break
      for (;;) {
        const name = str()
        if (!name) break
        const crc = buf.readUInt32LE(p)
        const preloadBytes = buf.readUInt16LE(p + 4)
        const archive = buf.readUInt16LE(p + 6)
        const offset = buf.readUInt32LE(p + 8)
        const length = buf.readUInt32LE(p + 12)
        p += 18 // + 2-byte terminator
        const preload = buf.subarray(p, p + preloadBytes)
        p += preloadBytes
        const full = (path === ' ' ? '' : path + '/') + name + (ext === ' ' ? '' : '.' + ext)
        files.set(full, { crc, preload, archive, offset: archive === 0x7fff ? treeEnd + offset : offset, length })
      }
    }
  }
  return files
}

/** Reads one file's bytes out of the VPK set. */
export function readVpkFile(dirFile, entry) {
  const parts = [entry.preload]
  if (entry.length > 0) {
    const archiveFile =
      entry.archive === 0x7fff
        ? dirFile
        : join(dirname(dirFile), basename(dirFile).replace(/_dir\.vpk$/, `_${String(entry.archive).padStart(3, '0')}.vpk`))
    const fd = openSync(archiveFile, 'r')
    try {
      const data = Buffer.alloc(entry.length)
      readSync(fd, data, 0, entry.length, entry.offset)
      parts.push(data)
    } finally {
      closeSync(fd)
    }
  }
  return Buffer.concat(parts)
}
