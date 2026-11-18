import { useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardPaste, Copy, Dices, Layers, Music, Pin, Plus, SprayCan, Trash2, User, Users } from 'lucide-react'
import type { LoadoutSaveResult } from '@shared/ipc'
import Dropdown, { type DropdownOption } from '../components/Dropdown'
import Modal from '../components/Modal'
import SkinViewer3D from '../components/SkinViewer3D'
import ImportItem from '../components/ImportItem'
import { itemOf } from '@shared/itemCode'
import { rollCraft } from '@shared/craft'
import {
  emptyKeychain,
  emptyProfile,
  emptySticker,
  GRAFFITI_TINTS,
  isEmptySel,
  MAX_NAMETAG,
  MAX_SEED,
  STICKER_SLOTS,
  wearName,
  type AgentSel,
  type Catalog,
  type CatalogAgent,
  type CatalogGraffiti,
  type CatalogKeychain,
  type CatalogSkin,
  type CatalogSticker,
  type CatalogWeapon,
  type GloveSel,
  type KeychainSel,
  type StickerSel,
  type KnifeSel,
  type LoadoutStore,
  type Profile,
  type SkinSel,
  type SteamAccount,
  type Team
} from '@shared/skins'

type Slot = { kind: 'weapon'; defIndex: number } | { kind: 'knife' | 'gloves' | 'agent' | 'pin' | 'music' | 'graffiti' }
type SaveState = { state: 'idle' | 'saving' | 'error'; result?: LoadoutSaveResult; error?: string }

const TEAM_LABEL: Record<Team, string> = { t: 'T', ct: 'CT' }
const WEAPON_CATEGORIES = ['Pistols', 'SMGs', 'Rifles', 'Heavy', 'Equipment']
const SAVE_DEBOUNCE_MS = 400
/** shown with agent, knife and gloves instead of under Equipment */
const ZEUS = 'weapon_taser'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const defaultWear = (s?: CatalogSkin) => clamp(0.01, s?.minFloat ?? 0, s?.maxFloat ?? 1)
const randomSeed = () => Math.floor(Math.random() * (MAX_SEED + 1))
const sameSlot = (a: Slot, b: Slot) => JSON.stringify(a) === JSON.stringify(b)

