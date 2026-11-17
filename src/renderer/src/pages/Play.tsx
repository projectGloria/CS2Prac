import { useEffect, useState } from 'react'
import {
  CircleStop,
  Crosshair,
  LayoutGrid,
  Play as PlayIcon,
  Power,
  RefreshCw,
  SlidersHorizontal,
  Skull,
  Swords,
  Target,
  Trophy,
  Users,
  Bot as BotIcon,
  Bomb,
  Globe,
  type LucideIcon
} from 'lucide-react'
import Dropdown from '../components/Dropdown'
import CopyLine from '../components/CopyLine'
import ServerSettings from '../components/ServerSettings'
import Bots from '../components/Bots'
import Lineups from '../components/Lineups'
import WorkshopBrowser from '../components/WorkshopBrowser'
import { thumbUrl, type WorkshopMap } from '@shared/workshop'
import splashArt from '../../../../assets/CS2Prac.png'
import type { ConnectInfo, GameMode, MapChoice, MatchZyMode, ServerHealth, ServerStatus, Settings } from '@shared/ipc'

const MODES: { id: GameMode; label: string; icon: LucideIcon }[] = [
  { id: 'competitive', label: 'Competitive', icon: Trophy },
  { id: 'casual', label: 'Casual', icon: Users },
  { id: 'wingman', label: 'Wingman', icon: Swords },
  { id: 'deathmatch', label: 'Deathmatch', icon: Skull }
]

const MZ_MODES: { id: MatchZyMode; label: string; icon: LucideIcon; hint: string }[] = [
  { id: 'practice', label: 'Practice', icon: Crosshair, hint: 'MatchZy practice mode: infinite ammo and money, respawn, nade trajectories, .bot, .rethrow …' },
  { id: 'match', label: 'Match', icon: Target, hint: 'MatchZy match mode: warmup, .ready, knife round, pauses.' },
  { id: 'off', label: 'Plain', icon: Power, hint: 'MatchZy stays idle; the game mode rules apply. Use .prac in game to switch anyway.' }
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

/** map badges from assets/map-icons/<map>.png, keyed by map name */
const MAP_ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob('../../../../assets/map-icons/*.png', { eager: true, query: '?url', import: 'default' })).map(
    ([path, url]) => [path.slice(path.lastIndexOf('/') + 1, -4), url as string]
  )
)
/** the active-duty style pool shown first, in this order; everything else goes under "Others" */
const COMP_POOL = ['de_inferno', 'de_mirage', 'de_dust2', 'de_ancient', 'de_anubis', 'de_overpass', 'de_nuke', 'de_train', 'de_vertigo', 'de_cache']
type MapPool = 'comp' | 'others' | 'workshop'
const prettyMap = (name: string) => name.replace(/^(de|cs|ar)_/, '').replace(/_/g, ' ')

