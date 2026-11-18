/**
 * Look page (2026-11-18 Phase D): crosshair, viewmodel and HUD makers. The client refuses cvars a server sends, so
 * these end up as the app's own client cfgs (`cs2prac_crosshair.cfg`, `cs2prac_viewmodel.cfg`, `cs2prac_hud.cfg` in
 * <cs2>/game/csgo/cfg; files of their own like cs2prac_keys.cfg, never a copy of the user's cfg) and as copyable text.
 */
import { cleanCrosshair, crosshairCvars, DEFAULT_CROSSHAIR, type Crosshair } from './crosshair'

export interface Viewmodel {
  fov: number
  x: number
  y: number
  z: number
  /** 0 custom, 1 desktop, 2 couch, 3 classic */
  presetpos: number
  leftHand: boolean
}

export interface HudLook {
  /** cl_hud_color index (HUD_COLORS) */
  color: number
  /** hud_scaling 0.5–0.95 */
  scale: number
  /** cl_hud_radar_scale 0.8–1.3 */
  radarHudScale: number
  /** cl_radar_scale 0.25–1 (map zoom) */
  radarMapScale: number
  radarRotate: boolean
  radarCentered: boolean
  /** cl_radar_icon_scale_min 0.4–1.25 */
  radarIconScale: number
  radarSquareWithScoreboard: boolean
  /** cl_hud_telemetry_*_show: 0 never, 1 when bad, 2 always */
  telemetryFps: number
  telemetryPing: number
  telemetryLoss: number
  /** cl_teamid_overhead_mode 0–3 */
  overheadMode: number
  /** cl_teammate_colors_show 0–2 */
  teammateColors: number
  showLoadout: boolean
}

export interface LookConfig {
  crosshair: Crosshair
  viewmodel: Viewmodel
  hud: HudLook
}

export type LookPart = keyof LookConfig

export const HUD_COLORS = ['Default', 'White', 'Light blue', 'Dark blue', 'Purple', 'Pink', 'Red', 'Orange', 'Yellow', 'Green', 'Aqua']
/** preview colours for HUD_COLORS */
export const HUD_COLOR_CSS = ['#e7e7d0', '#ffffff', '#7fc4ff', '#2f6cff', '#a44bff', '#ff6ad5', '#ff4040', '#ff9a2e', '#ffe14a', '#5dff5d', '#4dfff0']
export const VIEWMODEL_PRESETS = ['Custom', 'Desktop', 'Couch', 'Classic']
/** viewmodel_presetpos values (the game sets fov/offsets to these) */
export const PRESET_VALUES: Record<number, Omit<Viewmodel, 'presetpos' | 'leftHand'>> = {
  1: { fov: 60, x: 1, y: 1, z: -1 },
  2: { fov: 54, x: -1.5, y: -2, z: -2 },
  3: { fov: 68, x: 2.5, y: 0, z: -1.5 }
}
export const TELEMETRY_MODES = ['Never', 'When poor', 'Always']
export const OVERHEAD_MODES = ['Off', 'Pips', 'Pips + name', 'Pips + name + equipment']
export const TEAMMATE_COLORS = ['Off', 'Colours', 'Colours + letters']

export const DEFAULT_VIEWMODEL: Viewmodel = { fov: 60, x: 1, y: 1, z: -1, presetpos: 1, leftHand: false }
export const DEFAULT_HUD: HudLook = {
  color: 0,
  scale: 0.85,
  radarHudScale: 1,
  radarMapScale: 0.7,
  radarRotate: true,
  radarCentered: true,
  radarIconScale: 0.6,
  radarSquareWithScoreboard: true,
  telemetryFps: 1,
  telemetryPing: 1,
  telemetryLoss: 1,
  overheadMode: 3,
  teammateColors: 1,
  showLoadout: false
}
export const DEFAULT_LOOK: LookConfig = { crosshair: DEFAULT_CROSSHAIR, viewmodel: DEFAULT_VIEWMODEL, hud: DEFAULT_HUD }

export const LOOK_CFG: Record<LookPart, string> = {
  crosshair: 'cs2prac_crosshair.cfg',
  viewmodel: 'cs2prac_viewmodel.cfg',
  hud: 'cs2prac_hud.cfg'
}

const num = (v: unknown, lo: number, hi: number, fallback: number, step = 0.01) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.round(Math.min(hi, Math.max(lo, n)) / step) * step
}
const fix = (v: number) => String(Math.round(v * 1000) / 1000)
const flag = (v: boolean) => (v ? '1' : '0')

