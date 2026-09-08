import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import * as asar from '@electron/asar';
import { checkPublicationRef, verifyArtifacts, prepareReleaseDist, verifyPublishedManifest, assetNames, verifyPayloadModes, canonicalNotes, readTagNotes, ensureReleaseTag, getOrCreateDraft, assertDraftRelease } from '../scripts/release.mjs';

it('local tag requests require synchronized main while hosted publication accepts the exact tag on main', () => {
  const local = { hosted: false, branch: 'main', head: 'commit', mainHead: 'commit' };
  checkPublicationRef(local);
  assert.throws(() => checkPublicationRef({ ...local, branch: 'feature' }), /must run on main/);
  assert.throws(() => checkPublicationRef({ ...local, mainHead: 'newer' }), /differs from origin/);
  const hosted = { ...local, hosted: true, branch: '', mainHead: 'newer', tag: 'v2.11.0', tagHead: 'commit', onMain: true, eventName: 'push', eventRef: 'refs/tags/v2.11.0', eventSha: 'commit' };
  checkPublicationRef(hosted); // main may advance while a tag build is queued.
  for (const override of [{ onMain: false }, { tagHead: 'other' }, { eventSha: 'other' }, { eventName: 'workflow_dispatch' }, { eventRef: 'refs/heads/main' }, { tag: 'v2.12.0' }]) {
    assert.throws(() => checkPublicationRef({ ...hosted, ...override }), /exact version-tag|on origin\/main/);
  }
});

it('release integrity accepts an external-only Chrome wrapper and rejects mismatched source or package bytes', { skip: process.platform !== 'linux' }, async (t) => {
  const original = process.cwd(), dir = mkdtempSync(join(tmpdir(), 'linubot-release-integrity-'));
  const version = '2.11.0', names = assetNames(version);
  const put = (path, value) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, value); };
  const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  try {
    process.chdir(dir);
    for (const path of ['desktop/main.cjs', 'desktop/icon.png', 'web/index.html', 'web/updates.js', 'LICENSE', 'NOTICE', 'dist/server.js']) put(`source/${path}`, `fixture:${path}`);
    put('source/package.json', JSON.stringify({ version }));
    cpSync('source', '.', { recursive: true });
    put('desktop/linubot-chrome.sh', 'external wrapper'); put('install.sh', 'installer');
    put('release/linux-unpacked/linubot', 'executable');
    put('release/linux-unpacked/resources/workspace/agent-workspace-linux', 'workspace');
    put('release/linux-unpacked/resources/install.sh', 'installer');
    put('release/linux-unpacked/resources/linubot-chrome.sh', 'external wrapper');
    await asar.createPackage('source', 'release/linux-unpacked/resources/app.asar');
    assert(!asar.listPackage('release/linux-unpacked/resources/app.asar').includes('/desktop/linubot-chrome.sh'));
    execFileSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("classes.dex","fixture"); z.close()', `release/${names[2]}`]);
    const pack = (badDeb = false, badTar = false) => {
      rmSync('deb', { recursive: true, force: true }); rmSync('tar', { recursive: true, force: true });
      cpSync('release/linux-unpacked', 'deb/opt/Linubot', { recursive: true });
      cpSync('release/linux-unpacked', 'tar', { recursive: true });
      put('deb/DEBIAN/control', `Package: linubot\nVersion: ${version}\nArchitecture: amd64\nMaintainer: Fixture <fixture@example.com>\nDescription: Fixture\n`);
      if (badDeb) put('deb/opt/Linubot/resources/linubot-chrome.sh', 'wrong deb wrapper');
      if (badTar) put('tar/resources/linubot-chrome.sh', 'wrong tar wrapper');
      execFileSync('dpkg-deb', ['--build', 'deb', `release/${names[0]}`], { stdio: 'ignore' });
      execFileSync('tar', ['-czf', `release/${names[1]}`, '-C', 'tar', '.']);
      put('release/SHA256SUMS', names.slice(0, 3).map((name) => `${sha(`release/${name}`)}  ${name}\n`).join(''));
    };
    const verify = () => {
      const temp = mkdtempSync(join(dir, 'verify-'));
      try { return verifyArtifacts(version, temp); } finally { rmSync(temp, { recursive: true, force: true }); }
    };
    await t.test('PR12 external-only layout passes all four asset checks', () => { pack(); assert.equal(verify().length, 4); });
    await t.test('Debian wrapper mismatch fails', () => { pack(true); assert.throws(verify, /payload mismatch: resources\/linubot-chrome.sh/); });
    await t.test('tar wrapper mismatch fails', () => { pack(false, true); assert.throws(verify, /payload mismatch: resources\/linubot-chrome.sh/); });
    await t.test('identical but stale wrappers in all three payloads fail source comparison', () => {
      put('release/linux-unpacked/resources/linubot-chrome.sh', 'stale wrapper'); pack();
      assert.throws(verify, /Chrome wrapper differs from the working tree/);
      put('release/linux-unpacked/resources/linubot-chrome.sh', 'external wrapper');
    });
    await t.test('dist mismatch still fails', () => { pack(); put('dist/server.js', 'changed'); assert.throws(verify, /ASAR differs from working tree/); });
  } finally { process.chdir(original); rmSync(dir, { recursive: true, force: true }); }
});

