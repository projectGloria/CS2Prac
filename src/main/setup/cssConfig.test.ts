import { describe, expect, it } from 'vitest'
import { allowEconChanges } from './cssConfig'

describe('allowEconChanges', () => {
  it('turns FollowCS2ServerGuidelines off and keeps the formatting', () => {
    const input = '{\n    "PublicChatTrigger": [ "!" ],\n    "FollowCS2ServerGuidelines": true,\n    "ServerLanguage": "en"\n}'
    const r = allowEconChanges(input)
    expect(r.changed).toBe(true)
    expect(r.text).toBe(input.replace('true', 'false'))
    expect(allowEconChanges(r.text).changed).toBe(false)
  })

  it('adds the option when it is missing (CSS defaults it to true)', () => {
    const r = allowEconChanges('{ "ServerLanguage": "en" }')
    expect(JSON.parse(r.text)).toEqual({ ServerLanguage: 'en', FollowCS2ServerGuidelines: false })
  })
})
