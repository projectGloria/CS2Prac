import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import {
  IPC,
  type ServerHealth,
  type ConnectInfo,
  type MapChoice,
  type ServerSource,
  type Settings,
  type SetupProgress,
  type SetupState,
  type StartOptions,
  cleanServerName
} from '@shared/ipc'
import { isInstalled, layout, loadSettings, saveSettings, userCfgDir } from './paths'
import { ensureAdmins, syncServerCfgs } from './setup/serverConfig'
import { ensureMatchZy, matchZyDll, writeMatchZyConfig } from './setup/matchzy'
import { ensureSteamCmd, installOrUpdateServer } from './setup/steamcmd'
import { ensurePlugins, readPluginVersions } from './setup/plugins'
import { installedPluginDir, installPracSkins } from './setup/pracskins'
import { MIRROR_MARKER, sameDrive, syncMirror } from './setup/mirror'
import { installClientHud, installGraffitiTextures, installSkyThumbs } from './setup/clientHud'
import { findCs2Install } from './steam/library'
import { listInstalledMaps } from './server/maps'
import { SERVER_PORT, ServerManager } from './server/serverManager'
import { killStaleServers, parseHealth } from './server/health'
import { cachedCatalog, getCatalog } from './skins/catalog'
import { exportLoadout, importLoadoutFile, loadStore, pluginConfigDir, saveStore } from './skins/loadoutStore'
import { exportPluginCatalog } from './skins/pluginCatalog'
import { SERVER_PREFS_FILE, addRecentWorkshop, readServerPrefs, writeServerPrefs, writeWorkshopMaps } from './server/serverPrefs'
import { SKIES, type ServerPrefs } from '@shared/serverSettings'
import { listSteamAccounts, steamPath } from './steam/accounts'
import { readBots, saveBots, writeServerBots } from './setup/bots'

/** a picture over the engine's 16 KB avatar limit, scaled down to 64×64 (Steam's cache holds 184×184 files) */
const shrinkAvatar = (png: Buffer): Buffer => nativeImage.createFromBuffer(png).resize({ width: 64, height: 64, quality: 'best' }).toPNG()
import type { BotsConfig } from '@shared/bots'
import { KEYS_CFG, cleanKeyBinds, keysCfg, type KeyBinds } from '@shared/keyBinds'
import { LOOK_CFG, cleanLook, lookCfg, type LookConfig, type LookPart } from '@shared/look'
import { readLineups, readRawNades, writeRawNades } from './setup/lineups'
import { addLineups, deleteLineup, GLOBAL_OWNER, parseShareFile, toShareFile, updateLineup, type Lineup } from '@shared/lineups'
import { WorkshopStore } from './server/workshop'
import { ModelStore } from './skins/models'
import type { WorkshopSort } from '@shared/workshop'
import { log, logError, logsDir } from './logger'
import { checkForUpdates, getUpdateStatus, initUpdater, installUpdate } from './updater'
import type { LoadoutStore } from '@shared/skins'

/** Plugin command that re-reads loadout.json (implemented by plugin/PracSkins). */
const RELOAD_SKINS_CMD = 'css_prac_reload'
/** Plugin command that re-reads server_prefs.json and applies it (SettingsHud.cs). */
const APPLY_SETTINGS_CMD = 'css_prac_settings_apply'

/** Workshop maps started from the app are offered in the in-game settings window's Map tab. */
async function rememberWorkshop(map: MapChoice) {
  if (map.kind !== 'workshop') return
  const settings = await loadSettings()
  await saveSettings({ ...settings, recentWorkshop: addRecentWorkshop(settings.recentWorkshop, map.id) })
  await workshop().keepThumb(map.id).catch((e) => logError('workshop', e))
}

/** maps.json (L window Map tab) with the recent workshop maps and their titles */
async function writeRecentWorkshop(csgoDir: string) {
  const ids = (await loadSettings()).recentWorkshop ?? []
  await writeWorkshopMaps(csgoDir, ids, await workshop().titles(ids))
}

