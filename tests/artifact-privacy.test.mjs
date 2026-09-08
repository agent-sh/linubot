import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { verifyArtifactPrivacy } from '../scripts/artifact-privacy.mjs';
import { workspaceRelease, workspaceReleaseUrl } from '../scripts/workspace-release.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const workspacePath = 'resources/workspace/agent-workspace-linux';
const provenance = { source: workspaceRelease.source, version: { name: 'agent-workspace-linux', version: workspaceRelease.version }, sha256: workspaceRelease.sha256 };
// The positive fixture is the real immutable public artifact, not a mocked hash.
// Cache it outside source; CI downloads and checksum-verifies it on a clean run.
const cached = `build/downloads/workspace-privacy-${workspaceRelease.sha256}`;
let publicBytes;
if (existsSync(cached)) publicBytes = readFileSync(cached);
else {
  const response = await fetch(workspaceReleaseUrl, { signal: AbortSignal.timeout(120000) });
  assert.equal(response.status, 200);
  publicBytes = Buffer.from(await response.arrayBuffer());
  assert.equal(sha(publicBytes), workspaceRelease.sha256);
  mkdirSync('build/downloads', { recursive: true }); writeFileSync(cached, publicBytes);
}
assert.equal(sha(publicBytes), workspaceRelease.sha256);

it('accepts public upstream Cargo paths only for the byte-identical pinned workspace with matching provenance', () => {
  assert(publicBytes.includes(Buffer.from('/home/runner/.cargo/')));
  verifyArtifactPrivacy(workspacePath, publicBytes, provenance, '/home/runner');
  verifyArtifactPrivacy(workspacePath, publicBytes, provenance, '/home/private-builder');
});

it('rejects one-byte tampering even when metadata still claims the public pin', () => {
  const tampered = Buffer.from(publicBytes); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => verifyArtifactPrivacy(workspacePath, tampered, provenance, '/home/runner'), /Private build-machine path/);
});

it('rejects missing or mismatched provenance and forged provenance for custom bytes', () => {
  for (const value of [undefined, { ...provenance, source: 'https://example.com' }, { ...provenance, sha256: '0'.repeat(64) }, { ...provenance, version: { ...provenance.version, version: 'custom' } }]) {
    assert.throws(() => verifyArtifactPrivacy(workspacePath, publicBytes, value, '/home/runner'), /Private build-machine path/);
  }
  const privateBytes = Buffer.from('/home/runner/private/customer-data');
  assert.throws(() => verifyArtifactPrivacy(workspacePath, privateBytes, { ...provenance, sha256: sha(privateBytes) }, '/home/runner'), /Private build-machine path/);
  assert.throws(() => verifyArtifactPrivacy(workspacePath, privateBytes, provenance, '/home/runner'), /Private build-machine path/);
});

it('keeps ASAR, uv, uvx and custom owner paths strict, including CI paths checked on a local machine', () => {
  for (const path of ['resources/app.asar', 'resources/runners/uv', 'resources/runners/uvx']) {
    assert.throws(() => verifyArtifactPrivacy(path, publicBytes, provenance, '/home/runner'), /Private build-machine path/);
    assert.throws(() => verifyArtifactPrivacy(path, Buffer.from('/home/private-builder/secret'), undefined, '/home/private-builder'), /Private build-machine path/);
    assert.throws(() => verifyArtifactPrivacy(path, Buffer.from('/home/runner/secret'), undefined, '/home/private-builder'), /Private build-machine path/);
    verifyArtifactPrivacy(path, Buffer.from('no build path'), undefined, '/home/runner');
  }
  assert.throws(() => verifyArtifactPrivacy(workspacePath, Buffer.from('/home/private-builder/secret'), provenance, '/home/private-builder'), /Private build-machine path/);
});

it('the package command disables real electron-builder upload scheduling even with CI, a tag and a token', () => {
  // The builder reads inherited PR signals and import-time CI metadata. Start
  // it in a fresh tag environment instead of the outer test runner's PR context.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { PublishManager } from 'app-builder-lib/out/publish/PublishManager.js';
    import { CancellationToken } from 'builder-util-runtime';
    const command = JSON.parse(readFileSync('package.json', 'utf8')).scripts['package:linux'];
    const policy = command.match(/\\belectron-builder\\b.*\\s--publish\\s+(\\w+)\\s*$/)?.[1];
    assert.equal(policy, 'never');
    async function scheduled(publish) {
      let created, uploads = 0;
      const manager = new PublishManager({ cancellationToken: new CancellationToken(), config: {}, appInfo: {}, onAfterPack() {}, onArtifactCreated(callback) { created = callback; } }, { publish });
      manager.scheduleUpload = async () => { uploads++; };
      await created({ file: 'fixture.deb', publishConfig: { provider: 'github', owner: 'fixture', repo: 'fixture' } });
      return uploads;
    }
    assert.equal(await scheduled(undefined), 1, 'control reproduces implicit tag publishing');
    assert.equal(await scheduled(policy), 0, 'the production package command disables scheduling');
  `], { env: { ...process.env, CI: 'true', GH_TOKEN: 'fixture-token', GITHUB_TOKEN: 'fixture-token',
    GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/tags/v2.12.2', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v2.12.2',
    GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: '', GITHUB_HEAD_REF: '', GITHUB_BASE_REF: '',
    TRAVIS_PULL_REQUEST: 'false', CI_PULL_REQUEST: '', CIRCLE_PULL_REQUEST: '', BITRISE_PULL_REQUEST: '', APPVEYOR_PULL_REQUEST_NUMBER: '', PUBLISH_FOR_PULL_REQUEST: 'false' } });
});