export default function Loadout() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [store, setStore] = useState<LoadoutStore | null>(null)
  const [accounts, setAccounts] = useState<SteamAccount[]>([])
  const [slot, setSlot] = useState<Slot>({ kind: 'knife' })
  const [team, setTeam] = useState<Team>('ct')
  const [save, setSave] = useState<SaveState>({ state: 'idle' })
  const [showImport, setShowImport] = useState(false)
  /** what the gun had before the last random craft(s), for Undo */
  const [craftUndo, setCraftUndo] = useState<{ team: Team; def: number; sel: SkinSel | null } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const latest = useRef<LoadoutStore | null>(null)
  const dirty = useRef(false)

  const loadCatalog = (refresh = false) => {
    setCatalogError(null)
    window.api.skins.getCatalog(refresh).then(setCatalog, (e) => setCatalogError((e as Error).message))
  }

  const flush = () => {
    clearTimeout(timer.current)
    if (!dirty.current || !latest.current) return
    dirty.current = false
    window.api.loadout.save(latest.current).then(
      (result) => setSave({ state: 'idle', result }),
      (e) => setSave({ state: 'error', error: (e as Error).message })
    )
  }

  useEffect(() => {
    loadCatalog()
    window.api.loadout.get().then((s) => {
      latest.current = s
      setStore(s)
    })
    window.api.skins.listSteamAccounts().then(setAccounts)
    // picks made with the in-game menu
    const off = window.api.loadout.onChanged((s) => {
      if (dirty.current) return // a local edit is about to be saved; it wins
      latest.current = s
      setStore(s)
    })
    return () => {
      off()
      flush() // save immediately if the user leaves the tab mid-debounce
    }
  }, [])

  const index = useMemo(() => {
    const byDef = new Map<number, CatalogSkin[]>()
    const weaponByDef = new Map<number, CatalogWeapon>()
    for (const s of catalog?.skins ?? []) byDef.set(s.defIndex, [...(byDef.get(s.defIndex) ?? []), s])
    for (const w of catalog?.weapons ?? []) weaponByDef.set(w.defIndex, w)
    const skin = (def: number, paint: number) => byDef.get(def)?.find((s) => s.paintKit === paint)
    const stickerByDef = new Map((catalog?.stickers ?? []).map((s) => [s.defIndex, s]))
    const keychainByDef = new Map((catalog?.keychains ?? []).map((k) => [k.defIndex, k]))
    return { byDef, weaponByDef, skin, stickerByDef, keychainByDef }
  }, [catalog])

  function update(fn: (s: LoadoutStore) => LoadoutStore) {
    if (!latest.current) return
    const next = fn(latest.current)
    latest.current = next
    dirty.current = true
    setStore(next)
    setSave({ state: 'saving' })
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS)
  }

  const updateProfile = (fn: (p: Profile) => Profile) =>
    update((s) => ({ ...s, profiles: s.profiles.map((p) => (p.id === s.activeId ? fn(p) : p)) }))

  if (catalogError && !catalog)
    return (
      <section className="card">
        <h2>Couldn’t load skin data</h2>
        <p className="error-text">{catalogError}</p>
        <button onClick={() => loadCatalog(true)}>Retry</button>
      </section>
    )
  if (!catalog || !store) return <p className="muted">Loading skins…</p>

  const profile = store.profiles.find((p) => p.id === store.activeId) ?? store.profiles[0]
  const weapons = catalog.weapons.filter((w) => w.kind === 'weapon')
  const knives = catalog.weapons.filter((w) => w.kind === 'knife')
  const gloveTypes = catalog.weapons.filter((w) => w.kind === 'glove')

  // ---- labels for the slot list ----
  const knifeLabel = (k: KnifeSel | null) => {
    if (!k) return 'Default'
    const model = index.weaponByDef.get(k.defIndex)?.name ?? k.className
    return k.paintKit ? `${model} | ${index.skin(k.defIndex, k.paintKit)?.name ?? k.paintKit}` : `${model} (vanilla)`
  }
  const gloveLabel = (g: GloveSel | null) =>
    g ? `${index.weaponByDef.get(g.defIndex)?.name ?? 'Gloves'} | ${index.skin(g.defIndex, g.paintKit)?.name ?? g.paintKit}` : 'Default'
  const pinItem = profile.pin ? catalog.pins?.find((x) => x.defIndex === profile.pin) : undefined
  const musicItem = profile.musicKit ? catalog.musicKits?.find((x) => x.defIndex === profile.musicKit) : undefined
  const graffitiItem = profile.graffiti ? catalog.graffiti?.find((x) => x.defIndex === profile.graffiti) : undefined
  const graffitiTintName = profile.graffitiTint ? GRAFFITI_TINTS.find((t) => t.id === profile.graffitiTint)?.name : undefined
  const agentLabel = (a: AgentSel | null) =>
    a ? (catalog.agents.find((x) => x.defIndex === a.defIndex)?.name.split(' | ')[0] ?? `Agent ${a.defIndex}`) : 'Default'
  const weaponLabel = (defIndex: number, sel: SkinSel | undefined) => {
    if (!sel) return 'Default'
    const finish = sel.paintKit > 0 ? (index.skin(defIndex, sel.paintKit)?.name ?? `Paint ${sel.paintKit}`) : 'Default'
    const n = sel.stickers?.filter(Boolean).length ?? 0
    return finish + (n ? ` · ${n} sticker${n > 1 ? 's' : ''}` : '') + (sel.keychain ? ' · charm' : '')
  }

  const weaponSlot = (w: CatalogWeapon) => {
    const sel = profile.weapons[team][w.defIndex]
    return (
      <SlotButton
        key={w.defIndex}
        active={sameSlot(slot, { kind: 'weapon', defIndex: w.defIndex })}
        icon={<EquipIcon name={w.className.replace(/^weapon_/, '')} />}
        title={w.name}
        sub={weaponLabel(w.defIndex, sel)}
        color={sel ? index.skin(w.defIndex, sel.paintKit)?.rarityColor : undefined}
        set={!!sel}
        onClick={() => setSlot({ kind: 'weapon', defIndex: w.defIndex })}
      />
    )
  }

  const currentItem = (() => {
    if (slot.kind === 'weapon') {
      const it = itemOf(profile, team, 'weapon', slot.defIndex)
      return it ? { label: index.weaponByDef.get(slot.defIndex)?.name ?? 'this weapon', item: it } : null
    }
    if (slot.kind === 'knife') {
      const it = itemOf(profile, team, 'knife', 0)
      return it ? { label: knifeLabel(profile.knife[team]), item: it } : null
    }
    if (slot.kind === 'gloves') {
      const it = itemOf(profile, team, 'glove', 0)
      return it ? { label: gloveLabel(profile.gloves[team]), item: it } : null
    }
    return null
  })()

  const ownerOptions: DropdownOption<string>[] = [
    ...accounts.map((a) => ({ value: a.steamId, label: a.personaName, icon: User })),
    ...(store.owner && !accounts.some((a) => a.steamId === store.owner) ? [{ value: store.owner, label: store.owner, icon: User }] : []),
    { value: '', label: 'Everyone (bots too)', icon: Users }
  ]

  return (
    <div className="loadout">
      {showImport && (
        <ImportItem
          catalog={catalog}
          profile={profile}
          team={team}
          current={currentItem}
          onApply={(fn, def, kind) => {
            updateProfile(fn)
            setSlot(kind === 'weapon' ? { kind: 'weapon', defIndex: def } : { kind: kind === 'knife' ? 'knife' : 'gloves' })
          }}
          onClose={() => setShowImport(false)}
        />
      )}
      <div className="card loadout-bar">
        <div title="Active profile: this one is sent to the server">
          <Dropdown
            value={profile.id}
            onChange={(id) => update((s) => ({ ...s, activeId: id }))}
            options={store.profiles.map((p) => ({ value: p.id, label: p.name || 'Untitled', icon: Layers }))}
          />
        </div>
        <input
          className="profile-name"
          value={profile.name}
          maxLength={40}
          onChange={(e) => updateProfile((p) => ({ ...p, name: e.target.value }))}
          aria-label="Profile name"
        />
        <button
          className="icon-text"
          title="Duplicate this profile"
          onClick={() =>
            update((s) => {
              const p = { ...structuredClone(profile), id: crypto.randomUUID(), name: `${profile.name} copy` }
              return { ...s, activeId: p.id, profiles: [...s.profiles, p] }
            })
          }
        >
          <Copy size={14} aria-hidden />
          Duplicate
        </button>
        <button
          className="icon-text"
          title="New empty profile"
          onClick={() =>
            update((s) => {
              const p = emptyProfile(crypto.randomUUID(), `Profile ${s.profiles.length + 1}`)
              return { ...s, activeId: p.id, profiles: [...s.profiles, p] }
            })
          }
        >
          <Plus size={14} aria-hidden />
          New
        </button>
        <button
          className="icon-text danger"
          title="Delete this profile"
          disabled={store.profiles.length < 2}
          onClick={() =>
            update((s) => {
              const profiles = s.profiles.filter((p) => p.id !== profile.id)
              return { ...s, profiles, activeId: profiles[0].id }
            })
          }
        >
          <Trash2 size={14} aria-hidden />
          Delete
        </button>
        <button className="icon-text" title="Import a !gen code or an inspect link" onClick={() => setShowImport(true)}>
          <ClipboardPaste size={14} aria-hidden />
          Import
        </button>
        <button
          className="icon-text"
          title={slot.kind === 'weapon' ? 'Random craft for this gun: finish, wear, seed, stickers, charm' : 'Pick a gun first'}
          disabled={slot.kind !== 'weapon'}
          onClick={() => {
            if (slot.kind !== 'weapon') return
            const def = slot.defIndex
            const roll = rollCraft(index.byDef.get(def) ?? [], catalog.stickers, catalog.keychains)
            if (!roll) return
            if (!(craftUndo && craftUndo.team === team && craftUndo.def === def))
              setCraftUndo({ team, def, sel: profile.weapons[team][def] ?? null })
            updateProfile((p) => ({ ...p, weapons: { ...p.weapons, [team]: { ...p.weapons[team], [def]: roll.sel } } }))
          }}
        >
          <Dices size={14} aria-hidden />
          Random craft
        </button>
        {craftUndo && slot.kind === 'weapon' && craftUndo.team === team && craftUndo.def === slot.defIndex && (
          <button
            className="icon-text"
            title="Put back what this gun had before the random craft"
            onClick={() => {
              const { def, sel } = craftUndo
              updateProfile((p) => {
                const map = { ...p.weapons[team] }
                if (sel) map[def] = sel
                else delete map[def]
                return { ...p, weapons: { ...p.weapons, [team]: map } }
              })
              setCraftUndo(null)
            }}
          >
            Undo craft
          </button>
        )}

        <span className="spacer" />
        <SaveIndicator save={save} />
        <div className="inline-field">
          Skins for
          <Dropdown value={store.owner ?? ''} onChange={(v) => update((s) => ({ ...s, owner: v || null }))} align="right" options={ownerOptions} />
        </div>
      </div>

      <div className="loadout-cols">
        <nav className="card slot-list">
          <div className="slot-list-head">
            <h2>Loadout</h2>
            <Dropdown
              value={team}
              onChange={setTeam}
              align="right"
              options={[
                { value: 'ct', label: 'Counter-Terrorist', image: CS_ICONS.ct_logo },
                { value: 't', label: 'Terrorist', image: CS_ICONS.t_logo }
              ]}
            />
          </div>
          <h4>Agent, knife, gloves & Zeus</h4>
          <div className="slot-grid">
            <SlotButton
              active={slot.kind === 'agent'}
              icon={<img className="team-logo" src={CS_ICONS[`${team}_logo`]} alt="" draggable={false} />}
              title="Agent"
              sub={agentLabel(profile.agents[team])}
              set={!!profile.agents[team]}
              onClick={() => setSlot({ kind: 'agent' })}
            />
            <SlotButton
              active={slot.kind === 'knife'}
              icon={<EquipIcon name={knifeIcon(team, profile.knife[team])} />}
              title="Knife"
              sub={knifeLabel(profile.knife[team])}
              set={!!profile.knife[team]}
              color={profile.knife[team]?.paintKit ? index.skin(profile.knife[team]!.defIndex, profile.knife[team]!.paintKit)?.rarityColor : undefined}
              onClick={() => setSlot({ kind: 'knife' })}
            />
            <SlotButton
              active={slot.kind === 'gloves'}
              icon={<EquipIcon name="clothing_hands" />}
              title="Gloves"
              sub={gloveLabel(profile.gloves[team])}
              set={!!profile.gloves[team]}
              color={profile.gloves[team] ? index.skin(profile.gloves[team]!.defIndex, profile.gloves[team]!.paintKit)?.rarityColor : undefined}
              onClick={() => setSlot({ kind: 'gloves' })}
            />
            {weapons.filter((w) => w.className === ZEUS).map(weaponSlot)}
          </div>
          <h4>Pin, music kit & graffiti (both teams)</h4>
          <div className="slot-grid">
            <SlotButton
              active={slot.kind === 'pin'}
              icon={pinItem ? <img className="slot-item-img" src={pinItem.image} alt="" draggable={false} /> : <Pin size={22} aria-hidden />}
              title="Pin"
              sub={pinItem?.name ?? (profile.pin ? `Item ${profile.pin}` : 'None')}
              set={!!profile.pin}
              color={pinItem?.rarityColor}
              onClick={() => setSlot({ kind: 'pin' })}
            />
            <SlotButton
              active={slot.kind === 'music'}
              icon={musicItem ? <img className="slot-item-img" src={musicItem.image} alt="" draggable={false} /> : <Music size={22} aria-hidden />}
              title="Music kit"
              sub={musicItem?.name ?? (profile.musicKit ? `Kit ${profile.musicKit}` : 'Default')}
              set={!!profile.musicKit}
              color={musicItem?.rarityColor}
              onClick={() => setSlot({ kind: 'music' })}
            />
            <SlotButton
              active={slot.kind === 'graffiti'}
              icon={
                graffitiItem ? (
                  <img
                    className="slot-item-img"
                    src={graffitiItem.tints[String(profile.graffitiTint)] ?? graffitiItem.image}
                    alt=""
                    draggable={false}
                  />
                ) : (
                  <SprayCan size={22} aria-hidden />
                )
              }
              title="Graffiti"
              sub={
                graffitiItem
                  ? graffitiItem.name + (graffitiTintName && Object.keys(graffitiItem.tints).length ? ` (${graffitiTintName})` : '')
                  : profile.graffiti
                    ? `Graffiti ${profile.graffiti}`
                    : 'None'
              }
              set={!!profile.graffiti}
              color={graffitiItem?.rarityColor}
              onClick={() => setSlot({ kind: 'graffiti' })}
            />
          </div>
          {WEAPON_CATEGORIES.map((cat) => {
            const list = weapons.filter((w) => w.category === cat && w.className !== ZEUS)
            if (!list.length) return null
            return (
              <div key={cat}>
                <h4>{cat}</h4>
                <div className="slot-grid">{list.map(weaponSlot)}</div>
              </div>
            )
          })}
          <p className="muted small catalog-meta">
            Skin data from {new Date(catalog.fetchedAt).toLocaleDateString()}{' '}
            <button className="link" onClick={() => loadCatalog(true)}>
              refresh
            </button>
          </p>
        </nav>

        <section className="card slot-panel">
          {slot.kind === 'weapon' && index.weaponByDef.get(slot.defIndex) && (
            <WeaponPanel
              key={`${slot.defIndex}-${team}`}
              team={team}
              weapon={index.weaponByDef.get(slot.defIndex)!}
              skins={index.byDef.get(slot.defIndex) ?? []}
              sel={profile.weapons[team][slot.defIndex] ?? null}
              stickers={catalog.stickers}
              keychains={catalog.keychains}
              stickerByDef={index.stickerByDef}
              keychainByDef={index.keychainByDef}
              onChange={(sel) =>
                updateProfile((p) => {
                  const map = { ...p.weapons[team] }
                  if (sel && !isEmptySel(sel)) map[slot.defIndex] = sel
                  else delete map[slot.defIndex]
                  return { ...p, weapons: { ...p.weapons, [team]: map } }
                })
              }
              onCopy={() => {
                const other: Team = team === 't' ? 'ct' : 't'
                updateProfile((p) => {
                  const map = { ...p.weapons[other] }
                  const sel = p.weapons[team][slot.defIndex]
                  if (sel) map[slot.defIndex] = structuredClone(sel)
                  else delete map[slot.defIndex]
                  return { ...p, weapons: { ...p.weapons, [other]: map } }
                })
              }}
            />
          )}
          {slot.kind === 'knife' && (
            <KnifePanel
              key={`knife-${team}`}
              team={team}
              knives={knives}
              byDef={index.byDef}
              sel={profile.knife[team]}
              onChange={(sel) => updateProfile((p) => ({ ...p, knife: { ...p.knife, [team]: sel } }))}
              onCopy={() => {
                const other: Team = team === 't' ? 'ct' : 't'
                updateProfile((p) => ({ ...p, knife: { ...p.knife, [other]: structuredClone(p.knife[team]) } }))
              }}
            />
          )}
          {slot.kind === 'pin' && (
            <ItemPanel
              title="Pin"
              hint="Shown next to your name on the scoreboard, for both teams. Coins, medals and trophies work too."
              none="No pin"
              items={catalog.pins ?? []}
              group
              value={profile.pin}
              onChange={(pin) => updateProfile((p) => ({ ...p, pin }))}
            />
          )}
          {slot.kind === 'music' && (
            <ItemPanel
              title="Music kit"
              hint="Plays at round start, round end and when you are MVP, for both teams."
              none="Default music"
              items={catalog.musicKits ?? []}
              value={profile.musicKit}
              onChange={(musicKit) => updateProfile((p) => ({ ...p, musicKit }))}
            />
          )}
          {slot.kind === 'graffiti' && (
            <GraffitiPanel
              items={catalog.graffiti ?? []}
              value={profile.graffiti}
              tint={profile.graffitiTint}
              onChange={(graffiti, graffitiTint) => updateProfile((p) => ({ ...p, graffiti, graffitiTint }))}
            />
          )}
          {slot.kind === 'agent' && (
            <AgentPanel
              key={`agent-${team}`}
              team={team}
              agents={catalog.agents.filter((a) => a.team === team)}
              sel={profile.agents[team]}
              onChange={(sel) => updateProfile((p) => ({ ...p, agents: { ...p.agents, [team]: sel } }))}
            />
          )}
          {slot.kind === 'gloves' && (
            <GlovePanel
              key={`gloves-${team}`}
              team={team}
              gloveTypes={gloveTypes}
              byDef={index.byDef}
              sel={profile.gloves[team]}
              onChange={(sel) => updateProfile((p) => ({ ...p, gloves: { ...p.gloves, [team]: sel } }))}
              onCopy={() => {
                const other: Team = team === 't' ? 'ct' : 't'
                updateProfile((p) => ({ ...p, gloves: { ...p.gloves, [other]: structuredClone(p.gloves[team]) } }))
              }}
            />
          )}
        </section>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function SaveIndicator({ save }: { save: SaveState }) {
  if (save.state === 'saving') return <span className="muted small">Saving…</span>
  if (save.state === 'error') return <span className="error-text small">Save failed: {save.error}</span>
  if (!save.result) return null
  const { exported, reloaded } = save.result
  return (
    <span className="muted small" title="Skins are applied when you respawn or pick up a weapon">
      Saved
      {exported ? (reloaded ? ' · applied to server' : ' · sent to server') : ' · server not set up yet'}
    </span>
  )
}

/** Official CS2 icons (assets/cs-icons, from the game's panorama images), keyed by file name. */
const CS_ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob('../../../../assets/cs-icons/*.svg', { eager: true, query: '?url', import: 'default' })).map(
    ([path, url]) => [path.slice(path.lastIndexOf('/') + 1, -4), url as string]
  )
)

