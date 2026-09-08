import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { workspaceRelease } from './workspace-release.mjs';

export function verifyArtifactPrivacy(path, bytes, provenance, home = homedir()) {
  // Check CI paths locally too, so a local pass cannot hide a hosted failure.
  for (const prefix of new Set([`${home}/`, '/home/runner/'])) {
    if (!bytes.includes(Buffer.from(prefix))) continue;
    // This public upstream blob contains Cargo source paths from its own CI.
    // Metadata alone never grants an exception: bytes must match our code pin.
    if (prefix === '/home/runner/' && path === 'resources/workspace/agent-workspace-linux'
      && provenance?.source === workspaceRelease.source
      && provenance?.version?.name === 'agent-workspace-linux'
      && provenance?.version?.version === workspaceRelease.version
      && provenance?.sha256 === workspaceRelease.sha256
      && createHash('sha256').update(bytes).digest('hex') === workspaceRelease.sha256) continue;
    throw new Error(`Private build-machine path found in ${path}. Use a release binary or rebuild with remapped paths.`);
  }
}
