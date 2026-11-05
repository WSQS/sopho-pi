# sopho-pi —— **沙箱实例**（起一份绝不可能碰到主实例的 A+B，给以后所有验证用）
#
# 为什么要有这个文件：同一天里有 **3 个子会话**各自手搓了同一套东西来验自己的改动，
# 每次都得小心别碰到人类在用的主实例（A=7331 / B=7321 / B备用=7322）。手搓的四个动作全是易错点：
#   ① 换端口（SOPHO_BASE_PORT / SOPHO_PORT）
#   ② 用**临时** ASSIST_HOME（用真的就会往真数据里写会话/标题/归档 —— 不可逆）
#   ③ worktree 里没有 node_modules，得从主树挂一个 junction（**摘的时候用 rm -rf 会把主树的
#      node_modules 一起删掉** —— 这是个真陷阱）
#   ④ 停的时候只能按 pidfile / 精确 pid（本项目踩过三次 pkill：会连自己一起杀）
# 这些判断应该是脚本，不该每次让人重推一遍。
#
# 用法（终端或会话里都行 —— 它不会碰到主实例）：
#   npm run serve:dev                     # 起沙箱（**起完就返回**，放进管子/`$(…)`/CI 都不会挂）
#   npm run stop:dev                      # 停沙箱（只按 pidfile 停自己那两个 pid）
# 等价写法（Windows PowerShell 5.1 与 pwsh 7 都行）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File bin\dev-serve.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File bin\dev-serve.ps1 -Stop
#
# 参数 / 环境变量（都可用参数或环境变量覆盖；参数优先）：
#   -BasePort   / SOPHO_BASE_PORT   A 端口（默认 7433）
#   -AppPort    / SOPHO_PORT        B 端口（默认 7423）
#   -BindHost   / SOPHO_HOST        B 绑定地址（默认 **127.0.0.1** —— 见下面「取舍」）
#   -AssistHome / SOPHO_DEV_HOME / ASSIST_HOME   数据目录（默认 %TEMP%\sopho-dev-<8位随机>）
#   -AgentDir   / SOPHO_AGENT_DIR   pi 的模型/配置目录（默认 = 沙箱 home，理由见下）
#   -WorkDir    / SOPHO_CWD         新会话默认工作目录（默认 = 这个 worktree 根）
#
# ⚠️ 实测坑（写在前面，省得你回去查）：**住在主实例里的会话，环境里带着主实例自己的配置** ——
#     ASSIST_HOME=C:\Users\…\.pi\profiles\assistant · SOPHO_BASE_PORT=7331 · SOPHO_AGENT_DIR=… · SOPHO_CWD=…
#   所以在这种 shell 里一句裸的 `npm run serve:dev` 会**被护栏拦住**（而不是静默换一个口跑起来）——
#   这是故意的：报错里会直接告诉你「这个值来自环境变量」并给出覆盖命令。要么改用参数，要么：
#     SOPHO_BASE_PORT=7433 SOPHO_PORT=7423 SOPHO_DEV_HOME="$env:TEMP\sopho-dev-1" npm run serve:dev
#
# ───────────────────────── 三条硬护栏（本脚本的核心价值，不是可选项）─────────────────────────
#   1. **端口**：7331 / 7321 / 7322 是主实例端口 → 拒绝；端口被别人占 → 也拒绝。
#      两者都**不自动换一个**：静默换口会让人搞不清自己在打哪个实例。报错走人，让人自己定。
#   2. **ASSIST_HOME**：解析后等于真 profile（%USERPROFILE%\.pi\profiles\assistant）、
#      或在它里面、或是个指向它的链接 → 拒绝并说清为什么（会污染真数据）。
#   3. **node_modules**：worktree 里没有 → 自动 `cmd /c mklink /J` 挂主树的（junction，不复制）；
#      停的时候**只摘这条链接**（`cmd /c rmdir`，见 Remove-OurJunction）——**绝不 rm -rf**。
#
# ───────────────────────────────────── 取舍（为什么这么写）─────────────────────────────────────
#   · 为什么不改 bin/serve-win.ps1 加一个开关，而是另写一份：
#     serve-win 是「起正式实例」，本脚本是「起沙箱且拒绝正式端口」—— 两者的护栏方向**正好相反**。
#     合成一个带开关的脚本，会让「我到底在起哪个实例」变成一个参数问题，而那种歧义正是要消灭的东西。
#     重复的只有起进程/写 pidfile 那十几行，换来的是两个脚本各自读一眼就知道在干什么。
#   · 为什么 Windows-only、`.sh` 只是个指路牌：本仓的 .sh 依赖 ss / setsid / /proc/<pid>/cmdline，
#     MSYS 里这三样都没有；而「主树 node_modules 那个坑」本身只有 Windows 语法（mklink /J、cmd rmdir）。
#     写一份在本机跑不起来的 bash = 半吊子。所以逻辑只存在这一份，bin/dev-serve.sh 只负责引到这里。
#   · 为什么 B 默认绑 127.0.0.1（而 bin/serve.sh 默认 0.0.0.0）：这个 UI **零认证**，绑 0.0.0.0
#     等于把「在这台机器上执行任意命令」暴露给整个 LAN。主实例那么干是它的需求；沙箱只为自己验证，
#     没必要比正式实例更宽。想局域网联调：-BindHost 0.0.0.0（脚本会再吼一声）。
#   · 为什么 SOPHO_AGENT_DIR 默认 = 沙箱 home（而不指向真 profile）：指向真 profile 会读到真
#     models.json/auth.json（能跑真模型），但 pi 也**会往那儿写**（models-store.json 等）——那就不叫
#     「绝不可能碰到主实例」了。默认宁可牺牲「能真的问模型」，也要保证一个字都不写进真数据。
#     需要真配置时显式 -AgentDir <真 profile>，脚本会明确警告「那会读写真配置」。
#   · 为什么停的时候不删沙箱 home：里面是这次验证的证据（sessions/、logs/）。脚本只告诉你它在哪；
#     不要了你自己 Remove-Item -Recurse。**隐藏的删除**正是本任务要消灭的那类意外。
#   · 为什么要绕 WMI（Win32_Process.Create）起进程、而不是 `Start-Process -RedirectStandardOutput`：
#     见 Start-SandboxNode 上面那段长注释。一句话 —— .NET 的 Process.Start 是 bInheritHandles=TRUE，
#     `-RedirectStandardOutput` 只重定向**流**、挡不住「子进程继承调用方的管道写端」，于是
#     `npm run serve:dev | grep …` 会**永远不返回**（今天真事故：挂了 20 分钟）。
#     修完的保证是：**serve:dev 起完就返回**，可以安全地放进管子 / `$(…)` / CI 里调用。
#     代价：拿不到 `$!`；pid 照 bin/port-pid.sh 那套既定规矩 —— **从端口反查监听者**。
#
# 日志：<沙箱 home>\logs\{base,app}.{log,err.log} —— 刻意**不**写 %TEMP%\sopho-base.log
#       （那是主实例的日志文件，沙箱不该覆盖它）。

