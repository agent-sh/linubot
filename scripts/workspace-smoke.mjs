import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'linubot-workspace-smoke-'));
process.env.LINUBOT_DATA = dir;
const { createComputer } = await import('../dist/computer/workspace.js');
const computer = createComputer();
const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Workspace input test</title><textarea autofocus style="position:fixed;inset:0;width:100%;height:100%;font-size:24px" oninput="document.title=this.value"></textarea>'); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let id;
try {
  ({ id } = await computer.start({ acknowledge: true, purpose: 'Verify literal keyboard input and navigation through the real Linubot CLI adapter' }));
  const browser = JSON.parse(await computer.openBrowser(id));
  const pid = browser.app_pid ?? browser.apps?.[0]?.pid;
  assert.ok(Number.isInteger(pid), 'Browser startup must identify its process');
  const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  assert.ok(!args.includes('--no-sandbox'), 'Chromium sandbox must stay enabled');
  await computer.browserNavigate(url, id);
  // Click the visible input in this controlled fixture; a fresh browser keeps focus in its address bar.
  await computer.click(300, 350, id);
  await computer.type('--id this-is-literal-text', id);
  let snapshot = JSON.parse(await computer.browserSnapshot(id));
  for (let attempt = 0; attempt < 20 && !JSON.stringify(snapshot).includes('--id this-is-literal-text'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    snapshot = JSON.parse(await computer.browserSnapshot(id));
  }
  assert.match(JSON.stringify(snapshot), /--id this-is-literal-text/);
  await computer.key('ctrl+l', id);
  await computer.type(`${url}/keyboard-navigation`, id);
  await computer.key('Return', id);
  for (let attempt = 0; attempt < 20; attempt++) {
    snapshot = JSON.parse(await computer.browserSnapshot(id));
    if (JSON.stringify(snapshot).includes('/keyboard-navigation')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(JSON.stringify(snapshot), /keyboard-navigation/);
  await computer.screenshot(join(dir, 'verified.png'), id);
  assert.ok(readFileSync(join(dir, 'verified.png')).length > 100);
  console.log(JSON.stringify({ ok: true, workspace: id, literalInput: true, keyboardNavigation: true, screenshot: true }));
} catch (error) {
  mkdirSync('test-results', { recursive: true });
  if (id) await computer.screenshot(resolve('test-results/workspace-smoke-error.png'), id).catch(() => {});
  throw error;
} finally {
  if (id) { await computer.stop(id); await computer.cleanup(id); }
  assert.deepEqual(JSON.parse(await computer.list()).workspaces, []);
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
