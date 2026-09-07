import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This release is qualified for Linux x64.');
copyFileSync('desktop/icon.png', 'release/linux-unpacked/linubot.png');
const archive = `linubot-${version}-x64.tar.gz`, deb = `linubot-${version}-amd64.deb`;
execFileSync('tar', ['-czf', `release/${archive}`, '-C', 'release/linux-unpacked', '.'], { stdio: 'inherit' });
const names = [archive, deb];
const lines = names.map((name) => `${createHash('sha256').update(readFileSync(`release/${name}`)).digest('hex')}  ${name}`);
writeFileSync('release/SHA256SUMS', lines.join('\n') + '\n');
console.log(`Prepared ${names.join(', ')} and SHA256SUMS.`);