let modelStore: ModelStore | null = null
/** weapon models for the 3D editor, cached in userData/models/<cs2 build> */
const models = () =>
  (modelStore ??= new ModelStore(join(app.getPath('userData'), 'models'), async () => {
    const client = await findCs2Install()
    const installDir = (await loadSettings()).installDir
    const serverCsgoDir = installDir ? layout(installDir).csgoDir : null
    if (client) return { csgoDir: join(client.dir, 'game', 'csgo'), buildId: client.buildId, serverCsgoDir }
    if (serverCsgoDir && existsSync(join(serverCsgoDir, 'pak01_dir.vpk'))) return { csgoDir: serverCsgoDir, buildId: 'server', serverCsgoDir }
    throw new Error('CS2 was not found on this PC.')
  }))

let workshopStore: WorkshopStore | null = null
/** workshop map details and thumbnails, cached in userData/workshop-maps.json */
const workshop = () => (workshopStore ??= new WorkshopStore(join(app.getPath('userData'), 'workshop-maps.json')))

let win: BrowserWindow | null = null
const server = new ServerManager()
const send = (channel: string, payload: unknown) => win?.webContents.send(channel, payload)
/** the app's bot list (names, clans, pictures as data URLs); written for the server on every start */
const botsFile = () => join(app.getPath('userData'), 'bots.json')
/** whether the running server was started with +sv_reliableavatardata 1 (pictures need it before the map loads) */
let startedWithAvatars = false

async function requireInstallDir(): Promise<string> {
  const { installDir } = await loadSettings()
  if (!installDir) throw new Error('Choose an install folder first')
  return installDir
}

async function getState(): Promise<SetupState> {
  const { installDir, serverSource } = await loadSettings()
  const client = await findCs2Install()
  const base = {
    installDir,
    serverSource,
    clientDir: client?.dir ?? null,
    sameDrive: !!(installDir && client && sameDrive(installDir, client.dir))
  }
  if (!installDir)
    return { ...base, steamcmdInstalled: false, serverInstalled: false, pluginsInstalled: false, pracSkinsInstalled: false, matchzyInstalled: false, pluginVersions: {} }
  const l = layout(installDir)
  const pluginVersions = await readPluginVersions(l.csgoDir)
  return {
    ...base,
    steamcmdInstalled: isInstalled(l.steamcmdExe),
    serverInstalled: isInstalled(l.cs2Exe),
    pluginsInstalled:
      isInstalled(join(l.csgoDir, 'addons', 'metamod')) && isInstalled(join(l.csgoDir, 'addons', 'counterstrikesharp')),
    pracSkinsInstalled: isInstalled(join(installedPluginDir(l.csgoDir), 'PracSkins.dll')),
    matchzyInstalled: isInstalled(matchZyDll(l.csgoDir)),
    pluginVersions
  }
}

/** Hard-links the player's CS2 install into <installDir>/server. Incremental, so it is cheap to re-run. */
async function mirrorClient(installDir: string, report?: (p: SetupProgress) => void) {
  const client = await findCs2Install()
  if (!client) throw new Error('CS2 is not installed through Steam on this PC. Use "Download the dedicated server" instead.')
  return syncMirror(client.dir, layout(installDir).serverDir, client.buildId, (done, total) =>
    report?.({ phase: 'server', percent: total ? (done / total) * 100 : null, message: `Linking CS2 game files (${done}/${total})` })
  )
}

/** Puts the skin window's Panorama files into the player's CS2 (K in game). Never fails a server start. */
async function installSkinWindow() {
  try {
    const client = await findCs2Install()
    if (!client) return
    const r = await installClientHud(client.dir)
    hudUpdated = r === 'installed'
    if (r === 'installed')
      send(IPC.serverLog, '[cs2prac] skin window installed into CS2 – restart CS2 if it is running, then press K in game')
    else if (r === 'missing') send(IPC.serverLog, '[cs2prac] skin window files missing (npm run build:hud) – K opens the text menu')
    void installSkyImages(client.dir)
  } catch (e) {
    logError('skin window install', e)
    send(IPC.serverLog, `[cs2prac] could not install the skin window: ${e instanceof Error ? e.message : e}`)
  }
}

