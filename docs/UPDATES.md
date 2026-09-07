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
4. If the app is still idle, it switches the active version and restarts.

The updater checks for active work before and after downloading. If new work
started during the download, the update remains staged and you can retry after
that work finishes. Activation blocks new task admission while the app restarts.
Your data directory, bots, sessions and provider settings remain separate from
the replaced application files.

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

On the qualified Linux x64 build machine:

```sh
npm run package:linux
npm run release:artifacts
```

The second command packages the existing unpacked build and writes
`release/linubot-VERSION-x64.tar.gz` plus `release/SHA256SUMS`, covering both the
archive and Debian installer. It does not publish a release. Publish the exact
tested files together on the matching GitHub release; keep the checksum manifest
consistent with those bytes.

Test a candidate on its documented Linux/glibc baseline, verify its package
contents, and exercise upgrade behavior in an isolated user profile before
publishing. Source fixture CI does not qualify bundled binaries for older
distributions. See [validation](VALIDATION.md).

The artifact script rejects the current builder's home path in the application
archive and bundled workspace/runners. This is a targeted guard, not a full
secret scan. Inspect both the tar archive and Debian payload before publication,
and confirm they contain the same tested application and runtime bytes.
