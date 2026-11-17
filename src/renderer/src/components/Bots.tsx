import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Plus, Trash2, X } from 'lucide-react'
import Modal from './Modal'
import {
  BOT_AVATAR_SIZE,
  MAX_BOTS_PER_TEAM,
  MAX_BOT_CLAN,
  MAX_BOT_NAME,
  type BotEntry,
  type BotsConfig
} from '@shared/bots'

type Team = 't' | 'ct'
const TEAMS: { id: Team; label: string }[] = [
  { id: 't', label: 'Terrorists' },
  { id: 'ct', label: 'Counter-Terrorists' }
]

/** the file as a data: URL (the renderer's CSP allows data: images but not blob: URLs) */
function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

/** reads an image file and scales it (centre crop) to a BOT_AVATAR_SIZE square PNG data URL */
async function toAvatar(file: File): Promise<string> {
  const img = new Image()
  img.src = await readDataUrl(file)
  await img.decode()
  const side = Math.min(img.naturalWidth, img.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = BOT_AVATAR_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No canvas')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(
    img,
    (img.naturalWidth - side) / 2,
    (img.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    BOT_AVATAR_SIZE,
    BOT_AVATAR_SIZE
  )
  return canvas.toDataURL('image/png')
}

/**
 * Custom bot names, clan tags and pictures, per team in slot order (the first bot of a team gets the first entry).
 * Saved in userData/bots.json; the running server picks names up at once, pictures need a restart the first time.
 */
export default function Bots({ onClose }: { onClose: () => void }) {
  const [bots, setBots] = useState<BotsConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restartHint, setRestartHint] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<BotsConfig | null>(null)

  useEffect(() => {
    window.api.bots.get().then(setBots)
    return () => {
      // flush a pending text edit when the window closes
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (pending.current) window.api.bots.save(pending.current).catch(() => undefined)
    }
  }, [])

  async function persist(next: BotsConfig) {
    pending.current = null
    setError(null)
    try {
      const r = await window.api.bots.save(next)
      setRestartHint(r.restartForPictures)
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  /** updates at once; text edits are saved after a short pause, everything else right away */
  function change(next: BotsConfig, debounce = false) {
    setBots(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (debounce) {
      pending.current = next
      saveTimer.current = setTimeout(() => persist(next), 500)
    } else persist(next)
  }

  const edit = (team: Team, i: number, patch: Partial<BotEntry>, debounce = false) => {
    if (!bots) return
    change({ ...bots, [team]: bots[team].map((e, j) => (j === i ? { ...e, ...patch } : e)) }, debounce)
  }

  async function pickPicture(team: Team, i: number, file: File | undefined) {
    if (!file) return
    try {
      edit(team, i, { avatar: await toAvatar(file) })
    } catch {
      setError('Could not read that image')
    }
  }

  return (
    <Modal title="Bots" onClose={onClose}>
      <p className="muted small">
        Names, clan tags and pictures for bots, in the order they join a team. Bots beyond the list keep the game's
        names. Names change at once on a running server; pictures need a server restart the first time one is added.
      </p>
      <p className="muted small">
        No pictures in game? CS2 hides the avatars of players who aren't your Steam friends when{' '}
        <code>cl_hide_avatar_images</code> is 2 (also the scoreboard's "hide avatars" toggle). Set it to 0 in the
        client console or your cfg.
      </p>
      {bots &&
        TEAMS.map(({ id, label }) => (
          <div key={id} className="srv-group">
            <h4>{label}</h4>
            {bots[id].map((e, i) => (
              <div key={i} className="srv-row bot-row">
                <label className="bot-avatar" title="Pick a picture">
                  {e.avatar ? <img src={e.avatar} alt="" /> : <ImagePlus size={18} aria-hidden />}
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(ev) => {
                      pickPicture(id, i, ev.target.files?.[0])
                      ev.target.value = ''
                    }}
                  />
                </label>
                <input
                  className="bot-name"
                  placeholder={`Bot ${i + 1}`}
                  value={e.name}
                  maxLength={MAX_BOT_NAME}
                  onChange={(ev) => edit(id, i, { name: ev.target.value }, true)}
                />
                <input
                  className="bot-clan"
                  placeholder="Clan"
                  value={e.clan}
                  maxLength={MAX_BOT_CLAN}
                  onChange={(ev) => edit(id, i, { clan: ev.target.value }, true)}
                />
                {e.avatar && (
                  <button className="icon-btn" title="Remove the picture" onClick={() => edit(id, i, { avatar: '' })}>
                    <X size={15} aria-hidden />
                  </button>
                )}
                <button
                  className="icon-btn"
                  title="Remove this bot"
                  onClick={() => change({ ...bots, [id]: bots[id].filter((_, j) => j !== i) })}
                >
                  <Trash2 size={15} aria-hidden />
                </button>
              </div>
            ))}
            {bots[id].length < MAX_BOTS_PER_TEAM && (
              <button
                className="bot-add"
                onClick={() => change({ ...bots, [id]: [...bots[id], { name: '', clan: '', avatar: '' }] })}
              >
                <Plus size={15} aria-hidden />
                Add bot
              </button>
            )}
          </div>
        ))}
      {restartHint && <p className="muted small">Restart the server to show the pictures.</p>}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}
