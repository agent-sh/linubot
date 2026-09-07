// Operator-driven acceptance test: real xAI OAuth, installed desktop, temporary user data.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const botDecisions = process.argv.includes('--bot-decisions');
const trialName = botDecisions ? 'bot-memory' : 'group-memory';
const directory = mkdtempSync(join(tmpdir(), `linubot-${trialName}-`));
const data = join(directory, 'store');
const output = resolve('test-results/live');
mkdirSync(output, { recursive: true });
const executable = process.env.LINUBOT_TRIAL_EXECUTABLE || join(homedir(), '.local/opt/linubot/linubot');
const env = { ...process.env, LINUBOT_DATA: data, LINUBOT_DESKTOP_PROFILE: join(directory, 'desktop') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'LINUBOT_BASE_URL', 'LINUBOT_API_KEY', 'LINUBOT_MODEL', 'LINUBOT_PROVIDER']) delete env[key];
const receipt = {
  startedAt: new Date().toISOString(), executable,
  appSha256: createHash('sha256').update(readFileSync(join(executable, '..', 'resources/app.asar'))).digest('hex'),
  testData: 'Temporary profile; synthetic planning preference, not a fact about the real user.',
  mode: botDecisions ? 'Bot chooses memory during ordinary conversation' : 'Explicit Remember option',
  runs: [], checks: {}, browserErrors: [], memoryEvents: [],
};
let app, page;
const call = (path) => page.evaluate(async (path) => {
  const response = await fetch(path);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}, path);
