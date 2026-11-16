import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, FileUp, RefreshCw, Trash2 } from 'lucide-react'
import Modal from './Modal'
import Dropdown from './Dropdown'
import CopyLine from './CopyLine'
import { GLOBAL_OWNER, importCode, NADE_TYPES, type Lineup, type NadeType } from '@shared/lineups'
import type { SteamAccount } from '@shared/skins'

const ALL = '*'
const TYPE_LABEL: Record<NadeType, string> = { Smoke: 'Smoke', Flash: 'Flash', HE: 'HE', Molly: 'Molotov', Decoy: 'Decoy', '': 'Any' }
const key = (l: Lineup) => `${l.owner}/${l.name}`
const message = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * MatchZy's saved nades (.savenade in practice mode): list per map, rename, describe, change the type, delete,
 * export/import a share file. In game they show on the L window's Nades tab (Go teleports you to the spot).
 */
export default function Lineups({ currentMap, onClose }: { currentMap: string | null; onClose: () => void }) {
  const [lineups, setLineups] = useState<Lineup[] | null>(null)
  const [accounts, setAccounts] = useState<SteamAccount[]>([])
  const [map, setMap] = useState<string>(currentMap ?? ALL)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const load = () =>
    window.api.lineups
      .list()
      .then(setLineups)
      .catch((e) => setError(message(e)))
  useEffect(() => {
    load()
    window.api.skins.listSteamAccounts().then(setAccounts).catch(() => undefined)
  }, [])

  const maps = useMemo(() => [...new Set((lineups ?? []).map((l) => l.map))].sort(), [lineups])
  const shown = (lineups ?? []).filter((l) => map === ALL || l.map === map)
  const owner = (id: string) =>
    id === GLOBAL_OWNER ? 'Everyone' : (accounts.find((a) => a.steamId === id)?.personaName ?? id)

  async function act(fn: () => Promise<Lineup[]>) {
    setError(null)
    try {
      setLineups(await fn())
    } catch (e) {
      setError(message(e))
    }
  }

  async function exportShown() {
    setError(null)
    try {
      const path = await window.api.lineups.exportFile(shown, `lineups-${map === ALL ? 'all' : map}.json`)
      if (path) setNote(`Saved ${shown.length} lineup${shown.length === 1 ? '' : 's'} to ${path}`)
    } catch (e) {
      setError(message(e))
    }
  }

  async function importFile() {
    setError(null)
    try {
      const r = await window.api.lineups.importFile(map === ALL ? (currentMap ?? '') : map)
      if (!r) return
      if (!r.ok) return setError(r.error)
      setLineups(r.lineups)
      setNote(`Imported ${r.added} lineup${r.added === 1 ? '' : 's'} (saved for everyone on the server)`)
    } catch (e) {
      setError(message(e))
    }
  }

  const mapOptions = [
    { value: ALL, label: 'All maps', hint: `${lineups?.length ?? 0}` },
    ...[...new Set([...maps, ...(currentMap ? [currentMap] : [])])].sort().map((m) => ({
      value: m,
      label: m,
      hint: `${(lineups ?? []).filter((l) => l.map === m).length}`
    }))
  ]

  return (
    <Modal title="Lineups" onClose={onClose}>
      <p className="muted small">
        Lineups saved in game with MatchZy's <code>.savenade &lt;name&gt; [description]</code> (practice mode). In game,
        open them from the L window's Nades tab or with <code>.loadnade &lt;name&gt;</code>. Changes here apply at once,
        also while the server runs.
      </p>
      <div className="lineup-bar">
        <Dropdown value={map} onChange={setMap} options={mapOptions} />
        <span className="spacer" />
        <button title="Read the file again" onClick={load}>
          <RefreshCw size={15} aria-hidden />
        </button>
        <button onClick={importFile} title="Add lineups from a share file or .importnade codes">
          <FileUp size={15} aria-hidden />
          Import
        </button>
        <button onClick={exportShown} disabled={shown.length === 0} title="Save the listed lineups to a share file">
          <Download size={15} aria-hidden />
          Export
        </button>
      </div>
      {lineups && shown.length === 0 && (
        <p className="muted small">No lineups{map === ALL ? '' : ` on ${map}`} yet.</p>
      )}
      <div className="lineup-list">
        {shown.map((l) => (
          <LineupRow
            key={key(l)}
            lineup={l}
            ownerName={owner(l.owner)}
            showMap={map === ALL}
            open={open === key(l)}
            onToggle={() => setOpen(open === key(l) ? null : key(l))}
            onChange={(patch) => act(() => window.api.lineups.update(l.owner, l.name, patch))}
            onDelete={() => act(() => window.api.lineups.remove(l.owner, l.name))}
          />
        ))}
      </div>
      {note && <p className="muted small">{note}</p>}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

function LineupRow(props: {
  lineup: Lineup
  ownerName: string
  showMap: boolean
  open: boolean
  onToggle: () => void
  onChange: (patch: Partial<Pick<Lineup, 'name' | 'desc' | 'type'>>) => void
  onDelete: () => void
}) {
  const { lineup: l } = props
  const [name, setName] = useState(l.name)
  const [desc, setDesc] = useState(l.desc)
  const [confirm, setConfirm] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => setName(l.name), [l.name])
  useEffect(() => setDesc(l.desc), [l.desc])

  const commitName = () => {
    if (name.trim() && name !== l.name) props.onChange({ name })
    else setName(l.name)
  }
  const changeDesc = (v: string) => {
    setDesc(v)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => props.onChange({ desc: v }), 600)
  }

  return (
    <div className={`lineup-row${props.open ? ' open' : ''}`}>
      <div className="lineup-head">
        <span className={`lineup-type t-${(l.type || 'any').toLowerCase()}`}>{TYPE_LABEL[l.type]}</span>
        <input
          className="lineup-name"
          value={name}
          title="Rename (no spaces: .loadnade takes one word)"
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        {props.showMap && <span className="muted small">{l.map}</span>}
        <span className="muted small" title={l.owner}>
          {props.ownerName}
        </span>
        <button className="small-btn" onClick={props.onToggle}>
          {props.open ? 'Less' : 'More'}
        </button>
        {confirm ? (
          <>
            <button className="danger small-btn" onClick={props.onDelete}>
              Delete
            </button>
            <button className="small-btn" onClick={() => setConfirm(false)}>
              Keep
            </button>
          </>
        ) : (
          <button className="icon-btn" title="Delete this lineup" onClick={() => setConfirm(true)}>
            <Trash2 size={15} aria-hidden />
          </button>
        )}
      </div>
      {props.open && (
        <div className="lineup-body">
          <input placeholder="Description (shown in game when you load it)" value={desc} onChange={(e) => changeDesc(e.target.value)} />
          <div className="lineup-types">
            {NADE_TYPES.map((t) => (
              <button key={t} className={`chip${l.type === t ? ' picked' : ''}`} onClick={() => props.onChange({ type: t })}>
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
          <span className="muted small">
            Position {l.pos.map((n) => Math.round(n)).join(' ')} · angles {l.ang.map((n) => Math.round(n * 10) / 10).join(' ')}
          </span>
          <span className="muted small">MatchZy code (paste in game chat to share it with a friend):</span>
          <CopyLine text={importCode(l)} />
        </div>
      )}
    </div>
  )
}