it('the local resume path pushes only the annotated tag and never invokes a release publisher', { skip: process.platform !== 'linux' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'linubot-release-owner-'));
  try {
    const put = (path, bytes, options) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, bytes, options); };
    const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const version = '2.11.0', head = 'a'.repeat(40), notes = '# Fixture release\n\nHard break  \nFinal line  ';
    put(join(dir, 'package.json'), JSON.stringify({ version }));
    put(join(dir, 'android/app/build.gradle'), "versionName '2.11.0'; versionCode 21100");
    put(join(dir, 'notes.md'), notes);
    const assets = assetNames(version).map((name) => { put(join(dir, 'release', name), 'fixture'); return { name, size: 7, sha256: sha('fixture') }; });
    put(join(dir, 'release/.release-2.11.0.json'), JSON.stringify({ version, head, notesHash: sha(canonicalNotes(Buffer.from(notes))), assets }));
    put(join(dir, '.local/state/linubot-android-signing/release.keystore'), 'fixture');
    put(join(dir, '.local/state/linubot-android-signing/password'), 'fixture');
    for (const tool of ['zipalign', 'apksigner']) put(join(dir, 'sdk/build-tools/36.0.0', tool), 'fixture');
    put(join(dir, 'bin/git'), `#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2);fs.appendFileSync(process.env.CALLS,JSON.stringify(['git',...a])+'\\n');
if(process.umask()!==0o022)process.exit(43);
if(a[0]==='rev-parse')console.log(a[1]==='--show-toplevel'?process.cwd():'${head}');
else if(a[0]==='branch')console.log(process.env.FIXTURE_BRANCH || 'main');
else if(a[0]==='remote')console.log('https://github.com/agent-sh/linubot.git');
`, { mode: 0o755 });
    put(join(dir, 'bin/gh'), `#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2);fs.appendFileSync(process.env.CALLS,JSON.stringify(['gh',...a])+'\\n');
if(a.join(' ')!=='auth status')process.exit(42);
`, { mode: 0o755 });
    const calls = join(dir, 'calls');
    const result = execFileSync('bash', ['-c', 'umask 077; exec "$@"', 'release-mask-test', process.execPath, join(process.cwd(), 'scripts/release.mjs'), '--resume', '--notes', join(dir, 'notes.md')], {
      cwd: dir, env: { ...process.env, HOME: dir, ANDROID_HOME: join(dir, 'sdk'), GITHUB_ACTIONS: '', DISPLAY: ':fixture', PATH: `${join(dir, 'bin')}:${process.env.PATH}`, CALLS: calls }, encoding: 'utf8',
    });
    assert.match(result, /Only the tag workflow publishes/);
    const commands = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    assert(commands.some((args) => args[0] === 'git' && args[1] === 'tag' && args.includes('-a') && args.includes('-F')));
    assert(commands.some((args) => args.join(' ') === 'git push origin refs/tags/v2.11.0:refs/tags/v2.11.0'));
    assert.deepEqual(commands.filter((args) => args[0] === 'gh'), [['gh', 'auth', 'status']]);
    writeFileSync(calls, '');
    const buildPlan = execFileSync(process.execPath, [join(process.cwd(), 'scripts/release.mjs'), '--build-only', '--dry-run'], {
      cwd: dir, env: { ...process.env, HOME: dir, ANDROID_HOME: join(dir, 'sdk'), GITHUB_ACTIONS: '', FIXTURE_BRANCH: 'integration-candidate', DISPLAY: ':fixture', PATH: `${join(dir, 'bin')}:${process.env.PATH}`, CALLS: calls }, encoding: 'utf8',
    });
    assert.match(buildPlan, /branch integration-candidate/);
    assert.match(buildPlan, /Would stop after verified artifacts; no tag, push or release writes/);
    assert(!readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(JSON.parse).some((args) => args[0] === 'git' && ['push', 'tag'].includes(args[1]) && args[2] !== '-l'));

  } finally { rmSync(dir, { recursive: true, force: true }); }
});


