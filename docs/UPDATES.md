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
failure after the app exits requires rerunning the installer; it cannot appear
in the closed window.

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

On the qualified Linux x64 build machine, from clean `main` equal to
`origin/main`, with Node.js 24+, installed npm dependencies, GitHub CLI auth,
JDK 17, Android SDK (including build-tools 36.0.0 and compile SDK 37), uv/uvx
and the packaging/display tools described in [installation](INSTALLATION.md):

```sh
node scripts/release.mjs --dry-run
npm run release -- --notes /path/to/release-notes.md
```

Set `ANDROID_HOME` if the SDK is not at `~/Android/Sdk`. Signing uses
`~/.local/state/linubot-android-signing/release.keystore` and the nonempty
`password` file beside it, with alias `linubot`. Keep both files private and
outside Git. The password is passed only through the Android child environment.
Release notes are required for publication. Dry run checks prerequisites and
prints the plan without building, tagging, publishing or installing; it fetches
Git refs and checks GitHub auth. It explicitly skips an existing version tag and
allows omitted notes. All other prerequisites still apply, including main and
a clean tree.

The release command runs typecheck, source tests, Linux packaging, the packaged
Playwright suite (starting and stopping Xvfb on a free display if needed), signed
Android tests/build/lint, and artifact generation. It verifies the downloaded
Gitleaks 8.30.1 checksum and requires clean tracked-tree and all-history scans.
It compares the ASAR version, fixed desktop/web/license files and every `dist/`
file with the working tree, compares key Debian/tar/unpacked payload hashes, and
checks raw and decompressed APK contents for the builder's home directory path.
Temporary scan/extraction files are removed even on failure.

Only then does it create and push `vVERSION`, upload a draft containing the
Debian package, Linux tarball, signed Android APK and `SHA256SUMS`, and verify all
four GitHub asset sizes and SHA-256 digests. It publishes as latest only after
that readback succeeds. It never changes the local installation.

A normal invocation rejects an existing tag. If publication is interrupted,
retain the ignored `release/.release-VERSION.json` receipt and the four local
assets, then rerun with the same notes and `--resume`. Resume requires the same
clean main commit, version, notes hash and asset hashes. It reuses already tested
bytes, safely replaces draft uploads, and verifies even an already published
release before confirming latest. A changed main, missing receipt or changed
artifact fails closed; do not delete a published tag to bypass that check.

The manually dispatched **release** GitHub workflow runs this same command from
main on a dedicated self-hosted Linux x64 runner labeled `linubot-release`, using
the `release` environment. Provision the qualified Ubuntu 26.04 desktop/build
libraries, Xvfb/xauth, curl, tar, unzip, dpkg-deb, GitHub CLI, SDK/JDK, signing
files and uv/uvx on that runner. Configure environment reviewers as appropriate.
The workflow accepts Markdown notes and an optional resume switch. It preserves
ignored artifacts between attempts, serializes releases, and never installs or
restarts the builder's desktop. Do not assign the label to the owner's live app
machine. PR CI remains the source/fixture gate; it does not publish releases.

To install after publication, use the explicit `--stage-only` then
`--activate-only` commands in [installation](INSTALLATION.md). Existing releases
through 2.11.0 contain the older updater and installer, so the first upgrade from
those versions still follows their old Electron relaunch path. Run the fresh
installer explicitly to register supervision immediately; subsequent in-app
upgrades from this implementation use the unit restart path.

Test a candidate on its documented Linux/glibc baseline and exercise upgrade
behavior in an isolated profile. Source fixture CI does not qualify bundled
binaries for older distributions. See [validation](VALIDATION.md).
