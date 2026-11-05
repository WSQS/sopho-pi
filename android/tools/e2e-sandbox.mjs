// 隔离沙箱：真 A（宿主+generation worker）＋ 真 B（反代）＋ 本地 OpenAI 兼容 stub provider。
// 用途：给「安卓 → 独立 B/A → stub provider」的端到端（图片/模型/思考）提供一手证据。
// 纪律：临时 ASSIST_HOME（mkdtemp）、随机高位端口（显式排除 7331/7321）、不碰真实 profiles/会话/活实例。
// 输出：port 与 sessionId 打到 stdout（JSON 一行），provider 收到的请求逐条写到 provider-requests.jsonl。
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { openSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const repo = process.argv[2];
if (!repo) { console.error('usage: node sandbox.mjs <repo-root>'); process.exit(2); }
const outDir = process.argv[3] ?? path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const requestsPath = path.join(outDir, 'provider-requests.jsonl');

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function reserveHighPort(excluded = new Set()) {
  for (let candidate = 44000 + Math.floor(Math.random() * 14000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321 || excluded.has(candidate)) continue;
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(candidate, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (ok) return candidate;
  }
  throw new Error('no free high port');
}

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-e2e-'));
const home = path.join(sandbox, 'home');
const cwd = path.join(sandbox, 'workspace');
const sessionsRoot = path.join(home, 'sessions');
for (const dir of [home, cwd, sessionsRoot]) await mkdir(dir, { recursive: true });

const used = new Set();
const providerPort = await reserveHighPort(used); used.add(providerPort);
const basePort = await reserveHighPort(used); used.add(basePort);
const appPort = await reserveHighPort(used); used.add(appPort);

function chunk(content, finishReason = null, includeUsage = false) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'stub-model',
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finishReason }],
    ...(includeUsage ? { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } } : {}),
  };
}

function imageUrlsIn(body) {
  const found = [];
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type === 'image_url') found.push(String(part.image_url?.url ?? ''));
    }
  }
  return found;
}

// stub provider：把每一发请求（含 image_url 的 data URL 只记前缀与长度，避免把整段图打进日志）落盘
const provider = http.createServer(async (req, res) => {
  if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404).end(); return; }
  let raw = '';
  for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  const urls = imageUrlsIn(body);
  const record = {
    at: new Date().toISOString(),
    model: body.model ?? null,
    reasoningEffort: body.reasoning_effort ?? null,
    messageRoles: (body.messages ?? []).map((m) => m.role),
    shape: (body.messages ?? []).map((m) => Array.isArray(m.content)
      ? m.content.map((p) => p.type)
      : typeof m.content),
    imageUrlCount: urls.length,
    imageUrls: urls.map((u) => ({ prefix: u.slice(0, 30), bytes: u.length })),
    textTail: (() => {
      for (let i = (body.messages ?? []).length - 1; i >= 0; i -= 1) {
        const m = body.messages[i];
        if (m.role !== 'user') continue;
        if (typeof m.content === 'string') return m.content.slice(0, 120);
        return (m.content ?? []).map((p) => p.type === 'text' ? p.text : '').join('').slice(0, 120);
      }
      return '';
    })(),
  };
  await appendFile(requestsPath, `${JSON.stringify(record)}\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  res.write(`data: ${JSON.stringify(chunk(''))}\n\n`);
  res.write(`data: ${JSON.stringify(chunk(`stub-reply#${urls.length > 0 ? 'with-image' : 'text-only'}`))}\n\n`);
  res.write(`data: ${JSON.stringify(chunk(null, 'stop', true))}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(providerPort, '127.0.0.1', resolve); });

await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
  providers: {
    fake: {
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      api: 'openai-completions',
      apiKey: 'sandbox-key',
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [
        { id: 'stub-vision', name: 'Stub Vision', reasoning: true, input: ['text', 'image'], contextWindow: 8192, maxTokens: 1024 },
        { id: 'stub-text', name: 'Stub Text', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 1024 },
      ],
    },
  },
}, null, 2)}\n`);
await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
  defaultProvider: 'fake',
  defaultModel: 'stub-vision',
  defaultThinkingLevel: 'off',
  compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 128 },
  retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
}, null, 2)}\n`);
await writeFile(path.join(home, 'ui-settings.json'), `${JSON.stringify({ version: 1, values: { 'suggestions.enabled': false } }, null, 2)}\n`);

const baseLog = openSync(path.join(outDir, 'base.log'), 'w');
const appLog = openSync(path.join(outDir, 'app.log'), 'w');
const childEnv = {
  ...process.env,
  HOME: home, ASSIST_HOME: home, SOPHO_AGENT_DIR: home, PI_CODING_AGENT_DIR: home,
  PI_CODING_AGENT_SESSION_DIR: sessionsRoot, PI_OFFLINE: '1',
  SOPHO_HOST: '127.0.0.1', SOPHO_PORT: String(basePort), SOPHO_DEFAULT_CWD: cwd,
  SOPHO_NO_TOOLS: '1', SOPHO_MAX_HOT: '8',
};
const baseChild = spawn(process.execPath, [path.join(repo, 'server', 'base.mjs')], { cwd: repo, env: childEnv, stdio: ['ignore', baseLog, baseLog] });
const appChild = spawn(process.execPath, [path.join(repo, 'server', 'app.mjs')], {
  cwd: repo,
  env: {
    ...process.env, HOME: home, ASSIST_HOME: home,
    SOPHO_APP_HOST: '127.0.0.1', SOPHO_APP_PORT: String(appPort),
    SOPHO_UPSTREAM_HOST: '127.0.0.1', SOPHO_UPSTREAM_PORT: String(basePort),
    SOPHO_WEB_ROOT: path.join(repo, 'web'),
  },
  stdio: ['ignore', appLog, appLog],
});

async function api(pathname, options = {}) {
  const res = await fetch(`http://127.0.0.1:${appPort}/api${pathname}`, {
    method: options.method ?? 'GET',
    headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  return { statusCode: res.status, body: text, value: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

let ready = false;
for (let i = 0; i < 600; i += 1) {
  try { if ((await api('/host')).statusCode === 200) { ready = true; break; } } catch { /* retry */ }
  await new Promise((r) => setTimeout(r, 50));
}
if (!ready) { console.error('A+B not ready'); process.exit(1); }

const created = await api('/sessions', { method: 'POST', body: { cwd, name: 'E2E 安卓真链路' } });
if (created.statusCode !== 201) { console.error('create session failed', created.body); process.exit(1); }

process.stdout.write(`${JSON.stringify({
  home, cwd, outDir, providerPort, basePort, appPort,
  sessionId: created.value.id,
  androidBaseUrl: `http://10.0.2.2:${appPort}`,
  png1x1: PNG_1X1,
})}\n`);

async function shutdown() {
  for (const child of [appChild, baseChild]) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
  provider.close();
  await new Promise((r) => setTimeout(r, 800));
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
