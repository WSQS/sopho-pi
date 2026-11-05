#!/usr/bin/env node
// test/pre-push.mjs —— G-06「pre-push 密钥闸」的机械契约（docs/feature-parity.md G-06，P0 安全项）。
//
// 全部在**临时 git 仓库 + 临时假远端**里跑：
//   · 不 push 本仓库、不碰任何真 remote（远端是 mkdtemp 里的 `git init --bare`）
//   · **不装本仓库的钩子**（那会改共享 config，影响别的 worktree）：本仓库的
//     core.hooksPath 在跑前跑后各读一次，必须一字不差。
//     ⚠️ 真仓的**工作区**（`git status` / HEAD）是**共享**状态、本门对真仓没有写路径，所以那份读数是
//       **记录**而不是断言 —— 否则别的进程（另一条工作线的脚本、人的终端）在本门这一两秒里写一下，
//       本门就会红在一个它从没碰过的路径上（2026-09-25 实测，见第 4 节那段注释）。
//   · 子进程一律用「空 global/system config + 沙箱 HOME」隔离，不继承本机 git 配置
//   · 临时目录跑完删掉；用到的"密钥"都是**自造的假串**，且断言钩子不会回显原文
//
// 跑法：npm run test:prepush
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(root, 'bin', 'hooks', 'pre-push');
const INSTALL = path.join(root, 'bin', 'install-hooks.sh');
const TMP_PREFIX = 'v22-prepush-';

const log = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const lineWith = (text, re) => (text.split('\n').find((l) => re.test(l)) ?? '').trim();

const leftoverBefore = readdirSync(os.tmpdir()).filter((n) => n.startsWith(TMP_PREFIX));
const sandbox = mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
const emptyConfig = path.join(sandbox, 'empty.gitconfig');
writeFileSync(emptyConfig, '');
const home = path.join(sandbox, 'home');
mkdirSync(home, { recursive: true });

// 隔离后的子进程环境：global/system config 用空文件顶掉，免得本机设置干扰结论。
const baseEnv = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_CONFIG_SYSTEM: emptyConfig,
  GIT_TERMINAL_PROMPT: '0',
};
delete baseEnv.SOPHO_PREPUSH_ALLOW;

/** 真仓库的只读快照。用**真实**环境读，不用隔离环境。
 *
 * ⚠️ 这里读到的三样东西**归属不同**，第 4 节按归属判：
 *   · `hooksPath` —— **本门名下**：只有本门会去装真钩子（它绝不），所以它可以断言；
 *   · `head` / `worktree` —— **共享**状态：别的进程（人在终端里、另一条工作线的脚本）随时会写，
 *     本门对真仓没有写路径 ⇒ 只**记录**、不判定（为什么见第 4 节那段注释）。
 */
function realRepoSnapshot() {
  const run = (args) => {
    const res = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    return { status: res.status, out: (res.stdout ?? '').trim(), err: (res.stderr ?? '').trim() };
  };
  return {
    at: Date.now(),
    hooksPath: run(['config', '--get', 'core.hooksPath']),
    head: run(['rev-parse', 'HEAD']),
    worktree: run(['status', '--porcelain']),
  };
}
const realBefore = realRepoSnapshot();

function git(cwd, args, env = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...baseEnv, ...env } });
  assert.equal(res.status, 0, `git ${args.join(' ')} 意外失败：${res.stderr ?? ''}`);
  return (res.stdout ?? '').trim();
}

