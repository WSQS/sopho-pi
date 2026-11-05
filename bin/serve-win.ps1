# sopho-pi v2 —— Windows 原生启动（等价于 bin/serve.sh）
#
# 为什么不能直接用 bin/serve.sh：那套脚本依赖 `ss -ltnp`（从端口反查监听者）、
# `setsid`（fork 出真进程）、`/proc/<pid>/cmdline`（核对 pid 是不是我们那个 node）——
# MSYS/Git Bash 里这三样都没有。Windows 上改用 WMI（Win32_Process.Create）起进程
# + Get-NetTCPConnection 从端口反查监听者 + Get-CimInstance 核对 cmdline。
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
#
# ─────────────────────────── 为什么是 WMI，而不是 Start-Process ───────────────────────────
# 症状（真事故）：`npm run serve:win | grep …`（或者 `$(npm run serve:win)`、被脚本/CI 包一层）
# **永远不返回** —— 上游 grep 等不到 EOF，管子里的调用挂到天荒地老。
#
# 机制**不是「忘了重定向」**：.NET 的 Process.Start 是 bInheritHandles=TRUE ——
# `-RedirectStandardOutput/-RedirectStandardError` 只重定向**流**，挡不住**其它可继承句柄**
# 被复制给子进程。A/B 是长命进程，会一直握着**调用方那条管道的写端**，于是调用方永远等不到 EOF。
#
# 修法：让 A/B 由 **WMI 服务**创建（`Invoke-CimMethod -ClassName Win32_Process -MethodName Create`）——
# 父子不在同一进程树里，**一个句柄都不继承**。修完的保证是：**起完就返回**，
# 可以安全地放进管道 / `$(…)` / CI 里调用。
#   · 代价一：拿不到 `$!` / `-PassThru` 的 pid → pid 照 bin/port-pid.sh 的既定规矩
#     **从端口反查监听者**（Get-NetTCPConnection 找 OwningProcess，再用 Get-CimInstance
#     核 cmdline 里确实是我们那个 server/base.mjs / server/app.mjs）。pidfile 里躺的就是
#     「谁在监听这个端口」，与 bin/stop-win.ps1 的判据一致。
#   · 代价二：WMI 起的进程**不继承调用方的环境变量**（它拿到的是 WMI 服务那份，实测
#     SOPHO_* / ASSIST_* 全空、TEMP 都不是调用方的）。而 PATH / 各家 API key / 本脚本
#     「这一刻解析出的端口与目录」必须传给孩子 → 所以**显式生成一个 .cmd 启动器**，
#     把「调用方的整个环境 + 我们的覆盖」一条条 `set` 进去，再由 WMI 去跑那个启动器。
#     日志重定向也写在启动器里。启动器落在 %TEMP%\sopho-run-{base,app}.cmd，是
#     「这一刻用的是哪个端口 / 哪个 HOME」可直接读的证据。（同一套做法见 bin/dev-serve.ps1。）
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
	# 与 bin/port-pid.sh 的 port_pid 同一条规矩：谁**监听**这个端口，谁才是那个进程
	try {
		$c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1
		if ($c) { return [int]$c.OwningProcess }
	} catch { }
	return 0
}

function Get-CmdLine([int]$procId) {
	if (-not $procId) { return '' }
	try { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop } catch { return '' }
	if (-not $p -or -not $p.CommandLine) { return '' }
	return ($p.CommandLine -replace '\\', '/')
}

function Test-OurNode([int]$procId, [string]$script) {
	# 与 bin/stop-win.ps1 / bin/port-pid.sh 同一条规矩：pid 会被系统复用，认之前先核 cmdline
	$cl = Get-CmdLine $procId
	if (-not $cl) { return $false }
	return ($cl -match [regex]::Escape($script))
}

# A 加载 pi 包要好几秒 —— 不能固定 sleep 2 就判生死，得轮询到真的应了。
function Wait-Http([string]$url, [int]$timeoutSec) {
	$deadline = (Get-Date).AddSeconds($timeoutSec)
	while ((Get-Date) -lt $deadline) {
		try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $url | Out-Null; return $true } catch { Start-Sleep -Milliseconds 500 }
	}
	return $false
}

