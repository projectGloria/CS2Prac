export type SetupPhase = 'idle' | 'steamcmd' | 'server' | 'done' | 'error'

export interface SetupState {
  installDir: string | null
  steamcmdInstalled: boolean
  serverInstalled: boolean
}

export interface SetupProgress {
  phase: SetupPhase
  /** 0-100, or null when indeterminate */
  percent: number | null
  message: string
}

export interface Api {
  setup: {
    getState(): Promise<SetupState>
    chooseInstallDir(): Promise<SetupState>
    install(): Promise<void>
    onProgress(cb: (p: SetupProgress) => void): () => void
    onLog(cb: (line: string) => void): () => void
  }
}

export const IPC = {
  setupGetState: 'setup:getState',
  setupChooseDir: 'setup:chooseDir',
  setupInstall: 'setup:install',
  setupProgress: 'setup:progress',
  setupLog: 'setup:log'
} as const
