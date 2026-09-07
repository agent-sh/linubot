import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { importHermesXai } from '../dist/auth/xai.js';
import { connectMuse, connectXai, providerConnections } from '../dist/auth/store.js';
import { chatResponse } from '../dist/auth/providers.js';
import { createBot } from '../dist/bots/manager.js';
import { setMemoryEnabled } from '../dist/memory/store.js';
import { createAgentRuntime } from '../dist/agents/runtime.js';

const directory = mkdtempSync(join(tmpdir(), 'linubot-multiple-provider-trial-'));
process.env.LINUBOT_DATA = directory;
mkdirSync('test-results/live', { recursive: true });
const receipt = { startedAt: new Date().toISOString(), appSha256: createHash('sha256').update(readFileSync('release/linux-unpacked/resources/app.asar')).digest('hex'), calls: [], checks: {}, passed: false };
let runtime;
try {
  importHermesXai(); connectXai();
  const first = providerConnections().connections.find((p) => p.kind === 'xai-oauth');
  const beforeDefault = providerConnections().activeId, second = connectMuse();
  setMemoryEnabled(false);
  createBot('GrokParallel', { providerId: first.id }); createBot('MuseParallel', { providerId: second.id });
  runtime = createAgentRuntime({ review: false, maxParallel: 2, complete: async (provider, messages, tools, signal, options) => {
    const call = { provider: provider.name, model: provider.model, startedAt: Date.now() }; receipt.calls.push(call);
    try { return await chatResponse(provider, messages, tools, undefined, signal, options); }
    finally { call.finishedAt = Date.now(); }
  } });
  const [a] = runtime.enqueue({ scope: 'bot:GrokParallel', message: 'Reply with exactly XAI_PARALLEL_OK. No tools are needed.' });
  const [b] = runtime.enqueue({ scope: 'bot:MuseParallel', message: 'Reply with exactly MUSE_PARALLEL_OK. No tools are needed.' });
  const results = await Promise.all([runtime.wait(a.id), runtime.wait(b.id)]);
  receipt.runs = results.map(({ id, bot, model, status, response, error, usage }) => ({ id, bot, model, status, response, error, usage }));
  receipt.checks = { xaiAnswered: results[0].status === 'completed' && results[0].response?.trim() === 'XAI_PARALLEL_OK', museAnswered: results[1].status === 'completed' && results[1].response?.trim() === 'MUSE_PARALLEL_OK', requestsOverlapped: receipt.calls.length === 2 && receipt.calls[0].startedAt < receipt.calls[1].finishedAt && receipt.calls[1].startedAt < receipt.calls[0].finishedAt, defaultUnchanged: providerConnections().activeId === beforeDefault, bothStillReady: [first.id, second.id].every((id) => providerConnections().connections.some((p) => p.id === id && p.ready)) };
  receipt.passed = Object.values(receipt.checks).every(Boolean);
} catch (error) { receipt.error = error instanceof Error ? error.message : String(error); }
finally {
  await runtime?.close(); rmSync(directory, { recursive: true, force: true }); receipt.testProfileRemoved = true; receipt.finishedAt = new Date().toISOString();
  writeFileSync('test-results/live/MULTI-PROVIDER-TRIAL.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ passed: receipt.passed, checks: receipt.checks, error: receipt.error }));
  if (!receipt.passed) process.exitCode = 1;
}
