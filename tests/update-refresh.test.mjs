import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { initUpdates, updateSettings } from '../web/updates.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

it('manual and foreground refresh share one forced lookup after an in-flight cached status read', async t => {
  const { document, window } = parseHTML('<html><body><button data-upgrade hidden></button><section id="updates"></section></body></html>');
  const previous = new Map(['document', 'window', 'Event'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { document, window, Event: window.Event });

  const cached = deferred(), forced = deferred(), requests = [], cleanups = [];
  let current = true;
  const version = {
    enabled: true, currentVersion: '2.7.0', checkedAt: Date.now() - 5 * 60000,
    installing: false, canInstall: false,
  };
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    requests.push({ path, method: options.method });
    if (path === '/api/updates' && options.method === 'GET') {
      await cached.promise;
      return Response.json(version);
    }
    assert.equal(path, '/api/updates/check');
    assert.equal(options.method, 'POST');
    await forced.promise;
    return Response.json({ ...version, checkedAt: Date.now(), latest: {
      version: '2.7.1', url: 'https://github.com/agent-sh/linubot/releases/tag/v2.7.1',
    } });
  });

  try {
    const root = document.getElementById('updates');
    initUpdates();
    updateSettings({ current: () => current, onCleanup: fn => cleanups.push(fn) }, root);
    await flush();

    root.querySelector('[data-check-updates]').onclick();
    window.dispatchEvent(new window.Event('focus'));
    assert.deepEqual(requests, [{ path: '/api/updates', method: 'GET' }]);

    cached.resolve();
    await flush();
    await flush();
    assert.deepEqual(requests, [
      { path: '/api/updates', method: 'GET' },
      { path: '/api/updates/check', method: 'POST' },
    ]);

    forced.resolve();
    await flush();
    await flush();
    assert.equal(document.querySelector('[data-upgrade]').hidden, false);
    assert.equal(document.querySelector('[data-upgrade]').textContent, 'Upgrade to 2.7.1');
    assert.match(root.querySelector('[data-update-status]').textContent, /Version 2\.7\.1 is available/);
    assert.equal(root.querySelector('[data-check-updates]').disabled, false);
  } finally {
    current = false;
    cached.resolve();
    forced.resolve();
    await flush();
    window.dispatchEvent(new window.Event('pagehide'));
    cleanups.forEach(cleanup => cleanup());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
