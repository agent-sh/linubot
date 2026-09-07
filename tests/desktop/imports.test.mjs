import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const write = (path, value) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, value); };
function encoded(value) { let bits = 0, buffer = 0, output = ''; for (const byte of Buffer.from(value)) { buffer = (buffer << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; output += 'abcdefghijklmnopqrstuvwxyz234567'[(buffer >> bits) & 31]; } } if (bits) output += 'abcdefghijklmnopqrstuvwxyz234567'[(buffer << (5 - bits)) & 31]; return output; }

test('imports Hermes context and a Grok group into working Linubot conversations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linubot-import-ui-')), hermes = join(directory, 'hermes'), grok = join(directory, 'grok');
  write(join(hermes, 'SOUL.md'), 'You are a friendly research helper.');
  write(join(hermes, 'config.yaml'), 'model:\n  provider: source\n  default: original-model\n');
  write(join(hermes, 'memories/MEMORY.md'), 'The project codename is DESKTOP_IMPORT_7391.');
  write(join(hermes, 'skills/research/SKILL.md'), '---\nname: research\ndescription: Verify source evidence\n---\nCheck the evidence before answering.');
  const db = new DatabaseSync(join(hermes, 'state.db'));
  db.exec("CREATE TABLE sessions (id TEXT, title TEXT, model TEXT, started_at REAL); CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT, timestamp REAL); INSERT INTO sessions VALUES ('one','Prior conversation','original-model',1000); INSERT INTO messages VALUES (1,'one','user','A prior question',1001),(2,'one','assistant','A prior answer',1002)"); db.close();
  const account = 'sand.client.slice.account.fixture';
  const blob = (key, value, schemaVersion = 1) => write(join(grok, `${encoded(key)}.blob`), JSON.stringify({ schemaVersion, value }));
  blob(`${account}.roster.last-roster`, { rows: [{ id: 'pip', name: 'Pip', description: 'Research' }, { id: 'fern', name: 'Fern', description: 'Writing' }, { id: 'team', name: 'Scout team', isGroup: true, memberIds: ['pip', 'fern'] }] }, 3);
  blob(`${account}.transcript.replicas.team`, { entries: [{ kind: 'message', id: 'one', role: 'user', content: 'An older group question', timestampMs: 1700000000000 }, { kind: 'send-message', id: 'two', message: { type: 'text', content: 'Fern supplied this cached answer.' }, author: { id: 'fern' }, timestampMs: 1700000001000 }] });
  const requests = [];
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET') { response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    const system = body.messages?.[0]?.content || '';
    const content = system.startsWith('Review a linubot') ? JSON.stringify({ summary: 'Reviewed.', checks: [], limitations: [], lesson: null }) : 'IMPORT_BOT_OK';
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, LINUBOT_UPDATE_CHECK: '0', LINUBOT_DATA: join(directory, 'store'), LINUBOT_DESKTOP_PROFILE: join(directory, 'desktop'), LINUBOT_IMPORT_HERMES: hermes, LINUBOT_IMPORT_GROK: grok, LINUBOT_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, LINUBOT_API_KEY: 'fixture-key', LINUBOT_MODEL: 'fixture-model', LINUBOT_PROVIDER: 'openai-compat' }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ args: [resolve('desktop/main.cjs')], env, ...(process.env.LINUBOT_TEST_EXECUTABLE ? { executablePath: process.env.LINUBOT_TEST_EXECUTABLE, args: [] } : {}) });
    const page = await app.firstWindow(), errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('.simple-page-header [data-create-bot]').click();
    await page.getByRole('button', { name: 'Import from Hermes or Grok Bot', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Bring your bots over' })).toBeVisible();
    await expect(page.locator('[name=sourceId]')).toBeEnabled();
    await page.locator('[name=sourceId]').selectOption({ label: 'Hermes' });
    await page.getByRole('textbox', { name: 'Linubot name', exact: true }).fill('ImportedHelper');
    await page.getByRole('button', { name: 'Preview import', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Review the import' })).toBeVisible();
    await page.getByText('Saved context for this bot', { exact: true }).click();
    await expect(page.locator('[data-import-preview]')).toContainText('DESKTOP_IMPORT_7391');
    mkdirSync('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/import-preview.png', fullPage: true });
    await page.getByRole('button', { name: 'Import into Linubot', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your teammates are ready' })).toBeVisible();
    expect(requests).toHaveLength(0);
    await page.getByRole('link', { name: 'Open bot', exact: true }).click();
    await expect(page.locator('.conversation-header h1')).toHaveText('ImportedHelper');
    await page.locator('textarea[name=message]').fill('Say hello using your imported context.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.message-body').last()).toHaveText('IMPORT_BOT_OK');
    expect(requests.some((r) => r.messages?.[0]?.content.includes('DESKTOP_IMPORT_7391'))).toBe(true);
    await page.evaluate(() => { location.hash = '#/imports'; });
    await expect(page.locator('[name=sourceId]')).toBeEnabled();
    await page.locator('[name=sourceId]').selectOption({ label: 'Scout team (group)' });
    await page.getByRole('button', { name: 'Preview import', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Review the import' })).toBeVisible();
    await page.getByRole('button', { name: 'Import into Linubot', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your teammates are ready' })).toBeVisible();
    await page.getByRole('link', { name: 'Open group', exact: true }).click();
    await expect(page.locator('.conversation-header h1')).toHaveText('Scout team');
    await expect(page.locator('.message-body').last()).toHaveText('Fern supplied this cached answer.');
    await page.screenshot({ path: 'test-results/imported-group.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { if (app) await app.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); }
});
