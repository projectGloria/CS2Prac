import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

const { parseProgress } = await import('./steamcmd')

describe('parseProgress', () => {
  it('parses a downloading line', () => {
    expect(parseProgress(' Update state (0x61) downloading, progress: 42.17 (123456 / 789012)')).toEqual({
      state: 'downloading',
      percent: 42.17
    })
  })

  it('parses a multi-word state', () => {
    expect(parseProgress('Update state (0x5) verifying install, progress: 3.00 (1 / 2)')).toEqual({
      state: 'verifying install',
      percent: 3
    })
  })

  it('ignores unrelated lines', () => {
    expect(parseProgress("Success! App '730' fully installed.")).toBeNull()
  })
})
