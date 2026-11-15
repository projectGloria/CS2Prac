import { useEffect, useState } from 'react'
import type { ServerStatus, SetupState } from '@shared/ipc'
import Setup from './pages/Setup'
import Play from './pages/Play'
import Console from './pages/Console'

type Tab = 'play' | 'console' | 'setup'
const MAX_LOG_LINES = 2000

export default function App() {
  const [setup, setSetup] = useState<SetupState | null>(null)
  const [tab, setTab] = useState<Tab>('play')
  const [status, setStatus] = useState<ServerStatus>({ state: 'stopped' })
  const [serverLog, setServerLog] = useState<string[]>([])

  useEffect(() => {
    window.api.setup.getState().then((s) => {
      setSetup(s)
      if (!s.serverInstalled || !s.pluginsInstalled) setTab('setup')
    })
    window.api.server.getStatus().then(setStatus)
    const offS = window.api.server.onStatus(setStatus)
    const offL = window.api.server.onLog((l) => setServerLog((log) => [...log.slice(-MAX_LOG_LINES + 1), l]))
    return () => {
      offS()
      offL()
    }
  }, [])

  if (!setup) return <div className="center muted">Loading…</div>
  const ready = setup.serverInstalled && setup.pluginsInstalled

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">CS2Prac</span>
        <nav className="tabs">
          {(['play', 'console', 'setup'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} disabled={t !== 'setup' && !ready} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
        <span className={`status-pill ${status.state}`}>{ready ? status.state : 'setup required'}</span>
      </header>
      <main className="content">
        {tab === 'play' && <Play status={status} />}
        {tab === 'console' && <Console status={status} log={serverLog} onClear={() => setServerLog([])} />}
        {tab === 'setup' && <Setup state={setup} onState={setSetup} serverStopped={status.state === 'stopped'} />}
      </main>
    </div>
  )
}
