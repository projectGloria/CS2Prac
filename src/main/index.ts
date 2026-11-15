import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { IPC, type SetupProgress, type SetupState } from '@shared/ipc'
import { isInstalled, layout, loadSettings, saveSettings } from './paths'
import { ensureSteamCmd, installOrUpdateServer } from './setup/steamcmd'

let win: BrowserWindow | null = null

async function getState(): Promise<SetupState> {
  const { installDir } = await loadSettings()
  if (!installDir) return { installDir, steamcmdInstalled: false, serverInstalled: false }
  const l = layout(installDir)
  return { installDir, steamcmdInstalled: isInstalled(l.steamcmdExe), serverInstalled: isInstalled(l.cs2Exe) }
}

function registerIpc() {
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
    const { installDir } = await loadSettings()
    if (!installDir) throw new Error('Choose an install folder first')
    installing = true
    const report = (p: SetupProgress) => win?.webContents.send(IPC.setupProgress, p)
    const log = (line: string) => win?.webContents.send(IPC.setupLog, line)
    try {
      await ensureSteamCmd(installDir, report)
      await installOrUpdateServer(installDir, report, log)
      report({ phase: 'done', percent: 100, message: 'CS2 server installed.' })
    } catch (e) {
      report({ phase: 'error', percent: null, message: (e as Error).message })
      throw e
    } finally {
      installing = false
    }
  })
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
app.on('window-all-closed', () => app.quit())
