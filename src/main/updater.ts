import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/ipc'
import { log } from './logger'

const { autoUpdater } = electronUpdater

let status: UpdateStatus = { state: 'idle' }
let notify: (s: UpdateStatus) => void = () => {}

function set(s: UpdateStatus) {
  status = s
  notify(s)
}

export const getUpdateStatus = () => status

/**
 * Checks GitHub Releases for a newer installer (packaged builds only) and downloads it in the background.
 * The renderer offers "Restart to update" once it is downloaded; otherwise it installs on the next quit.
 */
export function initUpdater(onStatus: (s: UpdateStatus) => void) {
  notify = onStatus
  if (!app.isPackaged) {
    set({ state: 'disabled' })
    return
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }))
  autoUpdater.on('update-not-available', () => set({ state: 'latest' }))
  autoUpdater.on('update-available', (i) => {
    log('updater', `update ${i.version} available`)
    set({ state: 'downloading', version: i.version, percent: 0 })
  })
  autoUpdater.on('download-progress', (p) => {
    if (status.state === 'downloading') set({ ...status, percent: p.percent })
  })
  autoUpdater.on('update-downloaded', (i) => {
    log('updater', `update ${i.version} downloaded`)
    set({ state: 'ready', version: i.version })
  })
  autoUpdater.on('error', (e) => {
    log('updater', `check failed: ${e.message.split(/\r?\n/)[0]}`)
    set({ state: 'error', message: e.message })
  })
  checkForUpdates()
}

export function checkForUpdates() {
  if (!app.isPackaged) return
  autoUpdater.checkForUpdates().catch(() => {
    /* reported through the 'error' event */
  })
}

/** Quits (stopping the server through before-quit) and runs the downloaded installer. */
export function installUpdate() {
  if (status.state === 'ready') autoUpdater.quitAndInstall()
}