/** Runs CS2's resourcecompiler (it reports errors on stdout and may exit non-zero after compiling). */
function runCompiler(exe: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(exe, args, { windowsHide: true, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
      err && !stdout ? reject(err) : resolve()
    )
  )
}

/** The L window's sky thumbnails (rendered and compiled once, in the background; ~40 s the first time). */
let skyImagesJob: Promise<void> | null = null
function installSkyImages(cs2Dir: string) {
  skyImagesJob ??= (async () => {
    try {
      const jpgs = await models().skyFiles(SKIES.map((s) => s.value).filter(Boolean))
      const r = await installSkyThumbs(cs2Dir, jpgs, runCompiler)
      if (r === 'installed') {
        hudUpdated = true
        send(IPC.serverLog, '[cs2prac] sky thumbnails installed for the L window – restart CS2 to see them')
      } else if (r === 'nocompiler')
        log('hud', 'sky thumbnails skipped: CS2 Workshop Tools (resourcecompiler.exe) not installed')
    } catch (e) {
      logError('sky thumbnails', e)
    } finally {
      skyImagesJob = null
    }
  })()
  return skyImagesJob
}

/**
 * SteamCMD must never write into a mirror: its files are hard links to the game install, and an
 * in-place update would change the player's game. The mirror holds only links and our addons,
 * so removing it is safe.
 */
async function removeMirror(installDir: string, log: (line: string) => void) {
  const { serverDir } = layout(installDir)
  if (!existsSync(join(serverDir, MIRROR_MARKER))) return
  log('[cs2prac] removing the linked server folder before downloading the dedicated server')
  await rm(serverDir, { recursive: true, force: true })
}

/** Writes catalog.json for the in-game menu (downloads the catalog if there is no cache yet). */
async function exportMenuCatalog(csgoDir: string) {
  try {
    const c = (await cachedCatalog()) ?? (await getCatalog())
    await exportPluginCatalog(csgoDir, c)
  } catch (e) {
    logError('catalog', e)
    send(IPC.serverLog, '[cs2prac] could not prepare the item list for the in-game menu (no skin data yet)')
  }
}

/**
 * The in-game menu (PracSkins) rewrites loadout.json; fold those changes into the active profile so the app stays
 * in sync. Our own exports produce no change, so they don't loop.
 */
let loadoutWatcher: FSWatcher | null = null
function watchLoadout(csgoDir: string) {
  loadoutWatcher?.close()
  const dir = pluginConfigDir(csgoDir)
  if (!existsSync(dir)) return
  let pending: ReturnType<typeof setTimeout> | undefined
  let prefsPending: ReturnType<typeof setTimeout> | undefined
  loadoutWatcher = watch(dir, (_event, name) => {
    if (name === SERVER_PREFS_FILE) {
      // the in-game settings window (L) saved; our own saves just send the same prefs again
      clearTimeout(prefsPending)
      prefsPending = setTimeout(() => {
        readServerPrefs(csgoDir).then(
          (p) => send(IPC.serverPrefsChanged, p),
          (e) => logError('server prefs', e)
        )
      }, 300)
      return
    }
    if (name !== 'loadout.json') return
    clearTimeout(pending)
    pending = setTimeout(async () => {
      try {
        const next = await importLoadoutFile(csgoDir, await loadStore(async () => null))
        if (!next) return
        await saveStore(next)
        log('loadout', 'updated from the in-game menu')
        send(IPC.loadoutChanged, next)
      } catch (e) {
        logError('loadout', e)
      }
    }, 300)
  })
}

let lastProblems: string[] = []
let hudUpdated = false

