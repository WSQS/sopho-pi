# sopho-pi v2 —— Windows 原生停止（等价于 bin/stop.sh）
#
# 和 bash 版同一条规矩：**先核对 pidfile 里那个 pid 确实是我们那个 node**，再 kill。
# Windows 的 pid 也会复用 —— 不核对就可能打到无关进程（不可逆）。
# 核对用的是 Get-CimInstance 的 CommandLine 里有没有 server/base.mjs / server/app.mjs。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File bin\stop-win.ps1
[CmdletBinding()]
param(
	[int]$AppPort = 0,
	[int]$BasePort = 0
)
$ErrorActionPreference = 'Stop'
if ($BasePort -le 0) { $BasePort = if ($env:SOPHO_BASE_PORT) { [int]$env:SOPHO_BASE_PORT } else { 7331 } }
if ($AppPort -le 0) { $AppPort = if ($env:SOPHO_PORT) { [int]$env:SOPHO_PORT } else { 7321 } }
$Tmp = $env:TEMP

function Test-OurNode([int]$pid_, [string]$script) {
	if (-not $pid_) { return $false }
	try {
		$p = Get-CimInstance Win32_Process -Filter "ProcessId=$pid_" -ErrorAction Stop
	} catch { return $false }
	if (-not $p -or -not $p.CommandLine) { return $false }
	return ($p.CommandLine -replace '\\', '/' -match [regex]::Escape($script))
}

foreach ($pair in @(
		@{ Port = $AppPort; Script = 'server/app.mjs' },
		@{ Port = $BasePort; Script = 'server/base.mjs' })) {
	$f = Join-Path $Tmp "sopho-pi-$($pair.Port).pid"
	if (-not (Test-Path $f)) { Write-Host "跳过端口 $($pair.Port)：没有 pidfile（$f）"; continue }
	$pid_ = 0
	[int]::TryParse((Get-Content $f -ErrorAction SilentlyContinue | Select-Object -First 1), [ref]$pid_) | Out-Null
	if (Test-OurNode $pid_ $pair.Script) {
		Stop-Process -Id $pid_ -Force -ErrorAction SilentlyContinue
		Write-Host "已停止 pid $pid_（端口 $($pair.Port)，$($pair.Script)）"
	} elseif ($pid_) {
		Write-Host "跳过端口 $($pair.Port)：pidfile 里的 pid $pid_ 不是我们的 $($pair.Script)（cmdline 对不上，可能已被复用）—— 一个信号都没发"
	} else {
		Write-Host "跳过端口 $($pair.Port)：pidfile 是空的"
	}
	Remove-Item $f -Force -ErrorAction SilentlyContinue
}
Write-Host "（pidfile 已清。真没了没：Get-NetTCPConnection -LocalPort $AppPort,$BasePort -State Listen）"
