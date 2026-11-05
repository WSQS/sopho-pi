#!/usr/bin/env node
// Mechanical gate for the *browser path* default in the CDP-driven test suites.
//
// Why this exists: five suites spawn a chromium and each carried the same Windows absolute
// path as its fallback. Four of them wrapped it in `process.platform === 'win32' ? ... :
// '/usr/bin/chromium'`; test/switch-session-paint.mjs did not, so on Linux a bare
// `npm run test:switchpaint` died with `spawn C:/Users/.../chrome.exe ENOENT` before the
// suite could assert anything -- a gate that is red on Linux for a reason that has nothing
// to do with what it tests. (The earlier "chromium path is portable" sweep missed exactly
// this one file.)
//
// The rule is lexical on purpose, and it is stated as tightly as the bug: every *path*
// occurrence of `chrome.exe` in a test file must sit inside a `process.platform`-guarded
// expression, so Linux never tries to spawn a Windows path. A `chrome.exe` that is only a
// *process name* (an argument to killTree) is not a path and needs no platform check; those
// occurrences are named in the allowlist below, each with a reason, and the allowlist is
// checked for staleness so it cannot rot into a blanket exemption.
//
// It reads sources only: no browser, no child process, no port, no sandbox, no profile --
// so it finishes in milliseconds and needs none of test/harness.mjs's cleanup helpers.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'test');
const lines = [];

// A `chrome.exe` preceded by a path separator is a filesystem path (the fallback bin path);
// a bare quoted one (`'chrome.exe'`) is a process name passed as an argument (killTree).
// Mentions inside prose/comments or human-readable message strings are neither and are ignored.
const PATH_OCCURRENCE = /[/\\]chrome\.exe/;
const PROCESS_NAME_ARG = /['"]chrome\.exe['"]/;
// How far around a path occurrence to look for the platform guard. The guard is the ternary
// condition on the line(s) just above the path string in every known suite; four lines cover
// `const chrome = process.env.CHROME_BIN || (process.platform === 'win32' \n ? '...' \n : '...')`.
const GUARD_WINDOW_BEFORE = 2;
const GUARD_WINDOW_AFTER = 1;

// Process-name occurrences that are deliberately *not* platform-guarded. This list may only
// shrink or stay: every entry must still match a real line, or the gate fails and the entry
// must be deleted (same discipline as harness-contract.mjs's batch-2 allowlist).
const processNameAllowlist = [
  {
    file: 'perf-compare.mjs',
    // killTree by image name: this is the *kill* of an already-spawned Windows chrome, not a
    // path to spawn. On non-win32 the whole suite SKIPs (line ~147), so this line never runs
    // on Linux; if it did, "chrome.exe" is the correct name to terminate. Changing it to a
    // path would break the kill, not make it portable.
    pattern: /killTree\(chrome\.child\.pid,\s*'chrome\.exe'\)/,
    reason: '按进程名杀已起的 Windows chrome（非路径）；非 win32 时整个 perfcompare 先 SKIP',
  },
];
const allowMatched = new Array(processNameAllowlist.length).fill(0);

function guardFor(linesInFile, index) {
  const from = Math.max(0, index - GUARD_WINDOW_BEFORE);
  const to = Math.min(linesInFile.length - 1, index + GUARD_WINDOW_AFTER);
  for (let i = from; i <= to; i += 1) {
    if (/process\.platform/.test(linesInFile[i])) return i + 1;
  }
  return null;
}

const violations = [];
let pathOccurrences = 0;
let processNameOccurrences = 0;

for await (const relative of walkMjs(testDir)) {
  const file = `test/${relative}`;
  const source = await readFile(path.join(testDir, relative), 'utf8');
  const fileLines = source.split(/\r?\n/);
  for (let index = 0; index < fileLines.length; index += 1) {
    // Ignore whole-line comments and trailing `//` comments so a mention in prose is not a hit.
    if (/^\s*(?:\/\/|\*|\/\*)/.test(fileLines[index])) continue;
    const code = fileLines[index].replace(/\s\/\/.*$/, '');
    if (!/chrome\.exe/.test(code)) continue;
    const line = fileLines[index].trim();
    if (PATH_OCCURRENCE.test(code)) {
      pathOccurrences += 1;
      const guardLine = guardFor(fileLines, index);
      if (guardLine === null) {
        violations.push(`${file}:${index + 1}: chrome.exe path without a process.platform guard: ${line}`);
      } else {
        lines.push(`  ${file}:${index + 1} chrome path guarded at line ${guardLine}`);
      }
    } else if (PROCESS_NAME_ARG.test(code)) {
      processNameOccurrences += 1;
      const hit = processNameAllowlist.findIndex((entry) => entry.file === relative && entry.pattern.test(code));
      if (hit === -1) {
        violations.push(`${file}:${index + 1}: chrome.exe process-name argument not in the allowlist: ${line}`);
      } else {
        allowMatched[hit] += 1;
        lines.push(`  ${file}:${index + 1} chrome process-name (allowlisted: ${processNameAllowlist[hit].reason})`);
      }
    }
  }
}

const staleAllowlist = processNameAllowlist.filter((_, index) => allowMatched[index] === 0);
assert.deepEqual(staleAllowlist, [], `browser-guard allowlist entries with no matching line -- delete them (this list may only shrink):\n${staleAllowlist.map((entry) => entry.file).join('\n')}`);
assert.deepEqual(violations, [], `browser-path platform guard (${violations.length}); add the process.platform win32/Linux split seen in the other suites:\n${violations.join('\n')}`);
assert.ok(pathOccurrences >= 4, `expected the known chrome-path suites to be found, saw only ${pathOccurrences} occurrence(s) -- did a suite stop spawning chromium, or did this walk break?`);

process.stdout.write(`browser platform guard PASS\n${lines.join('\n')}\nRESULT: ${pathOccurrences} chrome.exe path(s) under a process.platform guard; ${processNameOccurrences} process-name argument(s) allowlisted; ${processNameAllowlist.length} allowlist entr${processNameAllowlist.length === 1 ? 'y' : 'ies'} live\n`);

async function* walkMjs(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walkMjs(path.join(directory, entry.name), relative);
    else if (entry.isFile() && entry.name.endsWith('.mjs')) yield relative;
  }
}