const savedMemory = () => [readFileSync(join(data, 'MEMORY.md'), 'utf8'), readFileSync(join(data, 'USER.md'), 'utf8')].join('\n');
async function memoryEvents(run) {
  const feed = (await call(`/api/feed/${encodeURIComponent(run.scope)}?limit=200`)).entries;
  const events = feed.filter((event) => event.runId === run.id && event.name === 'memory');
  receipt.memoryEvents.push(...events);
  return events;
}
async function launch() {
  app = await electron.launch({ executablePath: executable, args: [], env, timeout: 30000 });
  page = await app.firstWindow();
  page.on('pageerror', (error) => receipt.browserErrors.push(error.message));
  await expect(page.getByRole('heading', { name: 'Your bots', exact: true })).toBeVisible();
}
async function navigate(route) {
  await page.evaluate((route) => { location.hash = `#/${route}`; }, route);
  if (route.startsWith('bot/') || route.startsWith('group/')) {
    const name = route.startsWith('bot/') ? route.slice(4) : 'Planning together';
    await expect(page.locator('.conversation-header h1')).toHaveText(name);
    await expect(page.locator('textarea[name=message]')).toBeVisible();
  }
}
async function createBot(name, goal) {
  await navigate('home');
  await page.locator('.bot-home').getByRole('button', { name: 'Add a bot', exact: true }).first().click();
  await page.getByRole('textbox', { name: 'Bot name', exact: true }).fill(name);
  await page.getByRole('textbox', { name: 'What can they help with?', exact: true }).fill(goal);
  await page.getByRole('button', { name: 'Add bot', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
async function send(scope, prompt, expectedCount = 1, remember = false) {
  await navigate(scope.replace(':', '/'));
  await expect(page.locator('textarea[name=message]')).toBeVisible();
  const prior = new Set((await call('/api/runs?limit=200')).map((run) => run.id));
  await page.locator('textarea[name=message]').fill(prompt);
  if (scope.startsWith('bot:') && remember) {
    await page.getByLabel('Message options', { exact: true }).click();
    await page.locator('input[name=remember]').setChecked(remember);
    await page.keyboard.press('Escape');
  }
  if (botDecisions && scope.startsWith('bot:')) assert.equal(await page.locator('input[name=remember]').isChecked(), false);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  let runs = [], previous = '';
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    runs = (await call('/api/runs?limit=200')).filter((run) => !prior.has(run.id) && run.scope === scope);
    const status = runs.map((run) => `${run.bot}:${run.status}`).join(',');
    if (status !== previous) { console.log(scope, status); previous = status; }
    if (runs.some((run) => run.status === 'awaiting_approval')) throw new Error('A conversation-only trial requested an unexpected privileged action');
    if (runs.length === expectedCount && runs.every((run) => !['queued', 'running'].includes(run.status))) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  receipt.runs.push(...runs);
  assert.equal(runs.length, expectedCount, 'one real run per intended bot');
  for (const run of runs) assert.equal(run.status, 'completed', `${run.bot}: ${run.error || run.status}`);
  return runs;
}
try {
  await launch();
  await navigate('settings/provider');
  await page.locator('select[name=preset]').selectOption('xai-oauth');
  await page.getByRole('button', { name: 'Use existing Hermes sign-in', exact: true }).click();
  await expect(page.locator('select[name=kind]')).toHaveValue('xai-oauth', { timeout: 15000 });
  const provider = await call('/api/provider');
  assert.equal(provider.kind, 'xai-oauth'); assert.equal(provider.model, 'grok-4.6'); assert.equal(provider.ready, true);
  receipt.provider = { kind: provider.kind, model: provider.model, auth: 'Authorized existing Hermes xAI OAuth session' };
  await createBot('MiloTrial', 'Make practical short plans. Keep responses under 80 words unless asked otherwise.');
  await createBot('FernTrial', 'Check plans, build on colleagues, and do not invent personal information. Keep responses under 80 words.');

  // A real negative control before the synthetic preference exists anywhere in this profile.
  const recallPrompt = 'What daily planning time, maximum planning duration, and project nickname have I asked you to remember? Use only stored context. If a detail is unknown, say so. Do not invent it. Reply in under 60 words.';
  const [control] = await send('bot:FernTrial', recallPrompt);
  receipt.checks.unknownBeforeTeaching = !/Cedar Lantern|7351|06:35/.test(control.response) && /unknown|not|haven.t|no |don.t/i.test(control.response);
  assert.ok(receipt.checks.unknownBeforeTeaching, 'control must not guess the synthetic details');
  if (botDecisions) { receipt.checks.noMemoryFromRoutineQuestion = !savedMemory().trim(); assert.ok(receipt.checks.noMemoryFromRoutineQuestion); }

  const teaching = botDecisions
    ? 'My daily planning window starts at 06:35 UTC. I keep plans within 25 minutes, and my working project nickname is Cedar Lantern 7351. Those are my usual working habits. Can you help me plan a short writing session? Keep it brief.'
    : 'This is a synthetic QA persona, not information about the real user. Please remember these planning preferences for future conversations: my daily planning window starts at 06:35 UTC, plans must fit within 25 minutes, and my working project nickname is Cedar Lantern 7351. Acknowledge briefly.';
  const [taught] = await send('bot:MiloTrial', teaching, 1, !botDecisions);
  receipt.teachingRunId = taught.id;
  const memoryBeforeRestart = savedMemory();
  if (botDecisions) {
    const decisions = await memoryEvents(taught);
    receipt.checks.botChoseMemoryWithoutRememberRequest = decisions.some((event) => event.status === 'done') && !/remember/i.test(teaching);
    receipt.checks.savedAllPreferences = /06:35/.test(memoryBeforeRestart) && /25/.test(memoryBeforeRestart) && /Cedar Lantern 7351/i.test(memoryBeforeRestart);
    assert.ok(receipt.checks.botChoseMemoryWithoutRememberRequest); assert.ok(receipt.checks.savedAllPreferences);
  } else { receipt.checks.savedWithExplicitRemember = memoryBeforeRestart.includes(teaching); assert.ok(receipt.checks.savedWithExplicitRemember); }
  console.log('Preference persisted. Restarting the whole desktop app.');
  await app.close(); app = undefined;
  await launch();
  receipt.checks.memorySurvivedRestart = savedMemory() === memoryBeforeRestart;

  // Fern's own conversation never received the teaching message; the prompt does not repeat its values.
  const [recalled] = await send('bot:FernTrial', recallPrompt);
  const hasPreference = (text) => /06:35/.test(text) && /25/.test(text) && /Cedar Lantern 7351/i.test(text);
  receipt.checks.otherBotRecalledAfterRestart = hasPreference(recalled.response);
  receipt.recall = { prompt: recallPrompt, response: recalled.response, runId: recalled.id };
  assert.ok(receipt.checks.otherBotRecalledAfterRestart, 'independent bot must recall all three values');
  await expect(page.locator('.message-body').last()).toContainText('Cedar Lantern 7351');
  await page.screenshot({ path: join(output, `${trialName}-recall.png`), fullPage: true });

  await page.locator('#new-group').click();
  const modal = page.getByRole('dialog');
  await modal.locator('input[name=name]').fill('Planning together');
  await modal.locator('input[name=id]').fill('planning-trial');
  for (const name of ['MiloTrial', 'FernTrial']) await modal.locator(`input[name=members][value="${name}"]`).check();
  await modal.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Planning together', exact: true })).toBeVisible();
  const group = await call('/api/groups/planning-trial');
  assert.deepEqual([...group.members].sort(), ['FernTrial', 'MiloTrial']);
  receipt.group = { id: group.id, name: group.name, members: group.members };
  receipt.checks.createdGroupThroughUi = true;

  const groupPrompt = '@MiloTrial, work with FernTrial on a short plan to write a product update for my remembered project. Use the daily time and duration I previously asked you to remember. MiloTrial: begin with a plain line "Plan title: <new two-word title>" and propose three short steps. FernTrial: begin "Building on MiloTrial: <the exact title MiloTrial chose>" and give one concrete improvement to that plan. Each reply must stay under 80 words. Use the shared conversation and stored context. No web browsing or other external actions are needed.';
  const groupRuns = await send('group:planning-trial', groupPrompt, 2);
  const feed = (await call('/api/feed/group%3Aplanning-trial?limit=200')).entries;
  const ids = new Set(groupRuns.map((run) => run.id));
  const replies = feed.filter((event) => event.kind === 'message' && ids.has(event.runId));
  receipt.groupReplies = replies.map(({ from, text, seq, runId }) => ({ from, text, seq, runId }));
  receipt.checks.groupRepliesInOrder = JSON.stringify(replies.map((event) => event.from)) === JSON.stringify(['MiloTrial', 'FernTrial']);
  assert.ok(receipt.checks.groupRepliesInOrder);
  const title = replies[0].text.match(/Plan title:\s*([^\n]+)/i)?.[1].replace(/\*/g, '').trim();
  receipt.checks.secondBotBuiltOnFirst = Boolean(title && !groupPrompt.includes(title) && replies[1].text.toLowerCase().includes(title.toLowerCase()));
  receipt.checks.groupUsedRememberedContext = hasPreference(replies.map((event) => event.text).join('\n'));
  assert.ok(receipt.checks.secondBotBuiltOnFirst, 'second bot must use the title invented by the first');
  assert.ok(receipt.checks.groupUsedRememberedContext);
  await expect(page.locator('.message-body').last()).toContainText(title);
  await page.screenshot({ path: join(output, `${trialName}-conversation.png`), fullPage: true });
  await navigate('sessions');
  await expect(page.getByRole('link', { name: 'Open session with Planning together', exact: true })).toBeVisible();
  receipt.checks.groupInSessions = true;
  await app.close(); app = undefined;
  await launch();
  assert.deepEqual((await call('/api/groups/planning-trial')).members, group.members);
  receipt.checks.groupSurvivedRestart = true;
  if (botDecisions) {
    const [corrected] = await send('bot:MiloTrial', 'My daily planning window has moved to 08:10 UTC. The 25-minute limit and project nickname stay the same.');
    const correctionEvents = await memoryEvents(corrected);
    receipt.checks.botUpdatedPreference = correctionEvents.some((event) => event.status === 'done') && /08:10/.test(savedMemory()) && !/06:35/.test(savedMemory());
    assert.ok(receipt.checks.botUpdatedPreference, 'the old time must be replaced, not left as a competing fact');
    await app.close(); app = undefined; await launch();
    await createBot('DotTrial', 'Help with planning using the available user context. Do not invent missing preferences.');
    const [updatedRecall] = await send('bot:DotTrial', recallPrompt);
    receipt.updatedRecall = { response: updatedRecall.response, runId: updatedRecall.id };
    receipt.checks.freshBotRecalledCorrection = /08:10/.test(updatedRecall.response) && !/06:35/.test(updatedRecall.response) && /25/.test(updatedRecall.response) && /Cedar Lantern 7351/i.test(updatedRecall.response);
    assert.ok(receipt.checks.freshBotRecalledCorrection);
    const [forgotten] = await send('bot:MiloTrial', 'Forget the saved project nickname. Keep my planning time and duration.');
    const forgetEvents = await memoryEvents(forgotten);
    receipt.checks.botForgotOnlyRequestedDetail = forgetEvents.some((event) => event.status === 'done') && !/Cedar Lantern|7351/i.test(savedMemory()) && /08:10/.test(savedMemory()) && /25/.test(savedMemory());
    assert.ok(receipt.checks.botForgotOnlyRequestedDetail);
    await app.close(); app = undefined; await launch();
    await createBot('PipTrial', 'Use saved user context to answer briefly. Do not invent unknown personal details.');
    const [afterForget] = await send('bot:PipTrial', 'What is my working project nickname? If it is not in saved context, say it is unknown. Do not guess.');
    receipt.afterForget = { response: afterForget.response, runId: afterForget.id };
    receipt.checks.freshBotDidNotRecallForgottenDetail = !/Cedar Lantern|7351/i.test(afterForget.response) && /unknown|not|don.t|no /i.test(afterForget.response);
    receipt.checks.noRememberCheckboxUsed = true;
    assert.ok(receipt.checks.freshBotDidNotRecallForgottenDetail);
    await navigate('memory/user');
    await expect(page.getByRole('heading', { name: 'What your bots remember', exact: true })).toBeVisible();
    await page.screenshot({ path: join(output, 'bot-memory-after-forget.png'), fullPage: true });
  }
  receipt.checks.noBrowserErrors = receipt.browserErrors.length === 0;
  assert.ok(Object.values(receipt.checks).every(Boolean));
  receipt.passed = true;
  console.log('PASS', JSON.stringify(receipt.checks));
} catch (error) {
  receipt.passed = false; receipt.error = error.message;
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, `${trialName}-error.png`), fullPage: true }).catch(() => {});
  console.error('FAIL', error.message); process.exitCode = 1;
} finally {
  if (app) await app.close();
  rmSync(directory, { recursive: true, force: true });
  receipt.testProfileRemoved = true;
  receipt.finishedAt = new Date().toISOString();
  const filename = `${trialName}-${receipt.startedAt.replace(/[:.]/g, '-')}.json`;
  writeFileSync(join(output, filename), JSON.stringify(receipt, null, 2));
  if (receipt.passed) writeFileSync(`test-results/live/${trialName.toUpperCase()}-TRIAL.json`, JSON.stringify(receipt, null, 2));
  console.log('Receipt', filename);
}
