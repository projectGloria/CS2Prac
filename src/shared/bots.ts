/** Custom bot names, clan tags and pictures (Play page "Bots"; plugin/PracSkins/BotNames.cs reads bots.json). */

export const MAX_BOTS_PER_TEAM = 10
export const MAX_BOT_NAME = 31
export const MAX_BOT_CLAN = 15
/** pictures are scaled to this square before they are stored */
export const BOT_AVATAR_SIZE = 64

export interface BotEntry {
  name: string
  clan: string
  /** data:image/png;base64,… (BOT_AVATAR_SIZE square) or '' for the game's bot picture */
  avatar: string
}

export interface BotsConfig {
  t: BotEntry[]
  ct: BotEntry[]
}

export const emptyBots = (): BotsConfig => ({ t: [], ct: [] })

const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/

/** strips characters that break the name in chat or the scoreboard */
export const cleanBotText = (s: unknown, max: number): string =>
  typeof s === 'string'
    ? s
        .replace(/[\u0000-\u001f"\\]/g, '')
        .trim()
        .slice(0, max)
    : ''

export function normalizeBots(raw: unknown): BotsConfig {
  const r = (raw ?? {}) as Partial<Record<'t' | 'ct', unknown>>
  const team = (list: unknown): BotEntry[] =>
    (Array.isArray(list) ? list : []).slice(0, MAX_BOTS_PER_TEAM).map((e) => {
      const x = (e ?? {}) as Partial<BotEntry>
      return {
        name: cleanBotText(x.name, MAX_BOT_NAME),
        clan: cleanBotText(x.clan, MAX_BOT_CLAN),
        avatar: typeof x.avatar === 'string' && PNG_DATA_URL.test(x.avatar) && x.avatar.length < 200_000 ? x.avatar : ''
      }
    })
  return { t: team(r.t), ct: team(r.ct) }
}

/** Made-up SteamID64 for a bot picture: account ids from 4,000,000,000 up are far above any issued Steam account
 * (never a real account, never the user's). T bots 0-99, CT bots 100-199. Same as BotAvatarId in BotNames.cs. */
export function botAvatarId(team: 't' | 'ct', index: number): string {
  return (76561197960265728n + 4_000_000_000n + (team === 'ct' ? 100n : 0n) + BigInt(index)).toString()
}

export const botsHaveAvatars = (b: BotsConfig): boolean => [...b.t, ...b.ct].some((e) => !!e.avatar)
