import { useEffect, useState } from 'react'
import type { SetupState } from '@shared/ipc'
import Setup from './pages/Setup'

export default function App() {
  const [state, setState] = useState<SetupState | null>(null)

  useEffect(() => {
    window.api.setup.getState().then(setState)
  }, [])

  if (!state) return <div className="center muted">Loading…</div>

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">CS2Prac</span>
        <span className="muted">{state.serverInstalled ? 'Server ready' : 'Setup required'}</span>
      </header>
      <main className="content">
        {/* Play / Loadout / Console pages arrive in milestones 2–3 */}
        <Setup state={state} onState={setState} />
      </main>
    </div>
  )
}
