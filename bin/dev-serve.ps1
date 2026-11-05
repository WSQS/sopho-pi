# Safe Windows sandbox wrapper: random high ports, temporary home and private logs.
# It delegates process creation/stopping to serve-win.ps1 / stop-win.ps1, so the
# WMI + listener/pidfile identity rules stay in one place.
[CmdletBinding()]
param(
  [switch]$Stop,
  [int]$Port = 0,
  [int]$AppPort = 0,
  [string]$AssistHome = '',
  [string]$BindHost = '127.0.0.1'
)
$ErrorActionPreference = 'Stop'

$Repo = Split-Path -Parent $PSScriptRoot
$Tmp = if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
$RepoHash = [BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($Repo))).Replace('-', '').Substring(0, 12).ToLowerInvariant()
$StateFile = Join-Path $Tmp "sopho-dev-$RepoHash.json"
$ReservedPorts = @(7331, 7321)
$RealProfile = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.pi\profiles\assistant')).TrimEnd('\', '/')

function Get-PortOwner([int]$selectedPort) {
  try {
    $row = Get-NetTCPConnection -LocalPort $selectedPort -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($row) { return [int]$row.OwningProcess }
  } catch { }
  return 0
}

function Get-RandomFreePort([int[]]$excluded) {
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    $candidate = Get-Random -Minimum 20000 -Maximum 60000
    if ($excluded -contains $candidate) { continue }
    if (-not (Get-PortOwner $candidate)) { return $candidate }
  }
  throw 'could not find a free random high port after 100 attempts'
}

function Assert-SandboxPort([string]$name, [int]$value) {
  if ($value -lt 1024 -or $value -gt 65535) { throw "$name must be a high port (1024..65535): $value" }
  if ($ReservedPorts -contains $value) { throw "$name refuses reserved live-instance port $value" }
  if (Get-PortOwner $value) { throw "$name port $value is already in use" }
}

function Normalize-Path([string]$value) {
  return [System.IO.Path]::GetFullPath($value).TrimEnd('\', '/')
}

function Ensure-NodeModules {
  $local = Join-Path $Repo 'node_modules'
  if (Test-Path -LiteralPath $local) { return $false }
  $common = (& git -C $Repo rev-parse --git-common-dir 2>$null).Trim()
  if (-not $common) { throw 'node_modules is missing and git common directory could not be found' }
  if (-not [System.IO.Path]::IsPathRooted($common)) { $common = Join-Path $Repo $common }
  $main = Split-Path -Parent (Normalize-Path $common)
  $target = Join-Path $main 'node_modules'
  if (-not (Test-Path -LiteralPath $target)) { throw "node_modules is missing in both worktree and main tree ($target)" }
  & cmd.exe /d /c mklink /J "$local" "$target" | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $local)) { throw "failed to create node_modules junction: $local -> $target" }
  Write-Host "sandbox node_modules junction created: $local -> $target"
  return $true
}

function Remove-NodeModulesJunction([bool]$created) {
  if (-not $created) { return }
  $local = Join-Path $Repo 'node_modules'
  if (-not (Test-Path -LiteralPath $local)) { return }
  $item = Get-Item -LiteralPath $local -Force
  if (-not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    Write-Warning "refusing to remove node_modules because it is no longer a junction: $local"
    return
  }
  & cmd.exe /d /c rmdir "$local" | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Warning "failed to remove sandbox node_modules junction: $local" }
  else { Write-Host "sandbox node_modules junction removed: $local" }
}

if ($Stop) {
  if (-not (Test-Path -LiteralPath $StateFile)) {
    Write-Error "no sandbox state file: $StateFile; nothing stopped"
    exit 1
  }
  $state = Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json
  if ($ReservedPorts -contains [int]$state.port -or $ReservedPorts -contains [int]$state.appPort) {
    throw "refusing sandbox stop because state contains reserved port: $($state.port),$($state.appPort)"
  }
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'stop-win.ps1') -Port ([int]$state.port) -AppPort ([int]$state.appPort)
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Remove-NodeModulesJunction ([bool]$state.junctionCreated)
    Remove-Item -LiteralPath $StateFile -Force
    Write-Host "sandbox stopped; home retained for evidence: $($state.home)"
  } catch {
    Write-Error $_
    exit 1
  }
  exit 0
}