[CmdletBinding()]
param(
	[switch]$Stop,
	[string]$AssistHome = '',
	[string]$AgentDir = '',
	[string]$BindHost = '',
	[string]$WorkDir = '',
	[int]$BasePort = 0,
	[int]$AppPort = 0
)
$ErrorActionPreference = 'Stop'

$Repo = Split-Path -Parent $PSScriptRoot
$Tmp = $env:TEMP
$RealProfile = Join-Path $env:USERPROFILE '.pi\profiles\assistant'
$StateFile = Join-Path $Tmp 'sopho-dev-sandbox.json'

# 主实例端口 —— 沙箱**一个都不许碰**。7322 是 server/app.mjs 自己的默认值（7322 也被占用了，
# 说明有第二份 B 在跑），所以也一并禁掉。
$ReservedPorts = @{
	7331 = '主实例 A（会话基底）'
	7321 = '主实例 B（Web UI）'
	7322 = '主实例 B 的备用端口（server/app.mjs 的默认值，实测也被占用）'
}

# 这个值是从哪来的 —— 报错时要说清楚，不然“我没设 7331 啊”会很难查。
# 实测发现：**住在主实例里的会话**，环境里带着主实例自己的配置
#   ASSIST_HOME=C:\Users\…\.pi\profiles\assistant
#   SOPHO_BASE_PORT=7331 / SOPHO_AGENT_DIR=… / SOPHO_CWD=…
# 于是一句裸的 `npm run serve:dev` 在会话里会**被护栏拦住**（而不是静默换个口跑起来）。
# 这是故意的：宁可报错，也不让人分不清自己在打哪个实例。解法就写在报错里。
$script:PORT_ORIGIN = ''
$script:HOME_ORIGIN = ''

function Get-OriginHint([string]$origin) {
	if ($origin -like '环境变量*') {
		return "`n**这个值来自环境变量，不是你敲的参数** —— 你多半正住在主实例的会话里（会话继承了主实例的 $origin）。"
	}
	return ''
}

# ───────────────────────────────────── 小工具 ─────────────────────────────────────