export function cleanViewmodel(v: Partial<Viewmodel> | null | undefined): Viewmodel {
  const d = { ...DEFAULT_VIEWMODEL, ...(v ?? {}) }
  return {
    fov: num(d.fov, 54, 68, 60, 1),
    x: num(d.x, -2.5, 2.5, 1, 0.1),
    y: num(d.y, -2, 2, 1, 0.1),
    z: num(d.z, -2, 2, -1, 0.1),
    presetpos: num(d.presetpos, 0, 3, 1, 1),
    leftHand: !!d.leftHand
  }
}

export function cleanHud(h: Partial<HudLook> | null | undefined): HudLook {
  const d = { ...DEFAULT_HUD, ...(h ?? {}) }
  return {
    color: num(d.color, 0, 10, 0, 1),
    scale: num(d.scale, 0.5, 0.95, 0.85),
    radarHudScale: num(d.radarHudScale, 0.8, 1.3, 1),
    radarMapScale: num(d.radarMapScale, 0.25, 1, 0.7),
    radarRotate: !!d.radarRotate,
    radarCentered: !!d.radarCentered,
    radarIconScale: num(d.radarIconScale, 0.4, 1.25, 0.6),
    radarSquareWithScoreboard: !!d.radarSquareWithScoreboard,
    telemetryFps: num(d.telemetryFps, 0, 2, 1, 1),
    telemetryPing: num(d.telemetryPing, 0, 2, 1, 1),
    telemetryLoss: num(d.telemetryLoss, 0, 2, 1, 1),
    overheadMode: num(d.overheadMode, 0, 3, 3, 1),
    teammateColors: num(d.teammateColors, 0, 2, 1, 1),
    showLoadout: !!d.showLoadout
  }
}

export function cleanLook(l: Partial<LookConfig> | null | undefined): LookConfig {
  return { crosshair: cleanCrosshair(l?.crosshair), viewmodel: cleanViewmodel(l?.viewmodel), hud: cleanHud(l?.hud) }
}

export function viewmodelCvars(input: Viewmodel): [string, string][] {
  const v = cleanViewmodel(input)
  const out: [string, string][] = []
  // a preset sets fov/offsets itself; custom values go after it (presetpos 0 keeps them)
  if (v.presetpos > 0) out.push(['viewmodel_presetpos', String(v.presetpos)])
  else
    out.push(
      ['viewmodel_fov', fix(v.fov)],
      ['viewmodel_offset_x', fix(v.x)],
      ['viewmodel_offset_y', fix(v.y)],
      ['viewmodel_offset_z', fix(v.z)],
      ['viewmodel_presetpos', '0']
    )
  out.push(['cl_prefer_lefthanded', flag(v.leftHand)])
  return out
}

export function hudCvars(input: HudLook): [string, string][] {
  const h = cleanHud(input)
  return [
    ['cl_hud_color', String(h.color)],
    ['hud_scaling', fix(h.scale)],
    ['cl_hud_radar_scale', fix(h.radarHudScale)],
    ['cl_radar_scale', fix(h.radarMapScale)],
    ['cl_radar_rotate', flag(h.radarRotate)],
    ['cl_radar_always_centered', flag(h.radarCentered)],
    ['cl_radar_icon_scale_min', fix(h.radarIconScale)],
    ['cl_radar_square_with_scoreboard', flag(h.radarSquareWithScoreboard)],
    ['cl_hud_telemetry_frametime_show', String(h.telemetryFps)],
    ['cl_hud_telemetry_ping_show', String(h.telemetryPing)],
    ['cl_hud_telemetry_net_misdelivery_show', String(h.telemetryLoss)],
    ['cl_teamid_overhead_mode', String(h.overheadMode)],
    ['cl_teammate_colors_show', String(h.teammateColors)],
    ['cl_showloadout', flag(h.showLoadout)]
  ]
}

export function lookCvars(part: LookPart, look: LookConfig): [string, string][] {
  if (part === 'crosshair') return crosshairCvars(look.crosshair)
  if (part === 'viewmodel') return viewmodelCvars(look.viewmodel)
  return hudCvars(look.hud)
}

/** Console-pasteable one-liner ("a 1; b 2"). */
export function lookLine(part: LookPart, look: LookConfig): string {
  return lookCvars(part, look)
    .map(([k, v]) => `${k} ${v}`)
    .join('; ')
}

export function lookCfg(part: LookPart, look: LookConfig): string {
  const name = LOOK_CFG[part].replace(/\.cfg$/, '')
  return [
    `// ${name}.cfg: written by CS2Prac (Look page). Run with: exec ${name}`,
    '// The app rewrites this file on every save; put your own lines in your own cfg.',
    ...lookCvars(part, look).map(([k, v]) => `${k} "${v}"`),
    `echo "${name} loaded"`,
    ''
  ].join('\n')
}
