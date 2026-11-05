# Read-only Windows preflight for the local v2.1 -> v2.2 cutover.
# It deliberately performs no fetch, checkout, copy, migration, process stop, or file write.
[CmdletBinding()]
param(
  [string]$AssistHome = $env:ASSIST_HOME,
  [string]$Repo = '',
  [int]$BasePort = 7331,
  [int]$AppPort = 7321
)
$ErrorActionPreference = 'Stop'
if (-not $AssistHome) { $AssistHome = Join-Path $env:USERPROFILE '.pi\profiles\assistant' }
$AssistHome = [IO.Path]::GetFullPath($AssistHome)
if (-not $Repo) { $Repo = Split-Path -Parent $PSScriptRoot }
$Repo = [IO.Path]::GetFullPath($Repo)

function Write-Section([string]$title) { Write-Host "`n== $title ==" }

function Get-JsonShape([string]$file) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return @{ exists = $false; shape = 'missing'; detail = '' } }
  try {
    $raw = [IO.File]::ReadAllText($file)
    $shapeText = $raw.TrimStart()
    if ($shapeText.Length -gt 0 -and [int][char]$shapeText[0] -eq 0xFEFF) { $shapeText = $shapeText.Substring(1).TrimStart() }
    $value = $raw | ConvertFrom-Json
    if ($shapeText.StartsWith('[')) { return @{ exists = $true; shape = 'array'; detail = "count=$(@($value).Count)" } }
    if ($shapeText.StartsWith('{')) { return @{ exists = $true; shape = 'object'; detail = "properties=$(@($value.PSObject.Properties).Count)" } }
    if ($null -eq $value) { return @{ exists = $true; shape = 'null'; detail = '' } }
    return @{ exists = $true; shape = $value.GetType().Name; detail = '' }
  } catch {
    return @{ exists = $true; shape = 'invalid-json'; detail = $_.Exception.Message }
  }
}

function Get-PortOwner([int]$port) {
  try {
    $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop)
  } catch { $listeners = @() }
  if ($listeners.Count -eq 0) { return @() }
  foreach ($listener in $listeners) {
    $pidValue = [int]$listener.OwningProcess
    $commandLine = ''
    try { $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction Stop).CommandLine } catch { $commandLine = "<cmdline unavailable: $($_.Exception.Message)>" }
    [PSCustomObject]@{ Port = $port; Pid = $pidValue; LocalAddress = $listener.LocalAddress; CommandLine = $commandLine }
  }
}

function Invoke-GitRead([string]$directory, [string[]]$arguments) {
  $output = & git -C $directory @arguments 2>&1
  if ($LASTEXITCODE -ne 0) { return "<unavailable: $($output -join ' ')>" }
  return ($output -join "`n").Trim()
}

Write-Host 'sopho-pi local cutover preflight (READ ONLY)'
Write-Host "profile=$AssistHome"
Write-Host "repo=$Repo"

Write-Section 'data shapes'
$recents = Get-JsonShape (Join-Path $AssistHome 'cwd-recents.json')
$drafts = Get-JsonShape (Join-Path $AssistHome 'drafts.json')
Write-Host "cwd-recents.json exists=$($recents.exists) shape=$($recents.shape) $($recents.detail)"
Write-Host "drafts.json exists=$($drafts.exists) shape=$($drafts.shape) $($drafts.detail)"
if ($recents.shape -eq 'object') { Write-Host 'cwd-recents verdict=v2.1 shape; migration is required before v2.2 starts' }
elseif ($recents.shape -eq 'array') { Write-Host 'cwd-recents verdict=v2.2 shape; v2.1 rollback must restore an object backup' }
else { Write-Warning 'cwd-recents verdict=unexpected; do not cut over until inspected' }

