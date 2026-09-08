#!/usr/bin/env node
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as asar from '@electron/asar';

const repository = 'agent-sh/linubot';
const dryRun = process.argv.includes('--dry-run');
const resume = process.argv.includes('--resume');
let notes;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--notes') {
    if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error('--notes requires a file path.');
    notes = resolve(process.argv[++i]);
  } else if (!['--dry-run', '--resume'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
}
const log = (message) => console.log(`[release] ${message}`);
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const run = (command, args = [], options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const output = (command, args = [], options = {}) => run(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...options }).trim();
const git = (...args) => output('git', args);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileHash = (path) => hash(readFileSync(path));
const filesUnder = (path) => readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesUnder(join(path, entry.name)) : [join(path, entry.name)]).sort();
let temporary;
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    process.exit(code);
  });
}
try {
  log('1/6 Preconditions');
  requireThat(process.platform === 'linux' && process.arch === 'x64', 'Release builds require Linux x64.');
  const root = git('rev-parse', '--show-toplevel');
  requireThat(resolve('.') === root, 'Run this script from the repository root.');
  requireThat(git('branch', '--show-current') === 'main', 'Release builds must run on main.');
  requireThat(!git('status', '--porcelain'), 'The working tree must be clean, including untracked files.');
  const remote = git('remote', 'get-url', 'origin');
  requireThat(/^(https:\/\/github\.com\/|git@github\.com:)agent-sh\/linubot(?:\.git)?$/.test(remote), 'origin must point to agent-sh/linubot on GitHub.');
  run('git', ['fetch', 'origin', 'main', '--tags']);
  const head = git('rev-parse', 'HEAD');
  requireThat(head === git('rev-parse', 'origin/main'), 'Local main differs from origin/main. Sync main before releasing.');
  run('gh', ['auth', 'status']);
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  requireThat(/^\d+\.\d+\.\d+$/.test(version), 'package.json must contain a stable MAJOR.MINOR.PATCH version.');
  const tag = `v${version}`;
  const receiptPath = resolve(`release/.release-${version}.json`);
  const receipt = resume && existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : undefined;
  if (resume) requireThat(receipt?.head === head && receipt?.version === version, '--resume requires a verified release receipt for this exact main HEAD and version.');
  const tagged = Boolean(git('tag', '-l', tag));
  if (tagged && dryRun) log(`DRY RUN: skipping version-not-tagged check (${tag} already exists).`);
  else if (tagged && resume) {
    requireThat(git('rev-parse', `${tag}^{commit}`) === head, `${tag} does not point to the recorded release HEAD.`);
    log(`Resuming recorded publication of ${tag}.`);
  } else requireThat(!tagged, `${tag} already exists. Bump the version, or use --resume with this release's verified receipt.`);
  const gradle = readFileSync('android/app/build.gradle', 'utf8');
  requireThat(gradle.match(/\bversionName\s+['"]([^'"]+)['"]/)?.[1] === version, `Android versionName must equal ${version}.`);
  const versionCode = version.replaceAll('.', '') + '0';
  requireThat(gradle.match(/\bversionCode\s+(\d+)/)?.[1] === versionCode, `Android versionCode must equal ${versionCode} for ${version}.`);
  requireThat(notes || dryRun, '--notes <path> is required for publication.');
  if (notes) requireThat(existsSync(notes) && statSync(notes).isFile() && readFileSync(notes, 'utf8').trim(), '--notes must name a nonempty readable file.');
  else log('DRY RUN: no notes supplied; publication requires --notes <path>.');
  const signing = join(homedir(), '.local/state/linubot-android-signing');
  const keystore = join(signing, 'release.keystore'), passwordFile = join(signing, 'password');
  requireThat(existsSync(keystore) && statSync(keystore).size > 0, `Missing Android signing keystore: ${keystore}`);
  requireThat(existsSync(passwordFile) && readFileSync(passwordFile, 'utf8').trim(), `Missing or empty Android signing password file: ${passwordFile}`);
  const sdk = process.env.ANDROID_HOME || join(homedir(), 'Android/Sdk');
  for (const tool of ['zipalign', 'apksigner']) requireThat(existsSync(join(sdk, 'build-tools/36.0.0', tool)), `Missing Android build tool ${tool}; set ANDROID_HOME to the prepared SDK.`);
  for (const command of ['npm', 'npx', 'tar', 'unzip', 'dpkg-deb', 'curl', ...(!process.env.DISPLAY ? ['xvfb-run', 'Xvfb', 'xauth'] : [])]) {
    requireThat(process.env.PATH.split(':').some((dir) => existsSync(join(dir, command))), `Required command is missing from PATH: ${command}`);
  }
  const names = [`linubot-${version}-amd64.deb`, `linubot-${version}-x64.tar.gz`, `linubot-${version}-android.apk`, 'SHA256SUMS'];
  if (dryRun) {
    log('2/6 Would run typecheck, npm test, package:linux, packaged Playwright (Xvfb if DISPLAY is absent), signed Android build, release:artifacts.');
    log('3/6 Would download and checksum Gitleaks 8.30.1, scan tracked files and all Git history, and remove temporary files.');
    log('4/6 Would compare ASAR source/dist, Debian/tar/unpacked payload hashes and decompressed APK home-path contents.');
    log(`5/6 Would tag and push ${tag}, upload a draft with ${names.join(', ')}, verify asset sizes and SHA-256 digests, then publish as latest.`);
    log('6/6 No local installation changes. Dry run passed.');
  } else {
    temporary = mkdtempSync(join(tmpdir(), 'linubot-release-'));
    const notesHash = fileHash(notes);
    if (resume) {
      requireThat(receipt.notesHash === notesHash, 'Release notes differ from the verified receipt.');
      requireThat(JSON.stringify(receipt.assets?.map((asset) => asset.name)) === JSON.stringify(names), 'Release receipt asset list does not match this version.');
      for (const asset of receipt.assets) requireThat(statSync(join('release', asset.name)).size === asset.size && fileHash(join('release', asset.name)) === asset.sha256, `Recorded asset changed: ${asset.name}. Refusing to resume.`);
      log('2-4/6 Reusing tested and scanned assets from the verified receipt; all local hashes match.');
    } else {
      log('2/6 Build and acceptance tests');
      // Do not carry obsolete generated files into an otherwise clean release.
      for (const directory of ['dist', 'release/linux-unpacked']) rmSync(directory, { recursive: true, force: true });
      for (const name of names) rmSync(join('release', name), { force: true });
      for (const task of ['typecheck', 'test', 'package:linux']) { log(`npm run ${task}`); run('npm', ['run', task]); }
      const desktopEnv = { ...process.env, LINUBOT_TEST_EXECUTABLE: join(root, 'release/linux-unpacked/linubot'), WAYLAND_DISPLAY: '', XDG_SESSION_TYPE: 'x11' };
      delete desktopEnv.ELECTRON_RUN_AS_NODE;
      log('Packaged desktop suite');
      if (process.env.DISPLAY) run('npx', ['playwright', 'test'], { env: desktopEnv });
      else run('xvfb-run', ['--auto-servernum', '--server-args=-screen 0 1920x1080x24', 'npx', 'playwright', 'test'], { env: desktopEnv });
      log('Signed Android build (password passed only in the child environment)');
      run('bash', ['scripts/build-android.sh'], { env: { ...process.env, ANDROID_HOME: sdk, LINUBOT_ANDROID_KEYSTORE: keystore, LINUBOT_ANDROID_STORE_PASSWORD: readFileSync(passwordFile, 'utf8').trimEnd() } });
      run('npm', ['run', 'release:artifacts']);

      log('3/6 Gitleaks 8.30.1: tracked tree and all Git history');
      const archive = 'gitleaks_8.30.1_linux_x64.tar.gz', checksums = 'gitleaks_8.30.1_checksums.txt';
      for (const name of [archive, checksums]) run('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '180', `https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/${name}`, '-o', join(temporary, name)]);
      const expected = readFileSync(join(temporary, checksums), 'utf8').split('\n').map((line) => line.trim().split(/\s+/)).filter(([, name]) => name === archive);
      requireThat(expected.length === 1 && expected[0][0] === fileHash(join(temporary, archive)), 'Gitleaks download SHA-256 verification failed.');
      run('tar', ['-xzf', join(temporary, archive), '-C', temporary, 'gitleaks']);
      const tracked = join(temporary, 'tracked'); mkdirSync(tracked);
      for (const file of git('ls-files', '-z').split('\0').filter(Boolean)) {
        const destination = join(tracked, file); mkdirSync(dirname(destination), { recursive: true });
        if (lstatSync(file).isSymbolicLink()) writeFileSync(destination, readlinkSync(file));
        else copyFileSync(file, destination);
      }
      run(join(temporary, 'gitleaks'), ['dir', tracked, '--redact', '--no-banner']);
      run(join(temporary, 'gitleaks'), ['git', root, '--log-opts=--all', '--redact', '--no-banner']);

      log('4/6 Artifact integrity');
      const appAsar = 'release/linux-unpacked/resources/app.asar';
      requireThat(JSON.parse(asar.extractFile(appAsar, 'package.json').toString()).version === version, 'ASAR package.json version differs from the working tree.');
      const dist = filesUnder('dist');
      requireThat(dist.length > 0, 'dist/ is empty.');
      const archivedDist = asar.listPackage(appAsar).map((path) => path.replace(/^\//, '')).filter((path) => path.startsWith('dist/') && !asar.statFile(appAsar, path).files).sort();
      requireThat(JSON.stringify(dist) === JSON.stringify(archivedDist), 'ASAR dist/ file list differs from the working tree.');
      const fixed = ['desktop/main.cjs', 'desktop/icon.png', 'desktop/linubot-chrome.sh', 'web/index.html', 'web/updates.js', 'LICENSE', 'NOTICE'];
      for (const path of [...fixed, ...dist]) requireThat(hash(asar.extractFile(appAsar, path)) === fileHash(path), `ASAR differs from working tree: ${path}`);
      const deb = join(temporary, 'deb'), tar = join(temporary, 'tar'); mkdirSync(tar);
      run('dpkg-deb', ['-x', join('release', names[0]), deb]);
      run('tar', ['-xzf', join('release', names[1]), '-C', tar]);
      const debAsars = filesUnder(deb).filter((path) => path.endsWith('/resources/app.asar'));
      requireThat(debAsars.length === 1, 'Debian package must contain exactly one application ASAR.');
      const debRoot = dirname(dirname(debAsars[0]));
      for (const path of ['linubot', 'resources/app.asar', 'resources/workspace/agent-workspace-linux', 'resources/install.sh']) {
        const expectedHash = fileHash(join('release/linux-unpacked', path));
        requireThat(fileHash(join(debRoot, path)) === expectedHash && fileHash(join(tar, path)) === expectedHash, `Debian/tar/unpacked payload mismatch: ${path}`);
      }
      requireThat(fileHash('release/linux-unpacked/resources/install.sh') === fileHash('install.sh'), 'Packaged installer differs from the working tree.');
      const apk = join('release', names[2]);
      const expandedApk = run('unzip', ['-p', apk], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
      requireThat(!readFileSync(apk).includes(Buffer.from(homedir())) && !expandedApk.includes(Buffer.from(homedir())), 'APK contains the builder home directory path.');
      const assets = names.map((name) => ({ name, size: statSync(join('release', name)).size, sha256: fileHash(join('release', name)) }));
      for (const asset of assets.slice(0, 3)) requireThat(readFileSync('release/SHA256SUMS', 'utf8').split('\n').includes(`${asset.sha256}  ${asset.name}`), `SHA256SUMS does not match ${asset.name}.`);
      requireThat(!git('status', '--porcelain') && git('rev-parse', 'HEAD') === head, 'Build or tests changed the source tree or HEAD.');
      writeFileSync(`${receiptPath}.tmp`, JSON.stringify({ version, head, notesHash, assets }, null, 2) + '\n', { mode: 0o600 });
      renameSync(`${receiptPath}.tmp`, receiptPath);
    }
    log('5/6 Publish verified assets');
    run('git', ['fetch', 'origin', 'main']);
    requireThat(git('rev-parse', 'origin/main') === head && git('rev-parse', 'HEAD') === head && !git('status', '--porcelain'), 'main or the working tree changed during release validation.');
    if (!tagged) run('git', ['tag', tag, head]);
    run('git', ['push', 'origin', `refs/tags/${tag}:refs/tags/${tag}`]);
    // A successful list distinguishes a missing draft from an API/auth failure.
    const releases = JSON.parse(output('gh', ['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`])).flat();
    let release = releases.find((item) => item.tag_name === tag);
    if (!release) {
      run('gh', ['release', 'create', tag, '--repo', repository, '--verify-tag', '--draft', '--title', tag, '--notes-file', notes]);
      release = JSON.parse(output('gh', ['api', `repos/${repository}/releases/tags/${tag}`]));
    } else requireThat(resume, `A release for ${tag} already exists; use --resume with the verified receipt.`);
    const verified = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (release.draft) {
      run('gh', ['release', 'edit', tag, '--repo', repository, '--notes-file', notes]);
      run('gh', ['release', 'upload', tag, ...names.map((name) => join('release', name)), '--repo', repository, '--clobber']);
    }
    const readBack = () => JSON.parse(output('gh', ['api', `repos/${repository}/releases/${release.id}`]));
    const verifyAssets = (remoteRelease) => {
      requireThat(!remoteRelease.prerelease && remoteRelease.assets.length === verified.assets.length, 'Release must be stable and contain exactly the four expected assets.');
      for (const local of verified.assets) {
        const remoteAsset = remoteRelease.assets.find((asset) => asset.name === local.name);
        requireThat(remoteAsset?.state === 'uploaded' && remoteAsset.size === local.size && remoteAsset.digest === `sha256:${local.sha256}`, `Release asset size/SHA-256 verification failed: ${local.name}. Draft will not be published.`);
      }
    };
    verifyAssets(readBack());
    run('gh', ['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest']);
    const published = readBack(); verifyAssets(published);
    requireThat(!published.draft && JSON.parse(output('gh', ['api', `repos/${repository}/releases/latest`])).id === published.id, 'Publication/latest readback failed.');
    log('6/6 Release published. Local installation was not changed.');
    console.log(published.html_url);
  }
} catch (error) {
  // Child environments may contain signing credentials; do not dump error objects.
  console.error(`[release] FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
