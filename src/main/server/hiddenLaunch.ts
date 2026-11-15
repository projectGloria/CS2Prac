import { spawn, type ChildProcess } from 'node:child_process'

/**
 * cs2.exe -dedicated opens its own console window ("Counter-Strike 2") even when started hidden: it allocates the
 * console itself, so windowsHide and a hidden parent console don't help, and hiding it afterwards still flashes.
 * So cs2 is started on a separate, invisible desktop ("CS2PracHidden"): every window it opens lives there and never
 * appears on the user's screen. A hidden PowerShell does the CreateProcess (Node can't set STARTUPINFO.lpDesktop),
 * hands cs2 its own stdin/stdout/stderr (our pipes), waits for it and exits with its exit code, so the returned child
 * behaves like cs2 itself: output, exit and `taskkill /T` all work as before.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # progress records would show up on stderr as CLIXML
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class CS2PracLaunch {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h, int mask, int flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, int flags,
    IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out int code);

  public static int Run(string exe, string cmd, string cwd) {
    const uint GENERIC_ALL = 0x10000000;
    // opens the desktop when it already exists; it goes away once nothing uses it
    if (CreateDesktop("CS2PracHidden", IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero) == IntPtr.Zero)
      throw new Exception("CreateDesktop failed: " + Marshal.GetLastWin32Error());
    var si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.lpDesktop = "CS2PracHidden";
    si.dwFlags = 0x101; // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
    si.wShowWindow = 0; // SW_HIDE
    si.hStdInput = GetStdHandle(-10);
    si.hStdOutput = GetStdHandle(-11);
    si.hStdError = GetStdHandle(-12);
    foreach (var h in new[] { si.hStdInput, si.hStdOutput, si.hStdError })
      if (h != IntPtr.Zero && h != new IntPtr(-1)) SetHandleInformation(h, 1, 1); // HANDLE_FLAG_INHERIT
    PROCESS_INFORMATION pi;
    if (!CreateProcess(exe, new StringBuilder(cmd), IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, cwd, ref si, out pi))
      throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    int code;
    GetExitCodeProcess(pi.hProcess, out code);
    return code;
  }
}
"@
$exe = $env:CS2PRAC_EXE; $cmd = $env:CS2PRAC_CMDLINE; $cwd = $env:CS2PRAC_CWD
# not passed on to cs2 (the command line holds the rcon password)
Remove-Item Env:CS2PRAC_EXE, Env:CS2PRAC_CMDLINE, Env:CS2PRAC_CWD
exit [CS2PracLaunch]::Run($exe, $cmd, $cwd)
`

/** Windows command-line quoting (the rules CommandLineToArgvW and the CRT parse). */
export function quoteArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let slashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      slashes++
      continue
    }
    if (ch === '"') out += '\\'.repeat(slashes * 2 + 1) + '"'
    else out += '\\'.repeat(slashes) + ch
    slashes = 0
  }
  return out + '\\'.repeat(slashes * 2) + '"'
}

export function windowsCommandLine(exe: string, args: string[]): string {
  return [exe, ...args].map(quoteArg).join(' ')
}

/** Starts exe on the invisible desktop; stdin is ignored, stdout/stderr are pipes. */
export function spawnHidden(exe: string, args: string[], cwd: string): ChildProcess {
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CS2PRAC_EXE: exe, CS2PRAC_CMDLINE: windowsCommandLine(exe, args), CS2PRAC_CWD: cwd }
  })
}
