import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Clipboard, Crosshair as CrosshairIcon, Gauge, Hand, Import, Save } from 'lucide-react'
import { CROSSHAIR_STYLES, decodeCrosshair, encodeCrosshair, type Crosshair } from '@shared/crosshair'
import {
  DEFAULT_LOOK,
  HUD_COLORS,
  HUD_COLOR_CSS,
  LOOK_CFG,
  OVERHEAD_MODES,
  PRESET_VALUES,
  TEAMMATE_COLORS,
  TELEMETRY_MODES,
  VIEWMODEL_PRESETS,
  cleanLook,
  lookLine,
  type HudLook,
  type LookConfig,
  type LookPart,
  type Viewmodel
} from '@shared/look'

const errText = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * Look page (2026-11-18 Phase D): crosshair, viewmodel and HUD makers with previews. CS2 refuses cvars from a server,
 * so the result is copied (code / console line) or saved as the app's own cfg in CS2's cfg folder (`exec cs2prac_…`).
 */
export default function Look() {
  const [look, setLook] = useState<LookConfig | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.look.get().then(setLook)
  }, [])

  if (!look) return <p className="muted">Loading…</p>

  const set = <K extends LookPart>(part: K, patch: Partial<LookConfig[K]>) =>
    setLook((l) => (l ? cleanLook({ ...l, [part]: { ...l[part], ...patch } }) : l))

  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text)
    setError(null)
    setNote(`${what} copied.`)
  }
  const save = async (part?: LookPart) => {
    setError(null)
    try {
      const r = await window.api.look.save(look, part)
      setLook(r.look)
      const names = (part ? [part] : (Object.keys(LOOK_CFG) as LookPart[])).map((p) => `exec ${LOOK_CFG[p].replace('.cfg', '')}`)
      setNote(`Saved to ${r.files.join(', ')}. In the CS2 console: ${names.join('; ')}`)
    } catch (e) {
      setError(errText(e))
    }
  }
  const actions = (part: LookPart, extra?: ReactNode) => (
    <div className="look-actions">
      {extra}
      <button onClick={() => copy(lookLine(part, look), 'Console line')} title="One line to paste into the CS2 console">
        <Clipboard size={14} aria-hidden />
        Copy cfg line
      </button>
      <button className="primary" onClick={() => save(part)} title={`Writes ${LOOK_CFG[part]} into CS2's cfg folder`}>
        <Save size={14} aria-hidden />
        Save {LOOK_CFG[part]}
      </button>
    </div>
  )

  return (
    <div className="look">
      <p className="muted small">
        CS2 doesn&apos;t take these settings from a server, so the app writes them as its own cfgs in CS2&apos;s cfg folder
        (<code>exec cs2prac_crosshair</code>, <code>exec cs2prac_viewmodel</code>, <code>exec cs2prac_hud</code>) or you copy them. The
        previews are drawings to compare settings, not the game&apos;s own render.{' '}
        <button className="small-btn" onClick={() => save()}>
          Save all three
        </button>
      </p>
      {note && <p className="muted small">{note}</p>}
      {error && <p className="error-text">{error}</p>}
      <CrosshairCard c={look.crosshair} onChange={(p) => set('crosshair', p)} actions={actions} onCopy={copy} onError={setError} />
      <ViewmodelCard v={look.viewmodel} onChange={(p) => set('viewmodel', p)} actions={actions} />
      <HudCard h={look.hud} onChange={(p) => set('hud', p)} actions={actions} />
      <p className="muted small">
        <button className="small-btn" onClick={() => setLook(cleanLook(DEFAULT_LOOK))}>
          Reset everything to defaults
        </button>{' '}
        (not saved until you save)
      </p>
    </div>
  )
}

type Actions = (part: LookPart, extra?: ReactNode) => ReactNode

