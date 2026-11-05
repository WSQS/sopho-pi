# sopho-pi v2.2 - Windows native A+B launcher.
#
# Deliberately uses Win32_Process.Create instead of Start-Process. Start-Process can
# pass an inherited pipeline handle to the long-lived child and make
# `npm run serve:win | ...` wait forever for EOF. WMI creates the launcher outside
# this process tree; a generated .cmd carries the caller's environment explicitly.
#
# v2.2 ports: SOPHO_PORT = A, SOPHO_APP_PORT = B.
#
# Defaults = the live instance口径, byte-for-byte the same semantics as bin/serve.sh, so a bare
# `npm run serve:win` starts that pair:
#   A = 127.0.0.1:7331 (loopback only)  B = 0.0.0.0:7321 (browsers on the LAN/ZeroTier hit this)
#   data dir = %USERPROFILE%\.pi\profiles\assistant (all three agent-dir variables unified below)
# An explicit environment variable (or -Port/-AppPort/-BindHost/-AppHost) always wins, so tests /
# sandboxes / rehearsals that pass ports and a profile are unaffected by these defaults.
# ⚠️ B has no authentication (server/app.mjs); the 0.0.0.0 default means any client that can reach
# it can change files under the page root as this account.
[CmdletBinding()]
param(
  [string]$BindHost = $env:SOPHO_HOST,
  [string]$AppHost = $env:SOPHO_APP_HOST,
  [int]$Port = 0,
  [int]$AppPort = 0
)
$ErrorActionPreference = 'Stop'

$Repo = Split-Path -Parent $PSScriptRoot
$BaseEntry = (Join-Path $Repo 'server\base.mjs')
$AppEntry = (Join-Path $Repo 'server\app.mjs')
$Tmp = if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
if (-not $BindHost) { $BindHost = '127.0.0.1' }
# B's host: same口径 as bin/serve.sh — B does NOT follow A's host. A defaults to loopback, so
# inheriting it left `npm run serve` loopback-only and the web page unreachable from outside
# (owner ruling, 2026-09-23). Unless SOPHO_APP_HOST / -AppHost is given explicitly, B is 0.0.0.0;
# a sandbox that wants B on loopback must pass `-AppHost 127.0.0.1` / SOPHO_APP_HOST=127.0.0.1.
if (-not $AppHost) { $AppHost = '0.0.0.0' }
if ($Port -le 0) { $Port = if ($env:SOPHO_PORT) { [int]$env:SOPHO_PORT } else { 7331 } }
if ($AppPort -le 0) { $AppPort = if ($env:SOPHO_APP_PORT) { [int]$env:SOPHO_APP_PORT } else { 7321 } }
# One agent-dir口径 for all three variables, resolved with the same priority as bin/serve.sh
# (PI_CODING_AGENT_DIR > ASSIST_HOME > SOPHO_AGENT_DIR > default) and then unified below, so a
# half-set environment cannot leave A reading a different profile than the launcher promised.
$AgentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } elseif ($env:ASSIST_HOME) { $env:ASSIST_HOME } elseif ($env:SOPHO_AGENT_DIR) { $env:SOPHO_AGENT_DIR } else { Join-Path $env:USERPROFILE '.pi\profiles\assistant' }
$HomeDir = $AgentDir
$WorkDir = if ($env:SOPHO_CWD) { $env:SOPHO_CWD } else { $Repo }
$WebRoot = if ($env:SOPHO_WEB_ROOT) { $env:SOPHO_WEB_ROOT } else { Join-Path $Repo 'web' }
# Default log names carry the port, exactly like bin/serve.sh's per-port names and the
# `sopho-pi-<port>.pid` pidfile below. A live instance started with the old fixed names
# (%TEMP%\sopho-base.log / sopho-app.log) keeps those files open; when the launcher's
# `1>>` redirect then could not open them, node never ran and the only visible symptom was
# the 125s "start timed out" message. Per-port names keep two instances off each other's
# files without moving the logs out of %TEMP%. An explicit SOPHO_LOG / SOPHO_ERR_LOG /
# SOPHO_APP_LOG / SOPHO_APP_ERR_LOG still wins (the user's explicit intent is untouched).
$BaseLog = if ($env:SOPHO_LOG) { $env:SOPHO_LOG } else { Join-Path $Tmp "sopho-base-$Port.log" }
$BaseErr = if ($env:SOPHO_ERR_LOG) { $env:SOPHO_ERR_LOG } else { Join-Path $Tmp "sopho-base-$Port.err.log" }
$AppLog = if ($env:SOPHO_APP_LOG) { $env:SOPHO_APP_LOG } else { Join-Path $Tmp "sopho-app-$AppPort.log" }
$AppErr = if ($env:SOPHO_APP_ERR_LOG) { $env:SOPHO_APP_ERR_LOG } else { Join-Path $Tmp "sopho-app-$AppPort.err.log" }
# Busy-machine measurement (2026-09-18): an A listener appeared 62.425s after the
# launcher was written. The production cap is twice that observed maximum, rounded up to 125s.
$MeasuredLongestStartSeconds = 62.425
$BaseStartTimeoutSeconds = 125
$AppStartTimeoutSeconds = 20
$ProgressIntervalSeconds = 5
$LateCleanupSeconds = 15
# Test-only controls keep the slow-start/timeout contract reproducible without
# making the Windows gate sleep for the production cap.
if ($env:SOPHO_TEST_START_TIMEOUT_SECONDS) { $BaseStartTimeoutSeconds = [int]$env:SOPHO_TEST_START_TIMEOUT_SECONDS }
if ($env:SOPHO_TEST_PROGRESS_INTERVAL_SECONDS) { $ProgressIntervalSeconds = [int]$env:SOPHO_TEST_PROGRESS_INTERVAL_SECONDS }
if ($env:SOPHO_TEST_LATE_CLEANUP_SECONDS) { $LateCleanupSeconds = [int]$env:SOPHO_TEST_LATE_CLEANUP_SECONDS }
$script:LaunchedPorts = @{}

