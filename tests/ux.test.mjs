import { it } from 'node:test';
import assert from 'node:assert/strict';
import { sessionList } from '../web/home.js';
import { groupActivityRows, projectEvents } from '../web/conversation.js';
import { mascot } from '../web/mascots.js';
import { parseHTML } from 'linkedom';
import { providerSignin } from '../web/provider-signin.js';

function signinFixture(t, draft, get = async () => ({})) {
  const { document, window } = parseHTML('<html><body><section id="signin"></section></body></html>');
  const previous = new Map(['document', 'window', 'Event'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { document, window, Event: window.Event });
  t.after(() => { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const opened = []; window.open = url => { opened.push(url); };
  const root = document.querySelector('#signin');
  const signin = providerSignin({ current: () => true, onCleanup: () => {}, get }, root, draft, () => {});
  t.after(() => signin.cancel());
  return { root, signin, opened };
}
async function actionDone(root) {
  for (let i = 0; i < 100; i++) { if (!root.dataset.busy) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('Sign-in action did not finish');
}

it('sessions aggregate replies into the continuing bot and group conversations', () => {
  const runs = [
    { id: '1', scope: 'bot:Milo', createdAt: '2026-09-06T10:00:00Z', prompt: 'First message' },
    { id: '2', scope: 'bot:Milo', createdAt: '2026-09-06T12:00:00Z', response: 'Latest reply' },
    { id: '3', scope: 'group:planning', createdAt: '2026-09-06T11:00:00Z', prompt: 'A shared plan' },
  ];
  const sessions = sessionList({ bots: [{ name: 'Milo' }, { name: 'Fern' }], groups: [{ id: 'planning', name: 'Planning' }], runs });
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].scope, 'bot:Milo');
  assert.equal(sessions[0].snippet, 'Latest reply');
  assert.equal(sessions[1].route, 'planning');
});

it('collapses technical activity while keeping conversation, approvals and deliverables visible', () => {
  const events = projectEvents([
    { seq: 1, kind: 'message', from: 'user', text: 'Find a source' },
    { seq: 2, kind: 'thinking', runId: 'r', status: 'pending' },
    { seq: 3, kind: 'thinking', runId: 'r', refSeq: 2, status: 'done' },
    { seq: 4, kind: 'tool', runId: 'r', name: 'web_search', status: 'done' },
    { seq: 5, kind: 'approval', runId: 'r', status: 'pending' },
    { seq: 6, kind: 'file', runId: 'r', path: '/api/screenshots/screenshot' },
    { seq: 7, kind: 'tool', runId: 'r', status: 'done' },
    { seq: 8, kind: 'file', runId: 'r', path: '/api/artifacts/report/download' },
    { seq: 9, kind: 'message', runId: 'r', from: 'Milo', text: 'Here is the report' },
  ]);
  const rows = groupActivityRows(events);
  assert.deepEqual(rows.map((row) => row.kind), ['message', 'activity_group', 'approval', 'activity_group', 'file', 'message']);
  assert.equal(rows[2].status, 'pending');
  assert.equal(rows[1].events[0].status, 'done');
  assert.equal(rows[3].events[0].path, '/api/screenshots/screenshot');
  assert.equal(rows[4].path, '/api/artifacts/report/download');
});

it('mascots keep their identity across renders without inserting seed text into markup', () => {
  assert.equal(mascot('saved-look'), mascot('saved-look'));
  assert.notEqual(mascot('saved-look'), mascot('another-look'));
  assert.doesNotMatch(mascot('<script>untrusted</script>'), /script|untrusted/);
});

it('browser sign-in retries after an initial setup error without reopening settings', async t => {
  let starts = 0;
  t.mock.method(globalThis, 'fetch', async path => {
    if (path.endsWith('/cancel')) return Response.json({ cancelled: true });
    starts++;
    return starts === 1 ? Response.json({ error: 'Fixture setup needs retry' }, { status: 409 }) : Response.json({ id: 'fixture-login', authorizationUrl: 'https://auth.openai.com/authorize?fixture=yes' });
  });
  const { root, signin, opened } = signinFixture(t, () => ({ kind: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api/codex', auth: 'bearer' }));
  signin.render('openai-codex'); root.querySelector('[data-start]').click(); await actionDone(root);
  assert.equal(starts, 1); assert.match(root.querySelector('[data-feedback]').textContent, /setup needs retry/);
  root.querySelector('[data-start]').click(); await actionDone(root);
  assert.equal(starts, 2); assert.deepEqual(opened, ['https://auth.openai.com/authorize?fixture=yes']);
  assert.equal(root.querySelector('[data-cancel]').hidden, false);
});

it('a cancelled startup failure cannot replace the next provider panel with an old error', async t => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async () => { await delayed; return Response.json({ error: 'Previous provider private error' }, { status: 409 }); });
  let draft = { kind: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api/codex', auth: 'bearer' };
  const { root, signin, opened } = signinFixture(t, () => draft);
  signin.render('openai-codex'); root.querySelector('[data-start]').click();
  draft = { kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', auth: 'x-api-key' }; signin.render('anthropic');
  release(); await actionDone(root);
  assert.match(root.textContent, /Create an Anthropic API key/); assert.doesNotMatch(root.textContent, /Previous provider private error/); assert.deepEqual(opened, []);
});
