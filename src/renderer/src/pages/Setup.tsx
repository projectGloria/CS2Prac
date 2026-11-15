import { useEffect, useRef, useState } from 'react'
import type { SetupProgress, SetupState } from '@shared/ipc'

interface Props {
  state: SetupState
  onState: (s: SetupState) => void
  serverStopped: boolean
}

const MAX_LOG_LINES = 500

export default function Setup({ state, onState, serverStopped }: Props) {
  const [progress, setProgress] = useState<SetupProgress | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const offP = window.api.setup.onProgress(setProgress)
    const offL = window.api.setup.onLog((line) => setLog((l) => [...l.slice(-MAX_LOG_LINES + 1), line]))
    return () => {
      offP()
      offL()
    }
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight)
  }, [log])

  async function install() {
    setBusy(true)
    setLog([])
    try {
      await window.api.setup.install()
    } catch {
      /* error is reported through the progress event */
    } finally {
      setBusy(false)
      onState(await window.api.setup.getState())
    }
  }

  const pct = progress?.percent
  const ready = state.serverInstalled && state.pluginsInstalled
  const v = state.pluginVersions
  return (
    <section className="card">
      <h1>Server setup</h1>
      <p className="muted">
        CS2Prac installs a CS2 dedicated server on this PC with SteamCMD, then adds Metamod:Source and
        CounterStrikeSharp. The download is about 60&nbsp;GB, so pick a drive with enough space.
      </p>

      <div className="row">
        <code className="path">{state.installDir ?? 'No folder selected'}</code>
        <button disabled={busy} onClick={async () => onState(await window.api.setup.chooseInstallDir())}>
          Choose folder…
        </button>
      </div>

      <ul className="checklist">
        <li className={state.steamcmdInstalled ? 'ok' : ''}>SteamCMD</li>
        <li className={state.serverInstalled ? 'ok' : ''}>CS2 dedicated server</li>
        <li className={state.pluginsInstalled ? 'ok' : ''}>
          Metamod + CounterStrikeSharp
          {v.metamod && <span className="muted small"> (MM {v.metamod}, CSS {v.counterstrikesharp})</span>}
        </li>
      </ul>

      <button className="primary" disabled={busy || !state.installDir || !serverStopped} onClick={install}>
        {busy ? 'Working…' : ready ? 'Update / repair' : 'Install'}
      </button>
      {!serverStopped && <p className="muted small">Stop the server to update it.</p>}
      {ready && (
        <p className="muted small">
          Run “Update / repair” after a CS2 update. Each CS2 update can break the plugins until new Metamod and
          CounterStrikeSharp builds come out.
        </p>
      )}

      {progress && (
        <div className={`progress ${progress.phase === 'error' ? 'error' : ''}`}>
          <div className="bar">
            <div className={`fill ${pct == null ? 'indeterminate' : ''}`} style={{ width: `${pct ?? 100}%` }} />
          </div>
          <span>
            {progress.message}
            {pct != null && progress.phase !== 'done' ? ` — ${pct.toFixed(1)}%` : ''}
          </span>
        </div>
      )}

      {log.length > 0 && (
        <pre className="log" ref={logRef}>
          {log.join('\n')}
        </pre>
      )}
    </section>
  )
}
