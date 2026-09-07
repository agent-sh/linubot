import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

test('continues a historical 30-step failure from the conversation without replacing a draft', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linubot-continue-ui-')), data = join(directory, 'store');
  const requests = [];
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET') { response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return; }
    let body = ''; for await (const chunk of request) body += chunk; requests.push(JSON.parse(body));
    response.end(JSON.stringify({ choices: [{ message: { content: 'RESEARCH_CONTINUED_OK' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, WAYLAND_DISPLAY: '', XDG_SESSION_TYPE: 'x11', LINUBOT_UPDATE_CHECK: '0', LINUBOT_DATA: data, LINUBOT_DESKTOP_PROFILE: join(directory, 'desktop'), LINUBOT_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, LINUBOT_API_KEY: 'fixture-key', LINUBOT_MODEL: 'fixture-model', LINUBOT_PROVIDER: 'openai-compat' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('desktop/main.cjs')], env, ...(process.env.LINUBOT_TEST_EXECUTABLE ? { executablePath: process.env.LINUBOT_TEST_EXECUTABLE, args: [] } : {}) });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async () => { const r = await fetch('/api/bots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Research' }) }); if (!r.ok) throw Error('Fixture failed'); });
    const id = randomUUID(); mkdirSync(join(data, 'runs'), { recursive: true });
    writeFileSync(join(data, 'runs', `${id}.json`), JSON.stringify({ id, scope: 'bot:Research', bot: 'Research', prompt: 'Browse and learn the fixture project thoroughly', criteria: [], source: 'chat', status: 'failed', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), toolCalls: 30, error: 'Task reached the 30-step budget without delivering a final answer' }));
    await page.evaluate(() => { location.hash = '#/bot/Research'; });
    await page.locator('textarea[name=message]').fill('Keep this separate draft');
    await page.getByRole('button', { name: 'Continue task', exact: true }).click();
    await expect(page.locator('.message-body').last()).toHaveText('RESEARCH_CONTINUED_OK');
    await expect(page.locator('textarea[name=message]')).toHaveValue('Keep this separate draft');
    const runs = await page.evaluate(() => fetch('/api/runs?scope=bot%3AResearch').then(r => r.json()));
    expect(runs.filter(run => run.resumedFrom === id)).toHaveLength(1);
    expect(requests.some(request => request.messages.some(message => message.content.includes('Browse and learn the fixture project thoroughly')))).toBe(true);
    await expect(page.getByRole('button', { name: 'Continue task', exact: true })).toBeHidden();
  } finally { await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); }
});
