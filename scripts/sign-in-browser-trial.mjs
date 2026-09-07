import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'linubot-signin-trial-'));
process.env.LINUBOT_DATA = relative(process.cwd(), directory);
const { createComputer } = await import('../dist/computer/workspace.js');
let computer = createComputer();
const receipts = [];
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
  ({ id } = await computer.start({ scope: 'bot:SessionFixture', acknowledge: true, purpose: 'Verify ordinary browser sign-in mode using a local fixture, no account credentials' }));
  await computer.openBrowser(id); await computer.browserNavigate(`${url}/automated`, id);
  assert.equal((await receipt('/automated')).webdriver, true);
  await computer.openSignInBrowser(`${url}/standard`, id);
  assert.deepEqual(await receipt('/standard'), { path: '/standard', webdriver: false, returning: false });
  await computer.openSignInBrowser(`${url}/continue`, id);
  assert.deepEqual(await receipt('/continue'), { path: '/continue', webdriver: false, returning: true });
  await computer.stop(id); await computer.cleanup(id); id = undefined;
  computer = createComputer();
  ({ id } = await computer.start({ scope: 'bot:SessionFixture', acknowledge: true, purpose: 'Reopen the saved browser after task and adapter restart' }));
  assert.equal(computer.standardBrowser(id), true);
  await computer.openBrowser(id); await computer.browserNavigate(`${url}/automated-restart`, id);
  assert.deepEqual(await receipt('/automated-restart'), { path: '/automated-restart', webdriver: true, returning: true });
  await computer.openSignInBrowser(`${url}/after-restart`, id);
  assert.deepEqual(await receipt('/after-restart'), { path: '/after-restart', webdriver: false, returning: true });
  await computer.stop(id); await computer.cleanup(id); id = undefined;
  ({ id } = await computer.start({ scope: 'bot:SeparateFixture', acknowledge: true, purpose: 'Verify a different bot cannot reuse the first bot login' }));
  await computer.openSignInBrowser(`${url}/other-bot`, id);
  assert.deepEqual(await receipt('/other-bot'), { path: '/other-bot', webdriver: false, returning: false });
  console.log('Real browser passed: automated baseline detected; regular browser has no WebDriver flag; cookies survive desktop and adapter restart, and another bot has separate cookies. Google account acceptance was not tested.');
} finally {
  if (id) { await computer.stop(id); await computer.cleanup(id); assert.equal(existsSync(join(directory, 'computer-browsers', id)), false); }
  await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true });
}
