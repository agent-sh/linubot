import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Real Electron + owned Chromium + input forwarding. Only the model and login account are fixtures.
const directory = mkdtempSync(join(tmpdir(), 'linubot-takeover-trial-'));
const data = join(directory, 'store'), profile = join(directory, 'profile');
const password = 'fixture-owner-only-passcode';
const useCodex = process.env.LINUBOT_TRIAL_CODEX === '1';
const receipt = { passed: false, model: useCodex ? 'ChatGPT / gpt-5.6-luna' : 'deterministic fixture', realDesktop: true, realWorkspace: true };
let accepted = false, authenticatedReads = 0, app, page;
const website = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/login') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    accepted = new URLSearchParams(Buffer.concat(chunks).toString()).get('password') === password;
    res.writeHead(303, { location: accepted ? '/inside' : '/', ...(accepted ? { 'set-cookie': 'fixture-session=approved; HttpOnly; SameSite=Strict; Path=/' } : {}) }); res.end(); return;
  }
  if (req.url === '/inside' && req.headers.cookie?.includes('fixture-session=approved')) {
    authenticatedReads++; res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Signed in</title><body style="font:32px sans-serif;padding:60px"><h1>LOGIN_VERIFIED</h1><p>The owner signed in using the embedded computer.</p></body>'); return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>Sign in to continue</title><body style="margin:0;background:#f5f3ed;font:24px sans-serif"><form action="/login" method="post"><h1 style="position:absolute;top:20px;left:40px;pointer-events:none">Sign in to continue</h1><input name="password" type="password" aria-label="Password" autocomplete="off" style="box-sizing:border-box;width:100vw;height:85vh;padding:100px 40px 40px;font-size:32px;background:transparent;border:3px solid #0f766e"><button style="height:12vh;width:100%;font-size:24px">Sign in</button></form></body>');
});
await new Promise((resolve) => website.listen(0, '127.0.0.1', resolve));
const loginUrl = `http://127.0.0.1:${website.address().port}/`;
const model = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()), messages = body.messages || [];
  const called = (name) => messages.some((message) => message.tool_calls?.some((call) => call.function.name === name));
  const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: `fixture-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  let message;
  if (String(messages[0]?.content).startsWith('Review a linubot')) message = { role: 'assistant', content: JSON.stringify({ summary: 'Fixture checked.', checks: [], limitations: [], lesson: null }) };
  else if (!called('start_workspace')) message = call('start_workspace', { purpose: 'Sign in through the embedded computer' });
  else if (!called('browse_workspace')) message = call('browse_workspace', { url: loginUrl });
  else if (!called('request_user_control')) message = call('request_user_control', { reason: 'Please sign in on the computer, then return control.' });
  else message = { role: 'assistant', content: messages.some((message) => message.role === 'tool' && String(message.content).includes('LOGIN_VERIFIED')) ? 'LOGIN_HANDOFF_OK' : 'LOGIN_STATE_MISSING' };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
});
await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
try {
  const env = { ...process.env, WAYLAND_DISPLAY: '', XDG_SESSION_TYPE: 'x11', LINUBOT_UPDATE_CHECK: '0', LINUBOT_DATA: data, LINUBOT_DESKTOP_PROFILE: profile, LINUBOT_PROVIDER: 'openai-compat', LINUBOT_BASE_URL: `http://127.0.0.1:${model.address().port}`, LINUBOT_API_KEY: 'fixture-key', LINUBOT_MODEL: 'fixture-model' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [resolve('desktop/main.cjs')], env, ...(process.env.LINUBOT_TEST_EXECUTABLE ? { executablePath: process.env.LINUBOT_TEST_EXECUTABLE, args: [] } : {}) });
  page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'Your bots', exact: true })).toBeVisible();
  if (useCodex) {
    await page.evaluate(async () => {
      const post = async (path, body) => { const result = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const value = await result.json(); if (!result.ok) throw new Error(value.error); return value; };
      const connected = await post('/api/oauth/codex/existing', {});
      await post('/api/provider', { id: connected.connectionId, model: 'gpt-5.6-luna' });
      await post('/api/provider/select', { id: connected.connectionId });
    });
  }
  await page.evaluate(async () => {
    const result = await fetch('/api/bots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'LoginHelper' }) });
    if (!result.ok) throw new Error('Could not create fixture bot'); location.hash = '#/bot/LoginHelper';
  });
  await page.locator('textarea[name=message]').fill(`Use your computer browser to open ${loginUrl}. Ask me to sign in with request_user_control; do not enter credentials yourself. After I return control, verify the page says LOGIN_VERIFIED, then reply exactly LOGIN_HANDOFF_OK. No other apps or external websites are needed.`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve once', exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Approve once', exact: true }).click();
  await page.getByRole('button', { name: 'Computer', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Bot computer', exact: true }), screen = panel.locator('[data-screen]');
  await expect(panel.locator('[data-state]')).toContainText('Needs you:', { timeout: 90000 });
  await panel.getByRole('button', { name: 'Take control', exact: true }).click();
  await expect(screen).toHaveClass(/controlling/, { timeout: 30000 });
  await panel.getByRole('button', { name: 'Expand', exact: true }).click();
  await screen.click(); await screen.pressSequentially(password, { delay: 100 }); await screen.press('Enter');
  await expect.poll(() => accepted && authenticatedReads > 0, { timeout: 30000 }).toBe(true);
  receipt.loginAccepted = true;
  mkdirSync('test-results/live', { recursive: true });
  await page.screenshot({ path: 'test-results/live/computer-signed-in.png', fullPage: true });
  await panel.getByRole('button', { name: 'Return to bot', exact: true }).click();
  await expect(page.locator('.message-body').filter({ hasText: 'LOGIN_HANDOFF_OK' })).toBeVisible({ timeout: 30000 });
  await expect.poll(async () => page.evaluate(async () => {
    const runs = await fetch('/api/runs?bot=LoginHelper').then((r) => r.json());
    return runs.length > 0 && runs.every((run) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status));
  }), { timeout: 120000 }).toBe(true);
  const runs = await page.evaluate(() => fetch('/api/runs?bot=LoginHelper').then((r) => r.json()));
  if (runs.some((run) => run.status !== 'completed' || !run.response?.includes('LOGIN_HANDOFF_OK'))) throw new Error('The bot did not complete the login task: ' + (runs[0]?.error || runs[0]?.status));
  receipt.botContinued = true;
  await panel.getByRole('button', { name: 'Close computer', exact: true }).click();
  await expect(panel).toBeHidden(); receipt.panelClosed = true;
  const list = await page.evaluate(() => fetch('/api/computer/list').then((r) => r.json()));
  if (JSON.parse(list.report).workspaces.length) throw new Error('Task workspace did not clean up');
  receipt.workspaceCleaned = true;
  const transcripts = readdirSync(data).filter((name) => name.endsWith('.jsonl')).map((name) => readFileSync(join(data, name), 'utf8')).join('\n');
  if (transcripts.includes(password)) throw new Error('Owner input was written into a conversation log');
  receipt.passwordAbsentFromConversation = true; receipt.passed = true;
} catch (error) {
  receipt.error = error.message; process.exitCode = 1;
  mkdirSync('test-results/live', { recursive: true });
  if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/live/computer-trial-error.png', fullPage: true }).catch(() => {});
} finally {
  if (app) await app.close().catch(() => {});
  for (const server of [website, model]) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  rmSync(directory, { recursive: true, force: true });
  mkdirSync('test-results/live', { recursive: true });
  writeFileSync('test-results/live/computer-takeover.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
}