async function getHealth(): Promise<ServerHealth> {
  const { lastGoodBuildId, serverSource } = await loadSettings()
  const client = serverSource === 'client' ? await findCs2Install() : null
  return {
    problems: lastProblems,
    cs2Updated: !!(lastGoodBuildId && client?.buildId && client.buildId !== lastGoodBuildId),
    hudUpdated
  }
}

/** Asks the running server what loaded, remembers the CS2 build when all is well, and tells the UI. */
async function checkHealth(expectMatchZy: boolean) {
  const ask = (cmd: string) => server.exec(cmd).catch(() => '')
  const [meta, plugins, status] = [await ask('meta list'), await ask('css_plugins list'), await ask('css_prac_status')]
  lastProblems = parseHealth(meta, plugins, status, expectMatchZy)
  for (const p of lastProblems) send(IPC.serverLog, `[cs2prac] problem: ${p}`)
  if (!lastProblems.length) {
    const client = await findCs2Install()
    if (client?.buildId) await saveSettings({ ...(await loadSettings()), lastGoodBuildId: client.buildId })
  }
  send(IPC.serverHealth, await getHealth())
}

/** Every agent model, so the plugin can precache them and agents switch without a map change. */
const agentModels = async () => (await cachedCatalog())?.agents.map((a) => a.model) ?? []

/** IPv4 LAN addresses, for connecting from another PC on the network. */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .map((a) => a!.address)
}

async function connectInfo(): Promise<ConnectInfo> {
  const { rconPassword } = await loadSettings()
  return {
    connect: ['127.0.0.1', ...lanAddresses()].map((ip) => `connect ${ip}:${SERVER_PORT}`),
    rcon: `rcon_address 127.0.0.1:${SERVER_PORT}; rcon_password ${rconPassword}`,
    cfgDir: userCfgDir()
  }
}

