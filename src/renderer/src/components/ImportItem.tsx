import { useMemo, useState } from 'react'
import Modal from './Modal'
import CopyLine from './CopyLine'
import { applyImported, parseItemCode, toGenCode, type ImportedItem, type ImportTarget } from '@shared/itemCode'
import { wearName, type Catalog, type Profile, type Team } from '@shared/skins'

const TEAM_NAME: Record<Team, string> = { t: 'T', ct: 'CT' }

/**
 * Paste a !gen code or an inspect link (decoded locally), preview it and put it into the profile for T, CT or both.
 * Also shows the !gen code of the item in the selected slot, to share or use in chat.
 */
export default function ImportItem(props: {
  catalog: Catalog
  profile: Profile
  team: Team
  /** what the selected slot holds, if it's a weapon/knife/glove with a finish */
  current: { label: string; item: ImportedItem } | null
  onApply: (fn: (p: Profile) => Profile, def: number, kind: ImportTarget['kind']) => void
  onClose: () => void
}) {
  const { catalog } = props
  const [text, setText] = useState('')
  const parsed = useMemo(() => (text.trim() ? parseItemCode(text) : null), [text])

  const weapon = (def: number): ImportTarget | null => {
    const w = catalog.weapons.find((x) => x.defIndex === def)
    return w ? { kind: w.kind, name: w.name, className: w.className } : null
  }
  const skin = (def: number, paint: number) => catalog.skins.find((s) => s.defIndex === def && s.paintKit === paint)
  const legacy = (def: number, paint: number) => skin(def, paint)?.legacyModel ?? false

  const item = parsed?.ok ? parsed.item : null
  const target = item ? weapon(item.defIndex) : null
  const finish = item && item.paintKit ? (skin(item.defIndex, item.paintKit)?.name ?? `Paint ${item.paintKit}`) : 'Vanilla'
  const stickerName = (def: number) => catalog.stickers.find((s) => s.defIndex === def)?.name ?? `Sticker ${def}`
  const charmName = (def: number) => catalog.keychains.find((k) => k.defIndex === def)?.name ?? `Charm ${def}`

  function apply(teams: Team[]) {
    if (!item || !target) return
    props.onApply((p) => teams.reduce((acc, t) => applyImported(acc, t, item, weapon, legacy), p), item.defIndex, target.kind)
    props.onClose()
  }

  const other: Team = props.team === 't' ? 'ct' : 't'
  return (
    <Modal title="Import a skin" onClose={props.onClose}>
      <p className="muted small">
        Paste a <code>!gen</code> code or an inspect link that carries the item (the long hex kind). It is read here, on
        this PC; nothing is looked up online.
      </p>
      <textarea
        className="import-text"
        rows={3}
        autoFocus
        placeholder="!gen 7 801 661 0.07 …   or   steam://rungame/730/…/+csgo_econ_action_preview%20…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {parsed && !parsed.ok && <p className="error-text">{parsed.error}</p>}
      {item && !target && <p className="error-text">Unknown item (def index {item.defIndex}).</p>}
      {item && target && (
        <div className="import-preview">
          <strong>
            {item.statTrak !== null && target.kind !== 'glove' ? 'StatTrak™ ' : ''}
            {target.name} | {finish}
          </strong>
          <span className="muted small">
            {wearName(item.wear)} · wear {item.wear} · seed {item.seed}
            {item.statTrak !== null && target.kind !== 'glove' ? ` · ${item.statTrak} kills` : ''}
            {item.nameTag && target.kind !== 'glove' ? ` · “${item.nameTag}”` : ''}
          </span>
          {target.kind === 'weapon' && item.stickers.some(Boolean) && (
            <span className="small">
              Stickers:{' '}
              {item.stickers
                .map((s, i) => (s ? `${i + 1}: ${stickerName(s.defIndex)}${s.wear ? ` (${Math.round(s.wear * 100)}% scraped)` : ''}` : null))
                .filter(Boolean)
                .join(', ')}
            </span>
          )}
          {target.kind === 'weapon' && item.keychain && (
            <span className="small">
              Charm: {charmName(item.keychain.defIndex)} (seed {item.keychain.seed})
            </span>
          )}
          {target.kind !== 'weapon' && (item.stickers.some(Boolean) || item.keychain) && (
            <span className="muted small">Stickers and charms only go on guns; they are left out.</span>
          )}
          <div className="import-actions">
            <button className="primary" onClick={() => apply([props.team])}>
              Apply to {TEAM_NAME[props.team]}
            </button>
            <button onClick={() => apply([other])}>Apply to {TEAM_NAME[other]}</button>
            <button onClick={() => apply(['t', 'ct'])}>Both teams</button>
          </div>
        </div>
      )}
      {props.current && (
        <div className="srv-group">
          <h4>!gen code of {props.current.label}</h4>
          <CopyLine text={toGenCode(props.current.item)} />
        </div>
      )}
    </Modal>
  )
}
