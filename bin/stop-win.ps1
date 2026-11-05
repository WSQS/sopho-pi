# sopho-pi v2.2 - Windows native A+B stop.
# Authority is the configured listener plus its matching pidfile. Never scans by
# process name and never signals a pid whose command line does not match our entry.
# v2.2 ports: SOPHO_PORT = A, SOPHO_APP_PORT = B.
# The default ports must stay paired with bin/serve-win.ps1, otherwise a bare `npm run stop:win`
# cannot stop the pair a bare `npm run serve:win` started. Live instance (same as bin/serve.sh):
# A=7331, B=7321. Explicit environment variables always win.
#
# Identity rule (byte-for-byte the rule bin/stop.sh uses): the pid that actually listens on the
# port is the authority, and its command line must name our entry before any signal is sent.
# A pidfile that is missing, empty, unparsable, or disagrees with the listener is *untrusted* -
# it is a cross-check, never a reason to skip a live port. The pidfile lives in %TEMP% and can be
# gone by stop time (the 2026-09-19 cutover hit exactly that: v2.1 skipped the port silently and
# exited 0; v2.2 refused). So when the pidfile is not usable we fall back to the listener pid on
# the port and still require its cmdline to be server/base.mjs / server/app.mjs. A port owner we
# cannot name is never signalled, pidfile or not: Windows reuses pid numbers, so the cmdline
# match is the only real guard, and a wrong kill is irreversible.
#
# Exit codes (stated here so callers never have to guess):
#   0  every configured service that was listening was verified (its cmdline names our entry) and
#      stopped, and both ports are confirmed free afterwards.
#   1  refused, or the stop did not complete: a listener whose cmdline is not our entry (with or
#      without a pidfile), a configured port with no listener at all, an invalid port pair, or a
#      kill / port-release wait that failed. A silent port is deliberately not a success: stopping
#      something that was not running must never read as a clean stop, otherwise a mistyped port
#      pair looks like a successful stop (test/win-serve.mjs pins the Windows behaviour - a second
#      stop exits 1, logged as "FALSE-SUCCESS EVIDENCE"). A *present* listener we cannot verify
#      fails loud here too, so an exit of 0 never means "we left a listener running".
[CmdletBinding()]
param(
  [int]$Port = 0,
  [int]$AppPort = 0
)
$ErrorActionPreference = 'Stop'

$Repo = Split-Path -Parent $PSScriptRoot
$BaseEntry = Join-Path $Repo 'server\base.mjs'
$AppEntry = Join-Path $Repo 'server\app.mjs'
$Tmp = if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
if ($Port -le 0) { $Port = if ($env:SOPHO_PORT) { [int]$env:SOPHO_PORT } else { 7331 } }
if ($AppPort -le 0) { $AppPort = if ($env:SOPHO_APP_PORT) { [int]$env:SOPHO_APP_PORT } else { 7321 } }

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

# 0 means "no usable pidfile" (missing, empty, or unparsable) - never a pid to trust.
function Read-PidFile([int]$selectedPort) {
  $file = Get-PidFile $selectedPort
  if (-not (Test-Path -LiteralPath $file)) { return 0 }
  $value = 0
  [int]::TryParse((Get-Content -LiteralPath $file -ErrorAction SilentlyContinue | Select-Object -First 1), [ref]$value) | Out-Null
  return $value
}

function Wait-Stopped([string]$label, [int]$selectedPort, [int]$processId) {
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    $owner = Get-PortOwner $selectedPort
    $alive = $null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)
    if (-not $owner -and -not $alive) {
      Write-Host "$label stopped pid=$processId port=$selectedPort"
      return
    }
    if ($owner -and $owner -ne $processId) { throw "$label pid $processId exited, but port $selectedPort is now owned by pid $owner" }
    Start-Sleep -Milliseconds 100
  }
  throw "timed out waiting for $label pid $processId to disappear and release port $selectedPort"
}

$specs = @(
  @{ Label = 'B'; Port = $AppPort; Entry = $AppEntry },
  @{ Label = 'A'; Port = $Port; Entry = $BaseEntry })
$targets = @()
$problems = @()
foreach ($spec in $specs) {
  $owner = Get-PortOwner $spec.Port
  $recorded = Read-PidFile $spec.Port
  $pidFile = Get-PidFile $spec.Port
  if (-not $owner) {
    # No listener: nothing can be signalled, and any pidfile here is stale by definition.
    if ($recorded) {
      Write-Host "$($spec.Label) not running on port $($spec.Port); removing stale pidfile $pidFile (pid=$recorded)"
      Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    } else {
      Write-Host "$($spec.Label) not running on port $($spec.Port); no pidfile $pidFile"
    }
    continue
  }
  # A listener exists. The port owner is the authority; say out loud when we are not
  # trusting the pidfile, so the fallback is visible in the run log rather than silent.
  if (-not $recorded) {
    Write-Host "$($spec.Label) pidfile $pidFile is missing or unreadable; falling back to listener pid $owner on port $($spec.Port)"
  } elseif ($recorded -ne $owner) {
    Write-Host "$($spec.Label) pidfile $pidFile records pid $recorded but port $($spec.Port) is owned by pid $owner; ignoring the untrusted pidfile"
  }
  # Whatever the pidfile said, only the verified listener is ever signalled.
  if (-not (Test-OurProcess $owner $spec.Entry)) {
    $source = if ($recorded) { "pidfile pid $recorded" } else { 'no pidfile' }
    $problems += "$($spec.Label) port $($spec.Port) is owned by pid $owner but its command line does not name $($spec.Entry) ($source)"
    continue
  }
  $targets += @{ Label = $spec.Label; Port = $spec.Port; Entry = $spec.Entry; Pid = $owner; PidFile = $pidFile }
}

if ($problems.Count -gt 0) {
  foreach ($problem in $problems) { Write-Error "refusing to stop: $problem" -ErrorAction Continue }
  exit 1
}
if ($targets.Count -eq 0) {
  # No verified listener on either port. Deliberately non-zero: "nothing was there" must not read
  # like a successful stop (see the exit-code note above).
  Write-Error "nothing stopped: no verified sopho-pi listeners on ports $Port and $AppPort"
  exit 1
}

foreach ($target in $targets) {
  # The verified A root owns generation-worker children. Kill only this exact tree so
  # stop leaves no orphan worker while still avoiding any process-name scan.
  & taskkill.exe /PID $target.Pid /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "taskkill failed for verified $($target.Label) pid $($target.Pid) (exit=$LASTEXITCODE)" }
  Wait-Stopped $target.Label $target.Port $target.Pid
  Remove-Item -LiteralPath $target.PidFile -Force -ErrorAction SilentlyContinue
}
if ($targets.Count -ne $specs.Count) {
  Write-Error "partial stop: stopped $($targets.Count) verified service(s), but the other configured service was not running"
  exit 1
}
Write-Host "stopped A+B ports=$Port,$AppPort; pidfiles removed"
