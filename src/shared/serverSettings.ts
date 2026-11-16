/**
 * Server settings of the in-game L window (plugin/PracSkins/SettingsHud.cs). Both sides edit
 * <plugin config>/server_prefs.json; keep the ids, tabs and values here in sync with SetDefs in SettingsHud.cs.
 */

export interface ServerPrefs {
  /** setting id -> value, applied on every map */
  global: Record<string, string>
  /** map name -> setting id -> value, applied on top of global on that map */
  maps: Record<string, Record<string, string>>
}

export interface SettingOption {
  label: string
  value: string
}

export interface SettingDef {
  id: string
  tab: 'practice' | 'server' | 'bots' | 'sky'
  name: string
  sub: string
  options: SettingOption[]
}

const offOn: SettingOption[] = [
  { label: 'Off', value: '0' },
  { label: 'On', value: '1' }
]

/** Skies (materials in the client's pak01); same list as Skies in SettingsHud.cs. "" = the map's own sky. */
export const SKIES: SettingOption[] = [
  { label: 'Map default', value: '' },
  { label: 'Dust II', value: 'materials/skybox/sky_de_dust2.vmat' },
  { label: 'Mirage', value: 'materials/skybox/sky_de_mirage.vmat' },
  { label: 'Anubis', value: 'materials/skybox/sky_de_annubis.vmat' },
  { label: 'Nuke', value: 'materials/skybox/sky_de_nuke.vmat' },
  { label: 'Nuke (HDR)', value: 'materials/de_nuke/hr_nuke/sky/nuke_sky_hdr.vmat' },
  { label: 'Overpass', value: 'materials/skybox/sky_de_overpass_01.vmat' },
  { label: 'Train', value: 'materials/skybox/sky_de_train03.vmat' },
  { label: 'Vertigo', value: 'materials/skybox/sky_de_vertigo.vmat' },
  { label: 'Cache', value: 'materials/de_cache/sky/de_cache_sky_001.vmat' },
  { label: 'Italy', value: 'materials/skybox/cs_italy_s2_skybox_2.vmat' },
  { label: 'Office', value: 'materials/skybox/cs_office_45_0.vmat' },
  { label: 'Aztec', value: 'materials/skybox/sky_hr_aztec_02.vmat' },
  { label: 'Inferno (test sky)', value: 'materials/skybox/test/s2_de_inferno_sky01.vmat' },
  { label: 'Baggage', value: 'materials/skybox/sky_ar_baggage_01.vmat' },
  { label: 'Convoy', value: 'materials/skybox/convoy_sky.vmat' },
  { label: 'Cloudy', value: 'materials/skybox/sky_csgo_cloudy01.vmat' },
  { label: 'Cloudy (Rush)', value: 'materials/skybox/rush_cloudy_01a.vmat' },
  { label: 'Overcast', value: 'materials/skybox/sky_overcast_01.vmat' },
  { label: 'Daylight (CS 1.5)', value: 'materials/skybox/sky_cs15_daylight01_hdr.vmat' },
  { label: 'Rainy night', value: 'materials/skybox/sky_rain_night_01.vmat' },
  { label: 'Sunset (test sky)', value: 'materials/skybox/light_test_sky_sunset_light.vmat' },
  { label: 'Black', value: 'materials/skybox/sky_black.vmat' }
]

export const SETTING_TABS: { id: SettingDef['tab']; label: string }[] = [
  { id: 'practice', label: 'Practice' },
  { id: 'server', label: 'Server' },
  { id: 'bots', label: 'Bots' },
  { id: 'sky', label: 'Sky' }
]