function Slider(props: { label: string; value: number; min: number; max: number; step?: number; disabled?: boolean; onChange: (v: number) => void }) {
  const { label, value, min, max, step = 1, disabled, onChange } = props
  return (
    <label className="look-slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => e.target.value !== '' && onChange(Number(e.target.value))}
      />
    </label>
  )
}

function Check({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="look-check">
      <input type="checkbox" checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

function Choice({ label, value, options, onChange }: { label: string; value: number; options: string[]; onChange: (v: number) => void }) {
  return (
    <label className="look-slider">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map((o, i) => (
          <option key={o} value={i}>
            {o}
          </option>
        ))}
      </select>
    </label>
  )
}

const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))

// ---------------------------------------------------------------- crosshair

function CrosshairCard(props: {
  c: Crosshair
  onChange: (p: Partial<Crosshair>) => void
  actions: Actions
  onCopy: (text: string, what: string) => void
  onError: (e: string | null) => void
}) {
  const { c, onChange, actions, onCopy, onError } = props
  const [code, setCode] = useState('')
  const [zoom, setZoom] = useState(3)
  const [firing, setFiring] = useState(false)
  const dynamic = [0, 1, 2, 7].includes(c.style)

  const importCode = () => {
    try {
      onChange(decodeCrosshair(code))
      onError(null)
      setCode('')
    } catch (e) {
      onError(errText(e))
    }
  }

  return (
    <section className="card look-card">
      <h2 className="title-icon">
        <CrosshairIcon size={18} aria-hidden />
        Crosshair
      </h2>
      <div className="look-grid">
        <div>
          <CrosshairPreview c={c} zoom={zoom} firing={firing && dynamic} />
          <div className="look-row">
            <Choice label="Zoom" value={zoom - 1} options={['1×', '2×', '3×', '4×']} onChange={(v) => setZoom(v + 1)} />
            <Check label="Show moving spread" value={firing} disabled={!dynamic} onChange={setFiring} />
          </div>
          <div className="look-row">
            <input
              className="look-code"
              placeholder="Paste a code: CS… or CSGO-xxxxx-…"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && importCode()}
            />
            <button onClick={importCode} disabled={!code.trim()}>
              <Import size={14} aria-hidden />
              Import
            </button>
          </div>
          <code className="look-code-out">{encodeCrosshair(c)}</code>
        </div>
        <div>
          <Choice label="Style" value={c.style} options={CROSSHAIR_STYLES} onChange={(style) => onChange({ style })} />
          <Slider label="Length" value={c.length} min={0} max={40} onChange={(length) => onChange({ length })} />
          <Slider label="Thickness" value={c.thickness} min={0} max={10} onChange={(thickness) => onChange({ thickness })} />
          <Slider label="Gap" value={c.gap} min={-10} max={20} onChange={(gap) => onChange({ gap })} />
          <label className="look-slider">
            <span>Colour</span>
            <input type="color" value={hex(c.red, c.green, c.blue)} onChange={(e) => { const [red, green, blue] = rgb(e.target.value); onChange({ red, green, blue }) }} />
            <span className="muted small">{c.red} {c.green} {c.blue}</span>
          </label>
          <Slider label="Alpha" value={c.alpha} min={0} max={255} onChange={(alpha) => onChange({ alpha })} />
          <Choice label="Outline" value={c.outlineMode} options={['None', 'Full', 'Half']} onChange={(outlineMode) => onChange({ outlineMode })} />
          <label className="look-slider">
            <span>Outline colour</span>
            <input
              type="color"
              value={hex(c.outlineRed, c.outlineGreen, c.outlineBlue)}
              onChange={(e) => { const [outlineRed, outlineGreen, outlineBlue] = rgb(e.target.value); onChange({ outlineRed, outlineGreen, outlineBlue }) }}
            />
          </label>
          <Slider label="Outline alpha" value={c.outlineAlpha} min={0} max={255} onChange={(outlineAlpha) => onChange({ outlineAlpha })} />
          <div className="look-row">
            <Check label="Centre dot" value={c.centerDot} onChange={(centerDot) => onChange({ centerDot })} />
            <Check label="T style" value={c.tStyle} onChange={(tStyle) => onChange({ tStyle })} />
            <Check label="Follow recoil" value={c.followRecoil} onChange={(followRecoil) => onChange({ followRecoil })} />
          </div>
          <details>
            <summary className="muted small">Dynamic split, scope dot, screen height</summary>
            <Slider label="Spread limit" value={c.dynamicSpreadLimit} min={0} max={255} onChange={(dynamicSpreadLimit) => onChange({ dynamicSpreadLimit })} />
            <Slider label="Split distance" value={c.splitDistance} min={0} max={127} onChange={(splitDistance) => onChange({ splitDistance })} />
            <Slider label="Inner split α" value={c.innerSplitAlpha} min={0} max={1} step={0.01} onChange={(innerSplitAlpha) => onChange({ innerSplitAlpha })} />
            <Slider label="Outer split α" value={c.outerSplitAlpha} min={0.3} max={1} step={0.01} onChange={(outerSplitAlpha) => onChange({ outerSplitAlpha })} />
            <Slider label="Split size ratio" value={c.splitSizeRatio} min={0} max={1} step={0.01} onChange={(splitSizeRatio) => onChange({ splitSizeRatio })} />
            <Slider label="Scope dot scale" value={c.scopeDotScale} min={0.1} max={2} step={0.01} onChange={(scopeDotScale) => onChange({ scopeDotScale })} />
            <Check label="Scope dot in crosshair colour" value={c.scopeDotUseCrosshairColor} onChange={(scopeDotUseCrosshairColor) => onChange({ scopeDotUseCrosshairColor })} />
            <Slider label="Screen height" value={c.screenHeight} min={240} max={2160} onChange={(screenHeight) => onChange({ screenHeight })} />
          </details>
        </div>
      </div>
      {actions(
        'crosshair',
        <button onClick={() => onCopy(encodeCrosshair(c), 'Crosshair code')} title="Paste it in CS2: Settings > Game > Crosshair > Share or import">
          <Clipboard size={14} aria-hidden />
          Copy code
        </button>
      )}
    </section>
  )
}

