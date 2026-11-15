import { useEffect, useRef, useState } from 'react'
import type { SetupProgress, SetupState } from '@shared/ipc'

interface Props {
  state: SetupState
  onState: (s: SetupState) => void
}

const MAX_LOG_LINES = 500

export default function Setup({ state, onState }: Props) {
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
  return (
    <section className="card">
      <h1>Server setup</h1>
      <p className="muted">
        CS2Prac installs a CS2 dedicated server on this PC with SteamCMD. The download is about 60&nbsp;GB, so pick a
        drive with enough space.
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
      </ul>

      <button className="primary" disabled={busy || !state.installDir} onClick={install}>
        {busy ? 'Installing…' : state.serverInstalled ? 'Update / verify server' : 'Install server'}
      </button>

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