function Get-LogTail([string]$file, [int]$n = 15) {
	if (-not (Test-Path -LiteralPath $file)) { return "$file（没有）" }
	$t = @(Get-Content -LiteralPath $file -Tail $n -ErrorAction SilentlyContinue)
	if ($t.Count -eq 0) { return "$file（空的）" }
	return ("$file`n" + ($t -join "`n"))
}

function ConvertTo-CmdSetLine([string]$name, [string]$value) {
	# .cmd 是 cmd.exe 读的批处理：值里的 `%` 会被当变量展开 → 双写成 `%%` 才是一个字面 `%`
	# （`&` `|` `<` `>` `^` `"` 在 `set "K=V"` 的引号里都是字面量，实测不用额外处理）
	return "set `"$name=$($value.Replace('%', '%%'))`""
}

function Write-LauncherCmd([string]$name, [string]$nodePath, [string]$scriptName, [hashtable]$envPairs, [string]$outFile, [string]$errFile) {
	# 为什么要这个启动器（而不是把 env 交给子进程）：Win32_Process.Create **不支持自定义环境变量**，
	# 而它起的进程是 WMI 服务那份环境（PATH / ASSIST_HOME / 端口全都不对）—— 所以 env 写进启动器。
	# 副作用反而是好事：「这一刻用的是哪个端口 / 哪个 HOME」在 %TEMP% 里留了一份可直接读的证据。
	$file = Join-Path $Tmp "sopho-run-$name.cmd"
	$lines = @(
		'@echo off',
		'rem 由 bin/serve-win.ps1 生成 —— 正式实例的启动器（WMI 起的进程不继承调用方 env，所以这里逐条 set）',
		'rem chcp 65001 + 本文件按 UTF-8 写：非 ASCII 的环境变量值（中文路径等）才能原样传给孩子',
		'chcp 65001 >nul',
		"cd /d `"$Repo`"")
	foreach ($k in ($envPairs.Keys | Sort-Object)) {
		$lines += ConvertTo-CmdSetLine $k ("$($envPairs[$k])")
	}
	$lines += 'rem start /b：cmd 立刻退出（不留中间壳）；node 的 stdout/stderr 直接落日志文件'
	$lines += "start `"`" /b `"$nodePath`" $scriptName 1>`"$outFile`" 2>`"$errFile`""
	[System.IO.File]::WriteAllLines($file, $lines, (New-Object System.Text.UTF8Encoding($false)))
	return $file
}

function Start-OurNode([string]$name, [string]$scriptName, [int]$port, [hashtable]$envPairs, [string]$outFile, [string]$errFile, [int]$timeoutSec, [string]$nodePath, [string]$probePath) {
	$cmdFile = Write-LauncherCmd $name $nodePath $scriptName $envPairs $outFile $errFile
	try {
		$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
			CommandLine      = "cmd.exe /c `"$cmdFile`""
			CurrentDirectory = $Repo
		} -ErrorAction Stop
	} catch {
		throw "起 $name 失败：这台机器上走不了 WMI（Win32_Process.Create）：$($_.Exception.Message)"
	}
	if ($r.ReturnValue -ne 0) { throw "起 $name 失败：Win32_Process.Create 返回 $($r.ReturnValue)（启动器：$cmdFile）" }

	$probe = "http://127.0.0.1:$port$probePath"
	if (-not (Wait-Http $probe $timeoutSec)) {
		throw @"
$name（$scriptName）没在 $timeoutSec 秒内应 $probe。
--- 启动器（$cmdFile）---
$(Get-Content -LiteralPath $cmdFile -ErrorAction SilentlyContinue | Out-String)
--- stderr ---
$(Get-LogTail $errFile)
--- stdout ---
$(Get-LogTail $outFile)
"@
	}
	# pid = **监听这个端口的人**（不是 WMI 返回的 cmd pid，也不是启动器 pid）—— 与 bin/port-pid.sh 同一规矩
	$procId = Get-PortOwner $port
	if (-not $procId) { throw "$name 应了，但端口 $port 上查不到监听者 —— 拒绝写 pidfile" }
	if (-not (Test-OurNode $procId $scriptName)) {
		throw "$name：端口 $port 的监听者是 pid $procId，但它的 cmdline 里没有 $scriptName —— 拒绝往 pidfile 里写一个不是我们的 pid"
	}
	return $procId
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

$OurSpecs = @(
	@{ Port = $BasePort; Script = 'server/base.mjs' },
	@{ Port = $AppPort; Script = 'server/app.mjs' })

