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
  type StartOptions
} from '@shared/ipc'
import { isInstalled, layout, loadSettings, saveSettings, userCfgDir } from './paths'
import { ensureAdmins, syncServerCfgs } from './setup/serverConfig'
import { BRIDGE_DIR, writeCfgBridge } from './setup/cfgBridge'
import { ensureMatchZy, matchZyDll, writeMatchZyConfig } from './setup/matchzy'
import { ensureSteamCmd, installOrUpdateServer } from './setup/steamcmd'
import { ensurePlugins, readPluginVersions } from './setup/plugins'
import { installedPluginDir, installPracSkins } from './setup/pracskins'
import { MIRROR_MARKER, sameDrive, syncMirror } from './setup/mirror'
import { findCs2Install } from './steam/library'
import { listInstalledMaps } from './server/maps'
import { SERVER_PORT, ServerManager } from './server/serverManager'
import { killStaleServers, parseHealth } from './server/health'
import { cachedCatalog, getCatalog } from './skins/catalog'
import { exportLoadout, importLoadoutFile, loadStore, pluginConfigDir, saveStore } from './skins/loadoutStore'
import { exportPluginCatalog } from './skins/pluginCatalog'
import { listSteamAccounts } from './steam/accounts'
import { log, logError, logsDir } from './logger'
import { checkForUpdates, getUpdateStatus, initUpdater, installUpdate } from './updater'
import type { LoadoutStore } from '@shared/skins'

/** Plugin command that re-reads loadout.json (implemented by plugin/PracSkins). */
const RELOAD_SKINS_CMD = 'css_prac_reload'

let win: BrowserWindow | null = null
const server = new ServerManager()
const send = (channel: string, payload: unknown) => win?.webContents.send(channel, payload)

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
  loadoutWatcher = watch(dir, (_event, name) => {
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

/** Bridged copies of the user's client cfgs (see setup/cfgBridge.ts), as `exec cs2prac/<name>` lines. */
let bridgedCfgs: string[] = []
async function bridgeClientCfgs(csgoDir: string) {
  try {
    const client = await findCs2Install()
    if (!client) return
    const { cfgs } = await writeCfgBridge(join(client.dir, 'game', 'csgo', 'cfg'), pluginConfigDir(csgoDir))
    const used = cfgs.filter((c) => c.steps > 0)
    bridgedCfgs = used.map((c) => `exec ${BRIDGE_DIR}/${c.name}`)
    for (const c of used)
      send(IPC.serverLog, `[cs2prac] your ${c.name}.cfg on this server: exec ${BRIDGE_DIR}/${c.name} (${c.steps} server step(s))`)
  } catch (e) {
    logError('cfg bridge', e)
  }
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
    cfgDir: userCfgDir(),
    bridgedCfgs
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
    await exportMenuCatalog(csgoDir)
    await exportLoadout(csgoDir, await loadStore(async () => null), await agentModels())
    watchLoadout(csgoDir)
    // Every Steam account that has logged in on this PC is a root admin on the server.
    const accounts = await listSteamAccounts()
    await ensureAdmins(csgoDir, accounts.map((a) => a.steamId))
    if (accounts.length) send(IPC.serverLog, `[cs2prac] admins: ${accounts.map((a) => a.personaName).join(', ')}`)
    else send(IPC.serverLog, '[cs2prac] no Steam account found in loginusers.vdf – nobody is admin')
    // Installs MatchZy for setups made before it was added (and after a version bump)
    await ensureMatchZy(csgoDir, (p) => p.percent == null && send(IPC.serverLog, `[cs2prac] ${p.message}`))
    await writeMatchZyConfig(csgoDir, settings.matchzyMode, accounts.map((a) => a.steamId))
    const cfgs = await syncServerCfgs(userCfgDir(), csgoDir)
    send(IPC.serverLog, `[cs2prac] copied ${cfgs} cfg file(s) from ${userCfgDir()}`)
    await bridgeClientCfgs(csgoDir)
    const stale = await killStaleServers(layout(installDir).cs2Exe)
    if (stale.length) send(IPC.serverLog, `[cs2prac] closed a leftover server process (${stale.join(', ')})`)
    await server.start(installDir, opts, { rconPassword: settings.rconPassword, authKey: settings.authKey || undefined })
    checkHealth(settings.matchzyMode !== 'off').catch((e) => logError('health', e))
  })
  ipcMain.handle(IPC.serverStop, () => server.stop())
  ipcMain.handle(IPC.serverChangeMap, (_e, map: MapChoice) => server.changeMap(map))
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
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    // packaged builds take the icon from the exe; in dev it comes from build/
    icon: app.isPackaged ? undefined : join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true }
  })
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
