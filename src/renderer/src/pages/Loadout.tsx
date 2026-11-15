import { useEffect, useMemo, useRef, useState } from 'react'
import type { LoadoutSaveResult } from '@shared/ipc'
import {
  emptyProfile,
  MAX_NAMETAG,
  MAX_SEED,
  wearName,
  type Catalog,
  type CatalogSkin,
  type CatalogWeapon,
  type GloveSel,
  type KnifeSel,
  type LoadoutStore,
  type Profile,
  type SkinSel,
  type SteamAccount,
  type Team
} from '@shared/skins'

type Slot = { kind: 'weapon'; defIndex: number } | { kind: 'knife' | 'gloves'; team: Team }
type SaveState = { state: 'idle' | 'saving' | 'error'; result?: LoadoutSaveResult; error?: string }

const TEAM_LABEL: Record<Team, string> = { t: 'T', ct: 'CT' }
const WEAPON_CATEGORIES = ['Pistols', 'SMGs', 'Rifles', 'Heavy', 'Equipment']
const SAVE_DEBOUNCE_MS = 400

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const defaultWear = (s?: CatalogSkin) => clamp(0.01, s?.minFloat ?? 0, s?.maxFloat ?? 1)
const randomSeed = () => Math.floor(Math.random() * (MAX_SEED + 1))
const sameSlot = (a: Slot, b: Slot) => JSON.stringify(a) === JSON.stringify(b)

