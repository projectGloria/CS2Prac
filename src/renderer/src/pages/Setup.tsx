import { useEffect, useRef, useState } from 'react'
import type { ServerSource, SetupProgress, SetupState } from '@shared/ipc'

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

  async function install(quick = false, mode: 'pinned' | 'latest' = 'pinned') {
    setBusy(true)
    setLog([])
    try {
      // One click: use the CS2 install's drive when no usable folder is chosen yet
      if (quick && (!state.installDir || !state.sameDrive)) onState(await window.api.setup.useSuggestedDir())
      await window.api.setup.install(mode)
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
  const linked = state.serverSource === 'client'
  const drive = state.clientDir?.slice(0, 2)
  const badDrive = linked && !!state.installDir && !state.sameDrive
  const canInstall = !busy && !!state.installDir && serverStopped && !badDrive && (!linked || !!state.clientDir)
  const setSource = async (s: ServerSource) => onState(await window.api.setup.setSource(s))
  // First run with CS2 found: a single button does everything, the options stay folded away
  const quick = !ready && linked && !!state.clientDir && (!state.installDir || badDrive)
  return (
    <section className="card">
      <h1>Server setup</h1>
      <p className="muted">
        CS2Prac runs a CS2 server on this PC and adds Metamod:Source, CounterStrikeSharp and its skin plugin to it.
      </p>

      {quick && (
        <div className="quick-setup">
          <p>
            CS2 found in <code>{state.clientDir}</code>. The server will be set up in <code>{drive}\CS2Prac</code> using your game
            files. It needs almost no extra disk space, and your game is not modified.
          </p>
          <button className="primary big" disabled={busy || !serverStopped} onClick={() => install(true)}>
            {busy ? 'Setting up…' : 'Set up'}
          </button>
        </div>
      )}

      <details className="advanced" open={!quick}>
        <summary>{quick ? 'Other options' : 'Server files'}</summary>
      <div className="choices">
        <label className={`choice ${linked ? 'active' : ''} ${state.clientDir ? '' : 'disabled'}`}>
          <input
            type="radio"
            name="source"
            checked={linked}
            disabled={busy || !state.clientDir}
            onChange={() => setSource('client')}
          />
          <span>
            <b>Use my CS2 installation</b> <span className="muted small">(no extra disk space)</span>
            <span className="muted small block">
              {state.clientDir
                ? <>Links the game files from <code>{state.clientDir}</code>. Your game is not modified. The server folder must be on drive {drive}.</>
                : 'CS2 was not found in your Steam libraries.'}
            </span>
          </span>
        </label>
        <label className={`choice ${linked ? '' : 'active'}`}>
          <input type="radio" name="source" checked={!linked} disabled={busy} onChange={() => setSource('steamcmd')} />
          <span>
            <b>Download the dedicated server</b> <span className="muted small">(about 60&nbsp;GB, SteamCMD)</span>
            <span className="muted small block">A separate copy of CS2 that any drive can hold.</span>
          </span>
        </label>
      </div>

      <div className="row">
        <code className="path">{state.installDir ?? 'No folder selected'}</code>
        {linked && state.clientDir && (!state.installDir || badDrive) && (
          <button disabled={busy} onClick={async () => onState(await window.api.setup.useSuggestedDir())}>
            Use {drive}\CS2Prac
          </button>
        )}
        <button disabled={busy} onClick={async () => onState(await window.api.setup.chooseInstallDir())}>
          Choose folder…
        </button>
      </div>
      {badDrive && <p className="error-text small">This folder is not on drive {drive}, where CS2 is installed.</p>}
      </details>

      <ul className="checklist">
        {!linked && <li className={state.steamcmdInstalled ? 'ok' : ''}>SteamCMD</li>}
        <li className={state.serverInstalled ? 'ok' : ''}>{linked ? 'Server folder linked to your CS2 install' : 'CS2 dedicated server'}</li>
        <li className={state.pluginsInstalled ? 'ok' : ''}>
          Metamod + CounterStrikeSharp
          {v.metamod && <span className="muted small"> (MM {v.metamod}, CSS {v.counterstrikesharp})</span>}
        </li>
        <li className={state.pracSkinsInstalled ? 'ok' : ''}>PracSkins (skin plugin)</li>
        <li className={state.matchzyInstalled ? 'ok' : ''}>
          MatchZy (practice and match mode){v.matchzy && <span className="muted small"> ({v.matchzy})</span>}
        </li>
      </ul>

      <button className="primary" disabled={!canInstall} onClick={() => install()}>
        {busy ? 'Working…' : ready ? 'Update / repair' : 'Install'}
      </button>
      {ready && (
        <button disabled={!canInstall} onClick={() => install(false, 'latest')} title="Download the newest Metamod, CounterStrikeSharp and MatchZy">
          Update plugins to latest
        </button>
      )}
      {!serverStopped && <p className="muted small">Stop the server to update it.</p>}
      {ready && (
        <p className="muted small">
          “Update / repair” keeps the plugin versions CS2Prac was tested with. After a CS2 update breaks them, use “Update plugins
          to latest”.
        </p>
      )}
      {ready && (
        <p className="muted small">
          {linked ? 'Game files are re-linked automatically before each start. ' : 'Run “Update / repair” after a CS2 update. '} Each CS2 update can break the plugins until new Metamod and
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