function Assert-Port([string]$name, [int]$value) {
  if ($value -lt 1 -or $value -gt 65535) { throw "invalid ${name}: $value" }
}
Assert-Port 'SOPHO_PORT' $Port
Assert-Port 'SOPHO_APP_PORT' $AppPort
if ($Port -eq $AppPort) { throw "SOPHO_PORT and SOPHO_APP_PORT must differ: $Port" }

function Get-PortOwner([int]$selectedPort) {
  try {
    $row = Get-NetTCPConnection -LocalPort $selectedPort -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($row) { return [int]$row.OwningProcess }
  } catch { }
  return 0
}

function Get-CmdLine([int]$processId) {
  if (-not $processId) { return '' }
  try { $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop } catch { return '' }
  if (-not $process -or -not $process.CommandLine) { return '' }
  return ($process.CommandLine -replace '\\', '/')
}

function Test-OurProcess([int]$processId, [string]$entry) {
  $line = Get-CmdLine $processId
  if (-not $line) { return $false }
  return $line.IndexOf(($entry -replace '\\', '/'), [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-PidFile([int]$selectedPort) { return Join-Path $Tmp "sopho-pi-$selectedPort.pid" }

function Read-PidFile([int]$selectedPort) {
  $file = Get-PidFile $selectedPort
  if (-not (Test-Path -LiteralPath $file)) { return 0 }
  $value = 0
  [int]::TryParse((Get-Content -LiteralPath $file -ErrorAction SilentlyContinue | Select-Object -First 1), [ref]$value) | Out-Null
  return $value
}

function Test-AlreadyRunning([int]$selectedPort, [string]$entry) {
  $owner = Get-PortOwner $selectedPort
  $recorded = Read-PidFile $selectedPort
  return ($owner -gt 0 -and $owner -eq $recorded -and (Test-OurProcess $owner $entry))
}

function ConvertTo-CmdSetLine([string]$name, [string]$value) {
  return "set `"$name=$($value.Replace('%', '%%'))`""
}

function Write-Launcher([string]$name, [string]$entry, [hashtable]$environment, [string]$stdoutFile, [string]$stderrFile, [string]$nodePath) {
  $launcher = Join-Path $Tmp "sopho-run-$name-$Port-$AppPort.cmd"
  $lines = @(
    '@echo off',
    'chcp 65001 >nul',
    "cd /d `"$Repo`"")
  foreach ($key in ($environment.Keys | Sort-Object)) {
    $lines += ConvertTo-CmdSetLine $key ("$($environment[$key])")
  }
  if ($name -eq 'base' -and $env:SOPHO_TEST_BASE_START_DELAY_MS) {
    $delay = [int]$env:SOPHO_TEST_BASE_START_DELAY_MS
    $lines += "`"$nodePath`" -e `"setTimeout(() => {}, $delay)`""
  }
  $lines += "start `"`" /b `"$nodePath`" `"$entry`" 1>>`"$stdoutFile`" 2>>`"$stderrFile`""
  [System.IO.File]::WriteAllLines($launcher, $lines, (New-Object System.Text.UTF8Encoding($false)))
  return $launcher
}

function Wait-Listener([string]$label, [int]$selectedPort, [string]$entry, [int]$timeoutSeconds) {
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $nextProgress = $ProgressIntervalSeconds
  while ($watch.Elapsed.TotalSeconds -lt $timeoutSeconds) {
    $owner = Get-PortOwner $selectedPort
    if ($owner) {
      if (-not (Test-OurProcess $owner $entry)) { throw "$label start failed: port $selectedPort owner pid $owner is not $entry" }
      return @{ Pid = $owner; ElapsedSeconds = $watch.Elapsed.TotalSeconds }
    }
    if ($ProgressIntervalSeconds -gt 0 -and $watch.Elapsed.TotalSeconds -ge $nextProgress) {
      Write-Host ("$label still waiting: elapsed={0:N1}s; no listener on port $selectedPort" -f $watch.Elapsed.TotalSeconds)
      $nextProgress += $ProgressIntervalSeconds
    }
    Start-Sleep -Milliseconds 100
  }
  throw ("$label start timed out: WMI call succeeded (ReturnValue=0), but no node listener appeared on port $selectedPort; waited={0:N1}s; measuredLongest=${MeasuredLongestStartSeconds}s; productionCap=125s (2 x measured maximum, rounded up)" -f $watch.Elapsed.TotalSeconds)
}

function Assert-LogWritable([string]$label, [string]$path) {
  # The launcher's `1>>`/`2>>` redirect is opened by cmd.exe before node starts. If the file is
  # locked (a live instance) or unwritable, node never runs and the only symptom would be the
  # start timeout below. Probe the exact open here so the real cause and the path are reported
  # immediately instead of being disguised as "start timed out".
  try {
    $directory = Split-Path -Parent $path
    if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
    $probe = [System.IO.File]::Open($path, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
    $probe.Dispose()
  } catch {
    throw "$label log is not writable (locked or permission denied): $path; refusing to launch node because the launcher redirect would fail and surface only as a start timeout; underlying=$($_.Exception.Message)"
  }
}

function Start-Node([string]$label, [string]$name, [string]$entry, [int]$selectedPort, [hashtable]$environment, [string]$stdoutFile, [string]$stderrFile, [int]$timeoutSeconds, [string]$nodePath) {
  Assert-LogWritable "$label stdout" $stdoutFile
  Assert-LogWritable "$label stderr" $stderrFile
  $launcher = Write-Launcher $name $entry $environment $stdoutFile $stderrFile $nodePath
  $wmiDirectory = if ($env:SOPHO_TEST_WMI_CURRENT_DIRECTORY) { $env:SOPHO_TEST_WMI_CURRENT_DIRECTORY } else { $Repo }
  try {
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine = "cmd.exe /d /c `"$launcher`""
      CurrentDirectory = $wmiDirectory
    } -ErrorAction Stop
  } catch {
    $providerError = ($_ | Out-String).Trim()
    throw "$label WMI call failed: Win32_Process.Create ReturnValue=unavailable; providerError=$providerError; launcher=$launcher"
  }
  $providerResult = ($result | Format-List * | Out-String).Trim()
  if ($result.ReturnValue -ne 0) {
    throw "$label WMI call failed: Win32_Process.Create ReturnValue=$($result.ReturnValue); providerResult=$providerResult; launcher=$launcher"
  }
  $script:LaunchedPorts[$selectedPort] = $entry
  Write-Host "$label WMI Create succeeded ReturnValue=0 launcherPid=$($result.ProcessId) launcher=$launcher"
  $ready = Wait-Listener $label $selectedPort $entry $timeoutSeconds
  $owner = $ready.Pid
  Set-Content -LiteralPath (Get-PidFile $selectedPort) -Value $owner
  Write-Host ("$label started pid=$owner port=$selectedPort pidfile=$(Get-PidFile $selectedPort) listenerWait={0:N3}s" -f $ready.ElapsedSeconds)
  return $owner
}

$baseRunning = Test-AlreadyRunning $Port $BaseEntry
$appRunning = Test-AlreadyRunning $AppPort $AppEntry
if ($baseRunning -and $appRunning) {
  Write-Host "already running A pid=$(Get-PortOwner $Port) port=$Port; B pid=$(Get-PortOwner $AppPort) port=$AppPort"
  exit 0
}
if ($baseRunning -or $appRunning) {
  throw 'refusing partial start: exactly one configured service is already running; stop it first'
}
foreach ($spec in @(@{ Port = $Port; Entry = $BaseEntry }, @{ Port = $AppPort; Entry = $AppEntry })) {
  $owner = Get-PortOwner $spec.Port
  if ($owner) { throw "refusing to start: port $($spec.Port) is already listened to by pid $owner" }
  $recorded = Read-PidFile $spec.Port
  if ($recorded) { throw "refusing to start: stale or mismatched pidfile $(Get-PidFile $spec.Port) contains pid $recorded; inspect and remove it explicitly" }
}

$node = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path (Join-Path $HomeDir 'sessions') | Out-Null
$common = @{}
foreach ($item in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) { $common[$item.Key] = "$($item.Value)" }
$common['ASSIST_HOME'] = $AgentDir
$common['SOPHO_AGENT_DIR'] = $AgentDir
$common['PI_CODING_AGENT_DIR'] = $AgentDir
$common['SOPHO_CWD'] = $WorkDir
$common['SOPHO_HOST'] = $BindHost
$common['SOPHO_PORT'] = "$Port"

$baseEnvironment = $common.Clone()
$appEnvironment = $common.Clone()
$appEnvironment['SOPHO_APP_HOST'] = $AppHost
$appEnvironment['SOPHO_APP_PORT'] = "$AppPort"
$appEnvironment['SOPHO_UPSTREAM_HOST'] = $BindHost
$appEnvironment['SOPHO_UPSTREAM_PORT'] = "$Port"
$appEnvironment['SOPHO_WEB_ROOT'] = $WebRoot

function Stop-LaunchedPort([int]$selectedPort, [string]$entry, [int]$waitSeconds) {
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  do {
    $owner = Get-PortOwner $selectedPort
    if ($owner) {
      if (Test-OurProcess $owner $entry) {
        & taskkill.exe /PID $owner /T /F 2>$null | Out-Null
        Write-Host "cleanup: killed verified listener pid=$owner port=$selectedPort entry=$entry elapsed=$([math]::Round($watch.Elapsed.TotalSeconds, 1))s"
        return
      }
      Write-Warning "cleanup refused: port $selectedPort is owned by pid $owner whose command line is not $entry"
      return
    }
    Start-Sleep -Milliseconds 100
  } while ($watch.Elapsed.TotalSeconds -lt $waitSeconds)
  Write-Host "cleanup: no late listener appeared on port $selectedPort during ${waitSeconds}s grace"
}

$started = @()
try {
  $basePid = Start-Node 'A' 'base' $BaseEntry $Port $baseEnvironment $BaseLog $BaseErr $BaseStartTimeoutSeconds $node
  $started += @{ Port = $Port; Entry = $BaseEntry; Pid = $basePid }
  $appPid = Start-Node 'B' 'app' $AppEntry $AppPort $appEnvironment $AppLog $AppErr $AppStartTimeoutSeconds $node
  $started += @{ Port = $AppPort; Entry = $AppEntry; Pid = $appPid }

  $hostResult = Invoke-RestMethod -TimeoutSec 5 "http://127.0.0.1:$Port/host"
  $appResult = Invoke-RestMethod -TimeoutSec 5 "http://127.0.0.1:$AppPort/app-host"
  if ([int]$hostResult.pid -ne $basePid) { throw "/host pid $($hostResult.pid) does not match listener pid $basePid" }
  if ([int]$appResult.pid -ne $appPid) { throw "/app-host pid $($appResult.pid) does not match listener pid $appPid" }
} catch {
  $startError = $_
  foreach ($spec in $started) {
    Stop-LaunchedPort $spec.Port $spec.Entry 0
    Remove-Item -LiteralPath (Get-PidFile $spec.Port) -Force -ErrorAction SilentlyContinue
    $script:LaunchedPorts.Remove($spec.Port)
  }
  foreach ($selectedPort in @($script:LaunchedPorts.Keys)) {
    Stop-LaunchedPort $selectedPort $script:LaunchedPorts[$selectedPort] $LateCleanupSeconds
    Remove-Item -LiteralPath (Get-PidFile $selectedPort) -Force -ErrorAction SilentlyContinue
  }
  throw $startError
}

Write-Host "started A+B url=http://localhost:$AppPort/ baseLog=$BaseLog appLog=$AppLog"
if ($AppHost -eq '0.0.0.0' -or $AppHost -eq '::') {
  Write-Warning "B is bound to $AppHost with no authentication; any reachable client can execute commands on this machine."
}
