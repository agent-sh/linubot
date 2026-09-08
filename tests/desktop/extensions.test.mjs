import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';

test('Connected tools displays connection failures and removes a custom server', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linubot-extensions-ui-'));
  const env = { ...process.env, WAYLAND_DISPLAY: '', XDG_SESSION_TYPE: 'x11', LINUBOT_UPDATE_CHECK: '0', XDG_CONFIG_HOME: join(directory, 'config'), LINUBOT_DATA: join(directory, 'store'), LINUBOT_DESKTOP_PROFILE: join(directory, 'profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${reservation.address().port}/mcp`;
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    app = await electron.launch({ args: [resolve('desktop/main.cjs')], env, ...(process.env.LINUBOT_TEST_EXECUTABLE ? { executablePath: process.env.LINUBOT_TEST_EXECUTABLE, args: [] } : {}) });
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Your bots', exact: true })).toBeVisible();
    await page.evaluate(() => { location.hash = '#/advanced'; });
    await expect(page.getByRole('heading', { name: 'Disk usage', exact: true })).toBeVisible();
    await expect(page.locator('[data-sizes] dt')).toHaveCount(5);
    await page.getByLabel('Screenshot retention (days)', { exact: true }).fill('7');
    await page.getByRole('button', { name: 'Save retention settings', exact: true }).click();
    await expect(page.locator('[data-retention-settings]')).toContainText('Retention settings saved.');
    await page.reload();
    await expect(page.getByLabel('Screenshot retention (days)', { exact: true })).toHaveValue('7');
    await page.getByRole('button', { name: 'Free space now', exact: true }).click();
    await expect(page.locator('[data-retention-run]')).toContainText('Freed 0.00 MiB from 0 files.');
    await page.evaluate(() => { location.hash = '#/settings/mcp'; });
    await expect(page.getByRole('heading', { name: 'Connected tools', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add custom server', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Name', { exact: true }).fill('unreachable-test');
    await modal.getByLabel('Endpoint', { exact: true }).fill(endpoint);
    await modal.getByRole('button', { name: 'Add server', exact: true }).click();
    const row = page.locator('[data-server]').filter({ has: page.getByRole('heading', { name: 'unreachable-test', exact: true }) });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Connect', exact: true }).click();
    await modal.getByRole('button', { name: 'Connect and inspect tools', exact: true }).click();
    await expect(modal.locator('[data-feedback]')).toBeVisible();
    await expect(modal.locator('[data-feedback]')).toContainText(/fetch failed|connect|port/i);
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(row.locator('.form-feedback.error')).toBeVisible();
    await expect(row.locator('.form-feedback.error')).not.toHaveText('');
    await row.getByRole('button', { name: 'Remove', exact: true }).click();
    await modal.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(row).toHaveCount(0);
    expect(await page.evaluate(() => fetch('/api/mcp').then(response => response.json()).then(value => value.servers['unreachable-test']))).toBeUndefined();
  } finally {
    try { await app?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
