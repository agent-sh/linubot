#!/usr/bin/env node
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as asar from '@electron/asar';

const repository = 'agent-sh/linubot';
const log = (message) => console.log(`[release] ${message}`);
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const run = (command, args = [], options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const output = (command, args = [], options = {}) => run(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...options }).trim();
const git = (...args) => output('git', args);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileHash = (path) => hash(readFileSync(path));
const filesUnder = (path) => readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesUnder(join(path, entry.name)) : [join(path, entry.name)]).sort();
export const assetNames = (version) => [`linubot-${version}-amd64.deb`, `linubot-${version}-x64.tar.gz`, `linubot-${version}-android.apk`, 'SHA256SUMS'];

// PR12 deliberately excludes compiler maps from the shipped application. Remove
// only those ignored generated maps before comparing every remaining dist file.
export function prepareReleaseDist() {
  const { build } = JSON.parse(readFileSync('package.json', 'utf8'));
  if (build?.files?.some((pattern) => ['!**/*.{map,ts,tsx,mts,cts}', '!**/*.map'].includes(pattern))) {
    const maps = filesUnder('dist').filter((path) => path.endsWith('.map'));
    for (const path of maps) rmSync(path);
    log(`Removed ${maps.length} generated source maps excluded by the package configuration.`);
  }
}

// Inspect archive-restored modes, not whether the builder can read its own files.
export function verifyPayloadModes(root) {
  const visit = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    const required = stat.isDirectory() ? 0o005 : 0o004;
    requireThat((stat.mode & required) === required, `Package permissions deny ordinary users access: ${path} (mode ${(stat.mode & 0o7777).toString(8)})`);
    if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
  };
  visit(root);
}

// Preserve Markdown whitespace and blank lines. Only supply a missing final LF.
export const canonicalNotes = (bytes) => bytes.at(-1) === 10 ? bytes : Buffer.concat([bytes, Buffer.from('\n')]);
export function readTagNotes(tag) {
  const object = run('git', ['cat-file', 'tag', tag], { stdio: ['ignore', 'pipe', 'pipe'] });
  const separator = object.indexOf(Buffer.from('\n\n'));
  requireThat(separator !== -1, `Annotated tag ${tag} has no message separator.`);
  return object.subarray(separator + 2);
}
export function ensureReleaseTag(tag, head, notes, tagged) {
  const bytes = canonicalNotes(readFileSync(notes));
  if (!tagged) run('git', ['tag', '-a', tag, head, '--cleanup=verbatim', '-F', '-'], { input: bytes, stdio: ['pipe', 'inherit', 'inherit'] });
  else requireThat(canonicalNotes(readTagNotes(tag)).equals(bytes), 'Existing tag notes differ from the requested release notes.');
}