export const SETTINGS: SettingDef[] = [
  { id: 'glow', tab: 'practice', name: 'Bot glow', sub: 'Bots outlined through walls', options: offOn },
  { id: 'spawns', tab: 'practice', name: 'Spawn markers', sub: 'Look at one and press E to stand on it', options: offOn },
  {
    id: 'ammo',
    tab: 'practice',
    name: 'Infinite ammo',
    sub: 'sv_infinite_ammo',
    options: [
      { label: 'Off', value: '0' },
      { label: 'Clip', value: '1' },
      { label: 'Reserve', value: '2' }
    ]
  },
  { id: 'buyanywhere', tab: 'practice', name: 'Buy anywhere', sub: 'mp_buy_anywhere', options: offOn },
  { id: 'trajectory', tab: 'practice', name: 'Grenade preview', sub: 'Trajectory line while aiming a grenade', options: offOn },
  { id: 'impacts', tab: 'practice', name: 'Bullet impacts', sub: 'sv_showimpacts', options: offOn },
  { id: 'noflash', tab: 'practice', name: 'No flash', sub: "Flashbangs don't blind players", options: offOn },
  { id: 'god', tab: 'practice', name: 'God mode', sub: 'Players take no damage', options: offOn },
  { id: 'bhop', tab: 'practice', name: 'Auto bunnyhop', sub: 'Hold space to keep hopping', options: offOn },

  { id: 'friendlyfire', tab: 'server', name: 'Friendly fire', sub: 'mp_friendlyfire', options: offOn },
  { id: 'falldamage', tab: 'server', name: 'Fall damage', sub: 'sv_falldamage_scale', options: offOn },
  {
    id: 'roundtime',
    tab: 'server',
    name: 'Round time',
    sub: 'Minutes',
    options: [
      { label: '1:55', value: '1.92' },
      { label: '5', value: '5' },
      { label: '15', value: '15' },
      { label: '60', value: '60' }
    ]
  },
  {
    id: 'freezetime',
    tab: 'server',
    name: 'Freeze time',
    sub: 'Seconds at round start',
    options: [
      { label: '0', value: '0' },
      { label: '5', value: '5' },
      { label: '15', value: '15' }
    ]
  },
  {
    id: 'gravity',
    tab: 'server',
    name: 'Gravity',
    sub: 'sv_gravity (800 is normal)',
    options: ['200', '400', '600', '800'].map((v) => ({ label: v, value: v }))
  },
  {
    id: 'timescale',
    tab: 'server',
    name: 'Game speed',
    sub: 'host_timescale',
    options: ['0.25', '0.5', '1', '1.5', '2'].map((v) => ({ label: `${v}×`, value: v }))
  },

  {
    id: 'botradio',
    tab: 'bots',
    name: 'Bot radio',
    sub: 'Bot voice and radio calls',
    options: [
      { label: 'Off', value: 'off' },
      { label: 'Radio', value: 'radio' },
      { label: 'Minimal', value: 'minimal' },
      { label: 'Normal', value: 'normal' }
    ]
  },
  {
    id: 'botdifficulty',
    tab: 'bots',
    name: 'Bot difficulty',
    sub: 'For bots added after the change',
    options: [
      { label: 'Easy', value: '0' },
      { label: 'Normal', value: '1' },
      { label: 'Hard', value: '2' },
      { label: 'Expert', value: '3' }
    ]
  },
  {
    id: 'botshoot',
    tab: 'bots',
    name: 'Bots shoot',
    sub: 'bot_dont_shoot',
    options: [
      { label: 'No', value: '1' },
      { label: 'Yes', value: '0' }
    ]
  },
  { id: 'botstop', tab: 'bots', name: 'Bots frozen', sub: 'bot_stop', options: offOn },
  { id: 'botcrouch', tab: 'bots', name: 'Bots crouch', sub: 'bot_crouch', options: offOn },

  { id: 'sky', tab: 'sky', name: 'Sky', sub: 'Replaces the map’s sky', options: SKIES }
]

const byId = new Map(SETTINGS.map((s) => [s.id, s]))

export function emptyPrefs(): ServerPrefs {
  return { global: {}, maps: {} }
}

function cleanMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const def = byId.get(k)
    if (def && typeof v === 'string' && def.options.some((o) => o.value === v)) out[k] = v
  }
  return out
}

/** Parses server_prefs.json: unknown ids and values outside a setting's options are dropped. */
export function normalizePrefs(raw: unknown): ServerPrefs {
  const p = emptyPrefs()
  if (!raw || typeof raw !== 'object') return p
  const r = raw as { global?: unknown; maps?: unknown }
  p.global = cleanMap(r.global)
  if (r.maps && typeof r.maps === 'object')
    for (const [map, values] of Object.entries(r.maps as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9_\-.]+$/.test(map)) continue
      const m = cleanMap(values)
      if (Object.keys(m).length) p.maps[map] = m
    }
  return p
}

/** What applies on a map: global values with the map's own on top. */
export function effectivePrefs(prefs: ServerPrefs, map: string): Record<string, string> {
  return { ...prefs.global, ...(prefs.maps[map] ?? {}) }
}

/** Sets (or with value null removes) a global value. */
export function setGlobal(prefs: ServerPrefs, id: string, value: string | null): ServerPrefs {
  const global = { ...prefs.global }
  if (value == null) delete global[id]
  else global[id] = value
  return { ...prefs, global }
}

/** Removes every value saved for one map. */
export function clearMap(prefs: ServerPrefs, map: string): ServerPrefs {
  const maps = { ...prefs.maps }
  delete maps[map]
  return { ...prefs, maps }
}

/** Display text of a stored value. */
export function optionLabel(id: string, value: string): string {
  return byId.get(id)?.options.find((o) => o.value === value)?.label ?? value
}
