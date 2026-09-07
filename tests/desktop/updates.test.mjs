import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('Settings can discover an update immediately and foreground refresh updates the sidebar', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linubot-update-ui-'));
  const env = { ...process.env, WAYLAND_DISPLAY: '', XDG_SESSION_TYPE: 'x11', LINUBOT_UPDATE_CHECK: '0', LINUBOT_DATA: join(directory, 'store'), LINUBOT_DESKTOP_PROFILE: join(directory, 'profile') }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('desktop/main.cjs')], env, ...(process.env.LINUBOT_TEST_EXECUTABLE ? { executablePath: process.env.LINUBOT_TEST_EXECUTABLE, args: [] } : {}) });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { name: "Your bots", exact: true })).toBeVisible();
    let available, cached, forced = 0;
    const status = () => ({ enabled: true, currentVersion: '2.7.0', latest: cached ? { version: cached, url: `https://github.com/agent-sh/linubot/releases/tag/v${cached}` } : undefined, checkedAt: Date.now(), canInstall: false });
    await page.route('**/api/updates', (route) => route.fulfill({ json: status() }));
    await page.route('**/api/updates/check', (route) => { forced++; cached = available; return route.fulfill({ json: status() }); });
    await page.evaluate(() => { const original = Date.now; Date.now = () => original() + 61000; window.dispatchEvent(new Event("focus")); });
    await page.evaluate(() => { location.hash = '#/settings/provider'; });
    await expect(page.locator('[data-app-updates]')).toContainText('Linubot 2.7.0');
    await expect(page.locator('[data-upgrade]')).toBeHidden();
    available = '2.8.0';
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await expect(page.locator('[data-upgrade]')).toHaveText('Upgrade to 2.8.0');
    await expect(page.locator('[data-update-status]')).toContainText('Last checked');
    await page.evaluate(() => { const original = Date.now; Date.now = () => original() + 61000; });
    const before = forced; available = '2.9.0';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => forced).toBeGreaterThan(before);
    await expect(page.locator('[data-upgrade]')).toHaveText('Upgrade to 2.9.0');
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