/** White game silhouette drawn as a mask, so CSS decides its colour. */
function EquipIcon({ name }: { name: string }) {
  const url = CS_ICONS[name]
  if (!url) return <span className="equip-icon" />
  return <span className="equip-icon" style={{ maskImage: `url("${url}")`, WebkitMaskImage: `url("${url}")` }} />
}

const knifeIcon = (team: Team, k: KnifeSel | null) => (k ? k.className.replace(/^weapon_/, '') : team === 't' ? 'knife_t' : 'knife')

function SlotButton(props: {
  title: string
  sub: string
  icon: React.ReactNode
  team?: Team
  active: boolean
  set: boolean
  color?: string
  onClick: () => void
}) {
  return (
    <button
      className={`slot ${props.active ? 'active' : ''} ${props.set ? 'set' : ''}`}
      style={props.color ? ({ '--rarity': props.color } as React.CSSProperties) : undefined}
      onClick={props.onClick}
    >
      {props.team && <img className="slot-team" src={CS_ICONS[`${props.team}_logo`]} alt={TEAM_LABEL[props.team]} draggable={false} />}
      <span className="slot-icon">{props.icon}</span>
      <span className="slot-title">{props.title}</span>
      <span className={`slot-sub ${props.set ? '' : 'muted'}`}>{props.sub}</span>
    </button>
  )
}