/** Draws the crosshair the way the game lays it out (pixels at screenHeight, shown as on a 1080p screen × zoom). */
function CrosshairPreview({ c, zoom, firing }: { c: Crosshair; zoom: number; firing: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const g = canvas?.getContext('2d')
    if (!canvas || !g) return
    const W = canvas.width
    const H = canvas.height
    // a plain "dust wall and sky" scene so light and dark colours can be judged
    const sky = g.createLinearGradient(0, 0, 0, H)
    sky.addColorStop(0, '#8fb4d8')
    sky.addColorStop(0.45, '#c9d8e3')
    sky.addColorStop(0.46, '#c7a978')
    sky.addColorStop(1, '#8b6c45')
    g.fillStyle = sky
    g.fillRect(0, 0, W, H)
    g.fillStyle = '#4a3a2a'
    g.fillRect(W * 0.62, H * 0.3, W * 0.18, H * 0.7)
    g.fillStyle = '#1d1f22'
    g.fillRect(W * 0.12, H * 0.38, W * 0.12, H * 0.62)

    const px = (v: number) => (v * 1080 * zoom) / c.screenHeight
    const cx = Math.round(W / 2)
    const cy = Math.round(H / 2)
    const t = Math.max(1, px(c.thickness))
    const spread = firing ? px(Math.min(c.dynamicSpreadLimit, 40) / 4) : 0
    const gap = px(c.gap) + spread
    const len = px(c.length)
    const color = `rgba(${c.red},${c.green},${c.blue},${c.alpha / 255})`
    const outline = c.outlineMode === 0 ? null : `rgba(${c.outlineRed},${c.outlineGreen},${c.outlineBlue},${c.outlineAlpha / 255})`
    const ow = c.outlineMode === 2 ? Math.max(1, zoom / 2) : Math.max(1, zoom)
    const rect = (x: number, y: number, w: number, h: number) => {
      if (w <= 0 || h <= 0) return
      if (outline) {
        g.fillStyle = outline
        g.fillRect(x - ow, y - ow, w + ow * 2, h + ow * 2)
      }
      g.fillStyle = color
      g.fillRect(x, y, w, h)
    }
    const ring = (r: number) => {
      g.lineWidth = t
      if (outline) {
        g.strokeStyle = outline
        g.lineWidth = t + ow * 2
        g.beginPath()
        g.arc(cx, cy, r, 0, Math.PI * 2)
        g.stroke()
        g.lineWidth = t
      }
      g.strokeStyle = color
      g.beginPath()
      g.arc(cx, cy, r, 0, Math.PI * 2)
      g.stroke()
    }
    const half = t / 2
    const start = half + gap
    switch (c.style) {
      case 1:
      case 3:
        ring(Math.max(2, start + len / 2))
        break
      case 6:
        break
      case 7:
      case 9: {
        // four corner brackets
        const d = Math.max(2, start)
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const x0 = cx + sx * d
          const y0 = cy + sy * d
          rect(sx < 0 ? x0 - len : x0, y0 - half, len, t)
          rect(x0 - half, sy < 0 ? y0 - len : y0, t, len)
        }
        break
      }
      case 8: {
        const d = Math.max(2, start + len / 2)
        rect(cx - d - half, cy - d - half, d * 2 + t, t)
        rect(cx - d - half, cy + d - half, d * 2 + t, t)
        rect(cx - d - half, cy - d - half, t, d * 2 + t)
        rect(cx + d - half, cy - d - half, t, d * 2 + t)
        break
      }
      default:
        rect(cx + start, cy - half, len, t)
        rect(cx - start - len, cy - half, len, t)
        rect(cx - half, cy + start, t, len)
        if (!c.tStyle) rect(cx - half, cy - start - len, t, len)
    }
    if (c.centerDot || c.style === 6) rect(cx - half, cy - half, t, t)
  }, [c, zoom, firing])
  return <canvas ref={ref} className="look-canvas" width={480} height={270} />
}

