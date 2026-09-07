import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('connection catalogs, per-bot choices, and browser sign-in work in the desktop', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linubot-tiyuvta-provider-ui-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') {
      const prefix = req.url.startsWith('/responses/') ? 'response' : 'fixture';
      res.end(JSON.stringify({ data: [{ id: `${prefix}-a`, name: `${prefix} A` }, { id: `${prefix}-b`, name: `${prefix} B` }] })); return;
    }
    const parts = []; for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString()); requests.push({ url: req.url, model: body.model });
    const system = body.instructions || body.messages?.[0]?.content || '';
    const text = system.startsWith('Review a linubot') ? JSON.stringify({ summary: 'Checked.', checks: [], limitations: [], lesson: null }) : 'Connected.';
    res.end(JSON.stringify(req.url.endsWith('/responses') ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } : { choices: [{ message: { role: 'assistant', content: text } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, WAYLAND_DISPLAY: '', XDG_SESSION_TYPE: 'x11', LINUBOT_UPDATE_CHECK: '0', XDG_CONFIG_HOME: join(directory, 'config'), LINUBOT_DATA: join(directory, 'store'), LINUBOT_DESKTOP_PROFILE: join(directory, 'desktop'), LINUBOT_BASE_URL: `${base}/v1`, LINUBOT_API_KEY: 'fixture-key', LINUBOT_MODEL: 'fixture-a', LINUBOT_PROVIDER: 'openai-compat' };
  mkdirSync(join(directory, 'config/muse'), { recursive: true });
  writeFileSync(join(directory, 'config/muse/auth.json'), JSON.stringify({ providers: { meta: { api_base_url: 'https://api.meta.ai/v1', api_key: 'LLM|fixture|fake-muse-key', access_token: 'never-import-this-account-token' } } }));
  writeFileSync(join(directory, 'config/muse/settings.json'), JSON.stringify({ model: 'muse-spark-1.3-contributor' }));
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ args: [resolve('desktop/main.cjs')], env, ...(process.env.LINUBOT_TEST_EXECUTABLE ? { executablePath: process.env.LINUBOT_TEST_EXECUTABLE, args: [] } : {}) });
    const page = await app.firstWindow(); const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    const catalogRequests = [];
    const nonPublicPresets = [['openai', 'https://api.openai.com/v1'], ['anthropic', 'https://api.anthropic.com/v1']];
    let failTiyuvtaCatalog = false;
    await page.route('**/api/provider/models', async (route) => {
      const draft = route.request().postDataJSON(); catalogRequests.push(draft);
      if (draft?.baseUrl === 'https://api.tiyuvta.ai/v1') {
        if (failTiyuvtaCatalog) await route.fulfill({ status: 502, json: { error: 'Fixture catalog unavailable.' } });
        else await route.fulfill({ json: { models: [{ id: 'tiyuvta-fixture-a', name: 'Tiyuvta fixture A' }, { id: 'tiyuvta-fixture-b', name: 'Tiyuvta fixture B' }], supported: true, truncated: false } });
      } else if (nonPublicPresets.some(([, baseUrl]) => baseUrl === draft?.baseUrl)) await route.fulfill({ status: 502, json: { error: 'Unexpected non-public catalog request.' } });
      else await route.continue();
    });
    // Browser sign-in is observed without opening the user's browser during QA.
    await app.evaluate(({ shell }) => { shell.openExternal = async (url) => { globalThis.providerSignInUrl = url; }; });
    await page.evaluate(() => { location.hash = '#/settings/provider'; });
    await expect(page.getByRole('heading', { name: 'Connection settings', exact: true })).toBeVisible();
    const featured = page.locator('.provider-featured');
    await expect(featured).toBeVisible();
    await expect(featured.getByRole('heading', { name: 'Tiyuvta', exact: true })).toBeVisible();
    await expect(page.locator('select[name=preset] option').nth(0)).toHaveText('Tiyuvta');
    await expect(page.locator('select[name=preset] option').nth(1)).toHaveText('Custom endpoint');
    const picker = page.locator('[data-provider-model] select');
    await expect(picker.locator('option[value="fixture-b"]')).toHaveCount(1);
    await picker.selectOption('fixture-b');
    await page.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect(page.locator('[data-default-model]')).toHaveText('fixture-b');
    await page.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(page.locator('[data-test-output]')).toContainText('fixture-b: Connected.');

    await featured.getByRole('button', { name: 'Connect Tiyuvta', exact: true }).click();
    await expect(page.locator('input[name=baseUrl]')).toHaveValue('https://api.tiyuvta.ai/v1');
    await expect(page.locator('input[name=name]')).toHaveValue('Tiyuvta');
    await expect(page.locator('select[name=kind]')).toHaveValue('openai-compat');
    await expect(page.locator('select[name=auth]')).toHaveValue('bearer');
    await expect(picker.locator('option[value="tiyuvta-fixture-a"]')).toHaveText('Tiyuvta fixture A · tiyuvta-fixture-a');
    await expect(picker.locator('option[value="tiyuvta-fixture-b"]')).toHaveText('Tiyuvta fixture B · tiyuvta-fixture-b');
    await expect(page.locator('input[name=apiKey]')).toHaveValue('');
    const tiyuvtaRequests = catalogRequests.filter((draft) => draft?.baseUrl === 'https://api.tiyuvta.ai/v1');
    expect(tiyuvtaRequests).toHaveLength(1);
    expect(tiyuvtaRequests[0].apiKey).toBeUndefined();
    failTiyuvtaCatalog = true;
    await page.getByRole('button', { name: 'Add connection', exact: true }).click();
    await expect(page.locator('select[name=preset]')).toHaveValue('tiyuvta');
    await expect(page.locator('input[name=baseUrl]')).toHaveValue('https://api.tiyuvta.ai/v1');
    await expect(page.locator('input[name=name]')).toHaveValue('Tiyuvta');
    await expect(page.locator('[data-model-status]')).toContainText('Fixture catalog unavailable. Custom model IDs are available.');
    for (const [preset, baseUrl] of nonPublicPresets) {
      await page.locator('select[name=preset]').selectOption(preset);
      await expect(page.locator('input[name=baseUrl]')).toHaveValue(baseUrl);
      await expect(page.locator('input[name=apiKey]')).toHaveValue('');
      expect(catalogRequests.filter((draft) => draft?.baseUrl === baseUrl)).toHaveLength(0);
    }
    await page.getByRole('textbox', { name: 'Connection name', exact: true }).fill('Responses lab');
    await page.locator('select[name=kind]').selectOption('responses');
    await page.getByRole('textbox', { name: 'Endpoint base URL', exact: true }).fill(`${base}/responses/v1`);
    await page.locator('select[name=auth]').selectOption('none');
    await page.getByRole('button', { name: 'Refresh models', exact: true }).click();
    await expect(picker.locator('option[value="response-a"]')).toHaveCount(1);
    await picker.selectOption('response-a');
    await page.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect(page.locator('[data-connection] option')).toHaveCount(2);
    await expect(page.locator('[data-connection] option').filter({ hasText: 'Responses lab' })).toHaveCount(1);
    await expect(page.locator('[data-default-model]')).toHaveText('fixture-b');
    const secondId = await page.locator('[data-connection]').inputValue();
    await expect(page.locator('[data-edit-provider]')).toHaveCount(2);
    await page.locator('.provider-roster').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(directory, 'provider-roster.png'), fullPage: true });
    await page.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(page.locator('[data-test-output]')).toContainText('response-a: Connected.');
    await page.screenshot({ path: join(directory, 'provider-connections.png'), fullPage: true });

    await page.evaluate(async (id) => {
      const response = await fetch('/api/bots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Dual', providerId: id, model: 'response-b' }) });
      if (!response.ok) throw new Error('Could not create test bot');
      location.hash = '#/bot/Dual';
    }, secondId);
    await expect(page.locator('.conversation-header h1')).toHaveText('Dual');
    await page.locator('textarea[name=message]').fill('Hello');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message-body').last()).toHaveText('Connected.');
    expect(requests.some((r) => r.url === '/responses/v1/responses' && r.model === 'response-b')).toBe(true);
    await page.getByLabel('Bot options', { exact: true }).click();
    await page.getByRole('button', { name: 'About this bot', exact: true }).click();
    await page.getByText('Model, skills & preferences', { exact: true }).click();
    await expect(page.locator('select[name=providerId]')).toHaveValue(secondId);
    await expect(page.locator('[data-bot-model-picker] select')).toHaveValue('response-b');
    await page.screenshot({ path: join(directory, 'bot-provider-picker.png'), fullPage: true });
    await page.keyboard.press('Escape');

    await page.evaluate(() => { location.hash = '#/settings/provider'; });
    await page.locator('select[name=preset]').selectOption('openrouter');
    await page.getByRole('button', { name: 'Connect in browser', exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.providerSignInUrl || '')).toContain('https://openrouter.ai/auth?');
    const authUrl = new URL(await app.evaluate(() => globalThis.providerSignInUrl));
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const callback = new URL(authUrl.searchParams.get('callback_url')); callback.searchParams.set('state', 'invalid'); callback.searchParams.set('code', 'unapproved');
    expect((await fetch(callback)).status).toBe(400);
    await page.screenshot({ path: join(directory, 'provider-browser-sign-in.png'), fullPage: true });
    await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
    await expect(page.locator('.browser-connect:visible [data-feedback]')).toHaveText('Sign-in cancelled.');
    await page.route('**/api/provider/models', async (route) => {
      if (route.request().postDataJSON()?.baseUrl === 'https://api.meta.ai/v1') {
        await route.fulfill({ json: { models: [{ id: 'muse-spark-1.3-contributor', name: 'Muse Spark 1.3 Contributor' }, { id: 'muse-spark-1.3', name: 'Muse Spark 1.3' }], supported: true, truncated: false } });
      } else await route.fallback();
    });
    await page.getByRole('button', { name: 'Add connection', exact: true }).click();
    await page.locator('select[name=preset]').selectOption('muse');
    await expect(page.getByRole('textbox', { name: 'Endpoint base URL', exact: true })).toHaveValue('https://api.meta.ai/v1');
    await page.getByRole('button', { name: 'Use Muse Code sign-in', exact: true }).click();
    await expect(page.locator('.browser-connect:visible [data-feedback]')).toContainText('Connected through Muse Code');
    await expect(picker).toHaveValue('muse-spark-1.3-contributor');
    await expect(picker.locator('option[value="muse-spark-1.3"]')).toHaveCount(1);
    await expect(page.locator('[data-default-model]')).toHaveText('fixture-b');
    await expect(page.locator('[data-connection] option')).toHaveCount(3);
    await expect(page.locator('input[name=apiKey]')).toHaveValue('');
    await page.screenshot({ path: join(directory, 'muse-connection.png'), fullPage: true });
    await page.evaluate(() => { location.hash = '#/settings/context'; });
    await expect(page.getByRole('heading', { name: 'Long conversations', exact: true })).toBeVisible();
    await page.locator('input[name=inputBudget]').fill('14000');
    await page.locator('input[name=targetTokens]').fill('3000');
    await page.getByRole('button', { name: 'Save context settings', exact: true }).click();
    await expect(page.locator('[data-context-settings] [data-feedback]')).toHaveText('Context settings saved for new tasks.');
    await page.screenshot({ path: join(directory, 'context-controls.png'), fullPage: true });
    await page.evaluate(() => { location.hash = '#/settings/provider'; });
    await page.locator('select[name=preset]').selectOption('openai-codex');
    await expect(page.getByRole('button', { name: 'Sign in with ChatGPT', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use existing Codex sign-in', exact: true })).toBeVisible();
    await expect(page.locator('input[name=apiKey]')).toBeHidden();
    await expect(page.locator('input[name=baseUrl]')).toHaveAttribute('readonly', '');
    await page.screenshot({ path: join(directory, 'chatgpt-setup.png'), fullPage: true });
    await page.locator('select[name=preset]').selectOption('google-oauth');
    await expect(page.getByRole('button', { name: 'Sign in with Google', exact: true })).toBeVisible();
    await page.locator('[data-google-client]').setInputFiles({ name: 'desktop-client.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ installed: { client_id: 'fixture.apps.googleusercontent.com', client_secret: 'fixture-client-secret', project_id: 'fixture-project' } })) });
    await expect(page.locator('[data-google-project]')).toHaveValue('fixture-project');
    await page.route('**/api/oauth/google/start', (route) => route.fulfill({ json: { id: 'fixture-google-login', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture' } }));
    await page.route('**/api/oauth/google/status*', (route) => route.fulfill({ json: { state: 'waiting' } }));
    await page.route('**/api/oauth/google/cancel', (route) => route.fulfill({ json: { cancelled: true } }));
    await page.getByRole('button', { name: 'Sign in with Google', exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.providerSignInUrl || '')).toContain('https://accounts.google.com/');
    await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
    await expect(page.locator('.browser-connect:visible [data-feedback]')).toHaveText('Sign-in cancelled.');
    for (const preset of ['anthropic', 'gemini', 'qwen-token', 'qwen-coding', 'zai-coding']) {
      await page.locator('select[name=preset]').selectOption(preset);
      await expect(page.locator('input[name=apiKey]')).toBeVisible();
      if (preset.startsWith('qwen')) await expect(page.getByRole('button', { name: 'Use Qwen Code key', exact: true })).toBeVisible();
    }
    await page.screenshot({ path: join(directory, 'coding-plan-setup.png'), fullPage: true });
    const overview = await page.evaluate(async () => {
      const response = await fetch('/api/overview');
      if (!response.ok) throw new Error('Could not read test overview');
      return response.json();
    });
    await page.route('**/api/overview', (route) => route.fulfill({ json: { ...overview, provider: { ...overview.provider, ready: false } } }));
    await page.evaluate(() => { location.hash = '#/home'; });
    await page.reload();
    await expect(page.locator('.connect-line')).toContainText('Connect a model to start chatting.');
    await expect(page.locator('#provider-status')).toHaveText('Connect a model');
    await expect(page.locator('#provider-status')).toHaveAttribute('title', 'Open provider settings');
    await expect(page.locator('#provider-status')).toHaveAttribute('href', '#/settings/provider?preset=tiyuvta');
    await page.getByRole('link', { name: 'Connect Tiyuvta', exact: true }).click();
    await expect(page.locator('select[name=preset]')).toHaveValue('tiyuvta');
    await expect(page.locator('input[name=baseUrl]')).toHaveValue('https://api.tiyuvta.ai/v1');
    await expect(page.locator('input[name=name]')).toHaveValue('Tiyuvta');
    await page.evaluate(() => { location.hash = '#/home'; });
    await page.getByRole('link', { name: 'Other providers', exact: true }).click();
    await expect(page.locator('[data-connection]')).not.toHaveValue('');
    await page.route('**/api/updates', (route) => route.fulfill({ json: { currentVersion: '2.6.0', latest: { version: '2.7.0', url: 'https://github.com/agent-sh/linubot/releases/tag/v2.7.0' }, canInstall: false } }));
    await page.reload();
    await expect(page.getByRole('button', { name: 'Upgrade to 2.7.0', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Upgrade to 2.7.0', exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.providerSignInUrl || '')).toContain('/linubot/releases/tag/v2.7.0');
    await page.screenshot({ path: join(directory, 'update-available.png'), fullPage: true });
    expect(catalogRequests.filter((draft) => nonPublicPresets.some(([, baseUrl]) => baseUrl === draft?.baseUrl))).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    if (app) await app.close();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
