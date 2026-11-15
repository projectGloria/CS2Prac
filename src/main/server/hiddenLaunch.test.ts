import { describe, expect, it } from 'vitest'
import { quoteArg, windowsCommandLine } from './hiddenLaunch'

describe('windows command line', () => {
  it('leaves plain args alone and quotes the rest', () => {
    expect(quoteArg('+map')).toBe('+map')
    expect(quoteArg('')).toBe('""')
    expect(quoteArg('a b')).toBe('"a b"')
    expect(quoteArg('say "hi"')).toBe('"say \\"hi\\""')
    expect(quoteArg('C:\\dir with space\\')).toBe('"C:\\dir with space\\\\"')
  })

  it('builds the full line with the exe first', () => {
    expect(windowsCommandLine('C:\\CS2 Prac\\cs2.exe', ['-dedicated', '+map', 'de_mirage'])).toBe(
      '"C:\\CS2 Prac\\cs2.exe" -dedicated +map de_mirage'
    )
  })
})
