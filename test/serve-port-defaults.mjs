#!/usr/bin/env node
// Mechanical consistency gate for the *bare* `npm run serve` / `stop` defaults.
//
// Why this exists: the defaults are the live-instance口径 (A=127.0.0.1:7331, B=0.0.0.0:7321), and
// they are spread over four platform scripts plus four hand-started fallbacks. A silent drift in
// one of them is the exact failure the deployment docs keep warning about: a bare `npm run stop`
// that looks at its own defaults cannot stop the pair a bare `npm run serve` started, and a
// hand-started `node server/base.mjs` would bind a port nobody else is using.
//
// It reads the sources and asserts the口径 mechanically. It binds nothing, starts nothing, reads
// no profile, and creates no sandbox — so it needs none of test/harness.mjs's cleanup helpers.
// ⇒ be careful what it claims: a *string* that agrees with itself proves nothing about where the
// app ends up listening. `bin/serve.sh`'s app-host default has its own gate that really starts the
// app and reads the bound address (`npm run test:serveapphost`, test/serve-app-host.mjs).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const lines = [];

function grab(source, regex, label, file) {
  const match = source.match(regex);
  assert.ok(match, `${file}: cannot find ${label} (did the spelling change? update this gate deliberately)`);
  return match[1];
}

function report(label, value) {
  lines.push(`  ${label} = ${value}`);
  return value;
}

// --- bin/serve.sh (the baseline口径 the human set) --------------------------------------------
const serveSh = await read('bin/serve.sh');
const shHost = report('bin/serve.sh A host default', grab(serveSh, /^HOST=\$\{SOPHO_HOST:-([^}]+)\}$/m, 'A host default', 'bin/serve.sh'));
const shAPort = report('bin/serve.sh A port default', grab(serveSh, /^PORT=\$\{SOPHO_PORT:-(\d+)\}$/m, 'A port default', 'bin/serve.sh'));
const shAppHostExpr = report('bin/serve.sh B host expression', grab(serveSh, /^APP_HOST=(.+)$/m, 'B host expression', 'bin/serve.sh'));
const shAppPort = report('bin/serve.sh B port default', grab(serveSh, /^APP_PORT=\$\{SOPHO_APP_PORT:-(\d+)\}$/m, 'B port default', 'bin/serve.sh'));
const shAgentDir = report('bin/serve.sh agent-dir fallback', grab(serveSh, /^AGENT_DIR=.+:-([^}]+)\}\}\}$/m, 'agent-dir fallback', 'bin/serve.sh'));

// --- bin/stop.sh must pair with bin/serve.sh --------------------------------------------------
const stopSh = await read('bin/stop.sh');
const shStopAPort = report('bin/stop.sh A port default', grab(stopSh, /^PORT=\$\{SOPHO_PORT:-(\d+)\}$/m, 'A port default', 'bin/stop.sh'));
const shStopAppPort = report('bin/stop.sh B port default', grab(stopSh, /^APP_PORT=\$\{SOPHO_APP_PORT:-(\d+)\}$/m, 'B port default', 'bin/stop.sh'));