export default function Loadout() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [store, setStore] = useState<LoadoutStore | null>(null)
  const [accounts, setAccounts] = useState<SteamAccount[]>([])
  const [slot, setSlot] = useState<Slot>({ kind: 'knife', team: 't' })
  const [save, setSave] = useState<SaveState>({ state: 'idle' })
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
    return flush // save immediately if the user leaves the tab mid-debounce
  }, [])

  const index = useMemo(() => {
    const byDef = new Map<number, CatalogSkin[]>()
    const weaponByDef = new Map<number, CatalogWeapon>()
    for (const s of catalog?.skins ?? []) byDef.set(s.defIndex, [...(byDef.get(s.defIndex) ?? []), s])
    for (const w of catalog?.weapons ?? []) weaponByDef.set(w.defIndex, w)
    const skin = (def: number, paint: number) => byDef.get(def)?.find((s) => s.paintKit === paint)
    return { byDef, weaponByDef, skin }
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

  return (
    <div className="loadout">
      <div className="loadout-bar">
        <select
          value={profile.id}
          onChange={(e) => update((s) => ({ ...s, activeId: e.target.value }))}
          title="Active profile — this one is sent to the server"
        >
          {store.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || 'Untitled'}
            </option>
          ))}
        </select>
        <input
          className="profile-name"
          value={profile.name}
          maxLength={40}
          onChange={(e) => updateProfile((p) => ({ ...p, name: e.target.value }))}
          aria-label="Profile name"
        />
        <button
          onClick={() =>
            update((s) => {
              const p = { ...structuredClone(profile), id: crypto.randomUUID(), name: `${profile.name} copy` }
              return { ...s, activeId: p.id, profiles: [...s.profiles, p] }
            })
          }
        >
          Duplicate
        </button>
        <button
          onClick={() =>
            update((s) => {
              const p = emptyProfile(crypto.randomUUID(), `Profile ${s.profiles.length + 1}`)
              return { ...s, activeId: p.id, profiles: [...s.profiles, p] }
            })
          }
        >
          New
        </button>
        <button
          className="danger"
          disabled={store.profiles.length < 2}
          onClick={() =>
            update((s) => {
              const profiles = s.profiles.filter((p) => p.id !== profile.id)
              return { ...s, profiles, activeId: profiles[0].id }
            })
          }
        >
          Delete
        </button>

        <span className="spacer" />
        <label className="inline-field">
          Skins for
          <select
            value={store.owner ?? ''}
            onChange={(e) => update((s) => ({ ...s, owner: e.target.value || null }))}
          >
            {accounts.map((a) => (
              <option key={a.steamId} value={a.steamId}>
                {a.personaName}
              </option>
            ))}
            {store.owner && !accounts.some((a) => a.steamId === store.owner) && (
              <option value={store.owner}>{store.owner}</option>
            )}
            <option value="">Everyone (bots too)</option>
          </select>
        </label>
        <SaveIndicator save={save} />
      </div>

      <div className="loadout-body">
        <nav className="slot-list">
          <h4>Knife & gloves</h4>
          {(['t', 'ct'] as Team[]).map((team) => (
            <SlotButton
              key={`k${team}`}
              active={sameSlot(slot, { kind: 'knife', team })}
              title={`Knife (${TEAM_LABEL[team]})`}
              sub={knifeLabel(profile.knife[team])}
              set={!!profile.knife[team]}
              onClick={() => setSlot({ kind: 'knife', team })}
            />
          ))}
          {(['t', 'ct'] as Team[]).map((team) => (
            <SlotButton
              key={`g${team}`}
              active={sameSlot(slot, { kind: 'gloves', team })}
              title={`Gloves (${TEAM_LABEL[team]})`}
              sub={gloveLabel(profile.gloves[team])}
              set={!!profile.gloves[team]}
              onClick={() => setSlot({ kind: 'gloves', team })}
            />
          ))}
          {WEAPON_CATEGORIES.map((cat) => {
            const list = weapons.filter((w) => w.category === cat)
            if (!list.length) return null
            return (
              <div key={cat}>
                <h4>{cat}</h4>
                {list.map((w) => {
                  const sel = profile.weapons[w.defIndex]
                  return (
                    <SlotButton
                      key={w.defIndex}
                      active={sameSlot(slot, { kind: 'weapon', defIndex: w.defIndex })}
                      title={w.name}
                      sub={sel ? (index.skin(w.defIndex, sel.paintKit)?.name ?? `Paint ${sel.paintKit}`) : 'Default'}
                      color={sel ? index.skin(w.defIndex, sel.paintKit)?.rarityColor : undefined}
                      set={!!sel}
                      onClick={() => setSlot({ kind: 'weapon', defIndex: w.defIndex })}
                    />
                  )
                })}
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

        <section className="slot-panel">
          {slot.kind === 'weapon' && index.weaponByDef.get(slot.defIndex) && (
            <WeaponPanel
              weapon={index.weaponByDef.get(slot.defIndex)!}
              skins={index.byDef.get(slot.defIndex) ?? []}
              sel={profile.weapons[slot.defIndex] ?? null}
              onChange={(sel) =>
                updateProfile((p) => {
                  const weaponsNext = { ...p.weapons }
                  if (sel) weaponsNext[slot.defIndex] = sel
                  else delete weaponsNext[slot.defIndex]
                  return { ...p, weapons: weaponsNext }
                })
              }
            />
          )}
          {slot.kind === 'knife' && (
            <KnifePanel
              key={`knife-${slot.team}`}
              team={slot.team}
              knives={knives}
              byDef={index.byDef}
              sel={profile.knife[slot.team]}
              onChange={(sel) => updateProfile((p) => ({ ...p, knife: { ...p.knife, [slot.team]: sel } }))}
              onCopy={() => {
                const other: Team = slot.team === 't' ? 'ct' : 't'
                updateProfile((p) => ({ ...p, knife: { ...p.knife, [other]: structuredClone(p.knife[slot.team]) } }))
              }}
            />
          )}
          {slot.kind === 'gloves' && (
            <GlovePanel
              key={`gloves-${slot.team}`}
              team={slot.team}
              gloveTypes={gloveTypes}
              byDef={index.byDef}
              sel={profile.gloves[slot.team]}
              onChange={(sel) => updateProfile((p) => ({ ...p, gloves: { ...p.gloves, [slot.team]: sel } }))}
              onCopy={() => {
                const other: Team = slot.team === 't' ? 'ct' : 't'
                updateProfile((p) => ({ ...p, gloves: { ...p.gloves, [other]: structuredClone(p.gloves[slot.team]) } }))
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

function SlotButton(props: { title: string; sub: string; active: boolean; set: boolean; color?: string; onClick: () => void }) {
  return (
    <button className={`slot ${props.active ? 'active' : ''}`} onClick={props.onClick}>
      <span className="slot-title">{props.title}</span>
      <span className={`slot-sub ${props.set ? '' : 'muted'}`} style={props.color ? { color: props.color } : undefined}>
        {props.sub}
      </span>
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
}

function SkinGrid({ tiles, search }: { tiles: Tile[]; search?: boolean }) {
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
            title={t.name}
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

function WeaponPanel(props: {
  weapon: CatalogWeapon
  skins: CatalogSkin[]
  sel: SkinSel | null
  onChange: (sel: SkinSel | null) => void
}) {
  const { weapon, skins, sel, onChange } = props
  const current = sel ? skins.find((s) => s.paintKit === sel.paintKit) : undefined
  const tiles: Tile[] = [
    { key: 'default', name: 'Default', image: weapon.image, selected: !sel, onClick: () => onChange(null) },
    ...skins.map((s) => ({
      key: s.id,
      name: s.name,
      image: s.image,
      color: s.rarityColor,
      selected: sel?.paintKit === s.paintKit,
      onClick: () =>
        onChange({
          paintKit: s.paintKit,
          wear: sel ? clamp(sel.wear, s.minFloat, s.maxFloat) : defaultWear(s),
          seed: sel?.seed ?? 0,
          statTrak: sel?.statTrak ?? null,
          nameTag: sel?.nameTag ?? '',
          legacyModel: s.legacyModel
        })
    }))
  ]
  return (
    <div className="panel-split">
      <div className="panel-main">
        <h2>{weapon.name}</h2>
        <SkinGrid key={weapon.defIndex} tiles={tiles} search />
      </div>
      {sel && (
        <aside className="panel-side">
          <h3>{current?.name ?? `Paint kit ${sel.paintKit}`}</h3>
          <PaintEditor value={sel} skin={current} showExtras onChange={(patch) => onChange({ ...sel, ...patch })} />
        </aside>
      )}
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
            <SkinGrid key={model.defIndex} tiles={finishTiles} search />
          </>
        )}
      </div>
      {sel && (
        <aside className="panel-side">
          <h3>
            {model?.name.replace(/^★\s*/, '')} {current ? `| ${current.name}` : '(vanilla)'}
          </h3>
          {sel.paintKit > 0 ? (
            <PaintEditor value={sel} skin={current} showExtras onChange={(patch) => onChange({ ...sel, ...patch })} />
          ) : (
            <p className="muted small">Vanilla knives have no wear or pattern. Pick a finish to customise it.</p>
          )}
        </aside>
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
        <SkinGrid key={String(typeFilter)} tiles={tiles} search />
      </div>
      {sel && (
        <aside className="panel-side">
          <h3>{current?.name ?? `Paint kit ${sel.paintKit}`}</h3>
          <PaintEditor value={sel} skin={current} showExtras={false} onChange={(patch) => onChange({ ...sel, ...patch })} />
        </aside>
      )}
    </div>
  )
}