function registerIpc() {
  // --- app ---
  ipcMain.handle(IPC.appInfo, () => ({ version: app.getVersion(), packaged: app.isPackaged, logsDir: logsDir() }))
  ipcMain.handle(IPC.appOpenLogs, async () => {
    await mkdir(logsDir(), { recursive: true })
    await shell.openPath(logsDir())
  })
  ipcMain.handle(IPC.appCheckUpdates, () => checkForUpdates())
  ipcMain.handle(IPC.appGetUpdateStatus, getUpdateStatus)
  ipcMain.handle(IPC.appInstallUpdate, () => installUpdate())
  // --- window (frameless, the renderer draws the title bar) ---
  ipcMain.handle(IPC.winMinimize, () => win?.minimize())
  ipcMain.handle(IPC.winToggleMaximize, () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()))
  ipcMain.handle(IPC.winClose, () => win?.close())
  ipcMain.handle(IPC.winIsMaximized, () => win?.isMaximized() ?? false)

  // --- setup ---
  ipcMain.handle(IPC.setupGetState, getState)

  ipcMain.handle(IPC.setupChooseDir, async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose a folder for the CS2 server (~60 GB)',
      properties: ['openDirectory', 'createDirectory']
    })
    if (!r.canceled && r.filePaths[0]) await saveSettings({ ...(await loadSettings()), installDir: r.filePaths[0] })
    return getState()
  })

  ipcMain.handle(IPC.setupSuggestedDir, async () => {
    const client = await findCs2Install()
    if (client) await saveSettings({ ...(await loadSettings()), installDir: join(resolve(client.dir).slice(0, 3), 'CS2Prac') })
    return getState()
  })

  ipcMain.handle(IPC.setupSetSource, async (_e, source: ServerSource) => {
    if (source !== 'client' && source !== 'steamcmd') throw new Error('Unknown server source')
    await saveSettings({ ...(await loadSettings()), serverSource: source })
    return getState()
  })

  let installing = false
  ipcMain.handle(IPC.setupInstall, async (_e, mode: 'pinned' | 'latest' = 'pinned') => {
    if (mode !== 'pinned' && mode !== 'latest') throw new Error('Unknown install mode')
    if (installing) throw new Error('An install is already running')
    if (server.getStatus().state !== 'stopped') throw new Error('Stop the server before updating it')
    const installDir = await requireInstallDir()
    const { serverSource } = await loadSettings()
    installing = true
    const report = (p: SetupProgress) => {
      if (p.phase === 'done' || p.phase === 'error' || p.percent == null) log('setup', p.message)
      send(IPC.setupProgress, p)
    }
    const setupLog = (line: string) => {
      log('setup', line)
      send(IPC.setupLog, line)
    }
    try {
      if (serverSource === 'client') {
        const r = await mirrorClient(installDir, report)
        setupLog(`[cs2prac] game files: ${r.linked} linked, ${r.copied} copied, ${r.unchanged} unchanged, ${r.removed} removed`)
      } else {
        await removeMirror(installDir, setupLog)
        await ensureSteamCmd(installDir, report)
        await installOrUpdateServer(installDir, report, setupLog)
      }
      await ensurePlugins(installDir, report, mode)
      const { csgoDir } = layout(installDir)
      const skins = await installPracSkins(csgoDir)
      await ensureMatchZy(csgoDir, report, mode)
      const v = await readPluginVersions(csgoDir)
      report({
        phase: 'done',
        percent: 100,
        message:
          `Ready: CS2 server, Metamod ${v.metamod}, CounterStrikeSharp ${v.counterstrikesharp}, MatchZy ${v.matchzy}` +
          (skins ? ', PracSkins' : ' (PracSkins plugin not built – skins disabled)')
      })
    } catch (e) {
      report({ phase: 'error', percent: null, message: (e as Error).message })
      throw e
    } finally {
      installing = false
    }
  })

  // --- settings ---
  ipcMain.handle(IPC.settingsGet, loadSettings)
  ipcMain.handle(IPC.settingsUpdate, async (_e, patch: Partial<Settings>) => {
    const { installDir: _dir, serverSource: _source, rconPassword: _pw, ...rest } = patch
    if (rest.matchzyMode !== undefined && !['practice', 'match', 'off'].includes(rest.matchzyMode))
      throw new Error('Unknown MatchZy mode')
    if (rest.serverName !== undefined) rest.serverName = cleanServerName(rest.serverName)
    const next = { ...(await loadSettings()), ...rest }
    await saveSettings(next)
    return next
  })

  // --- server ---
  ipcMain.handle(IPC.serverGetStatus, () => server.getStatus())
  ipcMain.handle(IPC.serverListMaps, async () => {
    const { installDir } = await loadSettings()
    return listInstalledMaps(installDir ? layout(installDir).csgoDir : '')
  })
  ipcMain.handle(IPC.serverStart, async (_e, opts: StartOptions) => {
    const settings = await loadSettings()
    const installDir = await requireInstallDir()
    const { csgoDir } = layout(installDir)
    if (settings.serverSource === 'client') {
      // follows CS2 updates: Steam replaces game files, so the links are refreshed before every start
      const r = await mirrorClient(installDir)
      if (r.linked || r.removed) send(IPC.serverLog, `[cs2prac] game files updated: ${r.linked} linked, ${r.removed} removed`)
    }
    if (!(await installPracSkins(csgoDir))) send(IPC.serverLog, '[cs2prac] PracSkins plugin not found – skins will not be applied')
    await installSkinWindow()
    await installGraffitiTextures(pluginConfigDir(csgoDir)).catch((e) => logError('graffiti textures', e))
    await exportMenuCatalog(csgoDir)
    await exportLoadout(csgoDir, await loadStore(async () => null), await agentModels())
    await rememberWorkshop(opts.map)
    await writeRecentWorkshop(csgoDir)
    watchLoadout(csgoDir)
    // Every Steam account that has logged in on this PC is a root admin on the server.
    const accounts = await listSteamAccounts()
    await ensureAdmins(csgoDir, accounts.map((a) => a.steamId))
    if (accounts.length) send(IPC.serverLog, `[cs2prac] admins: ${accounts.map((a) => a.personaName).join(', ')}`)
    else send(IPC.serverLog, '[cs2prac] no Steam account found in loginusers.vdf – nobody is admin')
    // Installs MatchZy for setups made before it was added (and after a version bump)
    await ensureMatchZy(csgoDir, (p) => p.percent == null && send(IPC.serverLog, `[cs2prac] ${p.message}`))
    const serverName = cleanServerName(settings.serverName)
    await writeMatchZyConfig(csgoDir, settings.matchzyMode, accounts.map((a) => a.steamId), serverName)
    const cfgs = await syncServerCfgs(userCfgDir(), csgoDir, serverName)
    send(IPC.serverLog, `[cs2prac] copied ${cfgs} cfg file(s) from ${userCfgDir()}`)
    const avatars = await writeServerBots(csgoDir, await readBots(botsFile()), await steamPath(), accounts.map((a) => a.steamId), shrinkAvatar)
    startedWithAvatars = avatars
    if (avatars) send(IPC.serverLog, '[cs2prac] bot pictures on (sv_reliableavatardata 1)')
    const stale = await killStaleServers(layout(installDir).cs2Exe)
    if (stale.length) send(IPC.serverLog, `[cs2prac] closed a leftover server process (${stale.join(', ')})`)
    await server.start(installDir, opts, { rconPassword: settings.rconPassword, authKey: settings.authKey || undefined, avatars })
    checkHealth(settings.matchzyMode !== 'off').catch((e) => logError('health', e))
  })
  ipcMain.handle(IPC.serverStop, () => server.stop())
  ipcMain.handle(IPC.serverChangeMap, async (_e, map: MapChoice) => {
    await rememberWorkshop(map)
    const { installDir } = await loadSettings()
    if (installDir) await writeRecentWorkshop(layout(installDir).csgoDir).catch((e) => logError('maps', e))
    return server.changeMap(map)
  })
  ipcMain.handle(IPC.serverPrefsGet, async () => {
    const { installDir } = await loadSettings()
    return installDir ? readServerPrefs(layout(installDir).csgoDir) : { global: {}, maps: {} }
  })
  ipcMain.handle(IPC.serverPrefsSave, async (_e, prefs: ServerPrefs) => {
    const saved = await writeServerPrefs(layout(await requireInstallDir()).csgoDir, prefs)
    if (server.getStatus().state === 'running') await server.exec(APPLY_SETTINGS_CMD).catch((e) => logError('server prefs', e))
    return saved
  })
  ipcMain.handle(IPC.modelsGet, (_e, className: string) => models().get(String(className ?? '')))
  ipcMain.handle(IPC.modelsImage, (_e, url: string) => models().image(String(url ?? '')))
  ipcMain.handle(IPC.modelsPaint, (_e, paintKit: number) => models().paint(Math.floor(Number(paintKit) || 0)))
  ipcMain.handle(IPC.modelsSkies, () => models().skies(SKIES.map((s) => s.value).filter(Boolean)))
  ipcMain.handle(IPC.workshopSearch, (_e, query: string, page: number, sort: WorkshopSort) =>
    workshop().search(String(query ?? ''), Math.max(1, Math.floor(Number(page) || 1)), sort)
  )
  ipcMain.handle(IPC.workshopDetails, (_e, ids: string[], refresh?: boolean) =>
    workshop().details((Array.isArray(ids) ? ids : []).filter((id) => /^\d{5,20}$/.test(id)), !!refresh)
  )
  ipcMain.handle(IPC.workshopRecent, async () => workshop().details((await loadSettings()).recentWorkshop ?? []))
  ipcMain.handle(IPC.workshopForget, async (_e, id: string) => {
    const settings = await loadSettings()
    const recentWorkshop = (settings.recentWorkshop ?? []).filter((x) => x !== id)
    await saveSettings({ ...settings, recentWorkshop })
    if (settings.installDir) await writeRecentWorkshop(layout(settings.installDir).csgoDir).catch((e) => logError('maps', e))
    return workshop().details(recentWorkshop)
  })
  ipcMain.handle(IPC.keysGet, async () => cleanKeyBinds((await loadSettings()).keyBinds))
  ipcMain.handle(IPC.keysSave, async (_e, binds: KeyBinds) => {
    const clean = cleanKeyBinds(binds)
    await saveSettings({ ...(await loadSettings()), keyBinds: clean })
    const client = await findCs2Install()
    if (!client) throw new Error('CS2 not found: the keys are saved and will be written once CS2 is installed')
    const file = join(client.dir, 'game', 'csgo', 'cfg', KEYS_CFG)
    await writeFile(file, keysCfg(clean), 'utf8')
    log('keys', `wrote ${file}`)
    return { binds: clean, file }
  })
  ipcMain.handle(IPC.lookGet, async () => cleanLook((await loadSettings()).look))
  ipcMain.handle(IPC.lookSave, async (_e, look: LookConfig, part?: LookPart) => {
    const clean = cleanLook(look)
    await saveSettings({ ...(await loadSettings()), look: clean })
    const client = await findCs2Install()
    if (!client) throw new Error('CS2 not found: the look is saved, but no cfg could be written')
    const parts = part && part in LOOK_CFG ? [part] : (Object.keys(LOOK_CFG) as LookPart[])
    const files: string[] = []
    for (const p of parts) {
      const file = join(client.dir, 'game', 'csgo', 'cfg', LOOK_CFG[p])
      await writeFile(file, lookCfg(p, clean), 'utf8')
      files.push(file)
    }
    log('look', `wrote ${files.join(', ')}`)
    return { look: clean, files }
  })
  ipcMain.handle(IPC.botsGet, () => readBots(botsFile()))
  ipcMain.handle(IPC.botsSave, async (_e, bots: BotsConfig) => {
    const saved = await saveBots(botsFile(), bots)
    let restartForPictures = false
    if (server.getStatus().state === 'running') {
      const { installDir } = await loadSettings()
      if (installDir) {
        const accounts = await listSteamAccounts()
        const avatars = await writeServerBots(layout(installDir).csgoDir, saved, await steamPath(), accounts.map((a) => a.steamId), shrinkAvatar)
        restartForPictures = avatars && !startedWithAvatars
        await server.exec('css_prac_bots').catch((e) => logError('bots', e))
      }
    }
    return { bots: saved, restartForPictures }
  })
  // --- lineups (MatchZy's savednades.json; MatchZy re-reads it on every command, so edits apply while running) ---
  const nadesDir = async () => layout(await requireInstallDir()).csgoDir
  ipcMain.handle(IPC.lineupsList, async () => {
    const { installDir } = await loadSettings()
    return installDir ? readLineups(layout(installDir).csgoDir) : []
  })
  ipcMain.handle(IPC.lineupsUpdate, async (_e, owner: string, name: string, patch: Partial<Lineup>) => {
    const dir = await nadesDir()
    return writeRawNades(dir, updateLineup(await readRawNades(dir), owner, name, patch))
  })
  ipcMain.handle(IPC.lineupsRemove, async (_e, owner: string, name: string) => {
    const dir = await nadesDir()
    return writeRawNades(dir, deleteLineup(await readRawNades(dir), owner, name))
  })
  ipcMain.handle(IPC.lineupsExport, async (_e, lineups: Lineup[], fileName: string) => {
    const r = await dialog.showSaveDialog(win!, {
      title: 'Export lineups',
      defaultPath: join(app.getPath('documents'), fileName.replace(/[<>:"/\\|?*]/g, '_')),
      filters: [{ name: 'Lineups', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, toShareFile(lineups), 'utf8')
    return r.filePath
  })
  ipcMain.handle(IPC.lineupsImport, async (_e, map: string) => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Import lineups',
      properties: ['openFile'],
      filters: [{ name: 'Lineups', extensions: ['json', 'txt', 'cfg'] }, { name: 'All files', extensions: ['*'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null
    const parsed = parseShareFile(await readFile(r.filePaths[0], 'utf8'), GLOBAL_OWNER, map)
    if (!parsed.ok) return parsed
    const dir = await nadesDir()
    const { raw, added } = addLineups(await readRawNades(dir), parsed.lineups)
    return { ok: true, lineups: await writeRawNades(dir, raw), added: added.length }
  })
  ipcMain.handle(IPC.serverConnectInfo, connectInfo)
  ipcMain.handle(IPC.serverGetHealth, getHealth)
  ipcMain.handle(IPC.serverOpenCfg, async () => {
    await mkdir(userCfgDir(), { recursive: true })
    await shell.openPath(userCfgDir())
  })
  ipcMain.handle(IPC.serverExec, (_e, cmd: string) => server.exec(cmd))

  // --- skins / loadout ---
  ipcMain.handle(IPC.skinsCatalog, async (_e, refresh: boolean) => {
    const c = await getCatalog(refresh)
    const { installDir } = await loadSettings()
    if (installDir) exportPluginCatalog(layout(installDir).csgoDir, c).catch((e) => logError('catalog', e))
    return c
  })
  ipcMain.handle(IPC.skinsSteamAccounts, listSteamAccounts)
  const defaultOwner = async () => (await listSteamAccounts())[0]?.steamId ?? null
  ipcMain.handle(IPC.loadoutGet, () => loadStore(defaultOwner))
  ipcMain.handle(IPC.loadoutSave, async (_e, store: LoadoutStore) => {
    await saveStore(store)
    const { installDir } = await loadSettings()
    const exported = installDir ? await exportLoadout(layout(installDir).csgoDir, store, await agentModels()) : false
    let reloaded = false
    if (exported && server.getStatus().state === 'running') {
      reloaded = await server.exec(RELOAD_SKINS_CMD).then(
        (out) => !/unknown command/i.test(out),
        () => false
      )
    }
    return { exported, reloaded }
  })

  server.on('status', (s) => {
    log('server', `status ${s.state}`)
    send(IPC.serverStatus, s)
  })
  server.on('log', (l) => {
    log('cs2', l)
    send(IPC.serverLog, l)
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e1014',
    frame: false,
    autoHideMenuBar: true,
    // shown once the splash screen has painted with its art (app:splashReady), so there is no empty frame first
    show: false,
    // packaged builds take the icon from the exe; in dev it comes from assets/
    icon: app.isPackaged ? undefined : join(app.getAppPath(), 'assets', 'CS2Prac.ico'),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true }
  })
  const show = () => win && !win.isDestroyed() && !win.isVisible() && win.show()
  ipcMain.once(IPC.appSplashReady, show)
  setTimeout(show, 4000) // never stay invisible if the renderer failed
  win.on('maximize', () => send(IPC.winMaximized, true))
  win.on('unmaximize', () => send(IPC.winMaximized, false))
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

process.on('uncaughtException', (e) => logError('main', e))
process.on('unhandledRejection', (e) => logError('main', e))

app.whenReady().then(async () => {
  log('app', `CS2Prac ${app.getVersion()} starting${app.isPackaged ? '' : ' (dev)'}`)
  registerIpc()
  createWindow()
  // A server left running by a crashed or killed app would block the port.
  const { installDir } = await loadSettings()
  if (installDir)
    killStaleServers(layout(installDir).cs2Exe).then(
      (pids) => pids.length && log('app', `closed leftover server process(es) ${pids.join(', ')}`),
      (e) => logError('app', e)
    )
  initUpdater((s) => send(IPC.appUpdateStatus, s))
})

// Don't leave a headless cs2.exe running after the app closes.
let quitting = false
app.on('before-quit', (e) => {
  if (quitting || server.getStatus().state === 'stopped') return
  e.preventDefault()
  quitting = true
  server.stop().finally(() => app.quit())
})
app.on('window-all-closed', () => app.quit())
