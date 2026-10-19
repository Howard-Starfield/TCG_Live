# E2E helper (Windows only): runs a command in a private, hidden console and, when told to, sends that
# console a real CTRL_C_EVENT (or CTRL_BREAK_EVENT) - what pressing Ctrl+C (Ctrl+Break) in a terminal does.
# Node's process.kill(pid, 'SIGINT') cannot do this on Windows: it calls TerminateProcess.
#
# The child inherits this process's environment. Protocol on stdin/stdout (lines):
#   pid:<pid>        the child is running; the parent may now write "ctrl-c" or "ctrl-break" on stdin
#   sent:<ms>        the event was sent (Unix time in ms)
#   exit:<code>:<ms> the child exited (Unix time in ms), or "exit:timeout" if it still ran after 10 s
#   out:<line>       after the exit: each line the child wrote on stdout, then err:<line> for stderr
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Script
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace E2E {
  public static class Con {
    public delegate bool Handler(uint ctrlType);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AllocConsole();
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(Handler handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
    static readonly Handler swallow = ctrlType => true;
    /** Like a fresh terminal: Ctrl+C is processed (a parent may have started us with it ignored). */
    public static void ProcessCtrlC() { SetConsoleCtrlHandler(IntPtr.Zero, false); }
    /** This process survives every console event it sends; children started earlier are unaffected. */
    public static void Shield() { SetConsoleCtrlHandler(swallow, true); }
  }
}
'@

function Say([string]$line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }
function Now { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

# A console of our own, so the event reaches only this helper and the child, never the caller's console.
[void][E2E.Con]::FreeConsole()
if (-not [E2E.Con]::AllocConsole()) { throw 'AllocConsole failed' }
[void][E2E.Con]::ShowWindow([E2E.Con]::GetConsoleWindow(), 0)
# Headless parents often start processes with Ctrl+C ignored, and children inherit that. A terminal does not.
[E2E.Con]::ProcessCtrlC()

$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $Exe
$info.Arguments = '"' + $Script + '"'
$info.UseShellExecute = $false
$info.CreateNoWindow = $false          # inherit the console allocated above
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$child = New-Object System.Diagnostics.Process
$child.StartInfo = $info
[void]$child.Start()
# Drain both pipes in the background so the child never blocks on a full pipe.
$stdout = $child.StandardOutput.ReadToEndAsync()
$stderr = $child.StandardError.ReadToEndAsync()
Say "pid:$($child.Id)"

$command = [Console]::In.ReadLine()
# The helper swallows the event itself; the child (already running) keeps its own handlers.
[E2E.Con]::Shield()
$kind = if ($command -eq 'ctrl-break') { 1 } else { 0 }
if (-not [E2E.Con]::GenerateConsoleCtrlEvent([uint32]$kind, 0)) { throw 'GenerateConsoleCtrlEvent failed' }
Say "sent:$(Now)"
if ($child.WaitForExit(10000)) {
  $child.WaitForExit()
  Say "exit:$($child.ExitCode):$(([DateTimeOffset]$child.ExitTime).ToUnixTimeMilliseconds())"
} else {
  Say 'exit:timeout'
  $child.Kill()
  $child.WaitForExit()
}
foreach ($line in ($stdout.Result -split "`r?`n")) { if ($line) { Say "out:$line" } }
foreach ($line in ($stderr.Result -split "`r?`n")) { if ($line) { Say "err:$line" } }
