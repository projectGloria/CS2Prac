import { useEffect, useState } from 'react'
import { Copy, FolderOpen, Minus, Play as PlayIcon, Settings, Shirt, Square, SquareTerminal, X, type LucideIcon } from 'lucide-react'
import type { AppInfo, ServerStatus, SetupState, UpdateStatus } from '@shared/ipc'
import appIcon from '../../../build/icon.png'
import Setup from './pages/Setup'
import Play from './pages/Play'
import Console from './pages/Console'
import Loadout from './pages/Loadout'

type Tab = 'play' | 'loadout' | 'console' | 'setup'
const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'play', label: 'Play', icon: PlayIcon },
  { id: 'loadout', label: 'Loadout', icon: Shirt },
  { id: 'console', label: 'Console', icon: SquareTerminal },
  { id: 'setup', label: 'Setup', icon: Settings }
]
const MAX_LOG_LINES = 2000

export default function App() {
  const [setup, setSetup] = useState<SetupState | null>(null)
  const [tab, setTab] = useState<Tab>('play')
  const [status, setStatus] = useState<ServerStatus>({ state: 'stopped' })
  const [serverLog, setServerLog] = useState<string[]>([])
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [update, setUpdate] = useState<UpdateStatus>({ state: 'idle' })
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    window.api.setup.getState().then((s) => {
      setSetup(s)
      if (!s.serverInstalled || !s.pluginsInstalled) setTab('setup')
    })
    window.api.server.getStatus().then(setStatus)
    window.api.app.info().then(setInfo)
    window.api.app.getUpdateStatus().then(setUpdate)
    window.api.window.isMaximized().then(setMaximized)
    const offM = window.api.window.onMaximized(setMaximized)
    const offU = window.api.app.onUpdateStatus(setUpdate)
    const offS = window.api.server.onStatus(setStatus)
    const offL = window.api.server.onLog((l) => setServerLog((log) => [...log.slice(-MAX_LOG_LINES + 1), l]))
    return () => {
      offS()
      offL()
      offU()
      offM()
    }
  }, [])

  if (!setup) return <div className="center muted">Loading…</div>
  const ready = setup.serverInstalled && setup.pluginsInstalled

  return (
    <div className="app">
      <header className="titlebar" onDoubleClick={(e) => e.target === e.currentTarget && window.api.window.toggleMaximize()}>
        <span className="brand">
          <img src={appIcon} alt="" />
          CS2Prac
        </span>
        <nav className="tabs">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={tab === id ? 'active' : ''}
              disabled={(id === 'play' || id === 'console') && !ready}
              onClick={() => setTab(id)}
            >
              <Icon size={15} aria-hidden />
              {label}
            </button>
          ))}
        </nav>
        <span className="titlebar-right">
          <span className={`status-pill ${status.state}`}>{ready ? status.state : 'setup required'}</span>
          <button className="icon-btn" title="Open the folder with CS2Prac's log files" onClick={() => window.api.app.openLogsFolder()}>
            <FolderOpen size={15} aria-hidden />
          </button>
          {info && <span className="muted small version">v{info.version}</span>}
        </span>
        <span className="win-controls">
          <button title="Minimize" onClick={() => window.api.window.minimize()}>
            <Minus size={16} aria-hidden />
          </button>
          <button title={maximized ? 'Restore' : 'Maximize'} onClick={() => window.api.window.toggleMaximize()}>
            {maximized ? <Copy size={13} aria-hidden /> : <Square size={13} aria-hidden />}
          </button>
          <button className="close" title="Close" onClick={() => window.api.window.close()}>
            <X size={17} aria-hidden />
          </button>
        </span>
      </header>
      {update.state === 'ready' && (
        <div className="banner">
          CS2Prac {update.version} is ready to install.
          <button className="primary" onClick={() => window.api.app.installUpdate()}>
            Restart to update
          </button>
        </div>
      )}
      {update.state === 'downloading' && (
        <div className="banner muted">
          Downloading CS2Prac {update.version}… {update.percent.toFixed(0)}%
        </div>
      )}
      <main className="content">
        {tab === 'play' && <Play status={status} />}
        {tab === 'loadout' && <Loadout />}
        {tab === 'console' && <Console status={status} log={serverLog} onClear={() => setServerLog([])} />}
        {tab === 'setup' && <Setup state={setup} onState={setSetup} serverStopped={status.state === 'stopped'} />}
      </main>
    </div>
  )
}
