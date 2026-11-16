import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
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
import { installClientHud } from './setup/clientHud'
import { findCs2Install } from './steam/library'
import { listInstalledMaps } from './server/maps'
import { SERVER_PORT, ServerManager } from './server/serverManager'
import { killStaleServers, parseHealth } from './server/health'
import { cachedCatalog, getCatalog } from './skins/catalog'
import { exportLoadout, importLoadoutFile, loadStore, pluginConfigDir, saveStore } from './skins/loadoutStore'
import { exportPluginCatalog } from './skins/pluginCatalog'
import { SERVER_PREFS_FILE, addRecentWorkshop, readServerPrefs, writeServerPrefs, writeWorkshopMaps } from './server/serverPrefs'
import type { ServerPrefs } from '@shared/serverSettings'
import { listSteamAccounts, steamPath } from './steam/accounts'
import { readBots, saveBots, writeServerBots } from './setup/bots'
import type { BotsConfig } from '@shared/bots'
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
}

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
    if (r === 'installed')
      send(IPC.serverLog, '[cs2prac] skin window installed into CS2 – restart CS2 if it is running, then press K in game')
    else if (r === 'missing') send(IPC.serverLog, '[cs2prac] skin window files missing (npm run build:hud) – K opens the text menu')
  } catch (e) {
    logError('skin window install', e)
    send(IPC.serverLog, `[cs2prac] could not install the skin window: ${e instanceof Error ? e.message : e}`)
  }
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
        readServerPrefs(csgoDir).then((p) => send(IPC.serverPrefsChanged, p), (e) => logError('server prefs', e))
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

async function getHealth(): Promise<ServerHealth> {
  const { lastGoodBuildId, serverSource } = await loadSettings()
  const client = serverSource === 'client' ? await findCs2Install() : null
  return { problems: lastProblems, cs2Updated: !!(lastGoodBuildId && client?.buildId && client.buildId !== lastGoodBuildId) }
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
    await exportMenuCatalog(csgoDir)
    await exportLoadout(csgoDir, await loadStore(async () => null), await agentModels())
    await rememberWorkshop(opts.map)
    await writeWorkshopMaps(csgoDir, (await loadSettings()).recentWorkshop ?? [])
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
    const avatars = await writeServerBots(csgoDir, await readBots(botsFile()), await steamPath(), accounts.map((a) => a.steamId))
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
    const { installDir, recentWorkshop } = await loadSettings()
    if (installDir) await writeWorkshopMaps(layout(installDir).csgoDir, recentWorkshop ?? []).catch((e) => logError('maps', e))
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
  ipcMain.handle(IPC.botsGet, () => readBots(botsFile()))
  ipcMain.handle(IPC.botsSave, async (_e, bots: BotsConfig) => {
    const saved = await saveBots(botsFile(), bots)
    let restartForPictures = false
    if (server.getStatus().state === 'running') {
      const { installDir } = await loadSettings()
      if (installDir) {
        const accounts = await listSteamAccounts()
        const avatars = await writeServerBots(layout(installDir).csgoDir, saved, await steamPath(), accounts.map((a) => a.steamId))
        restartForPictures = avatars && !startedWithAvatars
        await server.exec('css_prac_bots').catch((e) => logError('bots', e))
      }
    }
    return { bots: saved, restartForPictures }
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
