import { useEffect, useState } from 'react'
import type { ConnectInfo, GameMode, MapChoice, ServerStatus, Settings } from '@shared/ipc'

const MODES: { id: GameMode; label: string }[] = [
  { id: 'competitive', label: 'Competitive' },
  { id: 'casual', label: 'Casual' },
  { id: 'wingman', label: 'Wingman' },
  { id: 'deathmatch', label: 'Deathmatch' }
]

/** A console line with a copy button. */
function CopyLine({ text, hidden }: { text: string; hidden?: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="copy-line">
      <code>{hidden ? text.replace(hidden, '•'.repeat(8)) : text}</code>
      <button className="small-btn" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

const mapLabel = (m: MapChoice) => (m.kind === 'official' ? m.name : `Workshop ${m.id}`)
const prettyMap = (name: string) => name.replace(/^(de|cs|ar)_/, '').replace(/_/g, ' ')

export default function Play({ status }: { status: ServerStatus }) {
  const [maps, setMaps] = useState<string[]>([])
  const [selected, setSelected] = useState<MapChoice>({ kind: 'official', name: 'de_mirage' })
  const [workshopId, setWorkshopId] = useState('')
  const [mode, setMode] = useState<GameMode>('competitive')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<ConnectInfo | null>(null)

  useEffect(() => {
    window.api.server.listMaps().then(setMaps)
    window.api.settings.get().then(setSettings)
    window.api.server.connectInfo().then(setInfo)
  }, [])

  const running = status.state === 'running'
  const stopped = status.state === 'stopped'

  async function run(fn: () => Promise<void>) {
    setError(null)
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  function pickWorkshop() {
    const id = workshopId.trim().match(/\d{5,20}/)?.[0] // accepts a raw id or a workshop URL
    if (!id) return setError('Enter a workshop ID or a steamcommunity.com workshop link')
    setError(null)
    setSelected({ kind: 'workshop', id })
  }

  const updateSettings = async (patch: Partial<Settings>) => setSettings(await window.api.settings.update(patch))
  const isSelected = (m: MapChoice) => JSON.stringify(m) === JSON.stringify(selected)

  return (
    <div className="play">
      <section className="card wide">
        <h2>Map</h2>
        <div className="map-grid">
          {maps.map((name) => {
            const m: MapChoice = { kind: 'official', name }
            return (
              <button key={name} className={`map-tile ${isSelected(m) ? 'selected' : ''}`} onClick={() => setSelected(m)}>
                <span className="map-name">{prettyMap(name)}</span>
                <span className="muted small">{name}</span>
              </button>
            )
          })}
        </div>
        <div className="row">
          <input
            placeholder="Workshop map ID or link"
            value={workshopId}
            onChange={(e) => setWorkshopId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && pickWorkshop()}
          />
          <button onClick={pickWorkshop}>Use workshop map</button>
        </div>
      </section>

      <section className="card side">
        <h2>Server</h2>
        <label className="field">
          Mode
          <select value={mode} disabled={!stopped} onChange={(e) => setMode(e.target.value as GameMode)}>
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <p className="muted small">
          Selected: <strong>{mapLabel(selected)}</strong>
          {status.state !== 'stopped' && (
            <>
              <br />
              Current: <strong>{mapLabel(status.map)}</strong>
            </>
          )}
        </p>

        <div className="stack">
          {stopped && (
            <button className="primary" disabled={busy} onClick={() => run(() => window.api.server.start({ map: selected, mode }))}>
              Start server
            </button>
          )}
          {status.state === 'starting' && <button disabled>Starting… (see Console)</button>}
          {running && (
            <>
              <button disabled={busy} onClick={() => run(() => window.api.server.changeMap(selected))}>
                Change map to {mapLabel(selected)}
              </button>
            </>
          )}
          {!stopped && (
            <button className="danger" disabled={status.state === 'stopping'} onClick={() => run(() => window.api.server.stop())}>
              {status.state === 'stopping' ? 'Stopping…' : 'Stop server'}
            </button>
          )}
        </div>
        {error && <p className="error-text">{error}</p>}

        {running && info && (
          <div className="connect-box">
            <h3>Join from CS2</h3>
            <p className="muted small">Open the CS2 console (~) and paste:</p>
            <CopyLine text={info.connect[0]} />
            {info.connect.length > 1 && (
              <details>
                <summary className="muted small">From another PC on your network</summary>
                {info.connect.slice(1).map((c) => (
                  <CopyLine key={c} text={c} />
                ))}
              </details>
            )}
            <p className="muted small">
              You are admin. Run any server command in chat with <code>!cmd &lt;command&gt;</code> or in the console with{' '}
              <code>css_cmd &lt;command&gt;</code>, e.g. <code>!cmd exec mycfg</code>. Optionally, to use <code>rcon &lt;command&gt;</code>
              from the console, paste this once:
            </p>
            <CopyLine text={info.rcon} hidden={settings?.rconPassword} />
          </div>
        )}

        {settings && (
          <>
            <h3>Options</h3>
            <p className="muted small">
              Your cfg files: everything in the server cfg folder is copied to the server before each start.{' '}
              <code>cs2prac_server.cfg</code> runs after every map load.
            </p>
            <button onClick={() => window.api.server.openCfgFolder()}>Open server cfg folder</button>
            <label className="field">
              Steam Web API key (optional, for workshop maps)
              <input
                type="password"
                defaultValue={settings.authKey ?? ''}
                onBlur={(e) => updateSettings({ authKey: e.target.value.trim() || undefined })}
              />
            </label>
          </>
        )}
      </section>
    </div>
  )
}
