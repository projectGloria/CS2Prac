import { describe, expect, it } from 'vitest'
import { patchGameinfo } from './gameinfo'

const SAMPLE = [
  '"GameInfo"',
  '{',
  '\tFileSystem',
  '\t{',
  '\t\tSearchPaths',
  '\t\t{',
  '\t\t\tGame_LowViolence\tcsgo_lv // Perfect World content override',
  '\t\t\tGame\tcsgo',
  '\t\t\tGame\tcsgo_imported',
  '\t\t}',
  '\t}',
  '}'
].join('\r\n')

describe('patchGameinfo', () => {
  it('inserts metamod as the first search path, keeping CRLF and indentation', () => {
    const { text, changed } = patchGameinfo(SAMPLE)
    expect(changed).toBe(true)
    expect(text).toContain('\t\t{\r\n\t\t\tGame\tcsgo/addons/metamod\r\n\t\t\tGame_LowViolence')
  })

  it('is idempotent', () => {
    const once = patchGameinfo(SAMPLE).text
    const twice = patchGameinfo(once)
    expect(twice.changed).toBe(false)
    expect(twice.text).toBe(once)
  })

  it('throws when the SearchPaths block is missing', () => {
    expect(() => patchGameinfo('"GameInfo" {}')).toThrow(/SearchPaths/)
  })
})
