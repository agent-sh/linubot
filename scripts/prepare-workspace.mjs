import { copyFileSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fetchPublic } from '../dist/network/http.js';
import { workspaceRelease, workspaceReleaseUrl } from './workspace-release.mjs';

const workspaceSha256 = workspaceRelease.sha256;
const cached = resolve('build/downloads/agent-workspace-linux');
if (!process.env.LINUBOT_WORKSPACE_BIN) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('The bundled release is qualified for Linux x64.');
  mkdirSync('build/downloads', { recursive: true });
  if (!existsSync(cached) || createHash('sha256').update(readFileSync(cached)).digest('hex') !== workspaceSha256) {
    const downloaded = (await fetchPublic(workspaceReleaseUrl, { maxBytes: 128 * 1024 * 1024 })).bytes;
    if (createHash('sha256').update(downloaded).digest('hex') !== workspaceSha256) throw new Error('Workspace release checksum mismatch');
    writeFileSync(cached, downloaded, { mode: 0o755 });
  }
}
const binary = process.env.LINUBOT_WORKSPACE_BIN || cached;
const destination = 'build/workspace';
mkdirSync(destination, { recursive: true });
const bytes = readFileSync(binary);
copyFileSync(binary, join(destination, 'agent-workspace-linux'));
chmodSync(join(destination, 'agent-workspace-linux'), 0o755);
const client = new Client({ name: 'linubot-packager', version: JSON.parse(readFileSync('package.json', 'utf8')).version });
const transport = new StdioClientTransport({ command: binary, args: ['mcp', '--headless'], stderr: 'pipe' });
transport.stderr?.on('data', () => {});
let version;
try { await client.connect(transport, { timeout: 10000 }); version = client.getServerVersion(); }
finally { await client.close(); }
writeFileSync(join(destination, 'provenance.json'), JSON.stringify({ source: workspaceRelease.source, version, sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2));
mkdirSync('build/runners', { recursive: true });
const runners = [];
for (const name of ['uv', 'uvx']) {
  const source = join(process.env.LINUBOT_UV_DIR || join(homedir(), '.local/bin'), name);
  const content = readFileSync(source);
  copyFileSync(source, join('build/runners', name)); chmodSync(join('build/runners', name), 0o755);
  runners.push({ name, sha256: createHash('sha256').update(content).digest('hex'), version: execFileSync(source, ['--version'], { encoding: 'utf8' }).trim() });
}
writeFileSync('build/runners/provenance.json', JSON.stringify({ source: 'https://github.com/astral-sh/uv', runners }, null, 2));
for (const [path, url] of [
  ['build/workspace/LICENSE', `${workspaceRelease.source.replace('github.com', 'raw.githubusercontent.com')}/v${workspaceRelease.version}/LICENSE`],
  ['build/runners/LICENSE-MIT', 'https://raw.githubusercontent.com/astral-sh/uv/0.11.7/LICENSE-MIT'],
  ['build/runners/LICENSE-APACHE', 'https://raw.githubusercontent.com/astral-sh/uv/0.11.7/LICENSE-APACHE'],
]) writeFileSync(path, (await fetchPublic(url)).bytes);
console.log('Bundled agent-workspace-linux with version and SHA-256 provenance.');
