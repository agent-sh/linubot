// Real model/tool continuation with deterministic compaction-service failures.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createAgentRuntime } from '../dist/agents/runtime.js';
import { chatResponse } from '../dist/auth/providers.js';
import { importHermesXai } from '../dist/auth/xai.js';
import { connectXai } from '../dist/auth/store.js';
import { appendEvent, eventsAfter } from '../dist/events/log.js';
import { setContextSettings } from '../dist/context/manager.js';
import { setMemoryEnabled } from '../dist/memory/store.js';
import { createBot } from '../dist/bots/manager.js';

const directory = mkdtempSync(join(tmpdir(), 'linubot-continuation-trial-'));
process.env.LINUBOT_DATA = directory;
mkdirSync('test-results/live', { recursive: true });
const receipt = { startedAt: new Date().toISOString(), fixture: 'Synthetic invoice events; real xAI model calls; native and portable compaction failures injected without waiting for their deadlines.', appSha256: createHash('sha256').update(readFileSync('release/linux-unpacked/resources/app.asar')).digest('hex'), checks: {}, passed: false };
let runtime;
try {
  importHermesXai(); connectXai(); createBot('ContinuationTrial');
  setMemoryEnabled(false);
  setContextSettings({ inputBudget: 10000, targetTokens: 1000, recentUnits: 2, mode: 'auto' });
  const scope = 'bot:ContinuationTrial';
  for (const [index, amount] of [17, 23, 31, 47, 59].entries()) appendEvent(scope, { detail: JSON.stringify({ invoice: index + 1, invoice_amount: amount, notes: 'Synthetic irrelevant receipt notes. '.repeat(220) }), kind: 'tool', name: 'invoice_fixture', status: 'done' });
  for (let index = 0; index < 4; index++) appendEvent(scope, { kind: 'message', from: 'user', text: `Earlier fixture discussion ${index}. ${'The current task will provide its own requirements. '.repeat(15)}` });
  let nativeFailures = 0, portableFailures = 0;
  runtime = createAgentRuntime({ review: false, contextNative: async () => { nativeFailures++; throw new Error('Injected native compaction timeout'); }, complete: async (provider, messages, tools, signal, options) => {
    if (messages[0]?.content.startsWith('Create a continuation checkpoint')) { portableFailures++; throw new Error('Injected portable compaction timeout'); }
    return chatResponse(provider, messages, tools, undefined, signal, options);
  } });
  const [run] = runtime.enqueue({ scope, message: 'First open original session events 1 through 5 by seq with read_session. They contain five invoice_amount values and long irrelevant notes. Add the five amounts and save exactly one Markdown artifact titled Invoice total with the sum. If the working context changes, search read_session for invoice_amount to recover the facts and continue the same task. Finish with CONTINUED_AFTER_COMPACTION and the total. Do not use memory, web or computer tools.' });
  const timer = setInterval(() => { const event = eventsAfter(scope, 0).at(-1); console.log(JSON.stringify({ seq: event?.seq, kind: event?.kind, status: event?.status, name: event?.name, text: event?.kind === 'thinking' ? event.text : undefined })); }, 15000);
  let done;
  try { done = await runtime.wait(run.id); } finally { clearInterval(timer); }
  const events = eventsAfter(scope, 0), recovery = events.find((event) => event.text === 'Continuing from the session archive');
  receipt.runId = run.id; receipt.model = done.model; receipt.status = done.status; receipt.error = done.error; receipt.response = done.response; receipt.nativeFailures = nativeFailures; receipt.portableFailures = portableFailures;
  receipt.checks = { bothCompactorsFailed: nativeFailures > 0 && portableFailures > 0, archiveRecovery: Boolean(recovery), continuedTools: events.some((event) => event.kind === 'tool' && event.status === 'done' && event.seq > (recovery?.seq ?? Infinity)), savedAfterCompaction: events.some((event) => event.kind === 'file' && event.name === 'Invoice total' && event.seq > (recovery?.seq ?? Infinity)), oneArtifact: events.filter((event) => event.kind === 'file' && event.name === 'Invoice total').length === 1, correctFinalAnswer: done.status === 'completed' && /CONTINUED_AFTER_COMPACTION/.test(done.response || '') && /\b177\b/.test(done.response || '') };
  receipt.events = events.filter((event) => event.runId === run.id).map(({ seq, kind, name, status, text }) => ({ seq, kind, name, status, ...(kind === 'thinking' || kind === 'notice' ? { text } : {}) }));
  receipt.passed = Object.values(receipt.checks).every(Boolean);
} catch (error) { receipt.error = error instanceof Error ? error.message : String(error); }
finally {
  await runtime?.close(); rmSync(directory, { recursive: true, force: true }); receipt.testProfileRemoved = true; receipt.finishedAt = new Date().toISOString();
  writeFileSync('test-results/live/COMPACTION-CONTINUATION-TRIAL.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ passed: receipt.passed, checks: receipt.checks, error: receipt.error }));
  if (!receipt.passed) process.exitCode = 1;
}
