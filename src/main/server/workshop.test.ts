import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { browseUrl, idsFromBrowsePage, isMap, mapFromDetails, parseWorkshopId, thumbUrl } from '@shared/workshop'
import { WorkshopStore } from './workshop'
import { writeWorkshopMaps } from './serverPrefs'

const detail = (id: string, extra: Record<string, unknown> = {}) => ({
  publishedfileid: id,
  result: 1,
  consumer_app_id: 730,
  title: `Map ${id}`,
  preview_url: `https://images.steamusercontent.com/ugc/${id}/`,
  file_size: '123000000',
  time_updated: 1700000000,
  subscriptions: 4200,
  tags: [{ tag: 'Cs2' }, { tag: 'Map' }],
  ...extra
})

/** escaped JSON as the React browse page embeds it */
const page = (ids: string[]) =>
  `<script>window.x = JSON.parse("[${ids.map((id) => `{\\"publishedfileid\\":\\"${id}\\",\\"title\\":\\"t\\"}`).join(',')}]")</script>`

function fakeFetch(opts: { offline?: boolean; pageIds?: string[]; details?: Record<string, unknown> } = {}) {
  const calls: string[] = []
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push(String(url))
    if (opts.offline) throw new Error('getaddrinfo ENOTFOUND')
    if (String(url).includes('/workshop/browse/')) return new Response(page(opts.pageIds ?? []))
    if (String(url).includes('GetPublishedFileDetails')) {
      const body = init?.body as URLSearchParams
      const ids = [...body.entries()].filter(([k]) => k.startsWith('publishedfileids')).map(([, v]) => v)
      return Response.json({ response: { publishedfiledetails: ids.map((id) => ({ ...detail(id), ...(opts.details?.[id] as object) })) } })
    }
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } })
  }) as unknown as typeof fetch
  return { fn, calls }
}

let dir = ''
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ''
})
const tmpFile = async () => {
  dir = await mkdtemp(join(tmpdir(), 'cs2prac-ws-'))
  return join(dir, 'workshop-maps.json')
}

describe('workshop helpers', () => {
  it('reads ids from links and raw ids', () => {
    expect(parseWorkshopId('3070284539')).toBe('3070284539')
    expect(parseWorkshopId(' https://steamcommunity.com/sharedfiles/filedetails/?id=3070284539&searchtext= ')).toBe('3070284539')
    expect(parseWorkshopId('de_mirage')).toBeNull()
    expect(parseWorkshopId('12')).toBeNull()
  })

  it('builds browse urls for CS2 maps', () => {
    const trend = new URL(browseUrl('', 2, 'trend'))
    expect(trend.searchParams.get('browsesort')).toBe('trend')
    expect(trend.searchParams.get('days')).toBe('30')
    expect(trend.searchParams.get('p')).toBe('2')
    expect(trend.searchParams.getAll('requiredtags[]')).toEqual(['Cs2', 'Map'])
    const q = new URL(browseUrl(' aim ', 1, 'mostrecent'))
    expect(q.searchParams.get('browsesort')).toBe('textsearch')
    expect(q.searchParams.get('searchtext')).toBe('aim')
    expect(q.searchParams.has('days')).toBe(false)
  })

  it('scrapes unique ids in page order', () => {
    expect(idsFromBrowsePage(page(['111111', '222222', '111111']))).toEqual(['111111', '222222'])
    expect(idsFromBrowsePage('{"publishedfileid": "333333"}')).toEqual(['333333'])
  })

  it('maps API details and skips missing items or other games', () => {
    const m = mapFromDetails(detail('123456'), 5)!
    expect(m).toMatchObject({ id: '123456', title: 'Map 123456', size: 123000000, subscriptions: 4200, tags: ['Cs2', 'Map'], fetchedAt: 5 })
    expect(isMap(m)).toBe(true)
    expect(isMap({ ...m, tags: ['Cs2', 'Weapon'] })).toBe(false)
    expect(mapFromDetails({ publishedfileid: '1234567', result: 9 })).toBeNull()
    expect(mapFromDetails(detail('123456', { consumer_app_id: 440 }))).toBeNull()
    expect(mapFromDetails(detail('123456', { title: '  ' }))!.title).toBe('Workshop 123456')
  })

  it('asks the CDN for a small thumbnail', () => {
    expect(thumbUrl('')).toBe('')
    expect(thumbUrl('https://x/ugc/1/')).toMatch(/^https:\/\/x\/ugc\/1\/\?imw=320&imh=180/)
    expect(thumbUrl('https://x/a?b=1')).toContain('?b=1&imw=320')
  })
})

describe('WorkshopStore', () => {
  it('searches, keeps only maps and caches details', async () => {
    const f = fakeFetch({ pageIds: ['100001', '100002'], details: { '100002': { tags: [{ tag: 'Cs2' }, { tag: 'Skin' }] } } })
    const store = new WorkshopStore(await tmpFile(), f.fn)
    const r = await store.search('', 1, 'trend')
    expect(r.maps.map((m) => m.id)).toEqual(['100001'])
    expect(r.more).toBe(false)
    const n = f.calls.length
    expect((await store.details(['100001']))[0].title).toBe('Map 100001')
    expect(f.calls.length).toBe(n) // fresh cache: no request
    expect(await store.titles(['100001', '999999'])).toEqual({ '100001': 'Map 100001' })
  })

  it('reports more pages when the browse page is full', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => String(200000 + i))
    const store = new WorkshopStore(await tmpFile(), fakeFetch({ pageIds: ids }).fn)
    expect((await store.search('x', 1, 'trend')).more).toBe(true)
  })

  it('returns placeholders offline and cached maps after a restart', async () => {
    const file = await tmpFile()
    const off = new WorkshopStore(file, fakeFetch({ offline: true }).fn)
    expect((await off.details(['300001']))[0]).toMatchObject({ id: '300001', title: 'Workshop 300001', preview: '' })
    await new WorkshopStore(file, fakeFetch().fn).details(['300001'])
    const again = new WorkshopStore(file, fakeFetch({ offline: true }).fn)
    expect((await again.details(['300001'], true))[0].title).toBe('Map 300001')
  })

  it('keeps a thumbnail as a data URL', async () => {
    const file = await tmpFile()
    const store = new WorkshopStore(file, fakeFetch().fn)
    await store.keepThumb('400001')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    expect(saved.maps['400001'].thumb).toBe('data:image/jpeg;base64,/9j/')
    // a later details refresh keeps the thumbnail
    expect((await store.details(['400001'], true))[0].thumb).toBe('data:image/jpeg;base64,/9j/')
  })

  it('writes workshop titles into the in-game maps.json', async () => {
    await tmpFile()
    await writeWorkshopMaps(dir, ['500001', '500002'], { '500001': 'Aim Map' })
    const out = await readFile(join(dir, 'addons/counterstrikesharp/configs/plugins/PracSkins/maps.json'), 'utf8')
    expect(out).toContain('Aim Map')
    expect(out).toContain('Workshop 500002')
  })
})