// ---------------------------------------------------------------- viewmodel

function ViewmodelCard({ v, onChange, actions }: { v: Viewmodel; onChange: (p: Partial<Viewmodel>) => void; actions: Actions }) {
  const preset = v.presetpos > 0
  const shown = preset ? { ...v, ...PRESET_VALUES[v.presetpos] } : v
  return (
    <section className="card look-card">
      <h2 className="title-icon">
        <Hand size={18} aria-hidden />
        Viewmodel
      </h2>
      <div className="look-grid">
        <ViewmodelPreview v={shown} />
        <div>
          <Choice
            label="Preset"
            value={v.presetpos}
            options={VIEWMODEL_PRESETS}
            onChange={(presetpos) => onChange(presetpos > 0 ? { presetpos, ...PRESET_VALUES[presetpos] } : { presetpos })}
          />
          <Slider label="FOV" value={shown.fov} min={54} max={68} disabled={preset} onChange={(fov) => onChange({ fov })} />
          <Slider label="Offset X" value={shown.x} min={-2.5} max={2.5} step={0.1} disabled={preset} onChange={(x) => onChange({ x })} />
          <Slider label="Offset Y" value={shown.y} min={-2} max={2} step={0.1} disabled={preset} onChange={(y) => onChange({ y })} />
          <Slider label="Offset Z" value={shown.z} min={-2} max={2} step={0.1} disabled={preset} onChange={(z) => onChange({ z })} />
          <Check label="Left hand (cl_prefer_lefthanded)" value={v.leftHand} onChange={(leftHand) => onChange({ leftHand })} />
          <p className="muted small">Pick “Custom” to set FOV and offsets yourself (a preset overrides them in game).</p>
        </div>
      </div>
      {actions('viewmodel')}
    </section>
  )
}

