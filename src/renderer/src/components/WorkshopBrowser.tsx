import { useEffect, useState } from 'react'
import { Flame, Clock, Search, Users, X } from 'lucide-react'
import Dropdown from './Dropdown'
import { parseWorkshopId, thumbUrl, type WorkshopMap, type WorkshopSort } from '@shared/workshop'

const SORTS: { value: WorkshopSort; label: string; icon: typeof Flame }[] = [
  { value: 'trend', label: 'Popular', icon: Flame },
  { value: 'mostrecent', label: 'Newest', icon: Clock },
  { value: 'totaluniquesubscribers', label: 'Most subscribed', icon: Users }
]
const message = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const mb = (b: number) => (b ? `${Math.round(b / 1e6)} MB` : '')
const subs = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`)

/**
 * Workshop tab of the Play page's map card: recent maps (kept with their thumbnails), search or browse CS2 maps,
 * or paste an id/link. Click selects, double-click starts (or changes to) the map right away.
 */
export default function WorkshopBrowser(props: {
  selectedId: string | null
  /** a map was picked (also called for maps the browser learns about, so the page can show their title) */
  onSelect: (m: WorkshopMap) => void
  onStart: (m: WorkshopMap) => void
  /** the server isn't stopped/running in a way that allows a start or a map change */
  startDisabled: boolean
}) {
  const [recent, setRecent] = useState<WorkshopMap[]>([])
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<WorkshopSort>('trend')
  const [results, setResults] = useState<WorkshopMap[] | null>(null)
  const [page, setPage] = useState(1)
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api.workshop
      .recent()
      .then(setRecent)
      .catch(() => undefined)
  }, [props.selectedId])

  async function search(nextPage = 1, s = sort) {
    setError(null)
    const id = parseWorkshopId(query)
    setLoading(true)
    try {
      if (id) {
        const [m] = await window.api.workshop.details([id], true)
        setResults([m])
        setMore(false)
        props.onSelect(m)
      } else {
        const r = await window.api.workshop.search(query, nextPage, s)
        setResults(nextPage === 1 ? r.maps : [...(results ?? []), ...r.maps.filter((m) => !results?.some((x) => x.id === m.id))])
        setPage(r.page)
        setMore(r.more)
        if (r.maps.length === 0 && nextPage === 1) setError('Nothing found. A workshop ID or link works too.')
      }
    } catch (e) {
      setError(`${message(e)}. Offline? Paste a workshop ID or link instead.`)
    } finally {
      setLoading(false)
    }
  }

  const forget = async (id: string) => setRecent(await window.api.workshop.forget(id))

  const tile = (m: WorkshopMap, removable: boolean) => (
    <div key={m.id} className={`ws-tile${props.selectedId === m.id ? ' selected' : ''}`}>
      <button
        className="ws-pick"
        title={props.startDisabled ? m.title : `${m.title}\nDouble-click to play it now`}
        onClick={() => props.onSelect(m)}
        onDoubleClick={() => !props.startDisabled && props.onStart(m)}
      >
        {m.thumb || m.preview ? <img src={m.thumb ?? thumbUrl(m.preview)} alt="" loading="lazy" /> : <span className="ws-noimg" />}
        <span className="ws-title">{m.title}</span>
        <span className="muted small">
          {[m.subscriptions ? `${subs(m.subscriptions)} subs` : '', mb(m.size)].filter(Boolean).join(' · ') || m.id}
        </span>
      </button>
      {removable && (
        <button className="ws-forget icon-btn" title="Remove from recent maps" onClick={() => forget(m.id)}>
          <X size={13} aria-hidden />
        </button>
      )}
    </div>
  )

  const pasted = parseWorkshopId(query)
  return (
    <div className="ws-browser">
      <div className="row ws-search">
        <input
          placeholder="Search workshop maps, or paste an ID or link"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
        />
        {!pasted && (
          <Dropdown
            value={sort}
            align="right"
            onChange={(v) => {
              setSort(v)
              if (results && !query.trim()) search(1, v)
            }}
            options={SORTS}
          />
        )}
        <button onClick={() => search()} disabled={loading}>
          <Search size={15} aria-hidden />
          {pasted ? 'Use map' : query.trim() ? 'Search' : 'Browse'}
        </button>
      </div>
      {error && <p className="error-text small">{error}</p>}
      {recent.length > 0 && (
        <>
          <h3 className="ws-head">Recent</h3>
          <div className="ws-grid">{recent.map((m) => tile(m, true))}</div>
        </>
      )}
      {results && (
        <>
          <h3 className="ws-head">{pasted ? 'Map' : query.trim() ? `Results for “${query.trim()}”` : SORTS.find((s) => s.value === sort)?.label}</h3>
          <div className="ws-grid">{results.map((m) => tile(m, false))}</div>
          {more && (
            <button className="ws-more" disabled={loading} onClick={() => search(page + 1)}>
              {loading ? 'Loading…' : 'More'}
            </button>
          )}
        </>
      )}
      {!results && recent.length === 0 && !loading && (
        <p className="muted small">Browse or search CS2 maps on the Steam Workshop. The server downloads a map the first time you start it.</p>
      )}
      {loading && !results && <p className="muted small">Loading…</p>}
    </div>
  )
}
