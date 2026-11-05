#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'bin', 'set-default-model.sh');
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'sopho-setmodel-'));
const home = path.join(sandbox, 'profile with spaces');
mkdirSync(home, { recursive: true });

const initialModels = `${JSON.stringify({
  providers: {
    litellm: {
      baseUrl: 'http://127.0.0.1:4000/v1',
      api: 'openai-responses',
      apiKey: 'sandbox-only',
      models: [{
        id: 'old-default',
        name: 'Old default',
        reasoning: false,
        input: ['text'],
        contextWindow: 8192,
        maxTokens: 1024,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      }],
    },
  },
}, null, 2)}\n`;
const initialSettings = `${JSON.stringify({
  defaultProvider: 'litellm',
  defaultModel: 'old-default',
  enabledModels: ['litellm/old-default'],
  defaultThinkingLevel: 'medium',
}, null, 2)}\n`;
const modelsPath = path.join(home, 'models.json');
const settingsPath = path.join(home, 'settings.json');
writeFileSync(modelsPath, initialModels);
writeFileSync(settingsPath, initialSettings);

function run(args = [], assistHome = home) {
  const env = { ...process.env, ASSIST_HOME: assistHome };
  delete env.PI_CODING_AGENT_DIR;
  delete env.SOPHO_AGENT_DIR;
  return spawnSync('bash', [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
}

function output(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

let primaryError;
try {
  const first = run();
  assert.equal(first.status, 0, output(first));
  const models = JSON.parse(readFileSync(modelsPath, 'utf8'));
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const entries = models.providers.litellm.models.filter((model) => model.id === 'autorouter');
  assert.equal(entries.length, 1, 'models.json 应只新增一个 autorouter 条目');
  assert.equal(settings.defaultProvider, 'litellm');
  assert.equal(settings.defaultModel, 'autorouter');
  assert.deepEqual(settings.enabledModels, ['litellm/*']);
  console.log('PASS ① 改成功：models.json 条目与 settings.json 默认 provider/model 一致');

  const afterFirstModels = readFileSync(modelsPath, 'utf8');
  const afterFirstSettings = readFileSync(settingsPath, 'utf8');
  const second = run();
  assert.equal(second.status, 0, output(second));
  assert.match(output(second), /没有任何要改的|幂等/);
  assert.equal(readFileSync(modelsPath, 'utf8'), afterFirstModels);
  assert.equal(readFileSync(settingsPath, 'utf8'), afterFirstSettings);
  assert.equal(JSON.parse(readFileSync(modelsPath, 'utf8')).providers.litellm.models.filter((model) => model.id === 'autorouter').length, 1);
  console.log('PASS ② 幂等：第二次运行明确 no-op，两份文件逐字不变且无重复条目');

  const names = readdirSync(home);
  const modelsBackups = names.filter((name) => name.startsWith('models.json.bak-'));
  const settingsBackups = names.filter((name) => name.startsWith('settings.json.bak-'));
  assert.equal(modelsBackups.length, 1, `models 备份数量异常：${modelsBackups.join(',')}`);
  assert.equal(settingsBackups.length, 1, `settings 备份数量异常：${settingsBackups.join(',')}`);
  assert.equal(readFileSync(path.join(home, modelsBackups[0]), 'utf8'), initialModels);
  assert.equal(readFileSync(path.join(home, settingsBackups[0]), 'utf8'), initialSettings);
  console.log('PASS ③ 备份：两份时间戳备份均存在，内容逐字等于改前');

  const badArg = run(['--definitely-not-an-option']);
  assert.notEqual(badArg.status, 0);
  assert.match(output(badArg), /不认识的参数/);
  const missingValue = run(['--model']);
  assert.notEqual(missingValue.status, 0);
  assert.match(output(missingValue), /需要一个非空参数/);
  console.log('PASS ④ 非法参数：未知选项与缺失参数均非零退出并给出人话');

  const incompleteHome = path.join(sandbox, 'missing settings');
  mkdirSync(incompleteHome, { recursive: true });
  writeFileSync(path.join(incompleteHome, 'models.json'), initialModels);
  const missingTarget = run([], incompleteHome);
  assert.notEqual(missingTarget.status, 0);
  assert.match(output(missingTarget), /没有这个文件/);
  assert.equal(readFileSync(path.join(incompleteHome, 'models.json'), 'utf8'), initialModels, '缺 settings 时不得先改 models');
  assert.deepEqual(readdirSync(incompleteHome), ['models.json'], '预检失败时不得产生备份或临时文件');
  console.log('PASS ⑤ 目标缺失：预检即非零退出，已有文件不变且不留备份/临时文件');

  const help = run(['--help']);
  assert.equal(help.status, 0, output(help));
  assert.match(help.stdout, /--dry-run/);
  console.log(`PASS Windows 路径：通过 ASSIST_HOME 传入含空格路径 ${JSON.stringify(home)}，脚本用 Node realpath + 全程 shell 引号处理`);
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
