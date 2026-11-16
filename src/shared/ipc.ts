import type { Catalog, LoadoutStore, SteamAccount } from './skins'
import type { ServerPrefs } from './serverSettings'

export type SetupPhase = 'idle' | 'steamcmd' | 'server' | 'plugins' | 'done' | 'error'

export interface PluginVersions {
  metamod?: string
  counterstrikesharp?: string
  matchzy?: string
}

/** What MatchZy loads on map start: practice mode, match mode, or neither ("plain" server). */
export type MatchZyMode = 'practice' | 'match' | 'off'

/** Where the server's game files come from. */
export type ServerSource = 'client' | 'steamcmd'

export interface SetupState {
  installDir: string | null
  serverSource: ServerSource
  /** the player's CS2 game install, if found */
  clientDir: string | null
  /** installDir is on the same drive as clientDir (required for 'client') */
  sameDrive: boolean
  steamcmdInstalled: boolean
  serverInstalled: boolean
  pluginsInstalled: boolean
  /** our skin plugin, copied into the server */
  pracSkinsInstalled: boolean
  matchzyInstalled: boolean
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
  /** 'client': hard-link the player's CS2 install (no extra space); 'steamcmd': download the dedicated server */
  serverSource: ServerSource
  /** CS2 build id at the last start where every plugin loaded */
  lastGoodBuildId?: string
  /** Steam Web API key; some workshop maps need it on a dedicated server. */
  authKey?: string
  /** fixed RCON password, so `rcon` from the game console keeps working across restarts */
  rconPassword: string
  matchzyMode: MatchZyMode
  /** Shown as the server name and as the chat prefix of MatchZy and PracSkins messages, e.g. [Nihil Prac Server]. */
  serverName: string
  /** workshop map ids started recently, newest first (offered in the in-game settings window's Map tab) */
  recentWorkshop?: string[]
}

export const DEFAULT_SERVER_NAME = 'Nihil Prac Server'