/** Schematic: a gun block where the offsets put it (x right, y forward = smaller, z up); higher FOV = smaller. */
function ViewmodelPreview({ v }: { v: Viewmodel }) {
  const scale = 1 - (v.fov - 54) * 0.018 - v.y * 0.06
  const x = 250 + v.x * 22 + (v.fov - 60) * 1.5
  const y = 150 - v.z * 20 + (v.fov - 60) * 0.8
  const flip = v.leftHand ? 'translate(320 0) scale(-1 1)' : undefined
  return (
    <svg className="look-canvas" viewBox="0 0 320 180" role="img" aria-label="Viewmodel position">
      <rect width="320" height="180" fill="#3c4a57" />
      <rect y="100" width="320" height="80" fill="#6b5a44" />
      <line x1="156" y1="90" x2="164" y2="90" stroke="#7f7" strokeWidth="1.5" />
      <line x1="160" y1="86" x2="160" y2="94" stroke="#7f7" strokeWidth="1.5" />
      <g transform={flip}>
        <g transform={`translate(${x} ${y}) scale(${scale})`}>
          {/* barrel, body, magazine, hand */}
          <polygon points="-120,-28 -40,-34 -36,-20 -118,-16" fill="#2b2b2b" />
          <polygon points="-50,-40 40,-30 70,10 -30,6" fill="#4a4a4a" />
          <polygon points="-20,0 0,0 -4,40 -26,38" fill="#333" />
          <ellipse cx="40" cy="20" rx="34" ry="24" fill="#c9a27e" />
          <rect x="30" y="30" width="60" height="70" rx="14" fill="#2e3d2e" />
        </g>
      </g>
    </svg>
  )
}

// ---------------------------------------------------------------- HUD

function HudCard({ h, onChange, actions }: { h: HudLook; onChange: (p: Partial<HudLook>) => void; actions: Actions }) {
  return (
    <section className="card look-card">
      <h2 className="title-icon">
        <Gauge size={18} aria-hidden />
        HUD
      </h2>
      <div className="look-grid">
        <HudPreview h={h} />
        <div>
          <Choice label="Colour" value={h.color} options={HUD_COLORS} onChange={(color) => onChange({ color })} />
          <Slider label="HUD scale" value={h.scale} min={0.5} max={0.95} step={0.01} onChange={(scale) => onChange({ scale })} />
          <Slider label="Radar size" value={h.radarHudScale} min={0.8} max={1.3} step={0.01} onChange={(radarHudScale) => onChange({ radarHudScale })} />
          <Slider label="Radar map zoom" value={h.radarMapScale} min={0.25} max={1} step={0.01} onChange={(radarMapScale) => onChange({ radarMapScale })} />
          <Slider label="Radar icon scale" value={h.radarIconScale} min={0.4} max={1.25} step={0.01} onChange={(radarIconScale) => onChange({ radarIconScale })} />
          <div className="look-row">
            <Check label="Rotate radar" value={h.radarRotate} onChange={(radarRotate) => onChange({ radarRotate })} />
            <Check label="Keep player centred" value={h.radarCentered} onChange={(radarCentered) => onChange({ radarCentered })} />
            <Check label="Square radar on scoreboard" value={h.radarSquareWithScoreboard} onChange={(radarSquareWithScoreboard) => onChange({ radarSquareWithScoreboard })} />
          </div>
          <Choice label="FPS" value={h.telemetryFps} options={TELEMETRY_MODES} onChange={(telemetryFps) => onChange({ telemetryFps })} />
          <Choice label="Ping" value={h.telemetryPing} options={TELEMETRY_MODES} onChange={(telemetryPing) => onChange({ telemetryPing })} />
          <Choice label="Packet loss" value={h.telemetryLoss} options={TELEMETRY_MODES} onChange={(telemetryLoss) => onChange({ telemetryLoss })} />
          <Choice label="Teammates overhead" value={h.overheadMode} options={OVERHEAD_MODES} onChange={(overheadMode) => onChange({ overheadMode })} />
          <Choice label="Teammate colours" value={h.teammateColors} options={TEAMMATE_COLORS} onChange={(teammateColors) => onChange({ teammateColors })} />
          <Check label="Always show inventory (cl_showloadout)" value={h.showLoadout} onChange={(showLoadout) => onChange({ showLoadout })} />
        </div>
      </div>
      {actions('hud')}
    </section>
  )
}

