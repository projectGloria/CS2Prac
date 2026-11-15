import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * CounterStrikeSharp's "FollowCS2ServerGuidelines" (on by default) blocks the econ item fields skins need
 * (m_iEntityQuality, m_OriginalOwnerXuidLow, ...). Valve's guidelines are about public servers. This one is a
 * private `-insecure` LAN server, so PracSkins needs the option off.
 */
export function allowEconChanges(text: string): { text: string; changed: boolean } {
  const re = /("FollowCS2ServerGuidelines"\s*:\s*)true/
  if (re.test(text)) return { text: text.replace(re, '$1false'), changed: true }
  const config = JSON.parse(text) as Record<string, unknown>
  if (config.FollowCS2ServerGuidelines === false) return { text, changed: false }
  config.FollowCS2ServerGuidelines = false
  return { text: JSON.stringify(config, null, 4), changed: true }
}

/** Applies {@link allowEconChanges} to addons/counterstrikesharp/configs/core.json. */
export async function ensureCssAllowsSkins(csgoDir: string): Promise<boolean> {
  const file = join(csgoDir, 'addons', 'counterstrikesharp', 'configs', 'core.json')
  let current: string
  try {
    current = await readFile(file, 'utf8')
  } catch {
    // CSS writes its defaults on first start; create the file so the very first start already allows skins
    current = '{}'
  }
  const { text, changed } = allowEconChanges(current)
  if (changed) await writeFile(file, text)
  return changed
}
