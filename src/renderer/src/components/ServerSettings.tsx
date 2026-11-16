import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import Modal from './Modal'
import Dropdown from './Dropdown'
import { SETTINGS, SETTING_TABS, clearMap, optionLabel, setGlobal, type ServerPrefs } from '@shared/serverSettings'

const DEFAULT = '__default'
const prettyMap = (name: string) => name.replace(/^(de|cs|ar)_/, '').replace(/_/g, ' ')

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
        Applied on every map and kept across restarts. In game, press <code>L</code> (<code>bind l css_settings</code>) to change
        them live; there you can also save a value for one map only. “Default” leaves the setting to the server and MatchZy.
      </p>
      {!prefs && <p className="muted">Loading…</p>}
      {prefs &&
        SETTING_TABS.map((tab) => (
          <div key={tab.id} className="srv-group">
            <h4>{tab.label}</h4>
            {SETTINGS.filter((s) => s.tab === tab.id).map((s) => (
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
            ))}
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
