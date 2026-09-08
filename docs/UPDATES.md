# Updates

Linubot checks the project's latest stable GitHub release on startup and every
15 minutes while the interface is open, and when you return to the app.
Settings also has **Check for updates**, the installed version, last check time
and any connection error. Foreground/manual checks are limited to once a minute.
Failed background checks retry after a minute. A newer version appears as **Upgrade to
VERSION** in the sidebar when a matching Linux archive and checksum file are
available. Drafts and prereleases are excluded.

The check reads public release metadata. It does not upload conversations,
credentials or usage records. It does not install anything automatically. If
GitHub cannot be reached, conversations continue normally. Set
`LINUBOT_UPDATE_CHECK=0` before launching the desktop to disable release checks.

## Upgrade a managed user installation

For the standard user installation under `~/.local/opt`:

1. Finish active tasks, evaluations and scheduled work.
2. Click the sidebar upgrade button and confirm **Download and restart**.
3. Linubot stages the release and verifies its checksum.
4. If the app is still idle, it freezes new work and schedules activation.
5. A helper waits for the old desktop process to exit, then runs the staged
   release's `install.sh --version VERSION --activate-only`. The installer switches
   the active version and restarts `linubot.service` when user systemd is available,
   or launches the app directly otherwise.

The updater checks for active work before and after downloading. If new work
started during the download, the update remains staged and you can retry after
that work finishes. Activation blocks new task admission while the app restarts.
Your data directory, bots, sessions and provider settings remain separate from
the replaced application files.

With systemd, the activation helper runs in a separate `linubot-update-PID`
unit so stopping the desktop does not kill the installer. Its output is in the
user journal. Without systemd, helper output goes to `update-install.log` in
the app data directory. If shutdown takes more than two minutes, activation
is abandoned and the version remains staged for a manual retry. An activation
failure after the app exits cannot appear in the closed window. If integration
or service activation fails, the installer restores the previous active version
and its integration files, then attempts to restart that version. The candidate
stays staged for retry. A failure of the recovery start is reported in the helper
log; the old version remains selected for an explicit retry.

If downloading or verification fails, the current installation remains selected.
Previous version directories are retained; they are not automatically deleted.

## Other installation methods

For Debian packages, development launches, installer `--build` source builds and
custom installation paths, the button opens the release page. Update with the
same package manager or rebuild process used to install the app. Source builds
are not silently replaced with downloaded binaries. The desktop does not run
sudo or modify a system package installation.

You can also close Linubot and rerun the [installer](../install.sh):

```sh
bash /tmp/linubot-install.sh --launch
```

Download a fresh copy using the [installation guide](INSTALLATION.md) if needed.
Use `--version VERSION` to select a particular stable release, or add `--build`
to build that tag from source. Keep `--build` when updating an installation you
want to compile locally. Older application versions may not understand
data formats introduced later; keep a backup before intentionally downgrading.

## Release checks for maintainers

Automatic availability requires a stable `vMAJOR.MINOR.PATCH` tag, the matching
`linubot-VERSION-x64.tar.gz` asset and a `SHA256SUMS` entry with its SHA-256 digest.
The archive must contain the Linux executable, `resources/app.asar`, the
application icon and the required runtime/license files at the expected paths.
The Debian installer is a separate distribution artifact. Releases also include
a signed Android APK; install a newer APK on Android to update that client.
The Linux upgrade button updates the Linux application only.

The local release command and the tag workflow share build and integrity gates.
Only the hosted workflow publishes releases. From clean `main` equal to
`origin/main`, with Node.js 24+, a real `npm ci` dependency directory, GitHub CLI
auth, JDK 17, Android SDK (build-tools 36.0.0 and platform 37), uv/uvx 0.11.7 and
the Linux packaging/display prerequisites:

```sh
node scripts/release.mjs --dry-run
npm run release -- --notes /path/to/release-notes.md
```