if (Test-Path -LiteralPath $StateFile) {
  $previous = Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json
  if ((Get-PortOwner ([int]$previous.port)) -or (Get-PortOwner ([int]$previous.appPort))) {
    throw "a sandbox is already running according to $StateFile (ports $($previous.port),$($previous.appPort)); stop it first"
  }
  Remove-NodeModulesJunction ([bool]$previous.junctionCreated)
  Remove-Item -LiteralPath $StateFile -Force
}
if ($Port -le 0) { $Port = Get-RandomFreePort $ReservedPorts }
if ($AppPort -le 0) { $AppPort = Get-RandomFreePort ($ReservedPorts + @($Port)) }
if ($Port -eq $AppPort) { throw "SOPHO_PORT and SOPHO_APP_PORT must differ: $Port" }
Assert-SandboxPort 'SOPHO_PORT' $Port
Assert-SandboxPort 'SOPHO_APP_PORT' $AppPort

if (-not $AssistHome) { $AssistHome = Join-Path $Tmp ('sopho-dev-' + [guid]::NewGuid().ToString('N')) }
$AssistHome = Normalize-Path $AssistHome
if ($AssistHome.Equals($RealProfile, [System.StringComparison]::OrdinalIgnoreCase) -or $AssistHome.StartsWith($RealProfile + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "refusing real profile as sandbox home: $AssistHome"
}
$logs = Join-Path $AssistHome 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$junctionCreated = Ensure-NodeModules

$old = @{}
foreach ($name in @('ASSIST_HOME','SOPHO_AGENT_DIR','PI_CODING_AGENT_DIR','SOPHO_CWD','SOPHO_HOST','SOPHO_APP_HOST','SOPHO_PORT','SOPHO_APP_PORT','SOPHO_LOG','SOPHO_ERR_LOG','SOPHO_APP_LOG','SOPHO_APP_ERR_LOG')) {
  $old[$name] = [System.Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
  $env:ASSIST_HOME = $AssistHome
  $env:SOPHO_AGENT_DIR = $AssistHome
  $env:PI_CODING_AGENT_DIR = $AssistHome
  $env:SOPHO_CWD = $Repo
  $env:SOPHO_HOST = $BindHost
  $env:SOPHO_APP_HOST = $BindHost
  $env:SOPHO_PORT = "$Port"
  $env:SOPHO_APP_PORT = "$AppPort"
  $env:SOPHO_LOG = Join-Path $logs 'base.log'
  $env:SOPHO_ERR_LOG = Join-Path $logs 'base.err.log'
  $env:SOPHO_APP_LOG = Join-Path $logs 'app.log'
  $env:SOPHO_APP_ERR_LOG = Join-Path $logs 'app.err.log'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'serve-win.ps1') -Port $Port -AppPort $AppPort -BindHost $BindHost -AppHost $BindHost
  if ($LASTEXITCODE -ne 0) { throw "serve-win.ps1 exited $LASTEXITCODE" }
  @{
    port = $Port
    appPort = $AppPort
    home = $AssistHome
    logs = $logs
    junctionCreated = $junctionCreated
    startedAt = (Get-Date).ToString('o')
  } | ConvertTo-Json | Set-Content -LiteralPath $StateFile
} catch {
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'stop-win.ps1') -Port $Port -AppPort $AppPort 2>$null | Out-Null
  } catch { }
  Remove-NodeModulesJunction $junctionCreated
  throw
} finally {
  foreach ($name in $old.Keys) { [System.Environment]::SetEnvironmentVariable($name, $old[$name], 'Process') }
}

Write-Host "sandbox started ports=$Port,$AppPort home=$AssistHome logs=$logs"
Write-Host "stop with: npm run stop:dev"