// --- bin/serve-win.ps1 (must carry the same semantics, not just the same numbers) --------------
const serveWin = await read('bin/serve-win.ps1');
const psHost = report('bin/serve-win.ps1 A host default', grab(serveWin, /if \(-not \$BindHost\) \{ \$BindHost = '([^']+)' \}/, 'A host default', 'bin/serve-win.ps1'));
const psAPort = report('bin/serve-win.ps1 A port default', grab(serveWin, /\$Port = if \(\$env:SOPHO_PORT\) \{ \[int\]\$env:SOPHO_PORT \} else \{ (\d+) \}/, 'A port default', 'bin/serve-win.ps1'));
const psAppPort = report('bin/serve-win.ps1 B port default', grab(serveWin, /\$AppPort = if \(\$env:SOPHO_APP_PORT\) \{ \[int\]\$env:SOPHO_APP_PORT \} else \{ (\d+) \}/, 'B port default', 'bin/serve-win.ps1'));
const psAppHostDefault = report('bin/serve-win.ps1 B host default', grab(serveWin, /if \(-not \$AppHost\) \{ \$AppHost = '([^']+)' \}/, 'B host default', 'bin/serve-win.ps1'));
const psAgentDir = report('bin/serve-win.ps1 agent-dir fallback', grab(serveWin, /else \{ Join-Path \$env:USERPROFILE '([^']+)' \}/, 'agent-dir fallback', 'bin/serve-win.ps1'));

// --- bin/stop-win.ps1 must pair with bin/serve-win.ps1 ----------------------------------------
const stopWin = await read('bin/stop-win.ps1');
const psStopAPort = report('bin/stop-win.ps1 A port default', grab(stopWin, /\$Port = if \(\$env:SOPHO_PORT\) \{ \[int\]\$env:SOPHO_PORT \} else \{ (\d+) \}/, 'A port default', 'bin/stop-win.ps1'));
const psStopAppPort = report('bin/stop-win.ps1 B port default', grab(stopWin, /\$AppPort = if \(\$env:SOPHO_APP_PORT\) \{ \[int\]\$env:SOPHO_APP_PORT \} else \{ (\d+) \}/, 'B port default', 'bin/stop-win.ps1'));

// --- the same pairs, asserted ----------------------------------------------------------------
assert.equal(shAPort, shStopAPort, 'bin/serve.sh and bin/stop.sh must share the A default port');
assert.equal(shAppPort, shStopAppPort, 'bin/serve.sh and bin/stop.sh must share the B default port');
assert.equal(psAPort, psStopAPort, 'bin/serve-win.ps1 and bin/stop-win.ps1 must share the A default port');
assert.equal(psAppPort, psStopAppPort, 'bin/serve-win.ps1 and bin/stop-win.ps1 must share the B default port');
assert.equal(shAPort, psAPort, 'Linux and Windows must share the A default port');
assert.equal(shAppPort, psAppPort, 'Linux and Windows must share the B default port');
assert.notEqual(shAPort, shAppPort, 'A and B default ports must differ');

// A is loopback on both platforms. B's default is a **ruling** (owner, 2026-09-23, `5681dcf`): the
// app defaults to the LAN, so `npm run serve` must not end up loopback-only just because A is.
// Neither platform inherits SOPHO_HOST any more (Windows was aligned 2026-09-24); a sandbox that
// wants B on loopback has to say `SOPHO_APP_HOST=127.0.0.1` explicitly.
assert.equal(shHost, '127.0.0.1', 'A must default to loopback');
assert.equal(psHost, '127.0.0.1', 'A must default to loopback on Windows too');
assert.equal(shAppHostExpr, '${SOPHO_APP_HOST:-0.0.0.0}', 'B must default to 0.0.0.0 and NOT inherit SOPHO_HOST (owner ruling 2026-09-23)');
assert.equal(psAppHostDefault, '0.0.0.0', 'B must default to 0.0.0.0 and NOT follow an explicit A host (Windows aligned to the owner ruling)');
assert.ok(!serveWin.includes('$HostWasExplicit'), 'Windows must no longer keep the old "was an A host given?" distinction (dead code after the ruling)');
assert.ok(!/\$AppHost = if\b/.test(serveWin), 'the Windows B-host default must not branch on the A host any more');

// One agent-dir口径: three variables, one value, same fallback shape on both platforms.
assert.equal(shAgentDir, '$HOME/.pi/profiles/assistant', 'Linux agent-dir fallback');
assert.equal(psAgentDir, '.pi\\profiles\\assistant', 'Windows agent-dir fallback');
assert.ok(serveSh.includes('export PI_CODING_AGENT_DIR ASSIST_HOME SOPHO_AGENT_DIR'), 'bin/serve.sh must export all three agent-dir variables');
assert.ok(serveSh.includes('ASSIST_HOME=$AGENT_DIR') && serveSh.includes('SOPHO_AGENT_DIR=$AGENT_DIR') && serveSh.includes('PI_CODING_AGENT_DIR=$AGENT_DIR'), 'bin/serve.sh must unify all three agent-dir variables');
for (const name of ['ASSIST_HOME', 'SOPHO_AGENT_DIR', 'PI_CODING_AGENT_DIR']) {
  assert.ok(serveWin.includes(`$common['${name}'] = $AgentDir`), `bin/serve-win.ps1 must set ${name} to the unified agent dir`);
}

// The fallbacks used when someone hand-starts an entry point (no serve.sh / serve-win.ps1) must
// not disagree with the scripts, or the diagnostic in base-logic would read the wrong host.
const baseEntry = await read('server/base.mjs');
const appEntry = await read('server/app.mjs');
const baseLogic = await read('server/base-logic.mjs');
const plugin = await read('pi-extensions/assistant/index.ts');
assert.ok(baseEntry.includes(`process.env.SOPHO_PORT || '${shAPort}'`), `server/base.mjs fallback must be the A default ${shAPort}`);
assert.ok(appEntry.includes(`readPort('SOPHO_APP_PORT', '${shAppPort}')`), `server/app.mjs fallback must be the B default ${shAppPort}`);
assert.ok(appEntry.includes(`process.env.SOPHO_PORT || '${shAPort}'`), `server/app.mjs upstream fallback must be the A default ${shAPort}`);
assert.ok(baseLogic.includes(`process.env.SOPHO_PORT ?? ${shAPort}`), `server/base-logic.mjs fallback must be the A default ${shAPort}`);
assert.ok(plugin.includes(`process.env.SOPHO_PORT || "${shAPort}"`), `pi-extensions/assistant/index.ts fallback must be the A default ${shAPort}`);

// The sandbox/production guards must protect exactly this pair.
const devServe = await read('bin/dev-serve.ps1');
assert.ok(devServe.includes(`$ReservedPorts = @(${psAPort}, ${psAppPort})`), 'dev-serve.ps1 must refuse to sandbox on the live default pair');
const sweep = await read('bin/sandbox-sweep.mjs');
assert.ok(sweep.includes(`const PRODUCTION_PORTS = new Set([${shAPort}, ${shAppPort}]);`), 'sandbox-sweep.mjs must treat the live default pair as production');

// Two things the human explicitly asked not to regress: per-port default log names, and the
// immediate "log is not writable" failure instead of a disguised start timeout.
assert.ok(serveWin.includes('Join-Path $Tmp "sopho-base-$Port.log"'), 'per-port default A log name must stay');
assert.ok(serveWin.includes('Join-Path $Tmp "sopho-app-$AppPort.log"'), 'per-port default B log name must stay');
assert.ok(serveWin.includes('function Assert-LogWritable'), 'Assert-LogWritable must stay in bin/serve-win.ps1');

process.stdout.write(`serve/stop default口径 PASS\n${lines.join('\n')}\nRESULT: ${lines.length} defaults read; Linux==Windows (ports), serve==stop, sandbox guards protect the live pair; server/plugin fallbacks agree; B host default = 0.0.0.0 on Linux and Windows (owner ruling 2026-09-23, no SOPHO_HOST inheritance on either)\n`);