interface Tile {
  key: string
  name: string
  image: string | null
  color?: string
  selected: boolean
  onClick: () => void
  /** right-click selects the tile (if needed) and opens the editor pop-up */
  editable?: boolean
}

function SkinGrid({ tiles, search, onEdit }: { tiles: Tile[]; search?: boolean; onEdit?: () => void }) {
  const [q, setQ] = useState('')
  const shown = q ? tiles.filter((t) => t.name.toLowerCase().includes(q.toLowerCase())) : tiles
  return (
    <>
      {search && tiles.length > 12 && (
        <input className="grid-search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
      )}
      <div className="skin-grid">
        {shown.map((t) => (
          <button
            key={t.key}
            className={`skin-tile ${t.selected ? 'selected' : ''}`}
            style={t.color ? { borderBottomColor: t.color } : undefined}
            onClick={t.onClick}
            onContextMenu={(e) => {
              e.preventDefault()
              if (!onEdit || !t.editable) return
              if (!t.selected) t.onClick()
              onEdit()
            }}
            title={onEdit && t.editable ? `${t.name}\nRight-click to edit wear, pattern …` : t.name}
          >
            {t.image ? <img src={t.image} alt="" loading="lazy" draggable={false} /> : <div className="img-placeholder" />}
            <span>{t.name}</span>
          </button>
        ))}
      </div>
    </>
  )
}

