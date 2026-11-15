import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type Api, type ServerHealth, type ServerStatus, type SetupProgress, type UpdateStatus } from '@shared/ipc'
import type { LoadoutStore } from '@shared/skins'

function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  const h = (_: unknown, v: T) => cb(v)
  ipcRenderer.on(channel, h)
  return () => {
    ipcRenderer.off(channel, h)
  }
}

const api: Api = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    openLogsFolder: () => ipcRenderer.invoke(IPC.appOpenLogs),
    checkForUpdates: () => ipcRenderer.invoke(IPC.appCheckUpdates),
    getUpdateStatus: () => ipcRenderer.invoke(IPC.appGetUpdateStatus),
    installUpdate: () => ipcRenderer.invoke(IPC.appInstallUpdate),
    onUpdateStatus: (cb) => subscribe<UpdateStatus>(IPC.appUpdateStatus, cb)
  },
  setup: {
    getState: () => ipcRenderer.invoke(IPC.setupGetState),
    chooseInstallDir: () => ipcRenderer.invoke(IPC.setupChooseDir),
    useSuggestedDir: () => ipcRenderer.invoke(IPC.setupSuggestedDir),
    setSource: (source) => ipcRenderer.invoke(IPC.setupSetSource, source),
    install: (mode) => ipcRenderer.invoke(IPC.setupInstall, mode ?? 'pinned'),
    onProgress: (cb) => subscribe<SetupProgress>(IPC.setupProgress, cb),
    onLog: (cb) => subscribe<string>(IPC.setupLog, cb)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch)
  },
  server: {
    getStatus: () => ipcRenderer.invoke(IPC.serverGetStatus),
    listMaps: () => ipcRenderer.invoke(IPC.serverListMaps),
    start: (opts) => ipcRenderer.invoke(IPC.serverStart, opts),
    stop: () => ipcRenderer.invoke(IPC.serverStop),
    changeMap: (map) => ipcRenderer.invoke(IPC.serverChangeMap, map),
    connectInfo: () => ipcRenderer.invoke(IPC.serverConnectInfo),
    getHealth: () => ipcRenderer.invoke(IPC.serverGetHealth),
    onHealth: (cb) => subscribe<ServerHealth>(IPC.serverHealth, cb),
    openCfgFolder: () => ipcRenderer.invoke(IPC.serverOpenCfg),
    exec: (cmd) => ipcRenderer.invoke(IPC.serverExec, cmd),
    onStatus: (cb) => subscribe<ServerStatus>(IPC.serverStatus, cb),
    onLog: (cb) => subscribe<string>(IPC.serverLog, cb)
  },
  skins: {
    getCatalog: (refresh) => ipcRenderer.invoke(IPC.skinsCatalog, refresh ?? false),
    listSteamAccounts: () => ipcRenderer.invoke(IPC.skinsSteamAccounts)
  },
  loadout: {
    get: () => ipcRenderer.invoke(IPC.loadoutGet),
    save: (store) => ipcRenderer.invoke(IPC.loadoutSave, store),
    onChanged: (cb) => subscribe<LoadoutStore>(IPC.loadoutChanged, cb)
  }
}

contextBridge.exposeInMainWorld('api', api)
