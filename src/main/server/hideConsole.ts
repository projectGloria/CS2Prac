import { spawn, type ChildProcess } from 'node:child_process'

/**
 * cs2.exe -dedicated opens its own console window ("Counter-Strike 2") even when started hidden: it allocates the
 * console itself, so windowsHide and a hidden parent console don't help. A hidden PowerShell watches for that window
 * and hides it. The watcher starts before cs2 (Add-Type takes a moment) and gets the pid on stdin, so the window
 * shows for a few frames at most. It keeps checking while the server runs, in case cs2 shows the window again.
 */
const SCRIPT = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class CS2PracWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static int Hide(uint want) {
    int n = 0;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == want && IsWindowVisible(h)) {
        var c = new StringBuilder(64); GetClassName(h, c, 64);
        if (c.ToString() == "ConsoleWindowClass") { ShowWindow(h, 0); n++; }
      }
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
"@
$target = [uint32][Console]::In.ReadLine()
$start = Get-Date
while ($true) {
  if (-not (Get-Process -Id $target -ErrorAction SilentlyContinue)) { break }
  [void][CS2PracWin]::Hide($target)
  $elapsed = ((Get-Date) - $start).TotalSeconds
  if ($elapsed -lt 60) { Start-Sleep -Milliseconds 30 } else { Start-Sleep -Seconds 2 }
}
`

export interface ConsoleHider {
  /** Tells the watcher which process to hide; call right after spawning cs2. */
  watch(pid: number): void
  stop(): void
}

export function startConsoleHider(): ConsoleHider {
  let ps: ChildProcess | null = null
  try {
    // The script goes in as -EncodedCommand (UTF-16LE base64) so stdin stays free for the pid.
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
    ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore']
    })
    ps.on('error', () => (ps = null))
    ps.stdin?.on('error', () => {}) // the watcher may already be gone
  } catch {
    ps = null
  }
  return {
    watch(pid) {
      ps?.stdin?.write(`${pid}\n`)
    },
    stop() {
      ps?.kill()
      ps = null
    }
  }
}
