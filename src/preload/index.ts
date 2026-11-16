import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type Api, type ServerHealth, type ServerStatus, type SetupProgress, type UpdateStatus } from '@shared/ipc'
import type { LoadoutStore } from '@shared/skins'
import type { ServerPrefs } from '@shared/serverSettings'

function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  const h = (_: unknown, v: T) => cb(v)
  ipcRenderer.on(channel, h)
  return () => {
    ipcRenderer.off(channel, h)
  }
}

const api: Api = {
  app: {
    splashReady: () => ipcRenderer.send(IPC.appSplashReady),
    info: () => ipcRenderer.invoke(IPC.appInfo),
    openLogsFolder: () => ipcRenderer.invoke(IPC.appOpenLogs),
    checkForUpdates: () => ipcRenderer.invoke(IPC.appCheckUpdates),
    getUpdateStatus: () => ipcRenderer.invoke(IPC.appGetUpdateStatus),
    installUpdate: () => ipcRenderer.invoke(IPC.appInstallUpdate),
    onUpdateStatus: (cb) => subscribe<UpdateStatus>(IPC.appUpdateStatus, cb)
  },
  window: {
    minimize: () => ipcRenderer.invoke(IPC.winMinimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.winToggleMaximize),
    close: () => ipcRenderer.invoke(IPC.winClose),
    isMaximized: () => ipcRenderer.invoke(IPC.winIsMaximized),
    onMaximized: (cb) => subscribe<boolean>(IPC.winMaximized, cb)
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
    onLog: (cb) => subscribe<string>(IPC.serverLog, cb),
    getPrefs: () => ipcRenderer.invoke(IPC.serverPrefsGet),
    savePrefs: (prefs) => ipcRenderer.invoke(IPC.serverPrefsSave, prefs),
    onPrefsChanged: (cb) => subscribe<ServerPrefs>(IPC.serverPrefsChanged, cb)
  },
  bots: {
    get: () => ipcRenderer.invoke(IPC.botsGet),
    save: (bots) => ipcRenderer.invoke(IPC.botsSave, bots)
  },
  lineups: {
    list: () => ipcRenderer.invoke(IPC.lineupsList),
    update: (owner, name, patch) => ipcRenderer.invoke(IPC.lineupsUpdate, owner, name, patch),
    remove: (owner, name) => ipcRenderer.invoke(IPC.lineupsRemove, owner, name),
    exportFile: (lineups, fileName) => ipcRenderer.invoke(IPC.lineupsExport, lineups, fileName),
    importFile: (map) => ipcRenderer.invoke(IPC.lineupsImport, map)
  },
  workshop: {
    search: (query, page, sort) => ipcRenderer.invoke(IPC.workshopSearch, query, page, sort),
    details: (ids, refresh) => ipcRenderer.invoke(IPC.workshopDetails, ids, refresh ?? false),
    recent: () => ipcRenderer.invoke(IPC.workshopRecent),
    forget: (id) => ipcRenderer.invoke(IPC.workshopForget, id)
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
