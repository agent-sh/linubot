import { copyFileSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fetchPublic } from '../dist/network/http.js';

const binary = process.env.LINUBOT_WORKSPACE_BIN || join(homedir(), '.local/bin/agent-workspace-linux');
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
writeFileSync(join(destination, 'provenance.json'), JSON.stringify({ source: 'https://github.com/agent-sh/agent-workspace-linux', version, sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2));
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
  ['build/workspace/LICENSE', 'https://raw.githubusercontent.com/agent-sh/agent-workspace-linux/main/LICENSE'],
  ['build/runners/LICENSE-MIT', 'https://raw.githubusercontent.com/astral-sh/uv/0.11.7/LICENSE-MIT'],
  ['build/runners/LICENSE-APACHE', 'https://raw.githubusercontent.com/astral-sh/uv/0.11.7/LICENSE-APACHE'],
]) writeFileSync(path, (await fetchPublic(url)).bytes);
console.log('Bundled agent-workspace-linux with version and SHA-256 provenance.');
