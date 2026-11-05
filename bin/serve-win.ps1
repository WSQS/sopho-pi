# sopho-pi v2 —— Windows 原生启动（等价于 bin/serve.sh）
#
# 为什么不能直接用 bin/serve.sh：那套脚本依赖 `ss -ltnp`（从端口反查监听者）、
# `setsid`（fork 出真进程）、`/proc/<pid>/cmdline`（核对 pid 是不是我们那个 node）——
# MSYS/Git Bash 里这三样都没有。Windows 上改用 Start-Process（拿到的就是 node 自己的
# pid，没有 setsid 那个「$! 是包装进程」的坑）+ Get-CimInstance 核对 cmdline。
#
# 用法（在终端，不要在会话里）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File bin\serve-win.ps1
# 可选环境变量 / 参数：
#   SOPHO_HOST       对外绑定地址（默认 0.0.0.0，与 bin/serve.sh 一致；想只开本机用 127.0.0.1）
#   SOPHO_PORT       B 端口（默认 7321）
#   SOPHO_BASE_PORT  A 端口（默认 7331）
#   ASSIST_HOME      数据目录（默认 %USERPROFILE%\.pi\profiles\assistant）
#   SOPHO_AGENT_DIR  模型 / 插件 profile（默认 = ASSIST_HOME）
#   SOPHO_CWD        无父会话的新会话默认工作目录（默认 = 仓库根）
#   SOPHO_DRY_RUN=1  只打印会起什么，不动进程
[CmdletBinding()]
param(
	[string]$BindHost = $env:SOPHO_HOST,
	[int]$AppPort = 0,
	[int]$BasePort = 0
)
$ErrorActionPreference = 'Stop'

$Repo = Split-Path -Parent $PSScriptRoot
$HomeDir = if ($env:ASSIST_HOME) { $env:ASSIST_HOME } else { Join-Path $env:USERPROFILE '.pi\profiles\assistant' }
$AgentDir = if ($env:SOPHO_AGENT_DIR) { $env:SOPHO_AGENT_DIR } else { $HomeDir }
if (-not $BindHost) { $BindHost = '0.0.0.0' }
if ($BasePort -le 0) { $BasePort = if ($env:SOPHO_BASE_PORT) { [int]$env:SOPHO_BASE_PORT } else { 7331 } }
if ($AppPort -le 0) { $AppPort = if ($env:SOPHO_PORT) { [int]$env:SOPHO_PORT } else { 7321 } }
$WorkDir = if ($env:SOPHO_CWD) { $env:SOPHO_CWD } else { $Repo }
$BaseUrl = "http://127.0.0.1:$BasePort"
$Tmp = $env:TEMP

function Get-PortOwner([int]$port) {
	try {
		$c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1
		if ($c) { return $c.OwningProcess }
	} catch { }
	return $null
}

# A 加载 pi 包要好几秒 —— 不能固定 sleep 2 就判生死，得轮询到真的应了。
function Wait-Http([string]$url, [int]$timeoutSec, [System.Diagnostics.Process]$proc) {
	$deadline = (Get-Date).AddSeconds($timeoutSec)
	while ((Get-Date) -lt $deadline) {
		if ($proc -and $proc.HasExited) { return $false }
		try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $url | Out-Null; return $true } catch { Start-Sleep -Milliseconds 500 }
	}
	return $false
}

Write-Host "==> A 会话基底  127.0.0.1:$BasePort   sessions=$HomeDir\sessions"
Write-Host "==> B 应用层    ${BindHost}:$AppPort   agentDir=$AgentDir"

if ($env:SOPHO_DRY_RUN -eq '1') {
	Write-Host "==> [dry-run] 会起 A / B（SOPHO_DRY_RUN=1，什么都没起）"
	exit 0
}

$node = (Get-Command node).Source
if (-not $node) { throw "PATH 里找不到 node" }
New-Item -ItemType Directory -Force -Path (Join-Path $HomeDir 'sessions') | Out-Null

foreach ($p in @(@{ Port = $BasePort; Name = 'A' }, @{ Port = $AppPort; Name = 'B' })) {
	$owner = Get-PortOwner $p.Port
	if ($owner) { throw "端口 $($p.Port) 已被 pid $owner 占用 —— 先 bin\stop-win.ps1 或手动处理。" }
}

# 子进程继承当前 PowerShell 的环境变量
$env:ASSIST_HOME = $HomeDir
$env:SOPHO_AGENT_DIR = $AgentDir
$env:SOPHO_BASE_PORT = "$BasePort"
$env:SOPHO_CWD = $WorkDir

$baseOut = Join-Path $Tmp 'sopho-base.log'
$baseErr = Join-Path $Tmp 'sopho-base.err.log'
$appOut = Join-Path $Tmp 'sopho-app.log'
$appErr = Join-Path $Tmp 'sopho-app.err.log'

$a = Start-Process -FilePath $node -ArgumentList 'server/base.mjs' -WorkingDirectory $Repo `
	-WindowStyle Hidden -PassThru -RedirectStandardOutput $baseOut -RedirectStandardError $baseErr
Set-Content -Path (Join-Path $Tmp "sopho-pi-$BasePort.pid") -Value $a.Id
if (-not (Wait-Http $BaseUrl'/host' 40 $a)) {
	if ($a.HasExited) { throw "A 没起来（退出码 $($a.ExitCode)）—— 看 $baseErr" }
	throw "A 40 秒内没应 $BaseUrl/host —— 看 $baseErr"
}
Write-Host "==> A pid $($a.Id)  pidfile $Tmp\sopho-pi-$BasePort.pid"

$env:SOPHO_BASE_URL = $BaseUrl
$env:SOPHO_PORT = "$AppPort"
$env:SOPHO_HOST = $BindHost

$b = Start-Process -FilePath $node -ArgumentList 'server/app.mjs' -WorkingDirectory $Repo `
	-WindowStyle Hidden -PassThru -RedirectStandardOutput $appOut -RedirectStandardError $appErr
Set-Content -Path (Join-Path $Tmp "sopho-pi-$AppPort.pid") -Value $b.Id
if (-not (Wait-Http "http://127.0.0.1:$AppPort/api/tree" 20 $b)) {
	if ($b.HasExited) { throw "B 没起来（退出码 $($b.ExitCode)）—— 看 $appErr" }
	throw "B 20 秒内没应 —— 看 $appErr"
}
Write-Host "==> B pid $($b.Id)  pidfile $Tmp\sopho-pi-$AppPort.pid"

Write-Host "==> 起来了： http://localhost:$AppPort/    日志：$baseOut · $appOut"
if ($BindHost -eq '0.0.0.0') {
	Write-Host "!! 绑在 0.0.0.0:$AppPort —— 这个 UI 零认证，能连上它的人就能在这台机器上执行任意命令。"
}
