import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import Modal from './Modal'
import { KEY_ACTIONS, KEYS_CFG, cs2KeyFromCode, cs2KeyFromMouse, type KeyBinds as Binds } from '@shared/keyBinds'

/** Play page > Keys: a CS2 key per CS2Prac action, written to the client's cfg/cs2prac_keys.cfg. */
export default function KeyBinds({ onClose }: { onClose: () => void }) {
  const [binds, setBinds] = useState<Binds | null>(null)
  const [listening, setListening] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.keys.get().then(setBinds)
  }, [])

  const save = async (next: Binds) => {
    setBinds(next)
    setError(null)
    try {
      const r = await window.api.keys.save(next)
      setBinds(r.binds)
      setNote(`Saved to ${r.file}. In game: exec NihilPrac (or exec cs2prac_keys).`)
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  // capture the next key / side mouse button for the action being picked
  useEffect(() => {
    if (!listening || !binds) return
    const take = (key: string | null) => {
      setListening(null)
      if (key) void save({ ...binds, [listening]: key })
    }
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape') return setListening(null)
      take(cs2KeyFromCode(e.code))
    }
    const onMouse = (e: MouseEvent) => {
      const k = cs2KeyFromMouse(e.button)
      if (k) {
        e.preventDefault()
        take(k)
      }
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onMouse, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onMouse, true)
    }
  }, [listening, binds])

  const clear = (id: string) => {
    if (!binds) return
    const next = { ...binds }
    delete next[id]
    void save(next)
  }

  return (
    <Modal title="Keys" onClose={() => !listening && onClose()}>
      <p className="muted small">
        A key for each CS2Prac action. The app writes them to <code>{KEYS_CFG}</code> in CS2&apos;s cfg folder; NihilPrac.cfg runs it
        (<code>exec cs2prac_keys</code>). The chat commands work without a key too. In the L window, “E = back to spawn” makes E do
        it when there is nothing to use in front of you.
      </p>
      {!binds && <p className="muted">Loading…</p>}
      {binds && (
        <div className="srv-group">
          {KEY_ACTIONS.map((a) => (
            <div key={a.id} className="srv-row">
              <span className="srv-name">
                {a.name}
                <span className="muted small">{a.sub}</span>
              </span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button
                  className={listening === a.id ? 'primary' : undefined}
                  title="Click, then press a key (Esc cancels)"
                  onClick={() => setListening(listening === a.id ? null : a.id)}
                >
                  {listening === a.id ? 'Press a key…' : binds[a.id] ? binds[a.id].toUpperCase() : 'Not set'}
                </button>
                {binds[a.id] && (
                  <button className="icon-btn" title="Remove the key" onClick={() => clear(a.id)}>
                    <Trash2 size={15} aria-hidden />
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {note && <p className="muted small">{note}</p>}
      {error && <p className="error small">{error}</p>}
    </Modal>
  )
}