foreach ($p in @(@{ Port = $BasePort; Name = 'A' }, @{ Port = $AppPort; Name = 'B' })) {
	$owner = Get-PortOwner $p.Port
	if ($owner) { throw "端口 $($p.Port) 已被 pid $owner 占用 —— 先 bin\stop-win.ps1 或手动处理。" }
}

$baseOut = Join-Path $Tmp 'sopho-base.log'
$baseErr = Join-Path $Tmp 'sopho-base.err.log'
$appOut = Join-Path $Tmp 'sopho-app.log'
$appErr = Join-Path $Tmp 'sopho-app.err.log'

# 起子进程那一刻的完整环境：① 调用方整个环境（以前 Start-Process 起 A/B 就是继承它的 ——
# 保留这个语义：PATH / 各家 API key / 别的工具要用的变量，一个都不能少，不然 A 里的会话会变哑）；
# ② 下面这些覆盖（脚本这一刻解析出的端口与目录，必须是孩子看到的那一份）。
$baseEnv = @{}
foreach ($e in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) { $baseEnv[$e.Key] = "$($e.Value)" }
$baseEnv['ASSIST_HOME'] = $HomeDir
$baseEnv['SOPHO_AGENT_DIR'] = $AgentDir
$baseEnv['SOPHO_BASE_PORT'] = "$BasePort"
$baseEnv['SOPHO_CWD'] = $WorkDir
# 根也要跟调用方进程一起进入 A；未设置时不写空值（paths.json 才能作为后备）。
if ($null -ne $env:SOPHO_PAGE_ROOT) { $baseEnv['SOPHO_PAGE_ROOT'] = $env:SOPHO_PAGE_ROOT }
if ($null -ne $env:SOPHO_EPUB_ROOT) { $baseEnv['SOPHO_EPUB_ROOT'] = $env:SOPHO_EPUB_ROOT }

$appEnv = $baseEnv.Clone()
$appEnv['SOPHO_BASE_URL'] = $BaseUrl
$appEnv['SOPHO_PORT'] = "$AppPort"
$appEnv['SOPHO_HOST'] = $BindHost

try {
	$pidA = Start-OurNode 'base' 'server/base.mjs' $BasePort $baseEnv $baseOut $baseErr 40 $node '/host'
	Set-Content -Path (Join-Path $Tmp "sopho-pi-$BasePort.pid") -Value $pidA
	Write-Host "==> A pid $pidA（端口所有者）  pidfile $Tmp\sopho-pi-$BasePort.pid"

	$pidB = Start-OurNode 'app' 'server/app.mjs' $AppPort $appEnv $appOut $appErr 20 $node '/api/tree'
	Set-Content -Path (Join-Path $Tmp "sopho-pi-$AppPort.pid") -Value $pidB
	Write-Host "==> B pid $pidB（端口所有者）  pidfile $Tmp\sopho-pi-$AppPort.pid"
} catch {
	Write-Host ''
	Write-Host "!! 起失败：$($_.Exception.Message)" -ForegroundColor Red
	foreach ($s in $OurSpecs) {
		# 回滚：只看**起之前核对过是空闲的那两个端口**，而且只杀 cmdline 对得上的那个 node。
		# 不 pkill、不按名字扫、不碰别的端口（起之前两个端口都是空的，这里的所有者只可能是我们起的）。
		$owner = Get-PortOwner $s.Port
		if ($owner -and (Test-OurNode $owner $s.Script)) {
			try { Stop-Process -Id $owner -Force -ErrorAction Stop; Write-Host "   已回滚 pid $owner（端口 $($s.Port)，$($s.Script)）" } catch { }
		}
		Remove-Item -LiteralPath (Join-Path $Tmp "sopho-pi-$($s.Port).pid") -Force -ErrorAction SilentlyContinue
	}
	exit 1
}

Write-Host "==> 起来了： http://localhost:$AppPort/    日志：$baseOut · $appOut"
Write-Host "    （启动器：$Tmp\sopho-run-base.cmd · sopho-run-app.cmd）"
if ($BindHost -eq '0.0.0.0') {
	Write-Host "!! 绑在 0.0.0.0:$AppPort —— 这个 UI 零认证，能连上它的人就能在这台机器上执行任意命令。"
}