function Get-NormPath([string]$p) {
	# GetFullPath 吃掉 `./`、`..`、尾部分隔符的歧义 —— 护栏全靠「解析后相等」这条判据
	if (-not $p) { return '' }
	try { $full = [System.IO.Path]::GetFullPath($p) } catch { return '' }
	return $full.TrimEnd('\', '/')
}

function Test-SamePath([string]$a, [string]$b) {
	$na = Get-NormPath $a
	$nb = Get-NormPath $b
	if (-not $na -or -not $nb) { return $false }
	return [string]::Equals($na, $nb, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-PathInside([string]$child, [string]$parent) {
	$nc = Get-NormPath $child
	$np = Get-NormPath $parent
	if (-not $nc -or -not $np) { return $false }
	return $nc.StartsWith($np + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-ReparseTargets([string]$p) {
	# 若这个路径本身是个 junction/symlink，把目标交出来 —— 「指到真 profile 的一条链接」也得堵住
	if (-not (Test-Path -LiteralPath $p)) { return @() }
	try { $i = Get-Item -LiteralPath $p -Force } catch { return @() }
	if (-not ($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { return @() }
	if (-not $i.Target) { return @() }
	return @($i.Target)
}

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
	# 与 bin/stop.sh / port-pid.sh 同一条规矩：pid 会被系统复用，kill 之前必须核对 cmdline。
	# 核对不过 → 一个信号都不发（宁可不停，也不误杀）。
	$cl = Get-CmdLine $procId
	if (-not $cl) { return $false }
	return ($cl -match [regex]::Escape($script))
}

function Write-Log([string]$msg) { Write-Host $msg }

function Die([string]$msg) {
	# 护栏拒绝：干净地红字说清楚 + 非零退出。
	# 为什么不用裸 throw：throw 会把 CategoryInfo / FullyQualifiedErrorId 那一大块糊在真正的原因后面，
	# 而护栏的**价值全在那句话上**（人得一眼看懂为什么被拒、怎么改）。
	Write-Host ''
	Write-Host $msg -ForegroundColor Red
	Write-Host ''
	exit 1
}

# ───────────────────────────── 护栏 ①：ASSIST_HOME 不许真 ─────────────────────────────

function Assert-SandboxHome([string]$dataHome) {
	$h = Get-NormPath $dataHome
	if (-not $h) { Die "拒绝：沙箱 ASSIST_HOME 解析出来是空的。不猜一个，请显式给 -AssistHome。" }
	$real = Get-NormPath $RealProfile

	if (Test-SamePath $h $real) {
		Die @"
拒绝：ASSIST_HOME 指到了**真 profile**：
    $h
真 profile 是主实例正在用的数据目录（sessions/ · titles.json · archive.json · exports/ · settled.json · seen.json …）。
沙箱往这儿写 = 污染真数据：会话、标题、归档全是**不可逆**的。
没有 --force、不给覆盖：这是本脚本存在的唯一理由。
（想动真数据，请用 bin\serve-win.ps1 / npm run serve —— 那不是沙箱该干的事。）$(Get-OriginHint $script:HOME_ORIGIN)
一条命令覆盖成临时 home：
    `$env:SOPHO_DEV_HOME = "`$env:TEMP\sopho-dev-1" ; npm run serve:dev     # 或传参数：-AssistHome "`$env:TEMP\sopho-dev-1"
"@
	}
	if (Test-PathInside $h $real) {
		Die "拒绝：ASSIST_HOME 落在**真 profile 里面**（$h ⊂ $real）—— 一样会把真数据弄脏（多出一层 dev 的 sessions/exports）。"
	}
	foreach ($t in (Get-ReparseTargets $h)) {
		if ((Test-SamePath $t $real) -or (Test-PathInside $t $real)) {
			Die "拒绝：ASSIST_HOME 是个链接，指向真 profile（$h → $t）—— 写入会原样落到真数据上。"
		}
	}
	return $h
}

# ───────────────────────────── 护栏 ②：端口不许主实例/不许占用 ─────────────────────────────

function Assert-SandboxPort([int]$port, [string]$label) {
	if ($port -le 0 -or $port -gt 65535) { Die "拒绝：$label 端口 '$port' 不是个合法端口。" }
	if ($ReservedPorts.ContainsKey($port)) {
		Die @"
拒绝：$label 端口 $port 是**主实例端口**（$($ReservedPorts[$port])）。
沙箱**绝不许**起在主实例端口上 —— 那会顶着人类正在用的实例（写它的 pidfile、抢它的端口）。
换个端口（沙箱默认：A=7433 / B=7423）。
**不自动换**：静默换口会让你分不清自己到底在打哪个实例。$(Get-OriginHint $script:PORT_ORIGIN)
一条命令覆盖成沙箱默认端口：
    SOPHO_BASE_PORT=7433 SOPHO_PORT=7423 npm run serve:dev
"@
	}
	$owner = Get-PortOwner $port
	if ($owner) {
		$cl = Get-CmdLine $owner
		$originHint = Get-OriginHint $script:PORT_ORIGIN
		Die @"
拒绝：$label 端口 $port 已被 pid $owner 占用。
    $cl
沙箱不抢端口、也不自动换口（静默换口会让你分不清在打哪个实例）。
先处理掉它（bin\stop-win.ps1 或手动），或者换一个端口。$originHint
"@
	}
}

# ───────────────────────────── 护栏 ③：node_modules junction ─────────────────────────────

function Get-MainRepoRoot {
	# worktree 里 `git rev-parse --git-common-dir` 给出**主仓库**的 .git —— 它的父目录就是主树根
	$common = ''
	try { $common = (& git -C $Repo rev-parse --git-common-dir 2>$null) } catch { return '' }
	if (-not $common) { return '' }
	$common = ([string]$common).Trim()
	if (-not [System.IO.Path]::IsPathRooted($common)) { $common = Join-Path $Repo $common }
	return (Split-Path -Parent (Get-NormPath $common))
}

function Remove-OurJunction {
	# **本文件唯一一处删除动作**，且只删「指向主树 node_modules 的那条 junction」：
	#   用 `cmd /c rmdir`（不带 /s）—— 它拆的是**链接本身**，主树的目标一个字节都不动。
	#   绝不用 `rm -rf` / `Remove-Item -Recurse`：顺着 junction 递归下去会把**主树**的
	#   node_modules 真删掉（MSYS 的 rm 就是这么干的）。这是本脚本最不能错的一行。
	$nm = Join-Path $Repo 'node_modules'
	if (-not (Test-Path -LiteralPath $nm)) { return }
	$i = Get-Item -LiteralPath $nm -Force
	if (-not ($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
		Write-Log "==> node_modules 是真目录（不是我们挂的链接）→ **不碰**"
		return
	}
	$targets = @($i.Target)
	$mainRoot = Get-MainRepoRoot
	$expected = if ($mainRoot) { Get-NormPath (Join-Path $mainRoot 'node_modules') } else { '' }
	$isOurs = $false
	foreach ($t in $targets) { if ($expected -and (Test-SamePath $t $expected)) { $isOurs = $true } }
	if (-not $isOurs) {
		Write-Log "==> node_modules 是个链接但指向别处（$($targets -join ', ')）→ **不碰**（不是我们挂的）"
		return
	}
	& cmd.exe /c rmdir "$nm" | Out-Null
	if (Test-Path -LiteralPath $nm) {
		Write-Log "==> ⚠️ 摘 junction 没成功（cmd rmdir 退出码 $LASTEXITCODE）→ 留在原地，没敢换别的删法"
		return
	}
	# 摘完**真去核一下主树**（这是本脚本最不能错的一步：要是 main 的 node_modules 被掏了，
	# 那是整个开发环境都没了）。node_modules 里没有 package.json（npm 写的是 .package-lock.json），
	# 所以“还活着”的判据是：目录还在且非空。
	$targetAlive = $false
	if (Test-Path -LiteralPath $expected) {
		try { $targetAlive = @(Get-ChildItem -LiteralPath $expected -Force -ErrorAction Stop).Count -gt 0 } catch { $targetAlive = $false }
	}
	if ($targetAlive) {
		Write-Log "==> 已摘 junction（cmd rmdir，不带 /s）→ 主树 node_modules 完好（非空）：$expected"
	} else {
		Write-Log "==> 🔴 已摘 junction，但主树 $expected 看着空了/没了 —— 立刻核一下！"
	}
}

function Ensure-NodeModules {
	$nm = Join-Path $Repo 'node_modules'
	if (Test-Path -LiteralPath $nm) {
		$i = Get-Item -LiteralPath $nm -Force
		if ($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
			Write-Log "==> node_modules 已是个链接 → $($i.Target)（用现成的；停的时候只在它指向主树时才摘）"
		} else {
			Write-Log "==> node_modules 已在（真目录，本 worktree 自己装的）"
		}
		return
	}
	$mainRoot = Get-MainRepoRoot
	$target = if ($mainRoot) { Join-Path $mainRoot 'node_modules' } else { '' }
	if (-not $target -or -not (Test-Path -LiteralPath $target)) {
		$mainRootText = if ($mainRoot) { $mainRoot } else { '(git rev-parse --git-common-dir 没给出结果)' }
	Die @"
拒绝：本 worktree 里没有 node_modules，也推算不出主树的 node_modules。
    worktree  = $Repo
    主树推算  = $mainRootText
请二选一：
    · 在主树里 npm install，然后重跑本脚本（会自动 mklink /J 挂过来，不占额外空间）；
    · 在这个 worktree 里自己 npm install（彻底独立，但要下 ~300MB）。
"@
	}
	# junction（不是复制）：主树那份依赖原地共享，worktree 不占空间；沙箱只读着用。
	& cmd.exe /c mklink /J "$nm" "$target" | Out-Null
	if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $nm)) {
		Die "创建 junction 失败：mklink /J `"$nm`" `"$target`"（退出码 $LASTEXITCODE）"
	}
	Write-Log "==> node_modules 缺失 → 已挂 junction：$nm → $target"
	Write-Log "    （停的时候只摘这条链接：cmd /c rmdir —— **绝不 rm -rf**，那会连主树的 node_modules 一起删）"
}

# ───────────────────────────────────── 起 ─────────────────────────────────────

function Wait-Http([string]$url, [int]$timeoutSec, $proc) {
	# A 加载 pi 包要好几秒 —— 不能固定 sleep 2 就判生死，得轮询到真的应了（同 bin/serve-win.ps1）
	$deadline = (Get-Date).AddSeconds($timeoutSec)
	while ((Get-Date) -lt $deadline) {
		if ($proc -and $proc.HasExited) { return $false }
		try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $url | Out-Null; return $true } catch { Start-Sleep -Milliseconds 500 }
	}
	return $false
}

function Show-Banner([int]$bp, [int]$ap, [string]$dataHome, [string]$bindHost) {
	$bar = '=' * 72
	Write-Host ''
	Write-Host $bar
	Write-Host '  🧪 沙箱实例已起 —— 主实例（7331/7321/7322）一个字都没碰'
	Write-Host "     在打这个 URL   : http://localhost:$ap/    （A/API: http://127.0.0.1:$bp/）绑在 $bindHost"
	Write-Host "     用的是这个 HOME: $dataHome"
	Write-Host "     怎么停         : npm run stop:dev    （powershell -NoProfile -File bin\dev-serve.ps1 -Stop）"
	Write-Host $bar
}

if ($Stop) {
	# ────────────────────────────────── 停 ──────────────────────────────────
	# 规矩照 bin/stop.sh：**只认 pidfile**，kill 前核对 cmdline（pid 会被复用）。
	# **绝不用 pkill / 「按名字杀 node」** —— 本项目的 A/B 自己就是 node，一锅端会连自己一起杀（踩过三次）。
	$state = $null
	if (Test-Path -LiteralPath $StateFile) {
		try { $state = Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json } catch { $state = $null }
	}

	if ($BasePort -le 0) {
		if ($state -and $state.basePort) { $BasePort = [int]$state.basePort }
		elseif ($env:SOPHO_BASE_PORT) { $BasePort = [int]$env:SOPHO_BASE_PORT }
		else { $BasePort = 7433 }
	}
	if ($AppPort -le 0) {
		if ($state -and $state.appPort) { $AppPort = [int]$state.appPort }
		elseif ($env:SOPHO_PORT) { $AppPort = [int]$env:SOPHO_PORT }
		else { $AppPort = 7423 }
	}

	# 先给停这一侧也上护栏：万一被喂了主实例端口，**一个信号都不发**
	foreach ($p in @($BasePort, $AppPort)) {
		if ($ReservedPorts.ContainsKey($p)) {
			Die "拒绝：要停的端口 $p 是主实例端口（$($ReservedPorts[$p])）。stop:dev 只停沙箱，绝不碰主实例。"
		}
	}

	$stoppedAny = $false
	foreach ($pair in @(
			@{ Port = $AppPort; Script = 'server/app.mjs' },
			@{ Port = $BasePort; Script = 'server/base.mjs' })) {
		$port = $pair.Port
		$script = $pair.Script
		$f = Join-Path $Tmp "sopho-pi-$port.pid"
		if (-not (Test-Path -LiteralPath $f)) {
			Write-Log "跳过端口 $port：没有 pidfile（$f）—— 不是本脚本起的，不猜着杀"
			continue
		}
		$procId = 0
		[int]::TryParse((Get-Content -LiteralPath $f -ErrorAction SilentlyContinue | Select-Object -First 1), [ref]$procId) | Out-Null

		if (-not $procId) {
			Write-Log "跳过端口 $port：pidfile 是空的 → 删掉它（本来就过期了）"
			Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
			continue
		}
		if (-not (Test-OurNode $procId $script)) {
			Write-Log "跳过端口 $port：pidfile 里的 pid $procId 不是我们的 $script（cmdline 对不上，可能已被复用）—— **一个信号都没发**"
			Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
			continue
		}
		# 双保险：这个 pid 还得真的坐着**沙箱那个端口**；并且不许是任何主实例端口的监听者
		$owner = Get-PortOwner $port
		if ($owner -ne $procId) {
			$ownerText = if ($owner) { "$owner" } else { '(没人在听)' }
			Write-Log "跳过端口 $port：pid $procId 的 cmdline 像我们的 $script，但它不是这个端口的监听者（监听者是 $ownerText）—— **一个信号都没发**"
			Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
			continue
		}
		$isMain = $false
		foreach ($rp in $ReservedPorts.Keys) { if ((Get-PortOwner $rp) -eq $procId) { $isMain = $true } }
		if ($isMain) {
			Write-Log "跳过端口 $port：pid $procId 正听着**主实例端口** → 这不对，**一个信号都没发**"
			continue
		}

		Stop-Process -Id $procId -Force -ErrorAction Stop
		Write-Log "已停止 pid $procId（端口 $port，$script）"
		$stoppedAny = $true
		Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
	}
	if (-not $stoppedAny) { Write-Log "（没有停掉任何进程）" }

	Remove-OurJunction

	if ($state) {
		Write-Log "沙箱 home 留着没删（里面是这次验证的证据）：$($state.home)"
		Write-Log "    不要了：Remove-Item -Recurse -Force '$($state.home)'"
		Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
	}
	Write-Log "（pidfile 已清。真没了没：Get-NetTCPConnection -LocalPort $AppPort,$BasePort -State Listen）"
	Write-Log "（主实例：curl -s http://localhost:7331/host · curl -sI http://localhost:7321/）"
	exit 0
}

# ────────────────────────────── 起（默认参数 + 护栏）──────────────────────────────

if ($BasePort -le 0) {
	if ($env:SOPHO_BASE_PORT) { $BasePort = [int]$env:SOPHO_BASE_PORT; $baseOrigin = '环境变量 SOPHO_BASE_PORT' }
	else { $BasePort = 7433; $baseOrigin = '沙箱默认' }
}
else { $baseOrigin = '参数 -BasePort' }
if ($AppPort -le 0) {
	if ($env:SOPHO_PORT) { $AppPort = [int]$env:SOPHO_PORT; $appOrigin = '环境变量 SOPHO_PORT' }
	else { $AppPort = 7423; $appOrigin = '沙箱默认' }
}
else { $appOrigin = '参数 -AppPort' }
if (-not $BindHost) { $BindHost = if ($env:SOPHO_HOST) { $env:SOPHO_HOST } else { '127.0.0.1' } }
if (-not $WorkDir) { $WorkDir = if ($env:SOPHO_CWD) { $env:SOPHO_CWD } else { $Repo } }
if (-not $AssistHome) {
	if ($env:SOPHO_DEV_HOME) { $AssistHome = $env:SOPHO_DEV_HOME; $script:HOME_ORIGIN = '环境变量 SOPHO_DEV_HOME' }
	elseif ($env:ASSIST_HOME) { $AssistHome = $env:ASSIST_HOME; $script:HOME_ORIGIN = '环境变量 ASSIST_HOME' }
	else { $AssistHome = Join-Path $Tmp ('sopho-dev-' + [guid]::NewGuid().ToString('N').Substring(0, 8)); $script:HOME_ORIGIN = '沙箱默认（临时目录）' }
}
else { $script:HOME_ORIGIN = '参数 -AssistHome' }
if ($BasePort -eq $AppPort) { Die "拒绝：A 和 B 配成了同一个端口（$BasePort）—— 会自己踩自己。" }

# 「上一份沙箱还在跑」要比「端口被占」先报 —— 后者会让人以为是哪个不认识的进程，
# 前者直接告诉他：是你自己的一份沙箱，用 npm run stop:dev 收掉。
# （状态文件是本脚本自己的世界：一次**只跑一份**沙箱，所以它是全局的、单个的。）
if (Test-Path -LiteralPath $StateFile) {
	$prev = $null
	try { $prev = Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json } catch { $prev = $null }
	if ($prev -and $prev.basePort) {
		$prevAB = Get-PortOwner ([int]$prev.basePort)
		$prevBB = Get-PortOwner ([int]$prev.appPort)
		$liveA = Test-OurNode $prevAB 'server/base.mjs'
		$liveB = Test-OurNode $prevBB 'server/app.mjs'
		if ($liveA -or $liveB) {
			Die @"
拒绝：**上一份沙箱还在跑**（A pid $prevAB 端口 $($prev.basePort) / B pid $prevBB 端口 $($prev.appPort)）。
本脚本一次只跑一份沙箱（pidfile 与状态文件都是全局单份的）。先收掉它：
    npm run stop:dev
"@
		}
		Write-Log "==> 有个旧的沙箱状态文件但进程已不在（A pid $prevAB / B pid $prevBB 都不认了）→ 顺手清掉：$StateFile"
		Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
	}
}

$script:PORT_ORIGIN = $baseOrigin
Assert-SandboxPort $BasePort 'A（会话基底）'
$script:PORT_ORIGIN = $appOrigin
Assert-SandboxPort $AppPort 'B（Web UI）'
$SandboxHome = Assert-SandboxHome $AssistHome

if (-not $AgentDir) { $AgentDir = if ($env:SOPHO_AGENT_DIR) { $env:SOPHO_AGENT_DIR } else { $SandboxHome } }
$AgentDir = Get-NormPath $AgentDir
if ((Test-SamePath $AgentDir $RealProfile) -or (Test-PathInside $AgentDir $RealProfile)) {
	Write-Warning "SOPHO_AGENT_DIR 指到了真 profile：$AgentDir"
	Write-Warning "  pi 会**读写**那儿的 models.json / auth.json / models-store.json —— 这不是「碰不到主实例」了。"
	Write-Warning "  （只有「要真的问模型」时才这么干；本脚本照跑，但这个警告是认真的。）"
}
if ($BindHost -eq '0.0.0.0' -or $BindHost -eq '::') {
	Write-Warning "B 绑在 $BindHost —— 这个 UI **零认证**，能连上它的人就能在这台机器上执行任意命令。沙箱默认绑 127.0.0.1。"
}

Write-Log "==> 沙箱 A 会话基底  127.0.0.1:$BasePort   sessions=$SandboxHome\sessions"
Write-Log "==> 沙箱 B 应用层    ${BindHost}:$AppPort   agentDir=$AgentDir"
Ensure-NodeModules

$node = (Get-Command node -ErrorAction Stop).Source
$logs = Join-Path $SandboxHome 'logs'
New-Item -ItemType Directory -Force -Path (Join-Path $SandboxHome 'sessions') | Out-Null
New-Item -ItemType Directory -Force -Path $logs | Out-Null

$baseOut = Join-Path $logs 'base.log'
$baseErr = Join-Path $logs 'base.err.log'
$appOut = Join-Path $logs 'app.log'
$appErr = Join-Path $logs 'app.err.log'

# 环境变量**显式写在生成的 .cmd 里**（不再靠「子进程继承本进程的 env」）——见 Start-SandboxNode 的注释。
# 这几项就是「沙箱」的全部：端口 + 数据目录都指到临时处，真数据一个字节不碰。
$commonEnv = @{
	ASSIST_HOME       = $SandboxHome
	ASSIST_SESSIONS   = (Join-Path $SandboxHome 'sessions')
	SOPHO_AGENT_DIR   = $AgentDir
	SOPHO_CWD         = $WorkDir
}
$baseEnv = $commonEnv.Clone()
$baseEnv['SOPHO_BASE_PORT'] = "$BasePort"
$appEnv = $commonEnv.Clone()
$appEnv['SOPHO_BASE_URL'] = "http://127.0.0.1:$BasePort"
$appEnv['SOPHO_PORT'] = "$AppPort"
$appEnv['SOPHO_HOST'] = $BindHost

function Write-LauncherCmd([string]$name, [string]$scriptName, [hashtable]$envPairs, [string]$outFile, [string]$errFile) {
	# 生成一个 .cmd 启动器。为什么不是直接把 env 交给子进程：下面 Start-SandboxNode 走的是
	# Win32_Process.Create，而它**不支持自定义环境变量**；所以 env 写进启动器里。
	# 副作用反而是好事：「这一刻用的是什么端口 / 什么 HOME」在日志目录里留了一份可直接读的证据。
	# ⚠️ 只支持 ASCII 路径（.cmd 是 ANSI/OEM）。本仓路径如此；非 ASCII 路径会让 node 起不来，
	#    这时会 Die 并附日志尾巴（不会静默把路径改错）。
	$file = Join-Path $logs "run-$name.cmd"
	$lines = @('@echo off', 'rem 由 bin/dev-serve.ps1 生成 —— 沙箱实例的启动器', "cd /d `"$Repo`"")
	foreach ($k in ($envPairs.Keys | Sort-Object)) {
		$v = ("$($envPairs[$k])").Replace('"', '')
		$lines += "set `"$k=$v`""
	}
	$lines += 'rem start /b：cmd 立刻退出（不留中间壳）；node 的 stdout/stderr 直接落日志文件'
	$lines += "start `"`" /b `"$node`" $scriptName 1>`"$outFile`" 2>`"$errFile`""
	[System.IO.File]::WriteAllLines($file, $lines)
	return $file
}

function Get-LogTail([string]$file, [int]$n = 12) {
	if (-not (Test-Path -LiteralPath $file)) { return "$file（没有）" }
	$t = @(Get-Content -LiteralPath $file -Tail $n -ErrorAction SilentlyContinue)
	if ($t.Count -eq 0) { return "$file（空的）" }
	return ("$file`n" + ($t -join "`n"))
}

function Start-SandboxNode([string]$name, [string]$scriptName, [int]$port, [hashtable]$envPairs, [string]$outFile, [string]$errFile, [int]$timeoutSec) {
	# 为什么要绕 WMI，而不是就 `Start-Process -RedirectStandardOutput …`：
	#   今天真事故：`npm run serve:dev | grep …` **永远不返回**。
	#   原因：.NET 的 Process.Start 是 bInheritHandles=TRUE —— 它会把**调用方管道的写端**
	#   一并复制给子进程（`-RedirectStandardOutput` 只重定向**流**，挡不住其它可继承句柄的复制）。
	#   于是长命的 A/B 一直握着那条管道的写端，`grep` / `$(…)` / CI 里的调用永远等不到 EOF。
	#   最小复现：`powershell -File t.ps1 | grep x` 用 Start-Process 起一个长命 node → 必挂（已验）。
	#   修法：让子进程**由 WMI 服务**（Win32_Process.Create）创建 —— 父子不同进程树，一个句柄都不继承。
	#   代价：拿不到 `$!`；pid 照 bin/port-pid.sh 的既定规矩，**从端口反查监听者**。
	$cmdFile = Write-LauncherCmd $name $scriptName $envPairs $outFile $errFile
	try {
		$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
			CommandLine    = "cmd.exe /c `"$cmdFile`""
			CurrentDirectory = $Repo
		} -ErrorAction Stop
	} catch {
		Die "起 $name 失败：这台机器上走不了 WMI（Win32_Process.Create）：$($_.Exception.Message)"
	}
	if ($r.ReturnValue -ne 0) { Die "起 $name 失败：Win32_Process.Create 返回 $($r.ReturnValue)（启动器：$cmdFile）" }

	$probe = if ($name -eq 'A') { "http://127.0.0.1:$port/host" } else { "http://127.0.0.1:$port/" }
	if (-not (Wait-Http $probe $timeoutSec $null)) {
		$cmdTail = Get-Content -LiteralPath $cmdFile -ErrorAction SilentlyContinue | Out-String
		throw "$name 没在 $timeoutSec 秒内应（$probe）。`n--- 启动器 ---`n$cmdTail`n--- stderr ---`n$(Get-LogTail $errFile)`n--- stdout ---`n$(Get-LogTail $outFile)"
	}
	# pid = **监听这个端口的人**（不是 $!，也不是 WMI 返回的 cmd pid）—— 与 bin/port-pid.sh 同一条规矩
	$procId = Get-PortOwner $port
	if (-not $procId) { throw "$name 应了，但端口 $port 上查不到监听者 —— 拒绝写 pidfile" }
	return $procId
}

$startedPorts = @(
	@{ Port = $BasePort; Script = 'server/base.mjs' },
	@{ Port = $AppPort; Script = 'server/app.mjs' })
try {
	$pidA = Start-SandboxNode 'A' 'server/base.mjs' $BasePort $baseEnv $baseOut $baseErr 40
	Set-Content -Path (Join-Path $Tmp "sopho-pi-$BasePort.pid") -Value $pidA
	Write-Log "==> A pid $pidA（端口所有者）  pidfile $Tmp\sopho-pi-$BasePort.pid"

	$pidB = Start-SandboxNode 'B' 'server/app.mjs' $AppPort $appEnv $appOut $appErr 25
	Set-Content -Path (Join-Path $Tmp "sopho-pi-$AppPort.pid") -Value $pidB
	Write-Log "==> B pid $pidB（端口所有者）  pidfile $Tmp\sopho-pi-$AppPort.pid"
} catch {
	Write-Host ''
	Write-Host "!! 起沙箱失败：$($_.Exception.Message)" -ForegroundColor Red
	foreach ($s in $startedPorts) {
		# 回滚：只看**刚才核对过是空闲的那两个端口**，而且只杀 cmdline 对得上的那个 node。
		# 不用 pkill、不按名字扫、不碰别的端口（起之前两个端口都是空的，所以这里的所有者只可能是我们自己起的）。
		$owner = Get-PortOwner $s.Port
		if ($owner -and (Test-OurNode $owner $s.Script)) {
			try { Stop-Process -Id $owner -Force -ErrorAction Stop; Write-Host "   已回滚 pid $owner（端口 $($s.Port)，$($s.Script)）" } catch { }
		}
		Remove-Item -LiteralPath (Join-Path $Tmp "sopho-pi-$($s.Port).pid") -Force -ErrorAction SilentlyContinue
	}
	exit 1
}

@{ basePort = $BasePort; appPort = $AppPort; home = $SandboxHome; agentDir = $AgentDir; workDir = $WorkDir
	bindHost = $BindHost; logs = $logs; startedAt = (Get-Date).ToString('s')
} | ConvertTo-Json | Set-Content -Path $StateFile

Show-Banner $BasePort $AppPort $SandboxHome $BindHost
Write-Log "==> 日志：$baseOut · $appOut    （状态文件：$StateFile）"
Write-Log "==> 自检：curl -s http://127.0.0.1:$BasePort/host · curl -sI http://localhost:$AppPort/"
