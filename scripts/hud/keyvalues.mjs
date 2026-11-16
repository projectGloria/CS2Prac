// Minimal Valve KeyValues (KV1) text parser. Objects are arrays of [key, value] pairs, because items_game.txt
// repeats keys (several "items" and "paint_kits" sections) and a plain object would keep only the last one.

export function parseKv(text) {
  let i = 0
  const n = text.length

  function skip() {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++
      if (text[i] === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++
        continue
      }
      // conditionals like [$WIN32] are ignored
      if (text[i] === '[') {
        while (i < n && text[i] !== ']') i++
        i++
        continue
      }
      return
    }
  }

  function token() {
    skip()
    if (i >= n) return null
    const c = text[i]
    if (c === '{' || c === '}') {
      i++
      return c
    }
    if (c === '"') {
      let s = ''
      i++
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const e = text[i + 1]
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e
          i += 2
        } else s += text[i++]
      }
      i++
      return { s }
    }
    let s = ''
    while (i < n && !/[\s{}"]/.test(text[i])) s += text[i++]
    return { s }
  }

  function object() {
    const out = []
    for (;;) {
      const k = token()
      if (k === null || k === '}') return out
      if (k === '{') throw new Error(`unexpected { at ${i}`)
      const v = token()
      if (v === '{') out.push([k.s, object()])
      else if (v && typeof v === 'object') out.push([k.s, v.s])
      else throw new Error(`bad value for ${k.s} at ${i}`)
    }
  }

  return object()
}

/** All values for key at this level. */
export const all = (obj, key) => obj.filter(([k]) => k === key).map(([, v]) => v)
/** First value for key at this level. */
export const get = (obj, key) => obj.find(([k]) => k === key)?.[1]