export function verifyArtifacts(version, temporary) {
  const names = assetNames(version);
  const appAsar = 'release/linux-unpacked/resources/app.asar';
  requireThat(JSON.parse(asar.extractFile(appAsar, 'package.json').toString()).version === version, 'ASAR package.json version differs from the working tree.');
  const dist = filesUnder('dist');
  requireThat(dist.length > 0, 'dist/ is empty.');
  const archivedDist = asar.listPackage(appAsar).map((path) => path.replace(/^\//, '')).filter((path) => path.startsWith('dist/') && !asar.statFile(appAsar, path).files).sort();
  requireThat(JSON.stringify(dist) === JSON.stringify(archivedDist), 'ASAR dist/ file list differs from the working tree.');
  const fixed = ['desktop/main.cjs', 'desktop/icon.png', 'web/index.html', 'web/updates.js', 'LICENSE', 'NOTICE'];
  for (const path of [...fixed, ...dist]) requireThat(hash(asar.extractFile(appAsar, path)) === fileHash(path), `ASAR differs from working tree: ${path}`);
  const deb = join(temporary, 'deb'), tar = join(temporary, 'tar'); mkdirSync(tar);
  run('dpkg-deb', ['-x', join('release', names[0]), deb]);
  run('tar', ['-xzf', join('release', names[1]), '-C', tar]);
  for (const root of [deb, tar, 'release/linux-unpacked']) verifyPayloadModes(root);
  const debAsars = filesUnder(deb).filter((path) => path.endsWith('/resources/app.asar'));
  requireThat(debAsars.length === 1, 'Debian package must contain exactly one application ASAR.');
  const debRoot = dirname(dirname(debAsars[0]));
  for (const path of ['linubot', 'resources/app.asar', 'resources/workspace/agent-workspace-linux', 'resources/install.sh', 'resources/linubot-chrome.sh']) {
    const expectedHash = fileHash(join('release/linux-unpacked', path));
    requireThat(fileHash(join(debRoot, path)) === expectedHash && fileHash(join(tar, path)) === expectedHash, `Debian/tar/unpacked payload mismatch: ${path}`);
  }
  requireThat(fileHash('release/linux-unpacked/resources/install.sh') === fileHash('install.sh'), 'Packaged installer differs from the working tree.');
  requireThat(fileHash('release/linux-unpacked/resources/linubot-chrome.sh') === fileHash('desktop/linubot-chrome.sh'), 'Packaged Chrome wrapper differs from the working tree.');
  const apk = join('release', names[2]);
  const expandedApk = run('unzip', ['-p', apk], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  requireThat(!readFileSync(apk).includes(Buffer.from(homedir())) && !expandedApk.includes(Buffer.from(homedir())), 'APK contains the builder home directory path.');
  const assets = names.map((name) => ({ name, size: statSync(join('release', name)).size, sha256: fileHash(join('release', name)) }));
  for (const asset of assets.slice(0, 3)) requireThat(readFileSync('release/SHA256SUMS', 'utf8').split('\n').includes(`${asset.sha256}  ${asset.name}`), `SHA256SUMS does not match ${asset.name}.`);
  return assets;
}

export function verifyPublishedManifest(release, version, manifest) {
  const names = assetNames(version);
  requireThat(!release.draft && !release.prerelease && release.assets.length === names.length, 'Published release must contain exactly four stable assets.');
  for (const name of names) {
    const asset = release.assets.find((item) => item.name === name);
    requireThat(asset?.state === 'uploaded' && asset.size > 0 && /^sha256:[a-f0-9]{64}$/.test(asset.digest), `Published asset is incomplete: ${name}`);
    if (name === 'SHA256SUMS') requireThat(asset.size === manifest.length && asset.digest === `sha256:${hash(manifest)}`, 'Published checksum manifest size/digest mismatch.');
    else requireThat(manifest.toString().split('\n').includes(`${asset.digest.slice(7)}  ${name}`), `Published checksum entry mismatch: ${name}`);
  }
}

export function checkPublicationRef({ hosted, branch, head, mainHead, tag, tagHead, onMain, eventName, eventRef, eventSha }) {
  if (hosted) {
    requireThat(eventName === 'push' && eventRef === `refs/tags/${tag}` && eventSha === head, 'Hosted publication requires the exact version-tag push event and commit.');
    requireThat(tagHead === head && onMain, 'Release tag must point to this commit on origin/main.');
  } else {
    requireThat(branch === 'main', 'Release builds must run on main.');
    requireThat(head === mainHead, 'Local main differs from origin/main. Sync main before releasing.');
  }
}

export function main(args = process.argv.slice(2)) {
  const dryRun = args.includes('--dry-run');
  const hosted = args.includes('--github-release');
  const buildOnly = args.includes('--build-only');
  const resume = args.includes('--resume');
  let notes;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--notes') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--notes requires a file path.');
      notes = resolve(args[++i]);
    } else if (!['--dry-run', '--resume', '--github-release', '--build-only'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
  }
  const previousUmask = process.umask(0o022);
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
    requireThat(!git('status', '--porcelain'), 'The working tree must be clean, including untracked files.');
    const remote = git('remote', 'get-url', 'origin');
    requireThat(/^(https:\/\/github\.com\/|git@github\.com:)agent-sh\/linubot(?:\.git)?$/.test(remote), 'origin must point to agent-sh/linubot on GitHub.');
    run('git', ['fetch', 'origin', 'main', '--tags']);
    const head = git('rev-parse', 'HEAD');
    run('gh', ['auth', 'status']);
    const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
    requireThat(/^\d+\.\d+\.\d+$/.test(version), 'package.json must contain a stable MAJOR.MINOR.PATCH version.');
    const tag = `v${version}`;
    requireThat(!buildOnly || (!hosted && !resume), '--build-only cannot publish or reuse a publication receipt.');
    requireThat(!hosted || process.env.GITHUB_ACTIONS === 'true', '--github-release is reserved for the tag workflow.');
    requireThat(buildOnly || hosted || process.env.GITHUB_ACTIONS !== 'true', 'Actions must use --github-release; the workflow never creates tags.');
    requireThat(!hosted || !resume, 'Hosted reruns rebuild the tag; --resume is local only.');
    if (!buildOnly) checkPublicationRef({ hosted, branch: git('branch', '--show-current'), head, mainHead: git('rev-parse', 'origin/main'), tag,
      tagHead: hosted ? git('rev-parse', `${tag}^{commit}`) : undefined,
      onMain: hosted ? Boolean(git('branch', '-r', '--contains', head).split('\n').some((line) => line.trim() === 'origin/main')) : false,
      eventName: process.env.GITHUB_EVENT_NAME, eventRef: process.env.GITHUB_REF, eventSha: process.env.GITHUB_SHA });
    if (hosted) requireThat(git('ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`).split('\n').some((line) => line === `${head}\trefs/tags/${tag}^{}`), 'Remote annotated tag no longer matches the event commit.');
    const receiptPath = resolve(`release/.release-${version}.json`);
    const receipt = resume && existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : undefined;
    if (resume) requireThat(receipt?.head === head && receipt?.version === version, '--resume requires a verified release receipt for this exact main HEAD and version.');
    const tagged = Boolean(git('tag', '-l', tag));
    if (buildOnly) log(`BUILD ONLY: branch ${git('branch', '--show-current') || '(detached)'}; existing version tags are allowed. No tag or release writes.`);
    else if (hosted) requireThat(tagged && git('cat-file', '-t', tag) === 'tag', 'Hosted releases require an existing annotated tag with release notes.');
    else if (tagged && dryRun) log(`DRY RUN: skipping version-not-tagged check (${tag} already exists).`);
    else if (tagged && resume) {
      requireThat(git('rev-parse', `${tag}^{commit}`) === head, `${tag} does not point to the recorded release HEAD.`);
      log(`Resuming the recorded tag request of ${tag}.`);
    } else requireThat(!tagged, `${tag} already exists. Bump the version, or use --resume with this release's verified receipt.`);
    const gradle = readFileSync('android/app/build.gradle', 'utf8');
    requireThat(gradle.match(/\bversionName\s+['"]([^'"]+)['"]/)?.[1] === version, `Android versionName must equal ${version}.`);
    const versionCode = version.replaceAll('.', '') + '0';
    requireThat(gradle.match(/\bversionCode\s+(\d+)/)?.[1] === versionCode, `Android versionCode must equal ${versionCode} for ${version}.`);
    if (hosted) {
      temporary = mkdtempSync(join(tmpdir(), 'linubot-release-'));
      notes = join(temporary, 'notes.md');
      writeFileSync(notes, canonicalNotes(readTagNotes(tag)));
    }
    requireThat(notes || dryRun || buildOnly, '--notes <path> is required for publication.');
    if (notes) requireThat(existsSync(notes) && statSync(notes).isFile() && readFileSync(notes, 'utf8').trim(), '--notes must name a nonempty readable file.');
    else if (!buildOnly) log('DRY RUN: no notes supplied; publication requires --notes <path>.');
    const signing = join(homedir(), '.local/state/linubot-android-signing');
    const keystore = join(signing, 'release.keystore'), passwordFile = join(signing, 'password');
    requireThat(existsSync(keystore) && statSync(keystore).size > 0, `Missing Android signing keystore: ${keystore}`);
    requireThat(existsSync(passwordFile) && readFileSync(passwordFile, 'utf8').trim(), `Missing or empty Android signing password file: ${passwordFile}`);
    const sdk = process.env.ANDROID_HOME || join(homedir(), 'Android/Sdk');
    for (const tool of ['zipalign', 'apksigner']) requireThat(existsSync(join(sdk, 'build-tools/36.0.0', tool)), `Missing Android build tool ${tool}; set ANDROID_HOME to the prepared SDK.`);
    for (const command of ['npm', 'npx', 'tar', 'unzip', 'dpkg-deb', 'curl', ...(!process.env.DISPLAY ? ['xvfb-run', 'Xvfb', 'xauth'] : [])]) {
      requireThat(process.env.PATH.split(':').some((dir) => existsSync(join(dir, command))), `Required command is missing from PATH: ${command}`);
    }
    const names = assetNames(version);
    if (hosted && !dryRun) {
      const releases = JSON.parse(output('gh', ['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`])).flat();
      const published = releases.find((item) => item.tag_name === tag && !item.draft);
      if (published) {
        const manifest = published.assets.find((asset) => asset.name === 'SHA256SUMS');
        requireThat(manifest, 'Published release is missing SHA256SUMS.');
        const bytes = run('gh', ['api', `repos/${repository}/releases/assets/${manifest.id}`, '-H', 'Accept: application/octet-stream'], { stdio: ['ignore', 'pipe', 'pipe'] });
        verifyPublishedManifest(published, version, bytes);
        log('Release is already published and its manifest matches all asset digests. No release or latest state changed.');
        console.log(published.html_url);
        return;
      }
    }
    if (dryRun) {
      log('2/6 Would run typecheck, npm test, package:linux, packaged Playwright (Xvfb if DISPLAY is absent), signed Android build, release:artifacts.');
      log('3/6 Would download and checksum Gitleaks 8.30.1, scan tracked files and all Git history, and remove temporary files.');
      log('4/6 Would compare ASAR source/dist, Debian/tar/unpacked payload hashes and decompressed APK home-path contents.');
      log(buildOnly ? '5/6 Would stop after verified artifacts; no tag, push or release writes.' : hosted ? `5/6 Would upload ${names.join(', ')} to the tag's draft, verify size/SHA-256, then publish as latest.` : `5/6 Would push annotated ${tag} with release notes. The hosted tag workflow alone builds and publishes; this command never uploads releases.`);
      log('6/6 No local installation changes. Dry run passed.');
    } else {
      temporary ||= mkdtempSync(join(tmpdir(), 'linubot-release-'));
      const notesHash = notes ? hash(canonicalNotes(readFileSync(notes))) : undefined;
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
        prepareReleaseDist();
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
        const assets = verifyArtifacts(version, temporary);
        requireThat(!git('status', '--porcelain') && git('rev-parse', 'HEAD') === head, 'Build or tests changed the source tree or HEAD.');
        if (buildOnly) {
          log('5-6/6 BUILD ONLY passed. Tested artifacts are in release/. No tag, push, draft, upload or publication was attempted.');
          console.log(JSON.stringify({ head, version, assets }, null, 2));
          return;
        }
        writeFileSync(`${receiptPath}.tmp`, JSON.stringify({ version, head, notesHash, assets }, null, 2) + '\n', { mode: 0o600 });
        renameSync(`${receiptPath}.tmp`, receiptPath);
      }
      log(hosted ? '5/6 Publish verified assets' : '5/6 Request hosted publication');
      run('git', ['fetch', 'origin', 'main']);
      requireThat(git('rev-parse', 'HEAD') === head && !git('status', '--porcelain'), 'The working tree changed during validation.');
      if (!hosted) {
        requireThat(git('rev-parse', 'origin/main') === head, 'origin/main changed during validation.');
        ensureReleaseTag(tag, head, notes, tagged);
        run('git', ['push', 'origin', `refs/tags/${tag}:refs/tags/${tag}`]);
        log('6/6 Tag request pushed. Only the tag workflow publishes. If already pushed, rerun its failed Actions run; pushing an unchanged tag creates no new event.');
        console.log(`https://github.com/${repository}/actions/workflows/release.yml`);
        return;
      }
      requireThat(git('ls-remote', 'origin', `refs/tags/${tag}^{}`).startsWith(`${head}\t`), 'Remote release tag changed during validation.');
      // A successful list distinguishes a missing draft from an API/auth failure.
      const releases = JSON.parse(output('gh', ['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`])).flat();
      let release = releases.find((item) => item.tag_name === tag);
      if (!release) {
        run('gh', ['release', 'create', tag, '--repo', repository, '--verify-tag', '--draft', '--title', tag, '--notes-file', notes]);
        release = JSON.parse(output('gh', ['api', `repos/${repository}/releases/tags/${tag}`]));
      }
      requireThat(release.draft, `Release ${tag} is already published; refusing to replace public assets.`);
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
    process.umask(previousUmask);
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }

}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
