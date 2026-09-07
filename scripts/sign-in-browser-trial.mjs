import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'linubot-signin-trial-'));
process.env.LINUBOT_DATA = relative(process.cwd(), directory);
const { createComputer } = await import('../dist/computer/workspace.js');
const computer = createComputer(), receipts = [];
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = ''; for await (const chunk of request) body += chunk;
    receipts.push(JSON.parse(body)); response.end('ok'); return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(`<!doctype html><title>Linubot sign-in browser fixture</title><h1>Browser fixture</h1><script>
    const returning = document.cookie.includes('fixture=retained'); document.cookie = 'fixture=retained; SameSite=Lax; path=/';
    fetch('/receipt', {method:'POST', body:JSON.stringify({path:location.pathname, webdriver:navigator.webdriver, returning})});
  </script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
async function receipt(path) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = receipts.find(item => item.path === path); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`Browser did not reach ${path}`);
}
let id;
try {
  ({ id } = await computer.start({ acknowledge: true, purpose: 'Verify ordinary browser sign-in mode using a local fixture, no account credentials' }));
  await computer.openBrowser(id); await computer.browserNavigate(`${url}/automated`, id);
  assert.equal((await receipt('/automated')).webdriver, true);
  await computer.openSignInBrowser(`${url}/standard`, id);
  assert.deepEqual(await receipt('/standard'), { path: '/standard', webdriver: false, returning: false });
  await computer.openSignInBrowser(`${url}/continue`, id);
  assert.deepEqual(await receipt('/continue'), { path: '/continue', webdriver: false, returning: true });
  console.log('Real browser passed: automated baseline detected; regular browser has no WebDriver flag; separate cookies persist during the task. Google account acceptance was not tested.');
} finally {
  if (id) { await computer.stop(id); await computer.cleanup(id); assert.equal(existsSync(join(directory, 'computer-browsers', id)), false); }
  await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true });
}
