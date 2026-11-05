#!/usr/bin/env node
// S4-2 probe: can ctx.modelRegistry.complete() be called from a *tool's* execute?
//
// pi's own examples/extensions/handoff.ts only ever calls it from a command handler, and
// the design doc (design-cwd-devices.md §8.1) recorded that as unverified. The handoff
// design depends on the answer: if it works, the summary can be generated inside the tool;
// if not, it has to fall back to a command, or the tool has to take the summary as input.
//
// Sandbox only: temp dir, random free port, local fake provider, no real model.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { cleanupStep, finishCleanup, removeSandbox } from './harness.mjs';

const tmp = await mkdtemp(path.join(os.tmpdir(), 's4-handoff-complete-probe-'));
const home = path.join(tmp, 'home');
const cwd = path.join(tmp, 'cwd');
const extensionPath = path.join(tmp, 'probe.ts');
let server;

function reservePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      socket.close(() => resolve(address.port));
    });
  });
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part.text || '').join('');
  return '';
}

function latestUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messageText(messages[index]);
  }
  return '';
}

function sse(response, delta, finishReason = null, includeUsage = false) {
  response.write(`data: ${JSON.stringify({
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-probe',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(includeUsage ? { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } : {}),
  })}\n\n`);
}

let primaryError;
const cleanupProblems = [];
try {
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const port = await reservePort();
  await writeFile(extensionPath, `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "complete_probe",
    label: "Complete probe",
    description: "Probe modelRegistry.complete inside tool execute",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      if (!ctx.model) throw new Error("probe has no current model");
      const response = await ctx.modelRegistry.complete(ctx.model, {
        systemPrompt: "Return the nested probe token exactly.",
        messages: [{ role: "user", content: [{ type: "text", text: "NESTED_COMPLETE_PROBE" }], timestamp: Date.now() }],
      }, { signal, cacheRetention: "none" });
      const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\\\\n");
      return { content: [{ type: "text", text }], details: { text, stopReason: response.stopReason } };
    },
  });
}
`);
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'sandbox',
    models: [{ id: 'fake-probe', name: 'Fake Probe', contextWindow: 8192, maxTokens: 512 }],
  } } }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake', defaultModel: 'fake-probe', defaultThinkingLevel: 'off',
    compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

  const requests = [];
  server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ tools: body.tools?.map((tool) => tool.function?.name) ?? [], latestUser: latestUserText(body.messages), roles: body.messages.map((message) => message.role) });
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    const hasToolResult = body.messages.some((message) => message.role === 'tool');
    if (latestUserText(body.messages).includes('NESTED_COMPLETE_PROBE')) {
      // The nested call: it reaches the provider with tools:[] and a prompt the tool wrote.
      sse(response, { role: 'assistant', content: 'NESTED_COMPLETE_OK' });
      sse(response, {}, 'stop', true);
    } else if (!hasToolResult) {
      sse(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'call-probe', type: 'function', function: { name: 'complete_probe', arguments: '{}' } }] });
      sse(response, {}, 'tool_calls', true);
    } else {
      sse(response, { role: 'assistant', content: 'OUTER_TURN_OK' });
      sse(response, {}, 'stop', true);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });

  const settingsManager = SettingsManager.create(cwd, home);
  const loader = new DefaultResourceLoader({ cwd, agentDir: home, settingsManager, additionalExtensionPaths: [extensionPath] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(home, 'auth.json'), modelsPath: path.join(home, 'models.json') });
  const model = modelRuntime.getModel('fake', 'fake-probe');
  assert.ok(model);
  const { session } = await createAgentSession({ cwd, agentDir: home, modelRuntime, model, settingsManager, resourceLoader: loader, sessionManager: SessionManager.create(cwd, path.join(home, 'sessions')) });
  try {
    await session.prompt('CALL_COMPLETE_PROBE');
    const branch = session.sessionManager.getBranch();
    const toolResult = branch.find((entry) => entry.type === 'message' && entry.message.role === 'toolResult');
    const resultText = toolResult?.message?.content?.map((part) => part.text ?? '').join('') ?? '';
    // The nested request is request #2: it carries the probe's own prompt and no tools.
    assert.equal(requests.length, 3, 'expected outer turn, nested complete, outer continuation');
    assert.equal(requests[1].latestUser, 'NESTED_COMPLETE_PROBE');
    assert.deepEqual(requests[1].tools, []);
    assert.equal(resultText, 'NESTED_COMPLETE_OK');
    console.log(JSON.stringify({ ok: true, toolResult: resultText, nestedRequest: requests[1] }, null, 2));
    console.log('RESULT: ctx.modelRegistry.complete() works inside a tool execute');
  } finally {
    await cleanupStep(cleanupProblems, 'dispose session', () => session.dispose());
  }
} catch (error) {
  primaryError = error;
} finally {
  if (server) await cleanupStep(cleanupProblems, 'close provider', () => new Promise((resolve) => server.close(resolve)));
  await removeSandbox(tmp, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
