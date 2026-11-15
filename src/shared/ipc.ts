export type SetupPhase = 'idle' | 'steamcmd' | 'server' | 'plugins' | 'done' | 'error'

export interface PluginVersions {
  metamod?: string
  counterstrikesharp?: string
}

export interface SetupState {
  installDir: string | null
  steamcmdInstalled: boolean
  serverInstalled: boolean
  pluginsInstalled: boolean
  pluginVersions: PluginVersions
}

export interface SetupProgress {
  phase: SetupPhase
  /** 0-100, or null when indeterminate */
  percent: number | null
  message: string
}

export interface Settings {
  installDir: string | null
  /** Steam Web API key; some workshop maps need it on a dedicated server. */
  authKey?: string
  autoConnect: boolean
}

export type GameMode = 'casual' | 'competitive' | 'wingman' | 'deathmatch'

export type MapChoice = { kind: 'official'; name: string } | { kind: 'workshop'; id: string }

export interface StartOptions {
  map: MapChoice
  mode: GameMode
}

export type ServerStatus =
  | { state: 'stopped' }
  | { state: 'starting' | 'running' | 'stopping'; map: MapChoice }

export interface Api {
  setup: {
    getState(): Promise<SetupState>
    chooseInstallDir(): Promise<SetupState>
    install(): Promise<void>
    onProgress(cb: (p: SetupProgress) => void): () => void
    onLog(cb: (line: string) => void): () => void
  }
  settings: {
    get(): Promise<Settings>
    update(patch: Partial<Omit<Settings, 'installDir'>>): Promise<Settings>
  }
  server: {
    getStatus(): Promise<ServerStatus>
    listMaps(): Promise<string[]>
    start(opts: StartOptions): Promise<void>
    stop(): Promise<void>
    changeMap(map: MapChoice): Promise<void>
    connect(): Promise<void>
    exec(command: string): Promise<string>
    onStatus(cb: (s: ServerStatus) => void): () => void
    onLog(cb: (line: string) => void): () => void
  }
}

export const IPC = {
  setupGetState: 'setup:getState',
  setupChooseDir: 'setup:chooseDir',
  setupInstall: 'setup:install',
  setupProgress: 'setup:progress',
  setupLog: 'setup:log',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  serverGetStatus: 'server:getStatus',
  serverListMaps: 'server:listMaps',
  serverStart: 'server:start',
  serverStop: 'server:stop',
  serverChangeMap: 'server:changeMap',
  serverConnect: 'server:connect',
  serverExec: 'server:exec',
  serverStatus: 'server:status',
  serverLog: 'server:log'
} as const
