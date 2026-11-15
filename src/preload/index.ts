import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type Api, type ServerStatus, type SetupProgress } from '@shared/ipc'

function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  const h = (_: unknown, v: T) => cb(v)
  ipcRenderer.on(channel, h)
  return () => {
    ipcRenderer.off(channel, h)
  }
}

const api: Api = {
  setup: {
    getState: () => ipcRenderer.invoke(IPC.setupGetState),
    chooseInstallDir: () => ipcRenderer.invoke(IPC.setupChooseDir),
    install: () => ipcRenderer.invoke(IPC.setupInstall),
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
    connect: () => ipcRenderer.invoke(IPC.serverConnect),
    exec: (cmd) => ipcRenderer.invoke(IPC.serverExec, cmd),
    onStatus: (cb) => subscribe<ServerStatus>(IPC.serverStatus, cb),
    onLog: (cb) => subscribe<string>(IPC.serverLog, cb)
  }
}

contextBridge.exposeInMainWorld('api', api)
