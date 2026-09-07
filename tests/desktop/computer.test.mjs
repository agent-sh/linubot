import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('embedded computer supports takeover, fresh input, closing, and direct bot deletion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linubot-panel-test-'));
  const env = { ...process.env, WAYLAND_DISPLAY: '', XDG_SESSION_TYPE: 'x11', LINUBOT_UPDATE_CHECK: '0', LINUBOT_DATA: join(directory, 'store'), LINUBOT_DESKTOP_PROFILE: join(directory, 'profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('desktop/main.cjs')], env, ...(process.env.LINUBOT_TEST_EXECUTABLE ? { executablePath: process.env.LINUBOT_TEST_EXECUTABLE, args: [] } : {}) });
  const id = 'linubot-11111111-1111-4111-8111-111111111111';
  let manual = false, generation = 0, token = '', frames = true, transfer = false;
  const inputs = [];
  try {
    const page = await app.firstWindow();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.evaluate(async () => {
      const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      for (const name of ['Disposable', 'Keeper']) { const result = await post('/api/bots', { name }); if (!result.ok) throw Error('Bot fixture failed'); }
      const group = await post('/api/groups', { id: 'fixture-team', members: ['Disposable', 'Keeper'] }); if (!group.ok) throw Error('Group fixture failed');
    });
    await page.route('**/api/computer/views*', (route) => route.fulfill({ json: { workspaces: [{ id, purpose: 'Fixture sign-in', state: 'running', scope: 'bot:Disposable', manual, requested: manual ? undefined : 'Please sign in' }] } }));
    await page.route('**/api/computer/frame*', (route) => frames ? route.fulfill({ contentType: 'image/png', body: readFileSync('desktop/icon.png') }) : route.fulfill({ status: 503, json: { error: 'Frame temporarily unavailable' } }));
    await page.route('**/api/computer/control', async (route) => {
      const body = route.request().postDataJSON();
      expect(body.id).toBe(id);
      if (body.action === 'take') { manual = true; token = `fixture-${++generation}`; await route.fulfill({ json: { token } }); }
      else if (transfer || body.token !== token) { transfer = false; await route.fulfill({ status: 409, json: { error: 'This control session is no longer active' } }); }
      else { manual = false; await route.fulfill({ json: { released: true } }); }
    });
    await page.route('**/api/computer/input', async (route) => { inputs.push(route.request().postDataJSON()); await route.fulfill({ json: { accepted: true } }); });
    await page.evaluate(() => { location.hash = '#/bot/Disposable'; });
    const toggle = page.getByRole('button', { name: 'Computer', exact: true });
    await expect(toggle).toBeVisible();
    await toggle.click();
    const panel = page.getByRole('complementary', { name: 'Bot computer', exact: true });
    const screen = panel.locator('[data-screen]');
    await expect(panel).toBeVisible(); await expect(screen).toBeVisible();
    expect(inputs).toHaveLength(0);
    await panel.getByRole('button', { name: 'Take control', exact: true }).click();
    await expect(screen).toHaveClass(/controlling/);
    await screen.click();
    await screen.press('Control+a'); await screen.press('k');
    await expect.poll(() => inputs.filter((value) => value.action === 'type').length).toBe(1);
    expect(inputs.find((value) => value.action === 'key')?.keys).toBe('ctrl+a');
    await app.evaluate(({ clipboard }) => clipboard.writeText('fixture-native-paste'));
    await screen.press('Control+v');
    await expect.poll(() => inputs.some((value) => value.text === 'fixture-native-paste')).toBe(true);
    expect(inputs.every((value) => value.id === id && value.token === token)).toBe(true);
    await panel.getByRole('button', { name: 'Paste text', exact: true }).click();
    await page.getByRole('textbox', { name: 'Text', exact: true }).fill('fixture-private-login');
    await page.getByRole('button', { name: 'Paste into computer', exact: true }).click();
    await expect.poll(() => inputs.some((value) => value.text === 'fixture-private-login')).toBe(true);
    expect(await page.locator('.feed-inner').innerText()).not.toContain('fixture-private-login');
    await panel.getByRole('button', { name: 'Open sign-in browser', exact: true }).click();
    await page.getByLabel('Website URL', { exact: true }).fill('https://example.com/login');
    await page.getByRole('button', { name: 'Open website', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect.poll(() => inputs.some(value => value.action === 'sign-in-browser' && value.url === 'https://example.com/login')).toBe(true);
    await panel.getByRole('button', { name: 'Expand', exact: true }).click();
    await expect(panel).toHaveClass(/wide/);
    await panel.getByRole('button', { name: 'Shrink', exact: true }).click();
    frames = false;
    await expect(screen).not.toHaveClass(/controlling/, { timeout: 6000 });
    const before = inputs.length;
    await screen.dispatchEvent('keydown', { key: 's', bubbles: true });
    expect(inputs).toHaveLength(before);
    frames = true; await expect(screen).toHaveClass(/controlling/, { timeout: 6000 });
    transfer = true;
    await panel.getByRole('button', { name: 'Return to bot', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Take control', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Take control', exact: true }).click();
    await expect(screen).toHaveClass(/controlling/);
    mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/embedded-computer.png', fullPage: true });
    await panel.getByRole('button', { name: 'Close computer', exact: true }).click();
    await expect(panel).toBeHidden(); expect(manual).toBe(true);
    await toggle.click();
    await expect(screen).toHaveClass(/controlling/);
    await panel.getByRole('button', { name: 'Return to bot', exact: true }).click();
    await expect.poll(() => manual).toBe(false);
    await panel.getByRole('button', { name: 'Close computer', exact: true }).click();
    await expect(panel).toBeHidden();
    await page.getByLabel('Bot options', { exact: true }).click();
    await page.locator('.conversation-menu').getByRole('button', { name: 'Delete bot', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('1 group');
    await page.getByRole('dialog').getByRole('button', { name: 'Delete bot', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your bots', exact: true })).toBeVisible();
    const result = await page.evaluate(async () => ({ bots: await fetch('/api/bots').then((r) => r.json()), groups: await fetch('/api/groups').then((r) => r.json()) }));
    expect(result.bots.map((bot) => bot.name)).toEqual(['Keeper']);
    expect(result.groups[0].members).toEqual(['Keeper']);
    expect(errors).toEqual([]);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
