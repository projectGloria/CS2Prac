import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type Api, type SetupProgress } from '@shared/ipc'

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
  }
}

contextBridge.exposeInMainWorld('api', api)
