import { useEffect, useState } from 'react'
import type { ConnectInfo, GameMode, MapChoice, MatchZyMode, ServerHealth, ServerStatus, Settings } from '@shared/ipc'

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

const MZ_MODES: { id: MatchZyMode; label: string; hint: string }[] = [
  { id: 'practice', label: 'Practice', hint: 'MatchZy practice mode: infinite ammo and money, respawn, nade trajectories, .bot, .rethrow …' },
  { id: 'match', label: 'Match', hint: 'MatchZy match mode: warmup, .ready, knife round, pauses.' },
  { id: 'off', label: 'Plain', hint: 'MatchZy stays idle; the game mode rules apply. Use .prac in game to switch anyway.' }
]

/** MatchZy chat commands (also with ! instead of .). */
const MZ_COMMANDS: [string, string][] = [
  ['.prac / .exitprac', 'start or leave practice mode'],
  ['.bot / .cbot', 'place a bot where you stand (crouching)'],
  ['.nobots', 'remove all bots'],
  ['.spawn <n> / .ctspawn / .tspawn', 'teleport to a spawn'],
  ['.spawns', 'spawn squares with numbers, on by default in practice; look at one and press E to stand on it (CS2Prac)'],
  ['.glow', 'outline bots through walls (CS2Prac)'],
  ['.rethrow / .last', 'rethrow your last grenade / go back to where you threw it'],
  ['.savenade <name> / .loadnade <name>', 'save and load lineups'],
  ['.listnades', 'list saved lineups'],
  ['.noflash', 'toggle flash immunity'],
  ['.clear', 'remove smokes and fires'],
  ['.ff', 'fast-forward 20 seconds'],
  ['.timer', 'stopwatch for runs'],
  ['.god', 'toggle god mode'],
  ['.dryrun', 'dry-run a round with match settings'],
  ['.ct / .t / .spec', 'switch team'],
  ['.map <name>', 'change map'],
  ['!cmd <command>', 'run any server command (CS2Prac)']
]

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
  const [health, setHealth] = useState<ServerHealth | null>(null)

  useEffect(() => {
    window.api.server.getHealth().then(setHealth)
    return window.api.server.onHealth(setHealth)
  }, [])

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

  const crashed = status.state === 'stopped' ? status.crashed : undefined
  return (
    <div className="play">
      {(crashed || health?.cs2Updated || !!health?.problems.length) && (
        <div className="notices">
          {crashed && (
            <p className="notice error">
              The server stopped unexpectedly (exit code {crashed.code ?? 'unknown'}). The Console tab and the Logs link show what it
              printed last. Start it again when ready.
            </p>
          )}
          {health?.problems.map((p) => (
            <p key={p} className="notice error">
              {p}
            </p>
          ))}
          {health?.cs2Updated && !health.problems.length && (
            <p className="notice">
              CS2 has been updated since your last working start. If the server or skins misbehave, use Setup → Update plugins to
              latest.
            </p>
          )}
        </div>
      )}
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

        {settings && (
          <label className="field">
            MatchZy
            <select
              value={settings.matchzyMode}
              disabled={!stopped}
              onChange={(e) => updateSettings({ matchzyMode: e.target.value as MatchZyMode })}
            >
              {MZ_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="muted small">{MZ_MODES.find((m) => m.id === settings.matchzyMode)?.hint}</span>
          </label>
        )}

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

        <details className="mz-help">
          <summary>MatchZy commands</summary>
          <table>
            <tbody>
              {MZ_COMMANDS.map(([c, d]) => (
                <tr key={c}>
                  <td>
                    <code>{c}</code>
                  </td>
                  <td className="muted small">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>

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
              You are admin. Run any server command in the console with <code>css_cmd &lt;command&gt;</code> or in chat with{' '}
              <code>!cmd &lt;command&gt;</code>, e.g. <code>css_cmd exec mycfg</code>. What the server prints shows up in the Console
              tab here. (CS2's own <code>rcon</code> command doesn't reach the server, so it isn't used.)
            </p>
          </div>
        )}

        <div className="connect-box">
          <h3>In-game skin menu</h3>
          <p className="muted small">Paste once in the CS2 console (it is saved with your binds), then press K in game:</p>
          <CopyLine text="bind k css_menu" />
          <p className="muted small">
            W/S move · A/D page · E select · R back. Chat search: <code>!skin</code>, <code>!knife</code>, <code>!gloves</code>,{' '}
            <code>!agent</code>, <code>!sticker</code>, <code>!charm</code> followed by a name, e.g. <code>!knife karambit fade</code>.
            Picks are applied immediately and saved to your active profile.
          </p>
        </div>

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