/** Schematic 16:9 screen: radar, health/armour, ammo, money, telemetry and a teammate marker. */
function HudPreview({ h }: { h: HudLook }) {
  const col = HUD_COLOR_CSS[h.color] ?? HUD_COLOR_CSS[0]
  const s = h.scale / 0.85
  const r = 34 * h.radarHudScale * s
  const tele = [h.telemetryFps && 'FPS 300', h.telemetryPing && 'PING 4', h.telemetryLoss && 'LOSS 0%'].filter(Boolean)
  return (
    <svg className="look-canvas" viewBox="0 0 320 180" role="img" aria-label="HUD layout">
      <rect width="320" height="180" fill="#2f3b45" />
      <rect y="105" width="320" height="75" fill="#5d4c38" />
      {/* radar */}
      <g transform={`translate(${6 + r} ${6 + r})`}>
        <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={h.radarSquareWithScoreboard ? 3 : r} fill="#0009" stroke="#fff4" />
        <g transform={h.radarRotate ? 'rotate(-25)' : undefined}>
          <rect x={-r * 0.6 * (1.4 - h.radarMapScale)} y={-r * 0.2} width={r * 1.2 * (1.4 - h.radarMapScale)} height={r * 0.35} fill="#7a7a6a" />
          <rect x={-r * 0.15} y={-r * 0.7 * (1.4 - h.radarMapScale)} width={r * 0.3} height={r * 1.3 * (1.4 - h.radarMapScale)} fill="#7a7a6a" />
        </g>
        <circle cx={h.radarCentered ? 0 : r * 0.35} cy={h.radarCentered ? 0 : r * 0.3} r={3 * h.radarIconScale + 1} fill="#ffd24a" />
      </g>
      {/* telemetry: shown when set to Always (When poor = only on a bad connection) */}
      <text x="314" y="12" textAnchor="end" fontSize="7" fill="#fff" opacity="0.85">
        {tele.join('  ')}
      </text>
      {/* teammate */}
      <g transform="translate(205 92)">
        <rect x="-5" y="0" width="10" height="24" rx="4" fill="#333" />
        <circle cx="0" cy="-4" r="5" fill="#444" />
        {h.overheadMode > 0 && <polygon points="-4,-16 4,-16 0,-11" fill="#4fd1ff" />}
        {h.overheadMode > 1 && (
          <text y="-19" textAnchor="middle" fontSize="6" fill="#4fd1ff">
            {h.teammateColors === 2 ? '[B] ' : ''}mate
          </text>
        )}
        {h.overheadMode > 2 && <rect x="-8" y="-30" width="16" height="4" fill="#4fd1ff" opacity="0.7" />}
      </g>
      {/* bottom bar */}
      <g fill={col} fontWeight="bold" fontSize={11 * s}>
        <text x="8" y={174}>✚ 100</text>
        <text x={8 + 50 * s} y={174}>⛨ 100</text>
        <text x="312" y={174} textAnchor="end">30 / 90</text>
        <text x="8" y={174 - 16 * s} fontSize={9 * s}>$ 16000</text>
      </g>
      {h.showLoadout && (
        <g fill={col} opacity="0.8">
          {[0, 1, 2, 3].map((i) => (
            <rect key={i} x={292} y={90 + i * 12 * s} width={20 * s} height={8 * s} rx="1" />
          ))}
        </g>
      )}
    </svg>
  )
}
