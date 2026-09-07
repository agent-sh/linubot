// Real xAI continuation/compaction trial over explicitly synthetic historical notes.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const directory = mkdtempSync(join(tmpdir(), 'linubot-context-trial-'));
const data = join(directory, 'store'), output = resolve('test-results/live'); mkdirSync(output, { recursive: true });
const executable = process.env.LINUBOT_TRIAL_EXECUTABLE || resolve('release/linux-unpacked/linubot');
const env = { ...process.env, LINUBOT_DATA: data, LINUBOT_DESKTOP_PROFILE: join(directory, 'desktop') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'LINUBOT_PROVIDER', 'LINUBOT_MODEL', 'LINUBOT_BASE_URL', 'LINUBOT_API_KEY', 'LINUBOT_AUTH']) delete env[key];
const receipt = { startedAt: new Date().toISOString(), fixture: 'Synthetic session history; real xAI OAuth inference and compaction. Durable bot memory disabled to isolate context behavior.',
  executable, appSha256: createHash('sha256').update(readFileSync(join(executable, '..', 'resources/app.asar'))).digest('hex'), checks: {}, runs: [], stages: [], browserErrors: [] };
let app, page;
async function launch() {
  app = await electron.launch({ executablePath: executable, args: [], env }); page = await app.firstWindow();
  page.on('pageerror', (error) => receipt.browserErrors.push(error.message));
  await expect(page.getByRole('heading', { name: 'Your bots', exact: true })).toBeVisible();
}
const call = (path, body, method = body === undefined ? 'GET' : 'POST') => page.evaluate(async ({ path, body, method }) => {
  const response = await fetch(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data;
}, { path, body, method });
async function send(prompt) {
  await page.evaluate(() => { location.hash = '#/bot/ContextTrial'; });
  await expect(page.locator('.conversation-header h1')).toHaveText('ContextTrial');
  const prior = new Set((await call('/api/runs?bot=ContextTrial')).map((run) => run.id));
  await page.locator('textarea[name=message]').fill(prompt); await page.getByRole('button', { name: 'Send', exact: true }).click();
  let run, previous = '';
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    run = (await call('/api/runs?bot=ContextTrial')).find((run) => !prior.has(run.id));
    if (run) {
      const status = `${run.id}: ${run.status}, tools=${run.toolCalls}`;
      if (status !== previous) { console.log(status); previous = status; }
      if (run.status === 'awaiting_approval') throw new Error('Unexpected privileged action in the context-only trial');
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (run) receipt.runs.push(run);
  assert.equal(run?.status, 'completed', run?.error || 'The run did not complete');
  const events = (await call('/api/feed/bot%3AContextTrial?limit=200')).entries.filter((event) => event.runId === run.id);
  receipt.stages.push(...events.filter((event) => event.kind === 'thinking' && /context|compact|checkpoint/i.test(event.text || '')));
  assert.equal(events.some((event) => event.kind === 'tool' && !['read_session', 'read_memory', 'compact_context'].includes(event.name)), false, 'unexpected non-context tool');
  return { run, events };
}
const feedPath = join(data, 'feed-bot_ContextTrial.jsonl');
function seedNotes(count, phase) {
  const existing = readFileSync(feedPath, 'utf8').trim().split('\n').filter(Boolean);
  let seq = existing.length ? JSON.parse(existing.at(-1)).seq : 0;
  const records = [];
  for (let i = 0; i < count; i++) {
    let text = `Historical fixture note ${phase}-${i}. ${'We discussed the release plan, reviewed nonessential draft wording and kept the work scoped to the existing project. '.repeat(13)}`;
    if (phase === 1 && i === 0) text = 'Release decision: the final artifact path is /project/release/ledger-7391.md. The initial region is eu-west-1. Release is allowed only after the owner says ORCHID_GATE_7391.';
    if (phase === 1 && i === 5) text += ' ARCHIVE_ONLY_7391: violet sparrow is the exact archive-only checksum phrase.';
    if (phase === 1 && i === 17) text = 'Correction: the latest deployment region is ap-south-2, replacing eu-west-1. Keep the artifact path and release approval phrase.';
    if (phase === 2 && i === 3) text = 'Updated decision: the latest deployment region is now sa-east-1, replacing ap-south-2. Keep the artifact path and approval phrase.';
    records.push({ seq: ++seq, at: new Date(Date.now() - (count - i) * 1000).toISOString(), kind: 'message', from: i % 2 ? 'ContextTrial' : 'user', text });
  }
  appendFileSync(feedPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}
try {
  await launch(); await page.evaluate(() => { location.hash = '#/settings/provider'; });
  await page.locator('select[name=preset]').selectOption('xai-oauth');
  await page.getByRole('button', { name: 'Use existing Hermes sign-in', exact: true }).click();
  await expect(page.locator('select[name=kind]')).toHaveValue('xai-oauth');
  await expect(page.locator('[data-provider-model] [data-model-status]')).toContainText('models from this endpoint', { timeout: 30000 });
  const provider = await call('/api/provider'); const catalog = await call('/api/provider/models');
  assert.equal(provider.kind, 'xai-oauth'); assert.ok(catalog.models.some((model) => model.id === provider.model));
  receipt.provider = { id: provider.id, kind: provider.kind, model: provider.model, catalogCount: catalog.models.length, catalogSource: catalog.source };
  receipt.checks.liveModelDropdown = true;
  await page.screenshot({ path: join(output, 'provider-live-catalog.png'), fullPage: true });
  await call('/api/memory/settings', { enabled: false }, 'PUT');
  await call('/api/context/settings', { enabled: true, mode: 'auto', inputBudget: 12000, targetTokens: 3000, recentUnits: 3 }, 'PUT');
  await call('/api/bots', { name: 'ContextTrial', goal: 'Answer from the supplied session notes. Recover exact original events when needed. Do not invent missing facts.' });
  writeFileSync(feedPath, '', { flag: 'wx', mode: 0o600 }); seedNotes(44, 1);
  const originalPrefix = readFileSync(feedPath, 'utf8');
  const question = 'This is a context-continuation trial using the earlier fixture notes. Return the final artifact path, the latest deployment region, and the exact release approval phrase. Use session recovery if needed. Do not browse, open a workspace, or perform external actions.';
  console.log('Testing initial compaction and recall.');
  const first = await send(question);
  assert.match(first.run.response, /\/project\/release\/ledger-7391\.md/); assert.match(first.run.response, /ap-south-2/); assert.match(first.run.response, /ORCHID_GATE_7391/);
  const initialContext = await call('/api/context/bot%3AContextTrial');
  assert.ok(initialContext.checkpoint?.count >= 1, 'a working checkpoint must be persisted');
  receipt.firstCheckpoint = initialContext.checkpoint; receipt.checks.initialRecall = true;
  assert.ok(readFileSync(feedPath, 'utf8').startsWith(originalPrefix)); receipt.checks.archivePrefixPreserved = true;
  await page.screenshot({ path: join(output, 'context-first-recall.png'), fullPage: true });
  await app.close(); app = undefined;
  seedNotes(32, 2);
  await launch(); console.log('Testing restart, repeated compaction and corrected state.');
  const second = await send(question);
  assert.match(second.run.response, /\/project\/release\/ledger-7391\.md/); assert.match(second.run.response, /sa-east-1/); assert.match(second.run.response, /ORCHID_GATE_7391/);
  const repeated = await call('/api/context/bot%3AContextTrial');
  assert.ok(repeated.checkpoint.count > initialContext.checkpoint.count);
  receipt.secondCheckpoint = repeated.checkpoint; receipt.checks.repeatedCompactionAfterRestart = true; receipt.checks.correctedState = true;
  await app.close(); app = undefined; await launch();
  console.log('Testing explicit recovery from original history.');
  const recovered = await send('Use read_session to find the original note containing ARCHIVE_ONLY_7391 and quote its checksum phrase exactly. Do not use web or workspace tools.');
  assert.match(recovered.run.response, /violet sparrow/i);
  assert.ok(recovered.events.some((event) => event.name === 'read_session' && event.status === 'done'));
  receipt.checks.archiveRecovery = true;
  const memory = await call('/api/memory'); assert.deepEqual(memory.memory, []); assert.deepEqual(memory.user, []); receipt.checks.memoryDidNotMaskFailure = true;
  receipt.checks.noBrowserErrors = receipt.browserErrors.length === 0;
  await page.screenshot({ path: join(output, 'context-archive-recovery.png'), fullPage: true });
  receipt.passed = Object.values(receipt.checks).every(Boolean);
  console.log('PASS', JSON.stringify(receipt.checks));
} catch (error) {
  receipt.passed = false; receipt.error = error.message; console.error('FAIL', error.message); process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'context-trial-error.png'), fullPage: true }).catch(() => {});
} finally {
  if (app) await app.close();
  rmSync(directory, { recursive: true, force: true }); receipt.testProfileRemoved = true; receipt.finishedAt = new Date().toISOString();
  const attempt = `context-trial-${receipt.startedAt.replace(/[:.]/g, '-')}.json`;
  writeFileSync(join(output, attempt), JSON.stringify(receipt, null, 2));
  if (receipt.passed) writeFileSync('test-results/live/CONTEXT-TRIAL.json', JSON.stringify(receipt, null, 2));
  console.log('Receipt', attempt);
}
