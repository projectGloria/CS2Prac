import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import Modal from './Modal'
import Dropdown from './Dropdown'
import {
  SETTINGS,
  SETTING_TABS,
  clearMap,
  optionLabel,
  setGlobal,
  type ServerPrefs,
  type SettingOption
} from '@shared/serverSettings'

const DEFAULT = '__default'
const prettyMap = (name: string) => name.replace(/^(de|cs|ar)_/, '').replace(/_/g, ' ')

/**
 * Sky choice as picture tiles. The pictures are rendered from the user's own CS2 files on first open (~30 s, then
 * cached per CS2 build); until then, or without Setup, the tiles show names only.
 */
function SkyPicker({
  value,
  options,
  onChange
}: {
  value: string
  options: SettingOption[]
  onChange: (v: string) => void
}) {
  const [thumbs, setThumbs] = useState<Record<string, string> | null>(null)
  const [note, setNote] = useState<string | null>('Rendering sky pictures from your CS2 files…')

  useEffect(() => {
    let live = true
    window.api.models
      .skies()
      .then((t) => {
        if (!live) return
        setThumbs(t)
        setNote(null)
      })
      .catch((e: Error) => live && setNote(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
    return () => {
      live = false
    }
  }, [])

  const tiles = [{ value: DEFAULT, label: 'Default' }, ...options.map((o) => ({ value: o.value, label: o.label || 'Map default' }))]
  return (
    <div className="sky-picker">
      {note && <p className="muted small">{note}</p>}
      <div className="sky-grid">
        {tiles.map((o) => {
          const img = thumbs?.[o.value]
          return (
            <button
              key={o.value}
              className={`sky-tile${o.value === value ? ' picked' : ''}`}
              title={o.value && o.value !== DEFAULT ? o.value : undefined}
              onClick={() => onChange(o.value)}
            >
              {img ? (
                <img src={img} alt="" draggable={false} />
              ) : (
                <span className="sky-none">{o.value === DEFAULT || o.value === '' ? 'Map sky' : ''}</span>
              )}
              <span className="sky-label">{o.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The settings of the in-game L window, saved for every map (server_prefs.json "global"). Values saved in game for
 * one map only are listed below and can be cleared here.
 */
export default function ServerSettings({ onClose }: { onClose: () => void }) {
  const [prefs, setPrefs] = useState<ServerPrefs | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api.server.getPrefs().then(setPrefs)
    return window.api.server.onPrefsChanged(setPrefs)
  }, [])

  async function save(next: ServerPrefs) {
    setPrefs(next)
    setError(null)
    try {
      setPrefs(await window.api.server.savePrefs(next))
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  const mapEntries = prefs ? Object.entries(prefs.maps).sort(([a], [b]) => a.localeCompare(b)) : []
  return (
    <Modal title="Server settings" onClose={onClose}>
      <p className="muted small">
        Applied on every map and kept across restarts. In game, press <code>L</code> (<code>bind l css_pracmenu</code>) to change
        them live; there you can also save a value for one map only. “Default” leaves the setting to the server and MatchZy.
      </p>
      {!prefs && <p className="muted">Loading…</p>}
      {prefs &&
        SETTING_TABS.map((tab) => (
          <div key={tab.id} className="srv-group">
            <h4>{tab.label}</h4>
            {SETTINGS.filter((s) => s.tab === tab.id).map((s) =>
              s.id === 'sky' ? (
                <SkyPicker
                  key={s.id}
                  value={prefs.global[s.id] ?? DEFAULT}
                  options={s.options}
                  onChange={(v) => save(setGlobal(prefs, s.id, v === DEFAULT ? null : v))}
                />
              ) : (
              <div key={s.id} className="srv-row">
                <span className="srv-name">
                  {s.name}
                  <span className="muted small">{s.sub}</span>
                </span>
                <Dropdown
                  value={prefs.global[s.id] ?? DEFAULT}
                  align="right"
                  onChange={(v) => save(setGlobal(prefs, s.id, v === DEFAULT ? null : v))}
                  options={[
                    { value: DEFAULT, label: 'Default' },
                    ...s.options.map((o) => ({ value: o.value, label: o.label || 'Map default' }))
                  ]}
                />
              </div>
              )
            )}
          </div>
        ))}
      {mapEntries.length > 0 && prefs && (
        <div className="srv-group">
          <h4>Saved for one map</h4>
          {mapEntries.map(([map, values]) => (
            <div key={map} className="srv-row">
              <span className="srv-name">
                {prettyMap(map)}
                <span className="muted small">
                  {Object.entries(values)
                    .map(([id, v]) => `${SETTINGS.find((s) => s.id === id)?.name ?? id}: ${optionLabel(id, v) || 'Map default'}`)
                    .join(', ')}
                </span>
              </span>
              <button className="icon-btn" title={`Clear ${map}`} onClick={() => save(clearMap(prefs, map))}>
                <Trash2 size={15} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}