The local command runs typecheck, source tests, Linux packaging, the packaged
Playwright suite, signed Android tests/build/lint, artifact generation, pinned
Gitleaks 8.30.1 scans of tracked files and all Git history, and integrity checks.
Without DISPLAY it starts and stops Xvfb on a free display. It checks every
shipped `dist/` file plus fixed ASAR desktop/web/license files. If the package
configuration explicitly excludes source maps, it first removes those generated
maps from `dist/`. The external Chrome wrapper is checked against source and
across the unpacked, Debian and tar payloads, together with the executable,
ASAR, workspace binary and installer. APK bytes and decompressed contents must
not contain the builder's home directory path.

After those gates pass, the local command creates an annotated `vVERSION` tag
whose message is the supplied notes, then pushes only that tag. The tag push
starts the hosted workflow, which rebuilds and revalidates the exact tagged
commit, uploads four assets to a draft, verifies GitHub sizes and SHA-256
digests, and publishes as latest. Local artifacts are evidence from the local
build; the workflow publishes its own independently checked build. There is no
local release upload or second publisher. The workflow never creates or pushes
a tag, so its token cannot recursively trigger publication.

The tag must match package and Android versions, point to a commit on
`origin/main`, and match the event SHA and current remote tag. Hosted checkout
may be detached and main may advance while the tagged run is queued. Local
requests still require synchronized main and reject an existing tag. Use a
normal owner-authenticated local Git push: a push using Actions' `GITHUB_TOKEN`
does not trigger another push workflow. See [GitHub's trigger documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

An interrupted local tag request can use `--resume` with its ignored
`release/.release-VERSION.json` receipt, unchanged artifacts and the same notes.
Once the tag is remote, pushing it again creates no event; rerun its failed
Actions job. Hosted reruns rebuild and replace only draft assets. A completed
release is read back against its checksum manifest and left unchanged, including
its latest status. No mode changes the local installation.

### Validate an integration branch without publication

After committing the assembled candidate and installing dependencies with
`npm ci`, run from its repository root:

```sh
node scripts/release.mjs --build-only
```

This permits any clean branch or detached commit and an already existing version
tag. It needs the same SDK, signing files and build tools, but no notes. It runs
all build/test/scan/integrity gates, prints the commit and four asset hashes, then
exits before any tag, push, release, upload or publication write. It does fetch
Git refs and check GitHub auth. `--build-only --dry-run` checks prerequisites and
prints the plan. Do not package through a shared node_modules symlink: use a
clean dependency installation in the assembled candidate.

### Hosted runner and signing configuration

The tag workflow uses GitHub-hosted `ubuntu-24.04`, the existing CI's pinned
Node setup and JDK 17 setup actions, and the hosted Android SDK with platform 37
and build-tools 36.0.0 installed explicitly. It installs desktop/package tools
and uv/uvx 0.11.7. No custom runner label or GitHub environment is needed.

Before the first real tag run, an owner must authorize provisioning these
repository Actions secrets from the existing signing material:

- `LINUBOT_ANDROID_KEYSTORE_BASE64`: base64 of the existing
  `~/.local/state/linubot-android-signing/release.keystore`.
- `LINUBOT_ANDROID_STORE_PASSWORD`: contents of the existing adjacent `password`
  file. The signing alias remains `linubot`; do not generate a replacement key.

The job writes private temporary signing files with umask 077, passes the
password only through the Android child environment, and removes signing files
on exit and in an always-run cleanup step. Never print secret values. Locally,
the same signing directory is used directly; set `ANDROID_HOME` if the SDK is
not at `~/Android/Sdk`.

The reviewed repository inventory had Actions enabled, zero self-hosted runners,
and neither signing secret configured. The hosted workflow configuration has
not yet had a real release run. Local fixtures and a composed package are not
proof of hosted execution or hosted Android signing. Provisioning secrets,
creating a release tag and running the workflow remain separate owner actions.

Use the explicit `--stage-only` then `--activate-only` installer commands in
[installation](INSTALLATION.md) after publication. Existing releases through
2.11.0 contain the older updater; their first upgrade follows the older Electron
relaunch path. A fresh installer registers supervision immediately, and updates
from this implementation use the unit restart path. See [validation](VALIDATION.md).
