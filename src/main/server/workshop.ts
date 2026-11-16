import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  browseUrl,
  idsFromBrowsePage,
  isMap,
  mapFromDetails,
  placeholderMap,
  thumbUrl,
  type WorkshopMap,
  type WorkshopSearchResult,
  type WorkshopSort
} from '@shared/workshop'

/**
 * Workshop map search and details. Everything here is anonymous and read-only: the public browse page (for ids) and
 * ISteamRemoteStorage/GetPublishedFileDetails (no key, no account). Results are cached in userData so names and
 * thumbnails of maps you played show offline; the server itself downloads the map (host_workshop_map).
 */
const DETAILS_API = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CS2Prac'
/** details older than this are fetched again when online */
const MAX_AGE = 24 * 3600_000
/** at most this many maps in the cache; maps with a kept thumbnail go last */
const MAX_CACHED = 300

export interface WorkshopCache {
  maps: Record<string, WorkshopMap>
}

export class WorkshopStore {
  private cache: WorkshopCache | null = null

  constructor(
    private readonly file: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  private async load(): Promise<WorkshopCache> {
    if (this.cache) return this.cache
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as WorkshopCache
      this.cache = { maps: raw && typeof raw.maps === 'object' ? raw.maps : {} }
    } catch {
      this.cache = { maps: {} }
    }
    return this.cache
  }

  private async save() {
    const c = await this.load()
    const all = Object.values(c.maps)
    if (all.length > MAX_CACHED) {
      all.sort((a, b) => Number(!!b.thumb) - Number(!!a.thumb) || b.fetchedAt - a.fetchedAt)
      c.maps = Object.fromEntries(all.slice(0, MAX_CACHED).map((m) => [m.id, m]))
    }
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(c))
    await rename(tmp, this.file)
  }

  private async put(maps: WorkshopMap[]) {
    const c = await this.load()
    for (const m of maps) c.maps[m.id] = { ...m, thumb: c.maps[m.id]?.thumb ?? m.thumb }
    await this.save()
  }

  /** GetPublishedFileDetails for up to 100 ids per call. */
  private async fetchDetails(ids: string[]): Promise<WorkshopMap[]> {
    const out: WorkshopMap[] = []
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100)
      const body = new URLSearchParams({ itemcount: String(chunk.length) })
      chunk.forEach((id, j) => body.append(`publishedfileids[${j}]`, id))
      const res = await this.fetchFn(DETAILS_API, { method: 'POST', body, headers: { 'User-Agent': UA } })
      if (!res.ok) throw new Error(`Steam answered ${res.status}`)
      const json = (await res.json()) as { response?: { publishedfiledetails?: unknown[] } }
      for (const d of json.response?.publishedfiledetails ?? []) {
        const m = mapFromDetails(d as Parameters<typeof mapFromDetails>[0])
        if (m) out.push(m)
      }
    }
    return out
  }

  /** Maps by id in the given order: cached ones as they are unless stale, unknown ones as placeholders when offline. */
  async details(ids: string[], refresh = false): Promise<WorkshopMap[]> {
    const c = await this.load()
    const want = ids.filter((id) => refresh || !c.maps[id] || Date.now() - c.maps[id].fetchedAt > MAX_AGE)
    if (want.length) {
      try {
        await this.put(await this.fetchDetails(want))
      } catch {
        /* offline: cached or placeholder */
      }
    }
    return ids.map((id) => c.maps[id] ?? placeholderMap(id))
  }

  /** One browse page of CS2 maps (30 per page): newest, most popular or matching `query`. */
  async search(query: string, page: number, sort: WorkshopSort): Promise<WorkshopSearchResult> {
    const res = await this.fetchFn(browseUrl(query, page, sort), { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } })
    if (!res.ok) throw new Error(`Steam Workshop answered ${res.status}`)
    const ids = idsFromBrowsePage(await res.text())
    const found = ids.length ? await this.fetchDetails(ids) : []
    await this.put(found)
    const byId = new Map(found.map((m) => [m.id, m]))
    const maps = ids.map((id) => byId.get(id)).filter((m): m is WorkshopMap => !!m && isMap(m))
    return { maps, page, more: ids.length >= 30 }
  }

  /** Keeps a small thumbnail of a map you started (shown offline and in the recent list). */
  async keepThumb(id: string): Promise<void> {
    const [m] = await this.details([id])
    if (!m.preview || m.thumb) return
    try {
      const res = await this.fetchFn(thumbUrl(m.preview), { headers: { 'User-Agent': UA } })
      if (!res.ok) return
      const type = res.headers.get('content-type') ?? 'image/jpeg'
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > 400_000) return
      const c = await this.load()
      c.maps[id] = { ...m, thumb: `data:${type};base64,${buf.toString('base64')}` }
      await this.save()
    } catch {
      /* offline: the preview URL still works later */
    }
  }

  /** id → title for the maps we know (for the in-game Map tab). */
  async titles(ids: string[]): Promise<Record<string, string>> {
    const c = await this.load()
    return Object.fromEntries(ids.filter((id) => c.maps[id]).map((id) => [id, c.maps[id].title]))
  }
}