function PaintEditor(props: {
  value: { wear: number; seed: number; statTrak?: number | null; nameTag?: string }
  skin?: CatalogSkin
  showExtras: boolean
  onChange: (patch: Partial<SkinSel>) => void
}) {
  const { value, skin, showExtras, onChange } = props
  const min = skin?.minFloat ?? 0
  const max = skin?.maxFloat ?? 1
  return (
    <div className="editor">
      <label className="field">
        <span>
          Wear: <strong>{value.wear.toFixed(4)}</strong> — {wearName(value.wear)}
          <span className="muted"> (range {min.toFixed(2)}–{max.toFixed(2)})</span>
        </span>
        <input
          type="range"
          min={min}
          max={max}
          step={0.0001}
          value={value.wear}
          onChange={(e) => onChange({ wear: Number(e.target.value) })}
        />
      </label>
      <label className="field">
        Pattern seed (0–{MAX_SEED})
        <div className="row tight">
          <input
            type="number"
            min={0}
            max={MAX_SEED}
            value={value.seed}
            onChange={(e) => onChange({ seed: clamp(Math.round(Number(e.target.value) || 0), 0, MAX_SEED) })}
          />
          <button onClick={() => onChange({ seed: randomSeed() })}>Random</button>
        </div>
      </label>
      {showExtras && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={value.statTrak != null}
              onChange={(e) => onChange({ statTrak: e.target.checked ? 0 : null })}
            />
            StatTrak™
            {value.statTrak != null && (
              <input
                type="number"
                className="small-num"
                min={0}
                value={value.statTrak}
                onChange={(e) => onChange({ statTrak: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
              />
            )}
          </label>
          <label className="field">
            Name tag
            <input
              maxLength={MAX_NAMETAG}
              placeholder="None"
              value={value.nameTag ?? ''}
              onChange={(e) => onChange({ nameTag: e.target.value })}
            />
          </label>
        </>
      )}
    </div>
  )
}

const blankSel = (): SkinSel => ({ paintKit: 0, wear: 0.01, seed: 0, statTrak: null, nameTag: '' })

function WeaponPanel(props: {
  team: Team
  onCopy: () => void
  weapon: CatalogWeapon
  skins: CatalogSkin[]
  sel: SkinSel | null
  stickers: CatalogSticker[]
  keychains: CatalogKeychain[]
  stickerByDef: Map<number, CatalogSticker>
  keychainByDef: Map<number, CatalogKeychain>
  onChange: (sel: SkinSel | null) => void
}) {
  const { weapon, skins, sel, onChange } = props
  const current = sel?.paintKit ? skins.find((s) => s.paintKit === sel.paintKit) : undefined
  const tiles: Tile[] = [
    {
      key: 'default',
      name: 'Default',
      image: weapon.image,
      selected: !sel || sel.paintKit === 0,
      // keeps stickers and charm on the default finish
      onClick: () => onChange(sel ? { ...sel, paintKit: 0, legacyModel: false } : null)
    },
    ...skins.map((s) => ({
      key: s.id,
      name: s.name,
      image: s.image,
      color: s.rarityColor,
      selected: sel?.paintKit === s.paintKit,
      onClick: () =>
        onChange({
          paintKit: s.paintKit,
          wear: sel?.paintKit ? clamp(sel.wear, s.minFloat, s.maxFloat) : defaultWear(s),
          seed: sel?.seed ?? 0,
          statTrak: sel?.statTrak ?? null,
          nameTag: sel?.nameTag ?? '',
          legacyModel: s.legacyModel,
          stickers: sel?.stickers,
          keychain: sel?.keychain
        })
    }))
  ]
  const [editing, setEditing] = useState(false)
  const base = sel ?? blankSel()
  return (
    <div className="panel-split">
      <div className="panel-main">
        <div className="panel-head">
          <h2>
            {weapon.name} ({TEAM_LABEL[props.team]})
          </h2>
          <button onClick={props.onCopy}>Copy to {TEAM_LABEL[props.team === 't' ? 'ct' : 't']}</button>
        </div>
        <p className="muted small edit-hint">Right-click a skin for wear, pattern, StatTrak, name tag, stickers and charm.</p>
        <SkinGrid key={weapon.defIndex} tiles={tiles.map((t) => ({ ...t, editable: true }))} search onEdit={() => setEditing(true)} />
      </div>
      {editing && (
        <Modal
          title={`${weapon.name} | ${current?.name ?? 'Default'} (${TEAM_LABEL[props.team]})`}
          onClose={() => setEditing(false)}
          wide
        >
          <SkinViewer3D
            className={weapon.className}
            legacy={!!base.legacyModel}
            paintKit={sel?.paintKit ?? 0}
            stickers={Array.from({ length: STICKER_SLOTS }, (_, i) => base.stickers?.[i] ?? null)}
            keychain={base.keychain ?? null}
            stickerImage={(d) => props.stickerByDef.get(d)?.image}
            keychainImage={(d) => props.keychainByDef.get(d)?.image}
            onSticker={(slot, st) =>
              onChange({ ...base, stickers: Array.from({ length: STICKER_SLOTS }, (_, i) => (i === slot ? st : (base.stickers?.[i] ?? null))) })
            }
            onKeychain={(keychain) => onChange({ ...base, keychain })}
          />
          {sel && sel.paintKit > 0 && (
            <PaintEditor value={sel} skin={current} showExtras onChange={(patch) => onChange({ ...sel, ...patch })} />
          )}
          <StickerEditor
            stickers={base.stickers ?? []}
            catalog={props.stickers}
            byDef={props.stickerByDef}
            onChange={(stickers) => onChange({ ...base, stickers })}
          />
          <KeychainEditor
            keychain={base.keychain ?? null}
            catalog={props.keychains}
            byDef={props.keychainByDef}
            onChange={(keychain) => onChange({ ...base, keychain })}
          />
        </Modal>
      )}
    </div>
  )
}

const PICKER_LIMIT = 150

/** Searchable grid for big lists (11 000+ stickers); shows at most PICKER_LIMIT matches. */
function Picker<T extends { defIndex: number; name: string; image: string; rarityColor: string }>(props: {
  items: T[]
  filters?: { label: string; test: (t: T) => boolean }[]
  onPick: (t: T) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState(0)
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const test = props.filters?.[filter]?.test
  const matches = props.items.filter(
    (t) => (!test || test(t)) && words.every((w) => t.name.toLowerCase().includes(w) || ('event' in t && String(t.event ?? '').toLowerCase().includes(w)))
  )
  return (
    <div className="picker">
      <div className="row tight">
        <input autoFocus className="grid-search" placeholder="Search… (e.g. katowice 2014 holo)" value={q} onChange={(e) => setQ(e.target.value)} />
        {props.filters && (
          <select value={filter} onChange={(e) => setFilter(Number(e.target.value))}>
            {props.filters.map((f, i) => (
              <option key={f.label} value={i}>
                {f.label}
              </option>
            ))}
          </select>
        )}
        <button onClick={props.onClose}>Cancel</button>
      </div>
      <p className="muted small">
        {matches.length > PICKER_LIMIT ? `Showing ${PICKER_LIMIT} of ${matches.length}; type to narrow down.` : `${matches.length} found`}
      </p>
      <div className="skin-grid small-tiles">
        {matches.slice(0, PICKER_LIMIT).map((t) => (
          <button key={t.defIndex} className="skin-tile" style={{ borderBottomColor: t.rarityColor }} title={t.name} onClick={() => props.onPick(t)}>
            <img src={t.image} alt="" loading="lazy" draggable={false} />
            <span>{t.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

const STICKER_FILTERS: { label: string; test: (s: CatalogSticker) => boolean }[] = [
  { label: 'All stickers', test: () => true },
  { label: 'Team', test: (s) => s.type === 'Team' },
  { label: 'Autograph', test: (s) => s.type === 'Autograph' },
  { label: 'Event', test: (s) => s.type === 'Event' },
  { label: 'Other', test: (s) => s.type === 'Other' }
]

function Num(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="inline-field">
      {props.label}
      <input
        type="number"
        className="small-num"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(clamp(Number(e.target.value) || 0, props.min, props.max))}
      />
    </label>
  )
}

function StickerEditor(props: {
  stickers: (StickerSel | null)[]
  catalog: CatalogSticker[]
  byDef: Map<number, CatalogSticker>
  onChange: (s: (StickerSel | null)[]) => void
}) {
  const [picking, setPicking] = useState<number | null>(null)
  const slots = Array.from({ length: STICKER_SLOTS }, (_, i) => props.stickers[i] ?? null)
  const set = (i: number, s: StickerSel | null) => props.onChange(slots.map((x, j) => (j === i ? s : x)))
  return (
    <div className="extras">
      <h4>Stickers</h4>
      {picking != null && (
        <Picker
          items={props.catalog}
          filters={STICKER_FILTERS}
          onPick={(s) => {
            set(picking, { ...(slots[picking] ?? emptySticker(s.defIndex)), defIndex: s.defIndex })
            setPicking(null)
          }}
          onClose={() => setPicking(null)}
        />
      )}
      {slots.map((s, i) => {
        const info = s ? props.byDef.get(s.defIndex) : undefined
        return (
          <div key={i} className="extra-slot">
            <button className="extra-pick" onClick={() => setPicking(i)} title="Choose sticker">
              {info ? <img src={info.image} alt="" /> : <span className="muted small">Slot {i + 1}</span>}
            </button>
            {s ? (
              <div className="extra-fields">
                <span className="small">{info?.name ?? `Sticker ${s.defIndex}`}</span>
                <label className="inline-field">
                  Scrape
                  <input type="range" min={0} max={1} step={0.01} value={s.wear} onChange={(e) => set(i, { ...s, wear: Number(e.target.value) })} />
                </label>
                <details>
                  <summary className="muted small">Position</summary>
                  <Num label="Scale" value={s.scale} min={0.1} max={3} step={0.05} onChange={(v) => set(i, { ...s, scale: v })} />
                  <Num label="Rotation" value={s.rotation} min={-360} max={360} step={5} onChange={(v) => set(i, { ...s, rotation: v })} />
                  <Num label="X" value={s.x} min={-2} max={2} step={0.01} onChange={(v) => set(i, { ...s, x: v })} />
                  <Num label="Y" value={s.y} min={-2} max={2} step={0.01} onChange={(v) => set(i, { ...s, y: v })} />
                </details>
                <button className="link small" onClick={() => set(i, null)}>
                  Remove
                </button>
              </div>
            ) : (
              <span className="muted small">Empty</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function KeychainEditor(props: {
  keychain: KeychainSel | null
  catalog: CatalogKeychain[]
  byDef: Map<number, CatalogKeychain>
  onChange: (k: KeychainSel | null) => void
}) {
  const [picking, setPicking] = useState(false)
  const k = props.keychain
  const info = k ? props.byDef.get(k.defIndex) : undefined
  return (
    <div className="extras">
      <h4>Charm</h4>
      {picking && (
        <Picker
          items={props.catalog}
          onPick={(c) => {
            props.onChange({ ...(k ?? emptyKeychain(c.defIndex)), defIndex: c.defIndex })
            setPicking(false)
          }}
          onClose={() => setPicking(false)}
        />
      )}
      <div className="extra-slot">
        <button className="extra-pick" onClick={() => setPicking(true)} title="Choose charm">
          {info ? <img src={info.image} alt="" /> : <span className="muted small">None</span>}
        </button>
        {k && (
          <div className="extra-fields">
            <span className="small">{info?.name ?? `Charm ${k.defIndex}`}</span>
            <Num label="Pattern" value={k.seed} min={0} max={100000} step={1} onChange={(v) => props.onChange({ ...k, seed: Math.round(v) })} />
            <details>
              <summary className="muted small">Position</summary>
              <Num label="X" value={k.x} min={-10} max={10} step={0.1} onChange={(v) => props.onChange({ ...k, x: v })} />
              <Num label="Y" value={k.y} min={-10} max={10} step={0.1} onChange={(v) => props.onChange({ ...k, y: v })} />
              <Num label="Z" value={k.z} min={-10} max={10} step={0.1} onChange={(v) => props.onChange({ ...k, z: v })} />
            </details>
            <button className="link small" onClick={() => props.onChange(null)}>
              Remove
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function ItemPanel(props: {
  title: string
  hint: string
  none: string
  items: { defIndex: number; name: string; image: string; rarityColor: string; type?: string }[]
  /** show the item type (Pin, Service Medal …) as a filter */
  group?: boolean
  value: number
  onChange: (def: number) => void
}) {
  const { title, hint, none, items, group, value, onChange } = props
  const types = useMemo(() => (group ? [...new Set(items.map((i) => i.type ?? 'Other'))].sort() : []), [items, group])
  const [type, setType] = useState(group && types.includes('Pin') ? 'Pin' : '')
  const tiles: Tile[] = [
    { key: 'none', name: none, image: null, selected: !value, onClick: () => onChange(0) },
    ...items
      .filter((i) => !type || i.type === type || i.defIndex === value)
      .map((i) => ({
        key: String(i.defIndex),
        name: i.name,
        image: i.image,
        color: i.rarityColor,
        selected: value === i.defIndex,
        onClick: () => onChange(i.defIndex)
      }))
  ]
  return (
    <div className="panel-split">
      <div className="panel-main">
        <div className="panel-head">
          <h2>{title}</h2>
          {group && types.length > 1 && (
            <Dropdown
              value={type}
              align="right"
              onChange={setType}
              options={[{ value: '', label: 'All types' }, ...types.map((t) => ({ value: t, label: t }))]}
            />
          )}
        </div>
        <p className="muted small">{hint}</p>
        <SkinGrid tiles={tiles} search />
      </div>
    </div>
  )
}

function GraffitiPanel(props: {
  items: CatalogGraffiti[]
  value: number
  tint: number
  onChange: (def: number, tint: number) => void
}) {
  const { items, value, tint, onChange } = props
  const current = value ? items.find((g) => g.defIndex === value) : undefined
  const tinted = !!current && Object.keys(current.tints).length > 0
  const tiles: Tile[] = [
    { key: 'none', name: 'No graffiti', image: null, selected: !value, onClick: () => onChange(0, 0) },
    ...items.map((g) => {
      const hasTints = Object.keys(g.tints).length > 0
      return {
        key: String(g.defIndex),
        name: g.name,
        image: (value === g.defIndex && g.tints[String(tint)]) || g.image,
        color: g.rarityColor,
        selected: value === g.defIndex,
        // keep the picked tint when switching to another tinted graffiti that has it
        onClick: () => onChange(g.defIndex, hasTints ? (g.tints[String(tint)] ? tint : Number(Object.keys(g.tints)[0])) : 0)
      }
    })
  ]
  return (
    <div className="panel-split">
      <div className="panel-main">
        <h2>Graffiti</h2>
        <p className="muted small">
          In game, tap T to spray it and hold T for the graffiti wheel (needs <code>+cs2prac_spray</code> on T: alias
          <code>+cs2prac_spray</code> to <code>css_spraywheel open</code> and <code>-cs2prac_spray</code> to{' '}
          <code>css_spraywheel close</code>; a plain <code>css_spray</code> bind also sprays). Only our server draws
          it; Steam is never asked.
        </p>
        {tinted && (
          <div className="tint-row">
            {GRAFFITI_TINTS.filter((t) => current!.tints[String(t.id)]).map((t) => (
              <button
                key={t.id}
                className={'tint-chip' + (t.id === tint ? ' active' : '')}
                style={{ background: t.color }}
                title={t.name}
                aria-label={t.name}
                onClick={() => onChange(current!.defIndex, t.id)}
              />
            ))}
          </div>
        )}
        <SkinGrid tiles={tiles} search />
      </div>
    </div>
  )
}

function AgentPanel(props: { team: Team; agents: CatalogAgent[]; sel: AgentSel | null; onChange: (a: AgentSel | null) => void }) {
  const { team, agents, sel, onChange } = props
  const tiles: Tile[] = [
    { key: 'default', name: 'Default agent', image: null, selected: !sel, onClick: () => onChange(null) },
    ...agents.map((a) => ({
      key: String(a.defIndex),
      name: a.name,
      image: a.image,
      color: a.rarityColor,
      selected: sel?.defIndex === a.defIndex,
      onClick: () => onChange({ defIndex: a.defIndex, model: a.model })
    }))
  ]
  return (
    <div className="panel-split">
      <div className="panel-main">
        <h2>Agent ({TEAM_LABEL[team]})</h2>
        <SkinGrid tiles={tiles} search />
      </div>
    </div>
  )
}

function KnifePanel(props: {
  team: Team
  knives: CatalogWeapon[]
  byDef: Map<number, CatalogSkin[]>
  sel: KnifeSel | null
  onChange: (sel: KnifeSel | null) => void
  onCopy: () => void
}) {
  const { team, knives, byDef, sel, onChange, onCopy } = props
  const [editing, setEditing] = useState(false)
  const model = sel ? knives.find((k) => k.defIndex === sel.defIndex) : undefined
  const finishes = model ? (byDef.get(model.defIndex) ?? []) : []
  const current = sel?.paintKit ? finishes.find((s) => s.paintKit === sel.paintKit) : undefined

  const pickModel = (k: CatalogWeapon) =>
    onChange({
      defIndex: k.defIndex,
      className: k.className,
      paintKit: 0,
      wear: 0.01,
      seed: sel?.seed ?? 0,
      statTrak: sel?.statTrak ?? null,
      nameTag: sel?.nameTag ?? ''
    })

  const modelTiles: Tile[] = [
    { key: 'default', name: 'Default knife', image: null, selected: !sel, onClick: () => onChange(null) },
    ...knives.map((k) => ({
      key: String(k.defIndex),
      name: k.name.replace(/^★\s*/, ''),
      image: k.image,
      selected: sel?.defIndex === k.defIndex,
      onClick: () => pickModel(k)
    }))
  ]
  const finishTiles: Tile[] = model
    ? [
        {
          key: 'vanilla',
          name: 'Vanilla',
          image: model.image,
          selected: sel?.paintKit === 0,
          onClick: () => onChange({ ...sel!, paintKit: 0, legacyModel: false })
        },
        ...finishes.map((s) => ({
          key: s.id,
          name: s.name,
          image: s.image,
          color: s.rarityColor,
          selected: sel?.paintKit === s.paintKit,
          onClick: () =>
            onChange({ ...sel!, paintKit: s.paintKit, wear: clamp(sel!.wear, s.minFloat, s.maxFloat), legacyModel: s.legacyModel })
        }))
      ]
    : []

  return (
    <div className="panel-split">
      <div className="panel-main">
        <div className="panel-head">
          <h2>Knife ({TEAM_LABEL[team]})</h2>
          <button onClick={onCopy}>Copy to {TEAM_LABEL[team === 't' ? 'ct' : 't']}</button>
        </div>
        <h3>Model</h3>
        <SkinGrid tiles={modelTiles} />
        {model && (
          <>
            <h3>Finish</h3>
            <p className="muted small edit-hint">Right-click a finish for wear, pattern, StatTrak and name tag.</p>
            <SkinGrid
              key={model.defIndex}
              tiles={finishTiles.map((t) => ({ ...t, editable: t.key !== 'vanilla' }))}
              search
              onEdit={() => setEditing(true)}
            />
          </>
        )}
      </div>
      {editing && sel && sel.paintKit > 0 && (
        <Modal title={`${model?.name.replace(/^★\s*/, '')} | ${current?.name ?? sel.paintKit} (${TEAM_LABEL[team]})`} onClose={() => setEditing(false)}>
          <PaintEditor value={sel} skin={current} showExtras onChange={(patch) => onChange({ ...sel, ...patch })} />
        </Modal>
      )}
    </div>
  )
}

function GlovePanel(props: {
  team: Team
  gloveTypes: CatalogWeapon[]
  byDef: Map<number, CatalogSkin[]>
  sel: GloveSel | null
  onChange: (sel: GloveSel | null) => void
  onCopy: () => void
}) {
  const { team, gloveTypes, byDef, sel, onChange, onCopy } = props
  const [typeFilter, setTypeFilter] = useState<number | 'all'>(sel?.defIndex ?? 'all')
  const [editing, setEditing] = useState(false)
  const types = typeFilter === 'all' ? gloveTypes : gloveTypes.filter((g) => g.defIndex === typeFilter)
  const current = sel ? byDef.get(sel.defIndex)?.find((s) => s.paintKit === sel.paintKit) : undefined

  const tiles: Tile[] = [
    { key: 'default', name: 'Default gloves', image: null, selected: !sel, onClick: () => onChange(null) },
    ...types.flatMap((g) =>
      (byDef.get(g.defIndex) ?? []).map((s) => ({
        key: s.id,
        name: `${g.name.replace(/^★\s*/, '')} | ${s.name}`,
        image: s.image,
        color: s.rarityColor,
        selected: sel?.defIndex === g.defIndex && sel.paintKit === s.paintKit,
        onClick: () =>
          onChange({
            defIndex: g.defIndex,
            paintKit: s.paintKit,
            wear: sel ? clamp(sel.wear, s.minFloat, s.maxFloat) : defaultWear(s),
            seed: sel?.seed ?? 0
          })
      }))
    )
  ]

  return (
    <div className="panel-split">
      <div className="panel-main">
        <div className="panel-head">
          <h2>Gloves ({TEAM_LABEL[team]})</h2>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            <option value="all">All glove types</option>
            {gloveTypes.map((g) => (
              <option key={g.defIndex} value={g.defIndex}>
                {g.name.replace(/^★\s*/, '')}
              </option>
            ))}
          </select>
          <button onClick={onCopy}>Copy to {TEAM_LABEL[team === 't' ? 'ct' : 't']}</button>
        </div>
        <p className="muted small edit-hint">Right-click a pair for wear and pattern.</p>
        <SkinGrid
          key={String(typeFilter)}
          tiles={tiles.map((t) => ({ ...t, editable: t.key !== 'default' }))}
          search
          onEdit={() => setEditing(true)}
        />
      </div>
      {editing && sel && (
        <Modal
          title={`${gloveTypes.find((g) => g.defIndex === sel.defIndex)?.name.replace(/^★\s*/, '') ?? 'Gloves'} | ${current?.name ?? sel.paintKit} (${TEAM_LABEL[team]})`}
          onClose={() => setEditing(false)}
        >
          <PaintEditor value={sel} skin={current} showExtras={false} onChange={(patch) => onChange({ ...sel, ...patch })} />
        </Modal>
      )}
    </div>
  )
}