Write-Section 'profile extension plugin to move out before cutover (read-only)'
# v2.2 loads its assistant plugin explicitly from the repo (pi-extensions/assistant), so any same-named
# plugin left inside the profile's extensions/ directory collides with it (docs/cutover-v2.2.md:14).
# This check only reads: it never moves, renames or deletes anything.
$profileExtension = Join-Path (Join-Path $AssistHome 'extensions') 'assistant'
if (Test-Path -LiteralPath $profileExtension) {
  Write-Warning "extensions verdict=CONFLICT: $profileExtension exists and will collide with the same-named plugin v2.2 loads from the repo. Move the WHOLE directory OUT of extensions/ before cutover, and move it back on rollback. Renaming files inside it is NOT enough - pi still scans the extensions/ directory by folder name."
} else {
  Write-Host "extensions verdict=PASS: no $profileExtension; nothing to move out before cutover"
}

Write-Section 'listeners to identify before stopping'
$owners = @()
$owners += @(Get-PortOwner $BasePort)
$owners += @(Get-PortOwner $AppPort)
if ($owners.Count -eq 0) { Write-Host "no listeners found on $BasePort/$AppPort" }
else { $owners | Format-List Port,Pid,LocalAddress,CommandLine | Out-String | Write-Host }

Write-Section 'active v2.2 workers'
try {
  $hostStatus = Invoke-RestMethod -Method Get -TimeoutSec 5 -Uri "http://127.0.0.1:$BasePort/host"
  Write-Host "host.pid=$($hostStatus.pid)"
  if ($null -eq $hostStatus.workerTotals) {
    Write-Host 'workerTotals=absent (expected on v2.1; active count cannot be inferred from this v2.1 /host shape)'
  } else {
    $active = [int]$hostStatus.workerTotals.active
    Write-Host "workerTotals.active=$active"
    if ($active -gt 0) { Write-Warning 'BLOCK: one or more sessions are active; do not cut over' }
    else { Write-Host 'active verdict=0; no active v2.2 runtime reported' }
  }
} catch {
  Write-Warning "cannot read /host on A port ${BasePort}: $($_.Exception.Message)"
}

Write-Section 'existing whole-profile backups'
$profileParent = Split-Path -Parent $AssistHome
$profileName = Split-Path -Leaf $AssistHome
$backups = @(Get-ChildItem -LiteralPath $profileParent -Directory -Filter "$profileName.cutover-v2.2.*" -ErrorAction SilentlyContinue | Sort-Object Name)
Write-Host "backup convention=$profileParent\$profileName.cutover-v2.2.YYYYMMDD-HHmmss"
if ($backups.Count -eq 0) { Write-Host 'backup count=0 (create one before migration)' }
else { $backups | ForEach-Object { Write-Host "backup found=$($_.FullName)" } }

Write-Section 'code locatability (no fetch performed)'
$commonDir = Invoke-GitRead $Repo @('rev-parse', '--path-format=absolute', '--git-common-dir')
$mainRepo = if ($commonDir -like '<unavailable:*') { '<unavailable>' } else { Split-Path -Parent $commonDir }
Write-Host "main repo=$mainRepo"
if ($mainRepo -ne '<unavailable>') {
  Write-Host "main tree commit=$(Invoke-GitRead $mainRepo @('rev-parse', 'HEAD'))"
  Write-Host "main tree branch=$(Invoke-GitRead $mainRepo @('branch', '--show-current'))"
}
Write-Host "current worktree commit=$(Invoke-GitRead $Repo @('rev-parse', 'HEAD'))"
$originV22 = Invoke-GitRead $Repo @('rev-parse', '--verify', 'origin/v2.2^{commit}')
$v22Base = '4d7b823977943e46fcc970e477c78cd26ca46417'
Write-Host "origin/v2.2 commit=$originV22"
Write-Host "reviewed v2.2 base=$v22Base"
if ($originV22 -notlike '<unavailable:*') {
  & git -C $Repo merge-base --is-ancestor $v22Base $originV22 2>$null
  if ($LASTEXITCODE -eq 0) { Write-Host 'v2.2 base verdict=origin/v2.2 contains the reviewed base' }
  else { Write-Warning 'v2.2 base verdict=origin/v2.2 does NOT contain the reviewed base; do not cut over' }
}
Write-Host "`nREAD ONLY complete: no files or processes were changed."
