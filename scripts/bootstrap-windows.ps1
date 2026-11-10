# Runs before Node exists. Emit only the selected node.exe path on stdout.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-manifest.json') -Raw | ConvertFrom-Json
$runtimeRoot = Join-Path $projectRoot '.local\runtime'
$folder = [string]$manifest.node.folder
$runtimeDir = Join-Path $runtimeRoot $folder
$nodeExe = Join-Path $runtimeDir 'node.exe'
$nodeUrl = [string]$manifest.node.url
$nodeSha256 = [string]$manifest.node.sha256

function Get-NpmCli([string] $candidate) {
  if ($env:TCG_NPM_CLI) {
    if (-not (Test-Path -LiteralPath $env:TCG_NPM_CLI -PathType Leaf)) {
      throw 'TCG_NPM_CLI points to a missing file. Correct it or unset it.'
    }
    return $env:TCG_NPM_CLI
  }
  $coLocated = Join-Path (Split-Path -Parent $candidate) 'node_modules\npm\bin\npm-cli.js'
  if (Test-Path -LiteralPath $coLocated -PathType Leaf) { return $coLocated }
  if ($env:npm_execpath -and (Test-Path -LiteralPath $env:npm_execpath -PathType Leaf)) { return $env:npm_execpath }
  foreach ($entry in ($env:Path -split ';')) {
    if (-not $entry) { continue }
    $cli = [System.IO.Path]::Combine($entry, 'node_modules\npm\bin\npm-cli.js')
    if (Test-Path -LiteralPath $cli -PathType Leaf) { return $cli }
  }
  return $null
}

function Test-NodeAndNpm([string] $candidate) {
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $false }
  try {
    $version = & $candidate -p 'process.versions.node' 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    if ($version -match '^24\.(\d+)\.(\d+)$') { $nodeMinor = [int]$Matches[1] }
    else { return $false }
    if ($nodeMinor -lt 15) { return $false }
    $npmCli = Get-NpmCli $candidate
    if (-not $npmCli) { return $false }
    $npmVersion = & $candidate $npmCli --version 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    if ($npmVersion -match '^11\.(\d+)\.(\d+)$') { $npmMinor = [int]$Matches[1] }
    else { return $false }
    return $npmMinor -ge 9
  } catch { return $false }
}

function Assert-ArchiveEntries([string] $zipPath) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    foreach ($entry in $archive.Entries) {
      $name = $entry.FullName.Replace('\', '/')
      if (-not $name.StartsWith("$folder/", [System.StringComparison]::Ordinal) -or
          $name.Contains(':') -or $name.StartsWith('/') -or
          (($name -split '/') -contains '..')) {
        throw 'The downloaded Node archive contains an unsafe path.'
      }
    }
  } finally { $archive.Dispose() }
}

function Remove-OwnStage([string] $target) {
  $full = [System.IO.Path]::GetFullPath($target)
  $parent = [System.IO.Path]::GetFullPath($runtimeRoot).TrimEnd('\') + '\'
  if (-not $full.StartsWith($parent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to clean a path outside the private runtime folder.'
  }
  if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force }
}

try {
  $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  if ($architecture -ne 'X64') { throw "TCG Live currently supports x64 Windows only (found $architecture)." }

  if ($env:TCG_NODE_EXE) {
    if (-not (Test-NodeAndNpm $env:TCG_NODE_EXE)) {
      throw 'TCG_NODE_EXE is set but does not provide Node 24.15+ and npm 11.9+. Correct it or unset it.'
    }
    [System.IO.Path]::GetFullPath($env:TCG_NODE_EXE)
    exit 0
  }

  if (Test-NodeAndNpm $nodeExe) { $nodeExe; exit 0 }
  $candidates = New-Object System.Collections.Generic.List[string]
  foreach ($entry in ($env:Path -split ';')) {
    if ($entry) { $candidates.Add([System.IO.Path]::Combine($entry, 'node.exe')) }
  }
  if ($env:USERPROFILE) {
    $cache = Join-Path $env:USERPROFILE '.cache\codex-runtimes'
    if (Test-Path -LiteralPath $cache -PathType Container) {
      foreach ($item in (Get-ChildItem -LiteralPath $cache -Directory -ErrorAction SilentlyContinue)) {
        $candidates.Add((Join-Path $item.FullName 'dependencies\node\bin\node.exe'))
      }
    }
  }
  foreach ($candidate in $candidates) {
    if (Test-NodeAndNpm $candidate) { [System.IO.Path]::GetFullPath($candidate); exit 0 }
  }

  [System.IO.Directory]::CreateDirectory($runtimeRoot) | Out-Null
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    $digest = $hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant()))
    $mutexName = 'Local\TCGLiveNode-' + [System.BitConverter]::ToString($digest).Replace('-', '').Substring(0, 24)
  } finally { $hasher.Dispose() }
  $mutex = New-Object System.Threading.Mutex($false, $mutexName)
  $locked = $false
  try {
    try { $locked = $mutex.WaitOne(120000) }
    catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another TCG Live launch is preparing Node. Try again shortly.' }
    if (Test-NodeAndNpm $nodeExe) { $nodeExe; exit 0 }
    if (Test-Path -LiteralPath $runtimeDir) {
      throw 'The private Node folder is incomplete. Move .local\runtime\node-v24.22.2-win-x64 aside, then retry.'
    }
    $suffix = [guid]::NewGuid().ToString('N')
    $zipPath = Join-Path $runtimeRoot ".node-$suffix.zip"
    $stage = Join-Path $runtimeRoot ".node-$suffix"
    try {
      [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
      $downloaded = $false
      [Console]::Error.WriteLine('TCG Live: downloading a private Node.js runtime from nodejs.org. This can take a few minutes.')
      for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
          Invoke-WebRequest -Uri $nodeUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 60 -MaximumRedirection 3
          $downloaded = $true
          break
        } catch {
          Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
          if ($attempt -eq 3) { throw 'Could not download the pinned Node runtime from nodejs.org. Check the connection and retry.' }
          Start-Sleep -Seconds (2 * $attempt)
        }
      }
      if (-not $downloaded) { throw 'Could not download Node.' }
      $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actual -ne $nodeSha256) { throw 'The Node download checksum did not match. No runtime was installed.' }
      [Console]::Error.WriteLine('TCG Live: Node checksum verified; extracting the private runtime.')
      Assert-ArchiveEntries $zipPath
      Expand-Archive -LiteralPath $zipPath -DestinationPath $stage -Force
      $stagedRuntime = Join-Path $stage $folder
      if (-not (Test-NodeAndNpm (Join-Path $stagedRuntime 'node.exe'))) {
        $stagedNode = Join-Path $stagedRuntime 'node.exe'
        $stagedCli = Get-NpmCli $stagedNode
        $nodeResult = if (Test-Path -LiteralPath $stagedNode) { & $stagedNode --version 2>&1 | Out-String } else { 'node.exe missing' }
        $npmResult = if ($stagedCli) { & $stagedNode $stagedCli --version 2>&1 | Out-String } else { 'npm CLI missing' }
        [Console]::Error.WriteLine("TCG Live: extracted runtime probe: node=$($nodeResult.Trim()) npm=$($npmResult.Trim()).")
        throw 'The downloaded Node runtime does not contain supported Node and npm.'
      }
      Move-Item -LiteralPath $stagedRuntime -Destination $runtimeDir
      $nodeExe
    } finally {
      Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
      Remove-OwnStage $stage
    }
  } finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
} catch {
  [Console]::Error.WriteLine("TCG Live bootstrap: $($_.Exception.Message)")
  exit 1
}
