import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// H-03 stays a named gate, but v2.2 already owns the expensive true-A + fake-provider
// sandbox in s1a2-api.mjs. Reuse that single owner instead of copying its process/port
// cleanup machinery and letting two versions drift. The markers below are printed only
// after the integrated test has asserted HTTP 409, stable error code/message, no
// persisted blocked message, and a compaction boundary read back from /messages.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [path.join(root, 'test', 's1a2-api.mjs')], {
  cwd: root,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', resolve);
});
assert.equal(code, 0, `s1a2 API harness failed\n${stderr}`);
assert.match(stdout, /compaction window 409 raw response:.*"statusCode":409/);
assert.match(stdout, /"error":"session_compacting"/);
assert.match(stdout, /compaction boundary:.*"atIndex":\d+/);
assert.match(stdout, /RESULT: S1a-2 API\/frontend PASS/);
process.stdout.write('RESULT: compact-window PASS (v2.2 true A + fake provider owner harness)\n');
