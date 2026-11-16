/** A CS2 Steam Workshop map, as the app shows it (from the public, keyless GetPublishedFileDetails API). */
export interface WorkshopMap {
  id: string
  title: string
  /** full-size preview image on Steam's CDN ('' if none) */
  preview: string
  /** small thumbnail kept locally (data URL) once the map was started; preferred over `preview` */
  thumb?: string
  /** bytes */
  size: number
  /** unix seconds */
  updated: number
  subscriptions: number
  tags: string[]
  /** unix ms when the details were fetched (cache age) */
  fetchedAt: number
}

export type WorkshopSort = 'trend' | 'mostrecent' | 'totaluniquesubscribers'

export interface WorkshopSearchResult {
  maps: WorkshopMap[]
  page: number
  /** the browse page was full, so a next page probably exists */
  more: boolean
}

/** A raw workshop id or any steamcommunity.com link that carries one (`?id=…`, `/filedetails/…id=…`). */
export function parseWorkshopId(text: string): string | null {
  const t = text.trim()
  const fromUrl = t.match(/[?&]id=(\d{5,20})/)
  if (fromUrl) return fromUrl[1]
  return /^\d{5,20}$/.test(t) ? t : null
}

/** The Steam Workshop browse page for CS2 maps (the ids are scraped from it, details come from the API). */
export function browseUrl(query: string, page: number, sort: WorkshopSort): string {
  const q = query.trim()
  const s = q ? 'textsearch' : sort
  const p = new URLSearchParams({ appid: '730', browsesort: s, actualsort: s, section: 'readytouseitems', p: String(page) })
  if (q) p.set('searchtext', q)
  if (s === 'trend') p.set('days', '30')
  p.append('requiredtags[]', 'Cs2')
  p.append('requiredtags[]', 'Map')
  return `https://steamcommunity.com/workshop/browse/?${p}`
}

/** Item ids in page order; the page embeds them in (escaped) JSON as publishedfileid":"<id>. */
export function idsFromBrowsePage(html: string): string[] {
  return [...new Set([...html.matchAll(/publishedfileid\\?"\s*:\s*\\?"(\d{5,20})/g)].map((m) => m[1]))]
}

interface RawDetails {
  publishedfileid?: string
  result?: number
  consumer_app_id?: number
  title?: string
  preview_url?: string
  file_size?: string | number
  time_updated?: number
  subscriptions?: number
  tags?: { tag?: string }[]
}

/** One entry of GetPublishedFileDetails' publishedfiledetails; null for missing/hidden items or other games. */
export function mapFromDetails(d: RawDetails, now = Date.now()): WorkshopMap | null {
  if (!d.publishedfileid || d.result !== 1 || (d.consumer_app_id !== undefined && d.consumer_app_id !== 730)) return null
  return {
    id: d.publishedfileid,
    title: (d.title ?? '').trim() || `Workshop ${d.publishedfileid}`,
    preview: d.preview_url ?? '',
    size: Number(d.file_size) || 0,
    updated: d.time_updated ?? 0,
    subscriptions: d.subscriptions ?? 0,
    tags: (d.tags ?? []).map((t) => t.tag ?? '').filter(Boolean),
    fetchedAt: now
  }
}

export const isMap = (m: WorkshopMap) => m.tags.length === 0 || m.tags.some((t) => t.toLowerCase() === 'map')

/** Steam's image CDN resizes on request; a 320x180 letterboxed JPEG is ~20 KB. */
export function thumbUrl(preview: string): string {
  if (!preview) return ''
  return `${preview}${preview.includes('?') ? '&' : '?'}imw=320&imh=180&ima=fit&impolicy=Letterbox&imcolor=%23000000&letterbox=true`
}

export const placeholderMap = (id: string): WorkshopMap => ({
  id,
  title: `Workshop ${id}`,
  preview: '',
  size: 0,
  updated: 0,
  subscriptions: 0,
  tags: [],
  fetchedAt: 0
})