function makeRepo(name) {
  const dir = path.join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'prepush-smoke@test.invalid']);
  git(dir, ['config', 'user.name', 'prepush smoke']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

function writeFiles(dir, files) {
  for (const f of files) {
    const abs = path.join(dir, f.path);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
}

function commitFiles(dir, files, message, { force = false } = {}) {
  writeFiles(dir, files);
  for (const f of files) git(dir, ['add', ...(force ? ['-f'] : []), '--', f.path]);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

const ZERO = '0'.repeat(40);
const pushLine = (localSha, remoteSha) => `refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`;

/** 直接按 git 的调用形状跑钩子：stdin 是 4 字段行，退出码非 0 ⇒ git 会中止推送。 */
function runHook(cwd, input, env = {}) {
  const res = spawnSync('sh', [HOOK], { cwd, input, encoding: 'utf8', env: { ...baseEnv, ...env } });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** stdin 塞的是**新版**（raw/sshkey 都在内），一律走「新分支形状」= 扫 local sha 可达的提交。 */
function runHookNewBranch(cwd, localSha, env = {}) {
  return runHook(cwd, pushLine(localSha, ZERO), env);
}

function assertBlocked(res, label, { file, rule } = {}) {
  assert.notEqual(res.status, 0, `${label}：钩子必须非 0 退出（否则就是静默放行）`);
  assert.match(res.stderr, /pre-push 拦截/, `${label}：必须说清是被 pre-push 拦下的`);
  if (file) assert.ok(res.stderr.includes(file), `${label}：必须点名文件 ${file}；实际 ${res.stderr}`);
  if (rule) assert.ok(res.stderr.includes(rule), `${label}：必须说清规则「${rule}」；实际 ${res.stderr}`);
  assert.ok(!res.stderr.includes('✔'), `${label}：拦截时不许出现"成功"字样`);
}

function makeRemote(name) {
  const dir = path.join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '--bare', '-b', 'main']);
  return dir.replace(/\\/g, '/');
}

function pushTo(repo, remoteDir, { args = [], env = {} } = {}) {
  const res = spawnSync('git', ['push', ...args, remoteDir, 'main'], { cwd: repo, encoding: 'utf8', env: { ...baseEnv, ...env } });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function remoteHead(remoteDir) {
  const res = spawnSync('git', ['--git-dir', remoteDir, 'rev-parse', '--verify', '-q', 'refs/heads/main'], { encoding: 'utf8', env: baseEnv });
  return res.status === 0 ? (res.stdout ?? '').trim() : null;
}

let pass = 0;
const cases = [];
function caseOk(name, note) {
  pass += 1;
  cases.push(name);
  log(`  ✓ ${name}`, note ?? '');
}

// 假串（**不是**任何真密钥；长度/形状够触发规则即可）。
// ⚠️ 一律用 join('') **拼**出来，不写字面量：pre-push 会扫推送范围内的**全部 blob**，
//    本文件自己就带着「即将推出去的提交」里的一个 blob —— 写字面量的话，这道闸会把
//    「加这道闸的那次提交」拦在门外（2026-09-17 实测踩到：提交 e0ca4bd 被自家钩子拦下，
//    证据 `test/pre-push.mjs` 命中 `sk-*`）。拼起来后，文件里没有任何一处满足 `sk-` + 16 位。
const FAKE_SK = ['sk-', 'FAKEtestKEY0123456789abcdef'].join('');
const FAKE_PEM = ['-----BEGIN ', 'OPENSSH PRIVATE KEY-----', '\nZmFrZS1ub3QtYS1yZWFsLWtleQ==\n', '-----END ', 'OPENSSH PRIVATE KEY-----\n'].join('');
const FAKE_AKIA = ['AKIA', 'FAKEFAKEFAKEFAKE'].join('');
const FAKE_GH = ['ghp_', 'FAKEfakeFAKEfakeFAKEfakeFAKEfake'].join('');
const FAKE_GLPAT = ['glpat-', 'FAKEfake-fake-fake-fake'].join('');
const FAKE_XOX = ['xox', 'b-', 'FAKE-fake-fake-fake'].join(''); // xox 那条规则**没有**长度要求 ⇒ 连 4 字节的前缀也不能写成字面量（本行也踩过一次）

let primaryError;
try {
  // ---------------------------------------------------------------- 0. 静态
  log('cases', '静态断言');
  assert.ok(existsSync(HOOK), `缺 ${HOOK}`);
  assert.ok(existsSync(INSTALL), `缺 ${INSTALL}`);
  const hookText = readFileSync(HOOK, 'utf8');
  const installText = readFileSync(INSTALL, 'utf8');
  assert.ok(hookText.startsWith('#!/bin/sh\n'), 'pre-push 必须 #!/bin/sh（Git for Windows 也走这一份）');
  assert.ok(!hookText.includes('\r'), 'pre-push 不许有 CR（CRLF 会咬 shebang）');
  assert.ok(!installText.includes('\r'), 'install-hooks.sh 不许有 CR');
  // 可执行位：只对**已进索引**的文件断言（未提交时无从查证 —— 如实跳过，不假装验过）
  const modes = git(root, ['ls-files', '-s', '--', 'bin/hooks/pre-push', 'bin/install-hooks.sh']);
  if (!modes) {
    log('  ⚠ SKIP', '两份脚本还没进 index（未 git add）—— 可执行位这条没验');
  } else {
    assert.match(modes, /^100755 [0-9a-f]+ 0\tbin\/hooks\/pre-push$/m, `pre-push 在 git 里必须是可执行位 100755：${modes}`);
    assert.match(modes, /^100755 [0-9a-f]+ 0\tbin\/install-hooks\.sh$/m, `install-hooks.sh 在 git 里必须是 100755：${modes}`);
    caseOk('静态：两份脚本 LF + 在 index 里都是 100755', modes.replace(/\n/g, ' | '));
  }

  // ------------------------------------------------- 1. install-hooks.sh
  log('cases', '安装脚本（幂等 / loud）');
  {
    const repo = makeRepo('install-ok');
    writeFiles(repo, [{ path: 'bin/hooks/pre-push', content: hookText }, { path: 'bin/install-hooks.sh', content: installText }]);
    const run = (env = {}) => spawnSync('sh', [path.join(repo, 'bin/install-hooks.sh')], { cwd: repo, encoding: 'utf8', env: { ...baseEnv, ...env } });
    const first = run();
    assert.equal(first.status, 0, `首次安装必须成功：${first.stderr}`);
    assert.equal(git(repo, ['config', '--get', 'core.hooksPath']), 'bin/hooks');
    const second = run();
    assert.equal(second.status, 0, `重复安装必须成功（幂等）：${second.stderr}`);
    const third = run();
    assert.equal(third.status, 0, `第三次安装必须成功（幂等）：${third.stderr}`);
    assert.equal(git(repo, ['config', '--get', 'core.hooksPath']), 'bin/hooks');
    assert.equal(git(repo, ['config', '--local', '--get-all', 'core.hooksPath']), 'bin/hooks', '不许叠成多条配置');
    assert.equal(first.stdout, second.stdout, '幂等：两次 stdout 必须一样');
    assert.equal(second.stdout, third.stdout, '幂等：三次 stdout 必须一样');
    assert.match(first.stdout, /已安装 pre-push 钩子/);
    assert.match(first.stdout, /git 解析结果\s+= .*bin\/hooks/);
    // 从**子目录**跑也必须解析对（git 在子目录里回的是相对 cwd 的 ../bin/hooks）
    const sub = path.join(repo, 'deep', 'sub');
    mkdirSync(sub, { recursive: true });
    const fromSub = spawnSync('sh', [path.join(repo, 'bin/install-hooks.sh')], { cwd: sub, encoding: 'utf8', env: baseEnv });
    assert.equal(fromSub.status, 0, `子目录里装也得成功：${fromSub.stderr}`);
    assert.ok(!fromSub.stderr.includes('假闸门'), `子目录里不该误报假闸门：${fromSub.stderr}`);
    assert.match(fromSub.stdout, /git 解析结果\s+= .*\/bin\/hooks/, '解析结果必须指到本 checkout 的 bin/hooks');
    caseOk('安装：装 3 次，status/stdout/config 都一样（幂等，不叠加）', first.stdout.split('\n').filter((l) => l.trim()).join(' / '));
    caseOk('安装：从子目录跑也解析对（不误报“假闸门”）', lineWith(fromSub.stdout, /git 解析结果/));
  }
  {
    const outside = path.join(sandbox, 'not-a-repo');
    mkdirSync(outside, { recursive: true });
    const res = spawnSync('sh', [INSTALL], { cwd: outside, encoding: 'utf8', env: baseEnv });
    assert.notEqual(res.status, 0, '不在 git 仓库里必须非 0');
    assert.match(res.stderr, /不在 git 仓库里/);
    caseOk('安装：不在仓库里 ⇒ 非 0 + 说明', lineWith(res.stderr, /不在 git 仓库里/));
  }
  {
    const repo = makeRepo('install-no-hook');
    const res = spawnSync('sh', [INSTALL], { cwd: repo, encoding: 'utf8', env: baseEnv });
    assert.notEqual(res.status, 0, '缺 bin/hooks/pre-push 必须非 0（否则就是装了一道假闸门）');
    assert.match(res.stderr, /找不到/);
    const read = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: repo, encoding: 'utf8', env: baseEnv });
    assert.notEqual(read.status, 0, '缺钩子时**不许**改 core.hooksPath');
    caseOk('安装：缺 bin/hooks/pre-push ⇒ 非 0 + 什么都不改', lineWith(res.stderr, /找不到/));
  }
  {
    const repo = makeRepo('install-existing-hooks');
    writeFiles(repo, [
      { path: 'bin/hooks/pre-push', content: hookText },
      { path: '.git/hooks/pre-commit', content: '#!/bin/sh\necho pre-existing\n' },
    ]);
    const res = spawnSync('sh', [INSTALL], { cwd: repo, encoding: 'utf8', env: baseEnv });
    assert.equal(res.status, 0, `装得成：${res.stderr}`);
    assert.match(res.stderr, /静默失效/, '必须点名警告既有钩子会被顶掉');
    assert.match(res.stderr, /pre-commit/, '必须点出是哪个钩子');
    caseOk('安装：.git/hooks 里有非 .sample 钩子 ⇒ 点名警告（不静默）', lineWith(res.stderr, /静默失效/));
  }
  {
    // 写 core.hooksPath 失败：POSIX 上把 .git/config 设只读可以造出来；NTFS 上造不出来 ⇒ 显式跳过并说明。
    const probe = path.join(sandbox, 'ro-probe');
    mkdirSync(probe, { recursive: true });
    git(probe, ['init', '-q', '-b', 'main']);
    const probeCfg = path.join(probe, '.git', 'config');
    const mode = statSync(probeCfg).mode & 0o777;
    let writeFails = false;
    try {
      chmodSync(probeCfg, 0o444);
      writeFails = spawnSync('git', ['config', 'core.hooksPath', 'bin/hooks'], { cwd: probe, encoding: 'utf8', env: baseEnv }).status !== 0;
    } finally {
      chmodSync(probeCfg, mode);
    }
    if (!writeFails) {
      log('  ⚠ SKIP', '本机（NTFS）把 .git/config 设只读也拦不住 git config 写 —— 这条分支没在本机跑到');
    } else {
      const repo = makeRepo('install-ro-config');
      writeFiles(repo, [{ path: 'bin/hooks/pre-push', content: hookText }]);
      const cfg = path.join(repo, '.git', 'config');
      const m = statSync(cfg).mode & 0o777;
      try {
        chmodSync(cfg, 0o444);
        const res = spawnSync('sh', [INSTALL], { cwd: repo, encoding: 'utf8', env: baseEnv });
        assert.notEqual(res.status, 0, 'config 写不进去必须非 0（v2.1-final 版会打印 ✔ 并退出 0）');
        assert.match(res.stderr, /写 core.hooksPath 失败/);
        assert.ok(!res.stdout.includes('✔'), '不许打印"已安装"');
        caseOk('安装：core.hooksPath 写不进去 ⇒ 非 0（不打印"已安装"）', lineWith(res.stderr, /写 core.hooksPath 失败/));
      } finally {
        chmodSync(cfg, m);
      }
    }
  }
  {
    // 更高优先级的 config 源把 core.hooksPath 顶掉了 ⇒ 写"成功"但读回来不是 bin/hooks。
    // 这不是人为怪招：真有人用 GIT_CONFIG_* 注入时，闸就是假的，必须非 0。
    const repo = makeRepo('install-overridden');
    writeFiles(repo, [{ path: 'bin/hooks/pre-push', content: hookText }]);
    const overridden = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: 'somewhere-else' };
    const res = spawnSync('sh', [INSTALL], { cwd: repo, encoding: 'utf8', env: { ...baseEnv, ...overridden } });
    assert.notEqual(res.status, 0, 'core.hooksPath 被更高优先级来源顶掉时必须非 0');
    assert.match(res.stderr, /不当作安装成功/);
    assert.ok(!res.stdout.includes('✔'), '不许打印"已安装"');
    caseOk('安装：core.hooksPath 读回来不是 bin/hooks ⇒ 非 0（不做"假成功"）', lineWith(res.stderr, /不当作安装成功/));
  }

  // ------------------------------------------- 2. 扫什么（直接跑钩子）
  log('cases', '扫描规则（直接按 git 的调用形状跑 bin/hooks/pre-push）');
  {
    const repo = makeRepo('clean');
    const sha = commitFiles(repo, [
      { path: 'README.md', content: '# hi\n' },
      { path: 'src/a.txt', content: 'hello world\n' },
      { path: 'src/b.txt', content: 'more text\n' },
    ], 'clean');
    const res = runHookNewBranch(repo, sha);
    assert.equal(res.status, 0, `干净内容必须放行：${res.stderr}`);
    assert.equal(res.stderr.trim(), '', '干净内容不该有输出');
    caseOk('放行：普通文件（文本/文档）', `status=${res.status} stderr=∅`);
  }
  {
    const contentRules = [
      { name: 'sk-*（云 API key）', content: `X=${FAKE_SK}\n`, rule: /内容规则 sk-\*/, secret: FAKE_SK },
      { name: 'PEM 私钥头', content: FAKE_PEM, rule: /内容规则 PRIVATE KEY 头/, secret: 'BEGIN OPENSSH PRIVATE KEY' },
      { name: 'AKIA*（AWS）', content: `aws=${FAKE_AKIA}\n`, rule: /内容规则 AKIA\*/, secret: FAKE_AKIA },
      { name: 'ghp_*（GitHub PAT）', content: `t=${FAKE_GH}\n`, rule: /内容规则 ghp_\*/, secret: FAKE_GH },
      { name: 'glpat-*（GitLab PAT）', content: `t=${FAKE_GLPAT}\n`, rule: /内容规则 glpat-\*/, secret: FAKE_GLPAT },
      { name: 'xox[baprs]-（Slack）', content: `t=${FAKE_XOX}\n`, rule: /内容规则 xox\[baprs\]-/, secret: FAKE_XOX },
    ];
    for (const [i, c] of contentRules.entries()) {
      const repo = makeRepo(`content-${i}`);
      const sha = commitFiles(repo, [
        { path: 'notes/thing.txt', content: c.content },
        { path: 'notes/marker.txt', content: `${i}\n` },
      ], `leak ${i}`);
      const res = runHookNewBranch(repo, sha);
      assertBlocked(res, `内容规则 ${c.name}`, { file: 'notes/thing.txt' });
      assert.match(res.stderr, c.rule);
      assert.ok(!res.stderr.includes(c.secret), `不许回显原文（${c.name}）`);
      assert.match(res.stderr, /证据：.{1,12}…（共 \d+ 字节）/, '证据只留前 6 位 + 长度');
      caseOk(`拦：内容规则 ${c.name}（蒙面，不回显原文）`, lineWith(res.stderr, /证据：/));
    }
  }
  {
    // 白名单反证臂：仓库里那个**已知的测试夹具字面量**单独出现时放行；
    // 同一个 blob 里还有别的命中时，必须照旧红（白名单不许吞掉旁证）。
    const allowlisted = ['sk-', 'abcdefghijklmnopq'].join(''); // 字面量在这里也拼出来，免得本文件自己变成新的命中源
    const repo = makeRepo('allowlist');
    const onlyFixture = commitFiles(repo, [
      { path: 'fixture/key.txt', content: `bad key ${allowlisted}\n` },
      { path: 'ok.txt', content: 'ok\n' },
    ], 'only the known fixture literal');
    const resOnly = runHookNewBranch(repo, onlyFixture);
    assert.equal(resOnly.status, 0, `只含已知夹具字面量 ⇒ 必须放行：${resOnly.stderr}`);
    caseOk('放行：只含已知夹具字面量（不是真 key）', `status=${resOnly.status}`);

    const mixed = commitFiles(repo, [
      { path: 'fixture/key.txt', content: `bad key ${allowlisted}\n` },
      { path: 'fixture/other.txt', content: `k=${FAKE_SK}\n` },
    ], 'fixture + another key');
    const resMixed = runHookNewBranch(repo, mixed);
    assertBlocked(resMixed, '夹具字面量 + 另一个密钥', { file: 'fixture/other.txt' });
    assert.match(resMixed.stderr, /内容规则 sk-\*/);
    caseOk('拦：同一推送里「夹具字面量 + 别的密钥」照样红（白名单只放过一个精确串）', lineWith(resMixed.stderr, /内容规则/));
  }
  {
    // 路径规则：内容里**没有**任何密钥形状，也必须拦（v2.1 事故真正的肇事者）
    const pathRules = [
      { path: 'tests/perf/ssh-scroll/raw/agent/models.json', content: '{"apiKey":"plain-text-no-pattern"}\n', rule: /路径规则 raw\/\{agent,sshd\}\//, tag: 'profile 快照' },
      { path: 'tests/perf/ssh-scroll/raw/sshd/id_probe', content: 'not-a-key\n', rule: /路径规则 raw\/\{agent,sshd\}\//, tag: 'sshd 探针私钥' },
      { path: 'secrets/id_rsa', content: 'not-a-key\n', rule: /路径规则 私钥文件名 id_rsa/, tag: 'id_rsa 文件名' },
      { path: 'some/dir/id_ed25519', content: 'not-a-key\n', rule: /路径规则 私钥文件名 id_ed25519/, tag: 'id_ed25519 文件名' },
      { path: '.env', content: 'TOKEN=not-a-pattern\n', rule: /路径规则 \.env 文件/, tag: '.env（git add -f 强加）', force: true },
    ];
    for (const [i, c] of pathRules.entries()) {
      const repo = makeRepo(`path-${i}`);
      const sha = commitFiles(repo, [{ path: c.path, content: c.content }, { path: 'ok.txt', content: 'ok\n' }], `path rule ${i}`, { force: c.force === true });
      const res = runHookNewBranch(repo, sha);
      assertBlocked(res, `路径规则 ${c.path}`, { file: c.path });
      assert.match(res.stderr, c.rule);
      caseOk(`拦：路径规则 ${c.tag}（内容不含密钥形状也拦）`, lineWith(res.stderr, /路径规则/));
    }
  }
  {
    // 普通推送形状（remote..local）：老提交干净，新提交带密钥 —— 这就是"重放出来的那条提交"的形状
    const repo = makeRepo('incremental');
    const base = commitFiles(repo, [{ path: 'app.js', content: 'console.log(2)\n' }], 'base');
    const tip = commitFiles(repo, [{ path: 'conf/leak.txt', content: `k=${FAKE_SK}\n` }], 'leak on top');
    const res = runHook(repo, pushLine(tip, base));
    assertBlocked(res, '增量推送', { file: 'conf/leak.txt' });
    // 同一条历史：只推 base 这个干净提交 ⇒ 放行
    const clean = runHook(repo, pushLine(base, ZERO));
    assert.equal(clean.status, 0, `只推到干净提交必须放行：${clean.stderr}`);
    caseOk('拦：增量推送只扫 remote..local（干净的前缀仍能单独推）', lineWith(res.stderr, /拦截/));
  }
  {
    const repo = makeRepo('degrade');
    const tip = commitFiles(repo, [{ path: 'a.txt', content: 'x\n' }, { path: 'b/leak.txt', content: `k=${FAKE_SK}\n` }], 'leak');
    const unknown = 'deadbeef'.repeat(5); // 40 位十六进制，但不存在 ⇒ 远端 sha 未知
    const res = runHook(repo, pushLine(tip, unknown));
    assertBlocked(res, '远端 sha 未知（force push 常见形状）', { file: 'b/leak.txt' });
    assert.match(res.stderr, /退化扫描提示/, '退化成扫整条历史时必须明说');
    caseOk('拦：远端 sha 未知 ⇒ 退化为扫整条历史（并明说）', lineWith(res.stderr, /退化扫描/));
  }
  {
    const repo = makeRepo('delete');
    commitFiles(repo, [{ path: 'a.txt', content: 'x\n' }, { path: 'b.txt', content: 'y\n' }], 'two');
    const res = runHook(repo, pushLine(ZERO, 'deadbeef'.repeat(5)));
    assert.equal(res.status, 0, `删分支形状必须放行：${res.stderr}`);
    assert.equal(res.stderr.trim(), '', '删分支形状不该有输出');
    caseOk('放行：删除分支/标签（local sha 全 0）不误报', `status=${res.status}`);
  }
  {
    const repo = makeRepo('bigblob');
    const big = 'A'.repeat(2 * 1024 * 1024 + 4096);
    const sha = commitFiles(repo, [{ path: 'a.txt', content: 'x\n' }, { path: 'big.txt', content: big }], 'big');
    const res = runHookNewBranch(repo, sha);
    assert.equal(res.status, 0, `大文本且无密钥 ⇒ 放行：${res.stderr}`);
    assert.match(res.stderr, /跳过 1 个超过 2097152 字节的大 blob/, '跳过内容扫描必须**报数**（不静默）');
    caseOk('放行但报数：>2MB blob 跳过内容扫描（明确打印跳过个数）', lineWith(res.stderr, /跳过/));
  }
  {
    const repo = makeRepo('escape');
    const sha = commitFiles(repo, [{ path: 'a.txt', content: 'x\n' }, { path: 'leak.txt', content: `k=${FAKE_SK}\n` }], 'leak');
    const res = runHookNewBranch(repo, sha, { SOPHO_PREPUSH_ALLOW: '1' });
    assert.equal(res.status, 0, `留痕放行必须放行：${res.stderr}`);
    assert.match(res.stderr, /留痕放行/, '放行必须打醒目横幅');
    assert.match(res.stderr, /SOPHO_PREPUSH_ALLOW=1/);
    caseOk('逃生口：SOPHO_PREPUSH_ALLOW=1 ⇒ 放行 + 醒目留痕横幅', lineWith(res.stderr, /SOPHO_PREPUSH_ALLOW/));
  }

  // ------------------------------- 3. 端到端：git push 真的走 core.hooksPath
  log('cases', '端到端（临时仓库 + 临时裸远端）');
  {
    const repo = makeRepo('e2e');
    const remote = makeRemote('e2e-remote.git');
    writeFiles(repo, [{ path: 'bin/hooks/pre-push', content: hookText }, { path: 'bin/install-hooks.sh', content: installText }]);
    const installed = spawnSync('sh', [path.join(repo, 'bin/install-hooks.sh')], { cwd: repo, encoding: 'utf8', env: baseEnv });
    assert.equal(installed.status, 0, `安装失败：${installed.stderr}`);
    const good = commitFiles(repo, [{ path: 'src/app.js', content: 'console.log(1)\n' }], 'good');
    const p1 = pushTo(repo, remote);
    assert.equal(p1.status, 0, `干净推送必须成功：${p1.stderr}`);
    assert.equal(remoteHead(remote), good, '干净提交必须真的落到远端');

    const leak = commitFiles(repo, [{ path: 'cfg/leak.txt', content: `k=${FAKE_SK}\n` }], 'leak');
    const p2 = pushTo(repo, remote);
    assert.notEqual(p2.status, 0, '带密钥的推送必须被 git 中止');
    assert.match(p2.stderr, /pre-push 拦截/);
    assert.ok(!p2.stderr.includes(FAKE_SK), '不许回显密钥原文');
    assert.equal(remoteHead(remote), good, '被拦的提交**不许**落到远端（远端 ref 不动）');
    caseOk('e2e：干净推成功 / 带密钥推被中止且远端 ref 不动', `${lineWith(p2.stderr, /拦截/)} ｜ remote@${String(remoteHead(remote)).slice(0, 8)}`);

    const p3 = pushTo(repo, remote, { env: { SOPHO_PREPUSH_ALLOW: '1' } });
    assert.equal(p3.status, 0, `留痕放行必须能推出去：${p3.stderr}`);
    assert.match(p3.stderr, /留痕放行/, '横幅说明这确实是**钩子**在管（不是别的原因拦的）');
    assert.equal(remoteHead(remote), leak, '留痕放行后提交才落到远端');
    caseOk('e2e：同一提交 SOPHO_PREPUSH_ALLOW=1 ⇒ 推成功（证明上一条拦的确实是钩子）', `remote@${String(leak).slice(0, 8)}`);

    const extra = commitFiles(repo, [{ path: 'cfg/leak2.txt', content: `k=${FAKE_GH}\n` }], 'leak2');
    const p4 = pushTo(repo, remote, { args: ['--no-verify'] });
    assert.equal(p4.status, 0, `--no-verify 必须能推出去：${p4.stderr}`);
    assert.equal(remoteHead(remote), extra, '--no-verify 后提交落到远端');
    caseOk('e2e：逃生口 --no-verify ⇒ 推成功（与 v2.1 一致）', `remote@${String(extra).slice(0, 8)}`);
  }
  {
    // 已知危险条（v2.1 也验过）：core.hooksPath 指到不存在/空的目录时 git **静默跳过**钩子。
    // 钩子脚本自己拦不住这种情况 —— install-hooks.sh 的做法是**装的时候**不许装成假闸门 + 打印解析结果。
    const repo = makeRepo('fakegate');
    const remote = makeRemote('fakegate-remote.git');
    writeFiles(repo, [{ path: 'bin/hooks/pre-push', content: hookText }]);
    git(repo, ['config', 'core.hooksPath', 'no-such-dir']);
    const leak = commitFiles(repo, [{ path: 'cfg/leak.txt', content: `k=${FAKE_SK}\n` }], 'leak into fake gate');
    const p = pushTo(repo, remote);
    assert.equal(p.status, 0, '记录事实：hooksPath 指向不存在目录时 git 静默放行');
    assert.equal(remoteHead(remote), leak, '记录事实：密钥真的落到了（假）远端');
    log('  ! 危险条', `hooksPath=no-such-dir ⇒ git 静默跳过钩子：status=${p.status}，远端已收到；git 自己的 stderr=${JSON.stringify(p.stderr.trim().slice(0, 120)) || '∅'}`);
    caseOk('（记录事实）hooksPath 指向不存在目录 ⇒ git 静默放行 = “假闸门”', '所以安装脚本按 -f 检查 + 打印 git 解析结果');
  }

  // ---------------------------------------------------- 4. 无副作用 / 清理
  //
  // ⚠️ 这一节原来断言「真仓 `git status` 跑前跑后一字不差」。那是**断言了别人的状态**：真仓是**共享**
  //    工作区，而本门对真仓**没有写路径** —— 本文件里每一处 write 的路径都由沙箱 `sandbox`
  //    (`mkdtemp`，在 `os.tmpdir()` 里）拼出，`git` 只在真仓里跑**读**命令。既然本门写不进真仓，
  //    真仓里的任何变化就都**不可能**是本门造成的；把它记成「本门的副作用」，门就红在了它管不着的东西上。
  //
  //    2026-09-25 确定性复现（`npm run test:prepush` 起跑后 0.7 s，让设计线那条真实的写者路径
  //    `design/samples/two-pane/attempts/settings-baseline.json` —— 它的写者是
  //    `design/samples/two-pane/settings-measure.mjs`，`test/**` 里一处都没碰过它 —— 改一个字节）：
  //      AssertionError [ERR_ASSERTION]: 本仓库工作区状态不许被改
  //      + actual   out: 'M design/samples/two-pane/attempts/settings-baseline.json'
  //      - expected out: ''
  //    而钩子本身的 30 条用例一条没红：这道 G-06 密钥闸红在一个**它从没写过的路径**上。
  //    「连着一串别的门之后才红」也不是因果，只是**窗口漂移**（前面的门把本门这 ~1.5 s 推到墙钟更晚的
  //    位置）—— 本门跑前工作区脏不脏对它毫无影响：` M …` 在跑前跑后都读得到、两边相等（已测）。
  //
  //    判据因此改成「只断言**本门名下、只有本门会碰**的东西」，真仓的 porcelain/HEAD 只**记录**：
  //      · `core.hooksPath`：本门**绝不装真钩子** —— 那是所有 worktree 共享的 config，装了就是事故；
  //      · `bin/hooks/pre-push.d`：本门名下的临时物；
  //      · 正控制：本门这一轮**确实是个写者**（沙箱里有东西）—— 否则「没写进真仓」这句话是空的。
  log('cases', '无副作用（只断言本门名下的东西；真仓工作区只记录）');
  const realAfter = realRepoSnapshot();
  assert.deepEqual(realAfter.hooksPath, realBefore.hooksPath, '本仓库 core.hooksPath 不许被改（本测试绝不装真钩子）');
  assert.ok(!existsSync(path.join(root, 'bin', 'hooks', 'pre-push.d')), '不许留下临时文件');
  const ownWrites = existsSync(sandbox) ? readdirSync(sandbox) : [];
  assert.ok(ownWrites.length > 0, `正控制：本门这轮必须真的往盘上写过（沙箱 ${sandbox} 现在是空的）—— 否则「它没写进真仓」这句话是空话`);
  caseOk('无副作用：真仓 core.hooksPath 跑前跑后一字不差 ＋ 名下临时物不留 ＋ 写全落在沙箱里', `hooksPath=${realAfter.hooksPath.out || '(unset)'}；沙箱里 ${ownWrites.length} 项产物（真仓一个字节没占）；真仓未提交 ${realAfter.worktree.out.split('\n').filter(Boolean).length} 条`);
  const drift = [];
  if (realAfter.worktree.out !== realBefore.worktree.out) drift.push(`git status ${JSON.stringify(realBefore.worktree.out)} → ${JSON.stringify(realAfter.worktree.out)}`);
  if (realAfter.head.out !== realBefore.head.out) drift.push(`HEAD ${realBefore.head.out.slice(0, 12)} → ${realAfter.head.out.slice(0, 12)}`);
  log('  ! 记录（不断言）', drift.length === 0
    ? `真仓工作区在本门这 ${((realAfter.at - realBefore.at) / 1000).toFixed(1)}s 里没被**别人**动过（未提交 ${realAfter.worktree.out.split('\n').filter(Boolean).length} 条）`
    : `真仓是共享工作区：本门这 ${((realAfter.at - realBefore.at) / 1000).toFixed(1)}s 里**别人**写/提交过它 —— 本门对真仓没有写路径，故这不是本门的失败：${drift.join('；')}`);

  // 自指检查：**本仓库自己的历史必须过自家这道闸**（要推我这个分支时，扫的就是这条历史）。
  // 这条能接住「测试 fixture 自己带着密钥字面量、把加闸的那次提交拦在门外」这类事故（实测踩过）。
  // ⚠️ 唯一的例外是那个**已知夹具字面量** `sk-abcdefghijklmnopq`（断言全靠它验证 401 抹除）：
  //    钩子只放过这**一个精确串**，同一 blob 里还有别的命中照样红（反证臂见上面「白名单」那条）。
  {
    const head = git(root, ['rev-parse', 'HEAD']);
    const res = runHook(root, pushLine(head, ZERO));
    if (res.status !== 0) {
      process.stderr.write(`自家历史没过自家闸：\n${res.stderr}\n`);
    }
    assert.equal(res.status, 0, '本仓库 HEAD 可达的历史里，除已知夹具字面量外不许有敏感命中（否则本分支自己都推不出去）');
    caseOk('自指：本仓库 HEAD 可达的全部历史过自家闸（除已知夹具字面量外 0 命中）', `${git(root, ['rev-list', '--count', 'HEAD'])} 个提交`);
  }

  log('RESULT', `pre-push (G-06) PASS —— ${pass} 条用例`);
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  await removeSandbox(sandbox, cleanupProblems);
  // ⚠️ 这里原本打的是「本轮新增残留=N」。那个数**没有归属**：`os.tmpdir()` 是**全机共享**的，
  //    同一前缀（`v22-prepush-`）也由**同时跑同一道门的另一个会话**建 —— 2026-09-25 实测就出现过
  //    `本轮新增残留=1 -> v22-prepush-vExMeW`，而那不是本门的漏，是别人的沙箱（本门自己那一个
  //    是下面那个精确的 `sandbox` 路径）。一行「残留=1」会被读成「本门漏了一个」⇒ 现在按**归属**说：
  //      · 本门名下：精确路径 `sandbox`（跑完必须不在）；
  //      · 同前缀的其它目录：只**报数**并写明「可能属于同时跑同一道门的另一个会话，不是本门的漏」；
  //      · 跑前就存在的同前缀目录（`leftoverBefore`）单列，免得历史残留被算进「本轮」。
  const leftover = readdirSync(os.tmpdir()).filter((n) => n.startsWith(TMP_PREFIX));
  const strays = leftover.filter((n) => !leftoverBefore.includes(n) && n !== path.basename(sandbox));
  log('cleanup', `本门名下 ${path.basename(sandbox)} 已删=${!existsSync(sandbox)}`
    + `；跑前就在的同前缀目录=${leftoverBefore.length}`
    + `；本轮新增的同前缀目录=${strays.length}（**不是本门的漏**：`
    + `${strays.length ? `另有会话同时跑了同一道门 -> ${strays.join(', ')}` : '没有第三方同时跑'}）`);
  log('cases', `${cases.length}`);
  finishCleanup(primaryError, cleanupProblems);
}