it('published reruns validate the manifest without replacing assets or changing latest', () => {
  const version = '2.11.0', names = assetNames(version), digest = 'a'.repeat(64);
  const manifest = Buffer.from(names.slice(0, 3).map((name) => `${digest}  ${name}\n`).join(''));
  const release = { draft: false, prerelease: false, assets: names.map((name) => ({ name, state: 'uploaded', size: name === 'SHA256SUMS' ? manifest.length : 1, digest: `sha256:${name === 'SHA256SUMS' ? createHash('sha256').update(manifest).digest('hex') : digest}` })) };
  verifyPublishedManifest(release, version, manifest);
  assert.throws(() => verifyPublishedManifest(release, version, Buffer.from('tampered')), /checksum/);
  assert.throws(() => verifyPublishedManifest({ ...release, assets: release.assets.slice(1) }, version, manifest), /exactly four/);
});

it('release dist preparation honors the explicit package source-map exclusion', () => {
  const previous = process.cwd(), dir = mkdtempSync(join(tmpdir(), 'linubot-release-dist-'));
  try {
    process.chdir(dir); mkdirSync('dist'); writeFileSync('dist/app.js', 'runtime'); writeFileSync('dist/app.js.map', 'map');
    writeFileSync('package.json', JSON.stringify({ build: { files: ['dist/**/*'] } }));
    prepareReleaseDist(); assert.equal(readFileSync('dist/app.js.map', 'utf8'), 'map');
    writeFileSync('package.json', JSON.stringify({ build: { files: ['dist/**/*', '!**/*.{map,ts,tsx,mts,cts}'] } }));
    prepareReleaseDist(); assert.throws(() => readFileSync('dist/app.js.map'), /ENOENT/);
    assert.equal(readFileSync('dist/app.js', 'utf8'), 'runtime');
  } finally { process.chdir(previous); rmSync(dir, { recursive: true, force: true }); }
});


it('verbatim tag notes preserve Markdown headings, hard breaks and blank lines across resume', () => {
  const previous = process.cwd(), dir = mkdtempSync(join(tmpdir(), 'linubot-tag-notes-'));
  try {
    process.chdir(dir);
    execFileSync('git', ['init', '--quiet', '--initial-branch=main']);
    for (const [key, value] of [['user.name', 'Release fixture'], ['user.email', 'fixture@example.com'], ['tag.gpgSign', 'false'], ['commit.gpgSign', 'false']]) execFileSync('git', ['config', key, value]);
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'Fixture']);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    for (const [index, text] of ['# Release heading\n\nFirst line  \nSecond line\n\n## Fixes\nLast line  ', '# Heading\n\nParagraph  \n\n\n'].entries()) {
      const notes = Buffer.from(text), tag = `fixture-${index}`;
      writeFileSync('notes.md', notes);
      ensureReleaseTag(tag, head, 'notes.md', false);
      assert.deepEqual(readTagNotes(tag), canonicalNotes(notes));
      const object = execFileSync('git', ['rev-parse', tag]);
      ensureReleaseTag(tag, head, 'notes.md', true);
      // Supplying the canonical final LF is equivalent; no other whitespace is.
      writeFileSync('notes.md', canonicalNotes(notes));
      ensureReleaseTag(tag, head, 'notes.md', true);
      assert.deepEqual(execFileSync('git', ['rev-parse', tag]), object);
      writeFileSync('notes.md', text.replace('  ', ''));
      assert.throws(() => ensureReleaseTag(tag, head, 'notes.md', true), /notes differ/);
      writeFileSync('notes.md', text.replace(/^#.*\n/, ''));
      assert.throws(() => ensureReleaseTag(tag, head, 'notes.md', true), /notes differ/);
    }
  } finally { process.chdir(previous); rmSync(dir, { recursive: true, force: true }); }
});