export default function Play({ status, lastLog }: { status: ServerStatus; lastLog?: string }) {
  const [maps, setMaps] = useState<string[]>([])
  const [selected, setSelected] = useState<MapChoice>({ kind: 'official', name: 'de_mirage' })
  const [pool, setPool] = useState<MapPool>('comp')
  /** workshop maps the page has seen (title, thumbnail) */
  const [wsInfo, setWsInfo] = useState<Record<string, WorkshopMap>>({})
  const [mode, setMode] = useState<GameMode>('competitive')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showPrefs, setShowPrefs] = useState(false)
  const [showBots, setShowBots] = useState(false)
  const [showLineups, setShowLineups] = useState(false)
  /** set from the Start click until the start finishes or fails (the prep before cs2.exe runs isn't 'starting' yet) */
  const [launching, setLaunching] = useState(false)
  const [info, setInfo] = useState<ConnectInfo | null>(null)
  const [health, setHealth] = useState<ServerHealth | null>(null)

  useEffect(() => {
    window.api.server.getHealth().then(setHealth)
    return window.api.server.onHealth(setHealth)
  }, [])

  useEffect(() => {
    window.api.workshop
      .recent()
      .then((list) => setWsInfo((i) => ({ ...Object.fromEntries(list.map((m) => [m.id, m])), ...i })))
      .catch(() => undefined)
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

  const mapLabel = (m: MapChoice) => (m.kind === 'official' ? prettyMap(m.name) : (wsInfo[m.id]?.title ?? `Workshop ${m.id}`))
  const mapIcon = (m: MapChoice) =>
    m.kind === 'official' ? MAP_ICONS[m.name] : wsInfo[m.id] && (wsInfo[m.id].thumb ?? thumbUrl(wsInfo[m.id].preview))

  function pickWorkshop(m: WorkshopMap) {
    setWsInfo((i) => ({ ...i, [m.id]: m }))
    setSelected({ kind: 'workshop', id: m.id })
  }

  /** Start the server on `map`, or switch the running one to it. */
  function playMap(map: MapChoice) {
    if (stopped) {
      setLaunching(true)
      run(() => window.api.server.start({ map, mode })).finally(() => setLaunching(false))
    } else if (running) run(() => window.api.server.changeMap(map))
  }

  const updateSettings = async (patch: Partial<Settings>) => setSettings(await window.api.settings.update(patch))
  const isSelected = (m: MapChoice) => JSON.stringify(m) === JSON.stringify(selected)

  const crashed = status.state === 'stopped' ? status.crashed : undefined
  const shownMap = status.state === 'stopped' ? selected : status.map
  const showStarting = status.state === 'starting' || (launching && stopped)
  return (
    <div className="play">
      {showStarting && (
        <div className="starting-overlay" role="status">
          <img src={splashArt} alt="" />
          <div className="spinner" />
          <strong>Server starting</strong>
          <span className="muted">{mapLabel(shownMap)}</span>
          <span className="muted small starting-log">{lastLog ?? ' '}</span>
          {status.state === 'starting' && (
            <button className="danger" onClick={() => run(() => window.api.server.stop())}>
              <CircleStop size={15} aria-hidden />
              Cancel
            </button>
          )}
        </div>
      )}
      {(crashed || health?.cs2Updated || health?.hudUpdated || !!health?.problems.length) && (
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
          {health?.hudUpdated && (
            <p className="notice">
              The in-game windows (K and L) were updated. If CS2 was already open, restart it once: until then it keeps the old
              layout (missing tiles, buttons that do nothing).
            </p>
          )}
          {health?.cs2Updated && !health.problems.length && (
            <p className="notice">
              CS2 has been updated since your last working start. If the server or skins misbehave, use Setup → Update plugins to
              latest.
            </p>
          )}
        </div>
      )}

      <section className="card play-maps">
        <div className="card-head">
          <h2>Map</h2>
          <Dropdown
            value={pool}
            onChange={setPool}
            align="right"
            options={[
              { value: 'comp', label: 'Comp pool', icon: Trophy, hint: `${COMP_POOL.filter((n) => maps.includes(n)).length} maps` },
              { value: 'others', label: 'Others', icon: LayoutGrid, hint: `${maps.filter((n) => !COMP_POOL.includes(n)).length} maps` },
              { value: 'workshop', label: 'Workshop', icon: Globe, hint: 'search Steam Workshop maps' }
            ]}
          />
        </div>
        {pool === 'workshop' ? (
          <WorkshopBrowser
            selectedId={selected.kind === 'workshop' ? selected.id : null}
            onSelect={pickWorkshop}
            onStart={(m) => {
              pickWorkshop(m)
              playMap({ kind: 'workshop', id: m.id })
            }}
            startDisabled={busy || !(stopped || running)}
          />
        ) : (
        <div className="map-grid">
          {(pool === 'comp' ? COMP_POOL.filter((n) => maps.includes(n)) : maps.filter((n) => !COMP_POOL.includes(n))).map((name) => {
            const m: MapChoice = { kind: 'official', name }
            return (
              <button key={name} className={`map-tile ${isSelected(m) ? 'selected' : ''}`} onClick={() => setSelected(m)}>
                {MAP_ICONS[name] ? <img className="map-icon" src={MAP_ICONS[name]} alt="" /> : <span className="map-icon" />}
                <span className="map-text">
                  <span className="map-name">{prettyMap(name)}</span>
                  <span className="muted small">{name}</span>
                </span>
              </button>
            )
          })}
        </div>
        )}
      </section>

      <div className="play-side">
        <section className="card server-card">
          <h2>Server</h2>
          <div className="server-fields">
            <div className="field">
              Mode
              <Dropdown
                value={mode}
                disabled={!stopped}
                onChange={setMode}
                options={MODES.map((m) => ({ value: m.id, label: m.label, icon: m.icon }))}
              />
            </div>
            {settings && (
              <div className="field">
                MatchZy
                <Dropdown
                  value={settings.matchzyMode}
                  disabled={!stopped}
                  onChange={(v) => updateSettings({ matchzyMode: v })}
                  align="right"
                  options={MZ_MODES.map((m) => ({ value: m.id, label: m.label, icon: m.icon }))}
                />
              </div>
            )}
          </div>
          {settings && <p className="muted small hint">{MZ_MODES.find((m) => m.id === settings.matchzyMode)?.hint}</p>}

          <div className="server-launch">
            <div className="selected-map">
              {mapIcon(shownMap) ? (
                <img className={`map-icon${shownMap.kind === 'workshop' ? ' ws-icon' : ''}`} src={mapIcon(shownMap)} alt="" />
              ) : (
                <span className="map-icon" />
              )}
              <span className="map-text">
                <span className="muted small">{stopped ? 'Selected map' : 'Running map'}</span>
                <strong>{mapLabel(shownMap)}</strong>
              </span>
            </div>
            <div className="server-actions">
              {stopped && (
                <button
                  className="primary big"
                  disabled={busy}
                  onClick={() => playMap(selected)}
                >
                  <PlayIcon size={16} aria-hidden />
                  Start server
                </button>
              )}
              {status.state === 'starting' && <button disabled>Starting… (see Console)</button>}
              {running && !isSelected(status.map) && (
                <button disabled={busy} onClick={() => playMap(selected)}>
                  <RefreshCw size={15} aria-hidden />
                  Change to {mapLabel(selected)}
                </button>
              )}
              {!stopped && (
                <button className="danger" disabled={status.state === 'stopping'} onClick={() => run(() => window.api.server.stop())}>
                  <CircleStop size={15} aria-hidden />
                  {status.state === 'stopping' ? 'Stopping…' : 'Stop server'}
                </button>
              )}
              <button title="Settings of the in-game L window" onClick={() => setShowPrefs(true)}>
                <SlidersHorizontal size={15} aria-hidden />
                Server settings
              </button>
              <button title="Bot names, clan tags and pictures" onClick={() => setShowBots(true)}>
                <BotIcon size={15} aria-hidden />
                Bots
              </button>
              <button title="Saved nade lineups (MatchZy .savenade)" onClick={() => setShowLineups(true)}>
                <Bomb size={15} aria-hidden />
                Lineups
              </button>
            </div>
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
                You are admin: <code>css_cmd &lt;command&gt;</code> in the console or <code>!cmd &lt;command&gt;</code> in chat runs any
                server command.
              </p>
            </div>
          )}
        </section>

        {showPrefs && <ServerSettings onClose={() => setShowPrefs(false)} />}
        {showBots && <Bots onClose={() => setShowBots(false)} />}
        {showLineups && (
          <Lineups
            currentMap={status.state !== 'stopped' && status.map.kind === 'official' ? status.map.name : null}
            onClose={() => setShowLineups(false)}
          />
        )}

        <section className="card mz-help">
          <h2>MatchZy commands</h2>
          <div className="mz-scroll">
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
          </div>
        </section>
      </div>
    </div>
  )
}
