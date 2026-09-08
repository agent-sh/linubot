import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('phone settings show disabled state, reject invalid own origins and disable access', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linubot-phone-settings-ui-'));
  const env = { ...process.env, WAYLAND_DISPLAY: '', XDG_SESSION_TYPE: 'x11', LINUBOT_UPDATE_CHECK: '0', XDG_CONFIG_HOME: join(directory, 'config'), LINUBOT_DATA: join(directory, 'store'), LINUBOT_DESKTOP_PROFILE: join(directory, 'profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ args: [resolve('desktop/main.cjs')], env, ...(process.env.LINUBOT_TEST_EXECUTABLE ? { executablePath: process.env.LINUBOT_TEST_EXECUTABLE, args: [] } : {}) });
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Your bots', exact: true })).toBeVisible();
    let enabled = false, origin = '', disabled = 0;
    const status = () => ({ enabled, listening: enabled, origin, port: 45873, devices: [] });
    await page.route('**/api/phone', route => route.fulfill({ json: status() }));
    await page.route('**/api/phone/enable', route => {
      const input = route.request().postDataJSON();
      // Invalid custom origins reach the real validator, before listener/network setup.
      if (input.origin !== 'https://private.example') return route.continue();
      enabled = true; origin = input.origin; return route.fulfill({ json: status() });
    });
    await page.route('**/api/phone/disable', route => { disabled++; enabled = false; origin = ''; return route.fulfill({ json: status() }); });
    await page.evaluate(() => { location.hash = '#/settings/phone'; });
    await expect(page.getByRole('button', { name: 'Enable phone access', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pair a phone', exact: true })).toHaveCount(0);
    await expect(page.getByText('No phones paired yet.', { exact: true })).toBeVisible();
    await page.getByText('Use your own HTTPS proxy', { exact: true }).click();
    for (const value of ['http://private.example', 'https://private.example/path']) {
      await page.getByLabel('HTTPS computer address', { exact: true }).fill(value);
      const response = page.waitForResponse(response => response.url().endsWith('/api/phone/enable'));
      await page.getByRole('button', { name: 'Use this address', exact: true }).click();
      expect((await response).status()).toBe(400);
      await expect(page.locator('[data-settings-pane] [data-feedback]')).toContainText('Use an HTTPS address without a path or credentials');
      await expect(page.getByRole('button', { name: 'Pair a phone', exact: true })).toHaveCount(0);
    }
    await page.getByLabel('HTTPS computer address', { exact: true }).fill('https://private.example');
    await page.getByRole('button', { name: 'Use this address', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pair a phone', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'https://private.example', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Disable phone access', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(disabled).toBe(0);
    await page.getByRole('button', { name: 'Disable phone access', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Disable', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Enable phone access', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pair a phone', exact: true })).toHaveCount(0);
    expect(disabled).toBe(1);
  } finally {
    try { await app?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
