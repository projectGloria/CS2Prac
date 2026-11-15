import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { IPC, type MapChoice, type Settings, type SetupProgress, type SetupState, type StartOptions } from '@shared/ipc'
import { isInstalled, layout, loadSettings, saveSettings } from './paths'
import { ensureSteamCmd, installOrUpdateServer } from './setup/steamcmd'
import { ensurePlugins, readPluginVersions } from './setup/plugins'
import { listInstalledMaps } from './server/maps'
import { SERVER_PORT, ServerManager } from './server/serverManager'

let win: BrowserWindow | null = null
const server = new ServerManager()
const send = (channel: string, payload: unknown) => win?.webContents.send(channel, payload)

async function requireInstallDir(): Promise<string> {
  const { installDir } = await loadSettings()
  if (!installDir) throw new Error('Choose an install folder first')
  return installDir
}

async function getState(): Promise<SetupState> {
  const { installDir } = await loadSettings()
  if (!installDir)
    return { installDir, steamcmdInstalled: false, serverInstalled: false, pluginsInstalled: false, pluginVersions: {} }
  const l = layout(installDir)
  const pluginVersions = await readPluginVersions(l.csgoDir)
  return {
    installDir,
    steamcmdInstalled: isInstalled(l.steamcmdExe),
    serverInstalled: isInstalled(l.cs2Exe),
    pluginsInstalled:
      isInstalled(join(l.csgoDir, 'addons', 'metamod')) && isInstalled(join(l.csgoDir, 'addons', 'counterstrikesharp')),
    pluginVersions
  }
}

const connectToServer = () => shell.openExternal(`steam://connect/127.0.0.1:${SERVER_PORT}`)

function registerIpc() {
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

  let installing = false
  ipcMain.handle(IPC.setupInstall, async () => {
    if (installing) throw new Error('An install is already running')
    if (server.getStatus().state !== 'stopped') throw new Error('Stop the server before updating it')
    const installDir = await requireInstallDir()
    installing = true
    const report = (p: SetupProgress) => send(IPC.setupProgress, p)
    try {
      await ensureSteamCmd(installDir, report)
      await installOrUpdateServer(installDir, report, (line) => send(IPC.setupLog, line))
      const v = await ensurePlugins(installDir, report)
      report({
        phase: 'done',
        percent: 100,
        message: `Ready: CS2 server, Metamod ${v.metamod}, CounterStrikeSharp ${v.counterstrikesharp}`
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
    const { installDir: _ignored, ...rest } = patch
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
    await server.start(await requireInstallDir(), opts, settings.authKey || undefined)
    if (settings.autoConnect) await connectToServer()
  })
  ipcMain.handle(IPC.serverStop, () => server.stop())
  ipcMain.handle(IPC.serverChangeMap, (_e, map: MapChoice) => server.changeMap(map))
  ipcMain.handle(IPC.serverConnect, connectToServer)
  ipcMain.handle(IPC.serverExec, (_e, cmd: string) => server.exec(cmd))

  server.on('status', (s) => send(IPC.serverStatus, s))
  server.on('log', (l) => send(IPC.serverLog, l))
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
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
