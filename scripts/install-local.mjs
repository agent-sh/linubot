import { cpSync, existsSync, mkdirSync, writeFileSync, readdirSync, readlinkSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const source = resolve('release/linux-unpacked');
const destination = join(homedir(), '.local/opt/linubot');
if (!existsSync(join(source, 'linubot'))) throw new Error('Build the Linux package first.');
const replacing = process.argv.includes('--replace');
if (existsSync(destination)) {
  if (!replacing) throw new Error('An installation already exists. Quit Linubot, then use --replace to update it.');
  if (lstatSync(destination).isSymbolicLink()) throw new Error('Refusing to replace a symlinked installation.');
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    let executable; try { executable = readlinkSync(`/proc/${pid}/exe`); } catch { continue; }
    if (executable === join(destination, 'linubot')) throw new Error(`Linubot is still running (PID ${pid}); quit it before updating.`);
  }
}
mkdirSync(join(homedir(), '.local/opt'), { recursive: true });
cpSync(source, destination, { recursive: true, dereference: false, errorOnExist: !replacing, force: replacing });
const bin = join(homedir(), '.local/bin'); const applications = join(homedir(), '.local/share/applications');
mkdirSync(bin, { recursive: true }); mkdirSync(applications, { recursive: true });
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
writeFileSync(join(bin, 'linubot'), `#!/bin/sh\nexec ${quote(join(destination, 'linubot'))} "$@"\n`, { mode: 0o755, flag: replacing ? 'w' : 'wx' });
const icon = join(homedir(), '.local/share/icons/hicolor/512x512/apps'); mkdirSync(icon, { recursive: true });
cpSync('desktop/icon.png', join(icon, 'linubot.png'));
writeFileSync(join(applications, 'linubot.desktop'), `[Desktop Entry]\nName=Linubot\nComment=Your local AI team\nExec="${join(bin, 'linubot')}"\nIcon=${join(icon, 'linubot.png').replaceAll('\\', '\\\\')}\nType=Application\nCategories=Utility;\nStartupWMClass=linubot\nTerminal=false\n`, { flag: replacing ? 'w' : 'wx' });
// Cache tools are optional; the desktop entry points directly to the installed image.
spawnSync('gtk-update-icon-cache', ['--force', '--ignore-theme-index', join(homedir(), '.local/share/icons/hicolor')], { stdio: 'ignore', timeout: 15000 });
spawnSync('update-desktop-database', [applications], { stdio: 'ignore', timeout: 15000 });
console.log(`Installed Linubot in ${destination} with a desktop launcher.`);
