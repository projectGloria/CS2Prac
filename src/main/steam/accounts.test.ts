import { describe, expect, it } from 'vitest'
import { accountsFromLoginUsers, parseVdf } from './accounts'

const LOGINUSERS = `"users"
{
	"76561198000000001"
	{
		"AccountName"		"alt_account"
		"PersonaName"		"Alt"
		"MostRecent"		"0"
	}
	"76561198000000002"
	{
		"AccountName"		"main"
		"PersonaName"		"Main \\"The\\" Player"
		"mostrecent"		"1"
	}
}`

describe('steam accounts', () => {
  it('parses nested KeyValues with escapes', () => {
    expect(parseVdf('"a" { "b" "c\\"d" "e" { } }')).toEqual({ a: { b: 'c"d', e: {} } })
  })

  it('lists accounts, most recent first, case-insensitive keys', () => {
    expect(accountsFromLoginUsers(LOGINUSERS)).toEqual([
      { steamId: '76561198000000002', personaName: 'Main "The" Player', mostRecent: true },
      { steamId: '76561198000000001', personaName: 'Alt', mostRecent: false }
    ])
  })
})
