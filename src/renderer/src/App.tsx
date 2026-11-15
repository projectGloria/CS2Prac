import { useEffect, useState } from 'react'
import type { AppInfo, ServerStatus, SetupState, UpdateStatus } from '@shared/ipc'
import Setup from './pages/Setup'
import Play from './pages/Play'
import Console from './pages/Console'
import Loadout from './pages/Loadout'

type Tab = 'play' | 'loadout' | 'console' | 'setup'
const MAX_LOG_LINES = 2000

export default function App() {
  const [setup, setSetup] = useState<SetupState | null>(null)
  const [tab, setTab] = useState<Tab>('play')
  const [status, setStatus] = useState<ServerStatus>({ state: 'stopped' })
  const [serverLog, setServerLog] = useState<string[]>([])
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [update, setUpdate] = useState<UpdateStatus>({ state: 'idle' })

  useEffect(() => {
    window.api.setup.getState().then((s) => {
      setSetup(s)
      if (!s.serverInstalled || !s.pluginsInstalled) setTab('setup')
    })
    window.api.server.getStatus().then(setStatus)
    window.api.app.info().then(setInfo)
    window.api.app.getUpdateStatus().then(setUpdate)
    const offU = window.api.app.onUpdateStatus(setUpdate)
    const offS = window.api.server.onStatus(setStatus)
    const offL = window.api.server.onLog((l) => setServerLog((log) => [...log.slice(-MAX_LOG_LINES + 1), l]))
    return () => {
      offS()
      offL()
      offU()
    }
  }, [])

  if (!setup) return <div className="center muted">Loading…</div>
  const ready = setup.serverInstalled && setup.pluginsInstalled

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">CS2Prac</span>
        <nav className="tabs">
          {(['play', 'loadout', 'console', 'setup'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} disabled={(t === 'play' || t === 'console') && !ready} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
        <span className="topbar-right">
          <button className="link small" title="Open the folder with CS2Prac's log files" onClick={() => window.api.app.openLogsFolder()}>
            Logs
          </button>
          {info && <span className="muted small">v{info.version}</span>}
          <span className={`status-pill ${status.state}`}>{ready ? status.state : 'setup required'}</span>
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
