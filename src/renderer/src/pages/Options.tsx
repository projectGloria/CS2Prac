import { useEffect, useState } from 'react'
import { FolderOpen, Keyboard, SlidersHorizontal } from 'lucide-react'
import type { Settings } from '@shared/ipc'
import CopyLine from '../components/CopyLine'

/** App options: in-game skin menu bind, server name, cfg folder, Steam Web API key. */
export default function Options() {
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    window.api.settings.get().then(setSettings)
  }, [])

  const updateSettings = async (patch: Partial<Settings>) => setSettings(await window.api.settings.update(patch))

  return (
    <div className="options">
      <section className="card">
        <h2 className="title-icon">
          <Keyboard size={18} aria-hidden />
          In-game skin menu
        </h2>
        <p className="muted small">Paste once in the CS2 console (it is saved with your binds), then press K in game:</p>
        <CopyLine text="bind k css_menu" />
        <p className="muted small">
          W/S move · A/D page · E select · R back. Chat search: <code>!skin</code>, <code>!knife</code>, <code>!gloves</code>,{' '}
          <code>!agent</code>, <code>!sticker</code>, <code>!charm</code> followed by a name, e.g. <code>!knife karambit fade</code>.
          Picks are applied immediately and saved to your active profile.
        </p>
      </section>

      {settings && (
        <section className="card">
          <h2 className="title-icon">
            <SlidersHorizontal size={18} aria-hidden />
            Options
          </h2>
          <label className="field">
            Server name (chat prefix)
            <input
              key={settings.serverName}
              defaultValue={settings.serverName}
              maxLength={32}
              onBlur={(e) => e.target.value !== settings.serverName && updateSettings({ serverName: e.target.value })}
            />
            <span className="muted small">Chat messages show as [{settings.serverName}]. Applies at the next server start.</span>
          </label>
          <div className="field">
            Your cfg files
            <span className="muted small">
              Everything in the server cfg folder is copied to the server before each start. <code>cs2prac_server.cfg</code> runs
              after every map load.
            </span>
            <button className="fit" onClick={() => window.api.server.openCfgFolder()}>
              <FolderOpen size={15} aria-hidden />
              Open server cfg folder
            </button>
          </div>
          <label className="field">
            Steam Web API key (optional, for workshop maps)
            <input
              type="password"
              defaultValue={settings.authKey ?? ''}
              onBlur={(e) => updateSettings({ authKey: e.target.value.trim() || undefined })}
            />
          </label>
        </section>
      )}
    </div>
  )
}
