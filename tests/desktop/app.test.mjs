import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('bots and sessions lead the desktop; feedback and tuning stay optional', async () => {
  const data = mkdtempSync(join(tmpdir(), 'linubot-desktop-test-'));
  const calls = [];
  const provider = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString()); calls.push(request);
    const permission = String(request.messages.findLast((message) => message.role === 'user')?.content).includes('permission check');
    const remember = String(request.messages.findLast((message) => message.role === 'user')?.content).includes('I prefer short paragraphs.');
    let message;
    if (request.messages[0].content.startsWith('Review a linubot')) message = { role: 'assistant', content: JSON.stringify({ summary: 'Reply checked.', checks: [], limitations: [], lesson: null }) };
    else if (!request.messages.some((message) => message.role === 'tool')) message = { role: 'assistant', content: null, tool_calls: [{ id: `call-${calls.length}`, type: 'function', function: remember ? { name: 'memory', arguments: JSON.stringify({ action: 'add', target: 'user', content: 'Prefers short paragraphs.', evidence: 'I prefer short paragraphs.' }) } : permission ? { name: 'start_workspace', arguments: JSON.stringify({ purpose: 'Desktop permission check' }) } : { name: 'save_artifact', arguments: JSON.stringify({ title: 'Desktop trial', content: '# Desktop trial\nA durable deliverable.' }) } }] };
    else message = { role: 'assistant', content: remember ? "I'll keep replies in short paragraphs." : permission ? 'Okay, I left the workspace closed.' : 'Saved the Desktop trial artifact with a durable deliverable.' };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, LINUBOT_UPDATE_CHECK: '0', LINUBOT_DATA: join(data, 'store'), LINUBOT_DESKTOP_PROFILE: join(data, 'profile'), LINUBOT_BASE_URL: `http://127.0.0.1:${provider.address().port}`, LINUBOT_API_KEY: 'fixture-key', LINUBOT_MODEL: 'fixture-model', LINUBOT_PROVIDER: 'openai-compat' };
  delete env.ELECTRON_RUN_AS_NODE;
  const options = { args: [resolve('desktop/main.cjs')], env, ...(process.env.LINUBOT_TEST_EXECUTABLE ? { executablePath: process.env.LINUBOT_TEST_EXECUTABLE, args: [] } : {}) };
  let app, page;
  try {
    app = await electron.launch(options);
    page = await app.firstWindow();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    mkdirSync('test-results', { recursive: true });
    await expect(page.getByRole('heading', { name: 'Your bots', exact: true })).toBeVisible();
    await expect.poll(() => page.locator('img.brand-mark').evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(page.locator('.main-nav a')).toHaveText(['Your bots', 'Sessions']);
    await expect(page.locator('.stats-strip')).toHaveCount(0);
    const origin = new URL(page.url()).origin;
    expect((await fetch(`${origin}/api/overview`)).status).toBe(403);
    expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
    await page.screenshot({ path: 'test-results/ux-welcome.png', fullPage: true });

    await page.locator('.bot-home').getByRole('button', { name: 'Add a bot', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Bot name', exact: true })).toBeFocused();
    await page.getByRole('textbox', { name: 'Bot name', exact: true }).fill('Milo');
    await page.getByRole('textbox', { name: 'What can they help with?', exact: true }).fill('Help me write clearly');
    const beforeShuffle = await page.locator('[data-mascot-preview] .mascot').getAttribute('data-mascot');
    await page.getByRole('button', { name: 'New look', exact: true }).click();
    const chosenLook = await page.locator('[data-mascot-preview] .mascot').getAttribute('data-mascot');
    expect(chosenLook).not.toBe(beforeShuffle);
    await page.screenshot({ path: 'test-results/ux-create-bot.png', fullPage: true });
    await page.getByRole('button', { name: 'Add bot', exact: true }).click();
    await expect(page.locator('.conversation-identity .mascot')).toHaveAttribute('data-mascot', chosenLook);
    await expect(page.getByRole('complementary', { name: 'Session details', exact: true })).not.toBeVisible();
    await expect(page.locator('textarea[name=criteria]')).not.toBeVisible();
    await page.getByLabel('Message options', { exact: true }).click();
    await expect(page.locator('textarea[name=criteria]')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByLabel('Bot options', { exact: true }).click();
    await page.getByRole('button', { name: 'Session details', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Session details', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close session details', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Improvement lab', exact: true })).toHaveCount(0);

    await page.locator('textarea[name=message]').fill('Save a Desktop trial artifact.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message-body').filter({ hasText: 'Saved the Desktop trial artifact' })).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.activity-group')).not.toHaveCount(0);
    await expect(page.locator('.activity-group > details[open]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Review result', exact: true })).toHaveCount(0);
    await expect(page.getByText('Not yet reviewed', { exact: true })).toHaveCount(0);
    await expect(page.locator('.composer [data-feedback]')).not.toBeVisible();
    await page.screenshot({ path: 'test-results/ux-chat.png', fullPage: true });

    // Reviewing is available only after the user asks for reply options.
    await page.locator('.message:not(.user-message)').last().hover();
    await page.getByLabel('Reply options', { exact: true }).last().click();
    await page.getByRole('button', { name: 'Feedback & evaluation', exact: true }).click();
    await page.getByLabel('Useful', { exact: true }).check();
    await page.getByRole('button', { name: 'Save feedback', exact: true }).click();
    await page.keyboard.press('Escape');

    await page.locator('textarea[name=message]').fill('Run a permission check.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(page.locator('.message-body').getByText('Okay, I left the workspace closed.', { exact: true })).toBeVisible();
    await page.evaluate(async () => {
      for (const bot of [{ name: 'Fern', topic: 'A curious researcher', mascotSeed: 'fern-qa' }, { name: 'Dot', topic: 'Plans and little details', mascotSeed: 'dot-qa' }]) {
        await fetch('/api/bots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bot) });
      }
      const runs = await fetch('/api/runs?bot=Milo').then((response) => response.json());
      const run = runs.find((run) => run.prompt === 'Run a permission check.');
      const proposal = await fetch('/api/agents/Milo/proposals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: run.id, text: 'Respect an explicit denial.', reason: 'Keep the owner in control.', evidence: 'Run a permission check.' }) });
      if (!proposal.ok) throw new Error('Could not prepare learning-note fixture');
      location.hash = '#/home';
    });
    await page.reload();
    await expect(page.locator('.bot-grid a.bot-tile')).toHaveCount(3);
    await expect(page.locator('.stats-strip')).toHaveCount(0);
    await expect(page.locator('[data-learning-indicator]')).toBeVisible();
    await expect(page.locator('[data-learning-summary]')).toHaveText('1 learning note available');
    await page.screenshot({ path: 'test-results/ux-bots.png', fullPage: true });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 640));
    await page.waitForFunction(() => innerWidth < 1000);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/ux-compact.png', fullPage: true });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 940));
    await page.waitForFunction(() => innerWidth >= 1350);
    await page.getByRole('link', { name: 'Sessions', exact: true }).click();
    await expect(page.locator('.session-row')).toHaveCount(1);
    await page.screenshot({ path: 'test-results/ux-sessions.png', fullPage: true });
    await page.getByRole('link', { name: 'Open session with Milo', exact: true }).click();
    await expect(page.locator('.conversation-identity .mascot')).toHaveAttribute('data-mascot', chosenLook);
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.getByLabel('Bot options', { exact: true }).click();
    await page.getByRole('button', { name: 'About this bot', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Advanced', exact: true }).click();
    await expect(page.getByRole('link', { name: /Learning & evaluations/ })).toBeVisible();
    await page.screenshot({ path: 'test-results/ux-advanced.png', fullPage: true });
    await page.getByRole('link', { name: /Learning & evaluations/ }).click();
    await expect(page.getByRole('heading', { name: 'Learning & evaluations', exact: true })).toBeVisible();
    await page.locator('main a[href="#/lab/Milo"]').click();
    await expect(page.locator('.stats-strip')).toBeVisible();

    await page.evaluate(() => { location.hash = '#/bot/Milo'; });
    await expect(page.locator('.conversation-header h1')).toHaveText('Milo');
    expect(await page.locator('input[name=remember]').isChecked()).toBe(false);
    await page.locator('textarea[name=message]').fill('I prefer short paragraphs.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message-body').last()).toHaveText("I'll keep replies in short paragraphs.");
    await page.evaluate(() => { location.hash = '#/memory/user'; });
    await expect(page.getByRole('heading', { name: 'What your bots remember', exact: true })).toBeVisible();
    await expect(page.locator('.memory-entry-copy p')).toHaveText('Prefers short paragraphs.');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('textbox', { name: 'Detail', exact: true }).fill('Prefers two short paragraphs.');
    await page.getByRole('button', { name: 'Save detail', exact: true }).click();
    await expect(page.locator('.memory-entry-copy p')).toHaveText('Prefers two short paragraphs.');
    await page.screenshot({ path: 'test-results/bot-memory-settings.png', fullPage: true });
    await page.getByRole('checkbox', { name: 'Let bots update memory', exact: true }).uncheck();
    await expect.poll(() => page.evaluate(() => fetch('/api/memory/settings').then((r) => r.json()).then((s) => s.enabled))).toBe(false);
    await page.getByRole('button', { name: 'Forget', exact: true }).click();
    await expect(page.locator('.memory-entry')).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Let bots update memory', exact: true }).check();
    await expect.poll(() => page.evaluate(() => fetch('/api/memory/settings').then((r) => r.json()).then((s) => s.enabled))).toBe(true);
    const overview = await page.evaluate(() => fetch('/api/overview').then((response) => response.json()));
    expect(overview.summary.useful).toBe(1); expect(overview.capabilities.desktop).toBe(true);
    expect(calls.some((request) => request.messages.some((message) => message.role === 'tool'))).toBe(true);
    expect(errors).toEqual([]);
    await app.close(); app = undefined;
    app = await electron.launch(options);
    const reopened = await app.firstWindow();
    await expect(reopened.getByRole('link', { name: 'Chat with Milo', exact: true })).toBeVisible();
    await reopened.getByRole('link', { name: 'Chat with Milo', exact: true }).click();
    await expect(reopened.locator('.conversation-identity .mascot')).toHaveAttribute('data-mascot', chosenLook);
    const restored = await reopened.evaluate(() => fetch('/api/overview').then((response) => response.json()));
    expect(restored.summary.useful).toBe(1);
    expect((await reopened.evaluate(() => fetch('/api/memory').then((response) => response.json()))).user).toEqual([]);
    const stopped = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => { const main = BrowserWindow.getAllWindows()[0]; new BrowserWindow({ show: false }); main.close(); });
    await stopped; app = undefined;
  } catch (error) {
    if (page && !page.isClosed()) { console.log('UI failure view:', page.url(), (await page.locator('main').innerText()).slice(0, 2500)); await page.screenshot({ path: 'test-results/ux-error.png', fullPage: true }).catch(() => {}); }
    throw error;
  } finally {
    if (app) await app.close();
    provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve));
    rmSync(data, { recursive: true, force: true });
  }
});