it('workflow signing files stay private while generated root-owned Debian payloads are readable', { skip: process.platform !== 'linux' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'linubot-release-modes-'));
  try {
    const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8'));
    const step = workflow.jobs.release.steps.find((step) => step.name === 'Build, verify and publish the existing tag');
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/dbus-run-session'), `#!/usr/bin/python3
import os,stat,subprocess,tarfile,io,json
from pathlib import Path
signing=Path.home()/'.local/state/linubot-android-signing'
assert stat.S_IMODE(signing.stat().st_mode)==0o700
for name in ['release.keystore','password']:assert stat.S_IMODE((signing/name).stat().st_mode)==0o600
assert os.umask(0o022)==0o022, 'Private signing umask leaked into build'
root=Path('payload');(root/'opt/Linubot/resources').mkdir(parents=True)
(root/'opt/Linubot/resources/app.asar').write_bytes(b'fixture')
(root/'opt/Linubot/linubot').write_bytes(b'fixture');(root/'opt/Linubot/linubot').chmod(0o755)
(root/'DEBIAN').mkdir();(root/'DEBIAN/control').write_text('Package: linubot\\nVersion: 1.0.0\\nArchitecture: amd64\\nMaintainer: Fixture <fixture@example.com>\\nDescription: Fixture\\n')
subprocess.run(['dpkg-deb','--build','--root-owner-group','payload','fixture.deb'],check=True,stdout=subprocess.DEVNULL)
archive=subprocess.check_output(['dpkg-deb','--fsys-tarfile','fixture.deb'])
with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
 modes={m.name:[m.mode,m.uid,m.gid] for m in tar.getmembers()}
 assert modes['./opt/Linubot/resources']==[0o755,0,0]
 assert modes['./opt/Linubot/resources/app.asar']==[0o644,0,0]
 assert modes['./opt/Linubot/linubot']==[0o755,0,0]
Path('package-modes.json').write_text(json.dumps(modes))
`, { mode: 0o755 });
    execFileSync('bash', ['-c', `umask 077\n${step.run}`], {
      cwd: dir, env: { ...process.env, HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, ANDROID_KEYSTORE_BASE64: Buffer.from('fixture key').toString('base64'), ANDROID_STORE_PASSWORD: 'fixture password' },
    });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'package-modes.json'), 'utf8'))['./opt/Linubot/resources/app.asar'], [0o644, 0, 0]);
    for (const name of ['release.keystore', 'password']) assert(!existsSync(join(dir, '.local/state/linubot-android-signing', name)), 'Workflow must clean signing files');
    const unpack = (name) => {
      const target = join(dir, name);
      execFileSync('dpkg-deb', ['-x', join(dir, 'fixture.deb'), target]);
      return target;
    };
    verifyPayloadModes(unpack('good'));
    // The builder still owns and can read these files. The gate must reject
    // their archived other-user permissions, regardless of the builder's access.
    for (const [name, path, mode] of [['file', 'opt/Linubot/resources/app.asar', 0o600], ['directory', 'opt/Linubot/resources', 0o700]]) {
      const file = join(dir, 'payload', path); chmodSync(file, mode);
      execFileSync('dpkg-deb', ['--build', '--root-owner-group', join(dir, 'payload'), join(dir, 'fixture.deb')], { stdio: 'ignore' });
      assert.throws(() => verifyPayloadModes(unpack(`bad-${name}`)), /Package permissions deny ordinary users access/);
      chmodSync(file, name === 'file' ? 0o644 : 0o755);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


it('new draft creation uses the POST response ID when tag lookup returns 404', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linubot-draft-readback-'));
  try {
    const tag = 'v2.12.2', head = 'a'.repeat(40), body = '# Release heading\n\nHard break  \nLast line  \n';
    const notes = join(dir, 'notes.md'); writeFileSync(notes, body);
    const draft = { id: 42, tag_name: tag, draft: true, prerelease: false, assets: [] };
    const calls = [];
    const api = (args) => {
      calls.push(args);
      if (args.some((arg) => arg.includes('/releases/tags/'))) throw new Error('Not Found (HTTP 404)');
      if (args.includes('--paginate')) return [[]];
      if (args.includes('POST')) {
        assert.deepEqual(JSON.parse(readFileSync(args[args.indexOf('--input') + 1], 'utf8')), { tag_name: tag, target_commitish: head, name: tag, body, draft: true, prerelease: false });
        return draft;
      }
      assert.deepEqual(args, ['api', 'repos/agent-sh/linubot/releases/42']);
      return { ...draft, url: 'https://api.github.com/repos/agent-sh/linubot/releases/42' };
    };
    assert.throws(() => api(['api', `repos/agent-sh/linubot/releases/tags/${tag}`]), /404/);
    calls.length = 0;
    assert.equal(getOrCreateDraft({ tag, head, notes, temporary: dir }, api).id, 42);
    assert.equal(calls.length, 3);
    assert(!calls.some((args) => args.some((arg) => arg.includes('/releases/tags/'))));
    assert.deepEqual(calls.at(-1), ['api', 'repos/agent-sh/linubot/releases/42']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('existing drafts are reused by ID and changed or non-draft readbacks fail closed', () => {
  const tag = 'v2.12.2', draft = { id: 42, tag_name: tag, draft: true, prerelease: false, assets: [] };
  const options = { tag, head: 'a'.repeat(40), notes: 'must-not-read', temporary: 'must-not-write' };
  const lookup = (readback) => (args) => {
    if (args.includes('--paginate')) return [[], [draft]];
    assert.deepEqual(args, ['api', 'repos/agent-sh/linubot/releases/42']);
    return readback;
  };
  assert.deepEqual(getOrCreateDraft(options, lookup(draft)), draft);
  for (const changed of [{ id: 43 }, { tag_name: 'v2.12.3' }, { draft: false }, { prerelease: true }, { draft: 'true' }, { prerelease: undefined }]) {
    assert.throws(() => getOrCreateDraft(options, lookup({ ...draft, ...changed })), /expected stable draft/);
  }
  for (const id of [undefined, null, 0, -1, '42']) assert.throws(() => assertDraftRelease({ ...draft, id }, tag), /expected stable draft/);
  assert.throws(() => getOrCreateDraft(options, () => { throw new Error('API unavailable'); }), /API unavailable/);
});

it('a failed create response stops immediately and a later retry reuses the saved draft', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linubot-draft-create-failure-'));
  try {
    const tag = 'v2.12.2', options = { tag, head: 'a'.repeat(40), notes: join(dir, 'notes.md'), temporary: dir };
    writeFileSync(options.notes, '# Fixture notes\n');
    let saved, creates = 0, reads = 0;
    const api = (args) => {
      if (args.includes('--paginate')) return [saved ? [saved] : []];
      if (args.includes('POST')) {
        creates++;
        saved = { id: 42, tag_name: tag, draft: true, prerelease: false, assets: [] };
        throw new Error('Create response connection lost');
      }
      assert.deepEqual(args, ['api', 'repos/agent-sh/linubot/releases/42']);
      reads++;
      return saved;
    };
    assert.throws(() => getOrCreateDraft(options, api), /connection lost/);
    assert.equal(creates, 1); assert.equal(reads, 0);
    assert.equal(getOrCreateDraft(options, api).id, 42);
    assert.equal(creates, 1); assert.equal(reads, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
