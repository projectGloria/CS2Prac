// Weapon models for the Loadout page's 3D editor (Phase 14). resources/modeltool (ModelExport.dll) reads the local
// CS2 install's pak01_dir.vpk and writes <name>.glb / .jpg / .json into userData/models/<buildid>/; nothing of
// Valve's ships with the app. It runs on the .NET runtime CounterStrikeSharp installs into the server folder.
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { modelPathFor, type ModelMarkup, type ModelResult } from '@shared/models'
import { log } from '../logger'

export interface ModelEnv {
  /** game/csgo of an install that has pak01_dir.vpk */
  csgoDir: string
  buildId: string | null
  /** the server's csgo dir (for CSS's dotnet.exe) */
  serverCsgoDir: string | null
}

export function modelToolDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'modeltool') : join(app.getAppPath(), 'resources', 'modeltool')
}

function dotnetExe(env: ModelEnv): string | null {
  if (env.serverCsgoDir) {
    const p = join(env.serverCsgoDir, 'addons', 'counterstrikesharp', 'dotnet', 'dotnet.exe')
    if (existsSync(p)) return p
  }
  return null
}

function run(exe: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 180_000 }, (err, stdout, stderr) => {
      // export exits 2 when a model failed; its stdout lines still say which
      if (err && !stdout) reject(new Error(String(stderr || err.message).trim().slice(0, 500)))
      else resolve(stdout)
    })
  })
}

const MAX_IMAGES = 200

export class ModelStore {
  private list: Promise<string[]> | null = null
  private exports = new Map<string, Promise<void>>()
  private queue: Promise<unknown> = Promise.resolve()
  private images = new Map<string, string>()

  constructor(
    private readonly root: string,
    private readonly env: () => Promise<ModelEnv>
  ) {}

  private async dir(env: ModelEnv) {
    const d = join(this.root, env.buildId ?? 'unknown')
    await mkdir(d, { recursive: true })
    return d
  }

  private async tool(env: ModelEnv): Promise<{ exe: string; dll: string }> {
    const dll = join(modelToolDir(), 'ModelExport.dll')
    if (!existsSync(dll)) throw new Error('The model tool is missing (npm run build:modeltool).')
    const exe = dotnetExe(env)
    if (!exe) throw new Error('3D view needs the server plugins: run Setup first (it brings the .NET runtime).')
    return { exe, dll }
  }

  /** drops caches of older CS2 builds */
  private async prune(keep: string) {
    for (const d of await readdir(this.root).catch(() => [] as string[]))
      if (d !== keep) await rm(join(this.root, d), { recursive: true, force: true }).catch(() => {})
  }

  private async modelList(env: ModelEnv): Promise<string[]> {
    const dir = await this.dir(env)
    const file = join(dir, 'list.json')
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch {
      /* not cached yet */
    }
    const { exe, dll } = await this.tool(env)
    const out = await run(exe, [dll, 'list', env.csgoDir])
    const start = out.indexOf('[')
    const list = JSON.parse(out.slice(start)) as string[]
    await writeFile(file, JSON.stringify(list))
    await this.prune(env.buildId ?? 'unknown')
    return list
  }

  async get(className: string): Promise<ModelResult> {
    try {
      const env = await this.env()
      this.list ??= this.modelList(env).catch((e) => {
        this.list = null
        throw e
      })
      const model = modelPathFor(className, await this.list)
      if (!model) return { ok: false, error: 'No 3D model for this item.' }
      const dir = await this.dir(env)
      const name = model.split('/').pop()!.replace(/\.vmdl_c$/, '')
      const json = join(dir, name + '.json')
      if (!existsSync(json)) {
        let job = this.exports.get(model)
        if (!job) {
          // one export at a time: each loads the VPK
          job = this.queue.then(() => this.export(env, dir, model))
          this.queue = job.catch(() => {})
          this.exports.set(model, job)
          job.catch(() => {}).finally(() => this.exports.delete(model))
        }
        await job
      }
      const markup = JSON.parse(await readFile(json, 'utf8')) as ModelMarkup
      const glb = new Uint8Array(await readFile(join(dir, markup.glb)))
      const texture = markup.texture
        ? 'data:image/jpeg;base64,' + (await readFile(join(dir, markup.texture))).toString('base64')
        : null
      return { ok: true, model: { markup, glb, texture } }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  private async export(env: ModelEnv, dir: string, model: string) {
    const { exe, dll } = await this.tool(env)
    const t0 = Date.now()
    const out = await run(exe, [dll, 'export', env.csgoDir, dir, model])
    const line = out
      .split(/\r?\n/)
      .filter((l) => l.startsWith('{"model"'))
      .map((l) => JSON.parse(l) as { model: string; ok: boolean; error?: string })
      .find((l) => l.model === model)
    if (!line?.ok) throw new Error('Model export failed: ' + (line?.error ?? 'no result'))
    log('models', `exported ${model} in ${Date.now() - t0} ms`)
  }

  /** A sticker/charm image as a data URL (the renderer's CSP only allows https images in <img>, WebGL needs CORS). */
  async image(url: string): Promise<string | null> {
    if (!/^https:\/\/[^/]*steamstatic\.com\//.test(url) && !/^https:\/\/raw\.githubusercontent\.com\//.test(url)) return null
    const hit = this.images.get(url)
    if (hit) return hit
    try {
      const res = await fetch(url)
      if (!res.ok) return null
      const type = res.headers.get('content-type')?.split(';')[0] || 'image/png'
      const data = `data:${type};base64,` + Buffer.from(await res.arrayBuffer()).toString('base64')
      if (this.images.size >= MAX_IMAGES) this.images.delete(this.images.keys().next().value!)
      this.images.set(url, data)
      return data
    } catch {
      return null
    }
  }
}
