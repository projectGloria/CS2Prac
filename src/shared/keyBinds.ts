/**
 * Keys for CS2Prac actions, picked in the app (Play page > Keys). The server only sees game buttons (E, R …), not
 * keys, so a key is a client bind: the app writes `cs2prac_keys.cfg` into the client's cfg folder (a file of its own,
 * not a copy of the user's cfg), and NihilPrac.cfg ends with `exec cs2prac_keys`. Running `exec cs2prac_keys` in the
 * console works too.
 */

export interface KeyAction {
  id: string
  name: string
  sub: string
  /** what the key runs */
  command: string
}

export const KEY_ACTIONS: KeyAction[] = [
  { id: 'backspawn', name: 'Back to spawn', sub: 'Last spawn marker / .spawn you went to, else where you spawned (.bs)', command: 'css_backspawn' },
  { id: 'side', name: 'Switch side', sub: 'T ↔ CT at once, where you stand (.side)', command: 'css_side' },
  { id: 'placeA', name: 'A site', sub: 'Teleport to A (.a)', command: 'css_place a' },
  { id: 'placeB', name: 'B site', sub: 'Teleport to B (.b)', command: 'css_place b' },
  { id: 'placeMid', name: 'Mid', sub: 'Teleport to mid (.mid)', command: 'css_place mid' },
  { id: 'spray', name: 'Spray', sub: 'Spray the picked (or a random) graffiti', command: 'css_spray' },
  { id: 'craft', name: 'Random craft', sub: 'Roll a random craft for the gun in your hand (!craft, !craft undo)', command: 'css_craft' }
]

/** action id → CS2 key name ('' or missing = not bound) */
export type KeyBinds = Record<string, string>

export const KEYS_CFG = 'cs2prac_keys.cfg'

const CODE_KEYS: Record<string, string> = {
  Space: 'space', Enter: 'enter', Escape: 'escape', Backspace: 'backspace', Tab: 'tab', CapsLock: 'capslock',
  ShiftLeft: 'shift', ShiftRight: 'rshift', ControlLeft: 'ctrl', ControlRight: 'rctrl', AltLeft: 'alt', AltRight: 'ralt',
  ArrowUp: 'uparrow', ArrowDown: 'downarrow', ArrowLeft: 'leftarrow', ArrowRight: 'rightarrow',
  Insert: 'ins', Delete: 'del', Home: 'home', End: 'end', PageUp: 'pgup', PageDown: 'pgdn',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: 'semicolon',
  Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  NumpadAdd: 'kp_plus', NumpadSubtract: 'kp_minus', NumpadMultiply: 'kp_multiply', NumpadDivide: 'kp_slash',
  NumpadEnter: 'kp_enter', NumpadDecimal: 'kp_del',
  Numpad0: 'kp_ins', Numpad1: 'kp_end', Numpad2: 'kp_downarrow', Numpad3: 'kp_pgdn', Numpad4: 'kp_leftarrow',
  Numpad5: 'kp_5', Numpad6: 'kp_rightarrow', Numpad7: 'kp_home', Numpad8: 'kp_uparrow', Numpad9: 'kp_pgup'
}

/** KeyboardEvent.code → CS2 key name, or null for keys CS2 can't bind (or that are better left alone). */
export function cs2KeyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-2])$/.test(code)) return code
  if (code === 'Escape' || code === 'Backquote') return null // menu / console
  return CODE_KEYS[code] ?? null
}

/** CS2 mouse buttons for a MouseEvent.button (4/5 = side buttons; left/right are left alone) */
export function cs2KeyFromMouse(button: number): string | null {
  return ({ 1: 'mouse3', 3: 'mouse4', 4: 'mouse5' } as Record<number, string>)[button] ?? null
}

const VALID_KEY = /^[a-z0-9_\-=\[\]\\',./`;]+$|^F([1-9]|1[0-2])$/i

/** Drops unknown actions and keys that wouldn't be safe in a cfg line. */
export function cleanKeyBinds(binds: unknown): KeyBinds {
  const out: KeyBinds = {}
  if (!binds || typeof binds !== 'object') return out
  for (const a of KEY_ACTIONS) {
    const k = (binds as Record<string, unknown>)[a.id]
    if (typeof k === 'string' && k && k.length <= 16 && VALID_KEY.test(k)) out[a.id] = k
  }
  return out
}

/** The cfg the app writes. Keys used by two actions keep the first one. */
export function keysCfg(binds: KeyBinds): string {
  const lines = [
    '// Written by CS2Prac (Play page > Keys). Changes here are overwritten; pick keys in the app instead.',
    '// Run by NihilPrac.cfg (exec cs2prac_keys) or by hand in the console.'
  ]
  const used = new Set<string>()
  for (const a of KEY_ACTIONS) {
    const k = binds[a.id]
    if (!k || used.has(k.toLowerCase())) continue
    used.add(k.toLowerCase())
    const key = k === ';' ? 'semicolon' : k
    lines.push(`bind "${key}" "${a.command}"`.padEnd(48) + ` // ${a.name}`)
  }
  lines.push('echo CS2Prac keys loaded')
  return lines.join('\r\n') + '\r\n'
}