/** A server name that is safe inside a quoted cfg value: no quotes, semicolons, color braces or line breaks. */
export function cleanServerName(name: unknown): string {
  const s = typeof name === 'string' ? name.replace(/["';{}\[\]\\\r\n\t]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32) : ''
  return s || DEFAULT_SERVER_NAME
}

/** Lines to paste into the CS2 console. */
export interface ConnectInfo {
  /** `connect 127.0.0.1:27015`, then one per LAN address */
  connect: string[]
  /** `rcon_address …; rcon_password …` */
  rcon: string
  /** the app's cfg folder that is copied to the server before each start */
  cfgDir: string
}

export type GameMode = 'casual' | 'competitive' | 'wingman' | 'deathmatch'

export type MapChoice = { kind: 'official'; name: string } | { kind: 'workshop'; id: string }

export interface StartOptions {
  map: MapChoice
  mode: GameMode
}

export type ServerStatus =
  /** crashed: the process ended without being asked to (exit code, if any) */
  | { state: 'stopped'; crashed?: { code: number | null } }
  | { state: 'starting' | 'running' | 'stopping'; map: MapChoice }

export interface ServerHealth {
  /** problems found after the last start (plugins not loaded, missing signature) */
  problems: string[]
  /** CS2 has a different build than at the last start where everything loaded */
  cs2Updated: boolean
}

export type UpdateStatus =
  | { state: 'idle' | 'disabled' | 'checking' | 'latest' }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

export interface AppInfo {
  version: string
  packaged: boolean
  logsDir: string
}

export interface Api {
  app: {
    /** the splash has painted with its art: main shows the (hidden) window */
    splashReady(): void
    info(): Promise<AppInfo>
    openLogsFolder(): Promise<void>
    checkForUpdates(): Promise<void>
    getUpdateStatus(): Promise<UpdateStatus>
    /** quits, stops the server and runs the downloaded installer */
    installUpdate(): Promise<void>
    onUpdateStatus(cb: (s: UpdateStatus) => void): () => void
  }
  /** frameless window: our own title bar drives these */
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    onMaximized(cb: (maximized: boolean) => void): () => void
  }
  setup: {
    getState(): Promise<SetupState>
    chooseInstallDir(): Promise<SetupState>
    /** <drive of the CS2 install>\CS2Prac */
    useSuggestedDir(): Promise<SetupState>
    setSource(source: ServerSource): Promise<SetupState>
    /** 'latest' updates Metamod, CounterStrikeSharp and MatchZy to their newest releases */
    install(mode?: 'pinned' | 'latest'): Promise<void>
    onProgress(cb: (p: SetupProgress) => void): () => void
    onLog(cb: (line: string) => void): () => void
  }
  settings: {
    get(): Promise<Settings>
    update(patch: Partial<Omit<Settings, 'installDir' | 'serverSource' | 'rconPassword'>>): Promise<Settings>
  }
  server: {
    getStatus(): Promise<ServerStatus>
    listMaps(): Promise<string[]>
    start(opts: StartOptions): Promise<void>
    stop(): Promise<void>
    changeMap(map: MapChoice): Promise<void>
    connectInfo(): Promise<ConnectInfo>
    getHealth(): Promise<ServerHealth>
    onHealth(cb: (h: ServerHealth) => void): () => void
    openCfgFolder(): Promise<void>
    exec(command: string): Promise<string>
    onStatus(cb: (s: ServerStatus) => void): () => void
    onLog(cb: (line: string) => void): () => void
    /** server_prefs.json (in-game L window settings) */
    getPrefs(): Promise<ServerPrefs>
    /** saves server_prefs.json and applies it on the running server */
    savePrefs(prefs: ServerPrefs): Promise<ServerPrefs>
    /** the in-game settings window changed server_prefs.json */
    onPrefsChanged(cb: (prefs: ServerPrefs) => void): () => void
  }
  skins: {
    getCatalog(refresh?: boolean): Promise<Catalog>
    listSteamAccounts(): Promise<SteamAccount[]>
  }
  loadout: {
    get(): Promise<LoadoutStore>
    /** Saves the store and writes loadout.json for the active profile. */
    save(store: LoadoutStore): Promise<LoadoutSaveResult>
    /** the in-game menu changed the loadout; the store has been updated */
    onChanged(cb: (store: LoadoutStore) => void): () => void
  }
}

export interface LoadoutSaveResult {
  /** loadout.json written to the server's plugin config folder */
  exported: boolean
  /** the running server was told to reload skins */
  reloaded: boolean
}

export const IPC = {
  appInfo: 'app:info',
  appSplashReady: 'app:splashReady',
  appOpenLogs: 'app:openLogs',
  appCheckUpdates: 'app:checkUpdates',
  appUpdateStatus: 'app:updateStatus',
  appGetUpdateStatus: 'app:getUpdateStatus',
  appInstallUpdate: 'app:installUpdate',
  winMinimize: 'win:minimize',
  winToggleMaximize: 'win:toggleMaximize',
  winClose: 'win:close',
  winIsMaximized: 'win:isMaximized',
  winMaximized: 'win:maximized',
  setupGetState: 'setup:getState',
  setupChooseDir: 'setup:chooseDir',
  setupSuggestedDir: 'setup:suggestedDir',
  setupSetSource: 'setup:setSource',
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
  serverConnectInfo: 'server:connectInfo',
  serverGetHealth: 'server:getHealth',
  serverHealth: 'server:health',
  serverOpenCfg: 'server:openCfg',
  serverExec: 'server:exec',
  serverStatus: 'server:status',
  serverLog: 'server:log',
  serverPrefsGet: 'server:prefsGet',
  serverPrefsSave: 'server:prefsSave',
  serverPrefsChanged: 'server:prefsChanged',
  skinsCatalog: 'skins:catalog',
  skinsSteamAccounts: 'skins:steamAccounts',
  loadoutGet: 'loadout:get',
  loadoutSave: 'loadout:save',
  loadoutChanged: 'loadout:changed'
} as const
