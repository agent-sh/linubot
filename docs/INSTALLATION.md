# Installation

Linubot runs as an Electron application on a Linux desktop. The desktop starts
its own local backend; you do not need a browser tab or a separate server.

## Install a release

The standard release requires **Linux x86-64 with glibc 2.39 or newer**. The
desktop and workspace have been tested on **Ubuntu 26.04**; the measured binary
ABI minimum is not a claim that every distribution meeting it has been tested.
It includes Electron/Node, the workspace backend and Python extension runners.
You still need the desktop GUI libraries and system utilities used by computer
workspaces. A prebuilt installation does not require Node or npm to build the app.

Download the [installer](../install.sh) with curl:

```sh
curl -fsSL https://raw.githubusercontent.com/agent-sh/linubot/main/install.sh -o /tmp/linubot-install.sh
bash /tmp/linubot-install.sh --launch
```

Or use wget:

```sh
wget -qO /tmp/linubot-install.sh https://raw.githubusercontent.com/agent-sh/linubot/main/install.sh
bash /tmp/linubot-install.sh --launch
```

Run it as your desktop user, without sudo. The installer needs Bash, curl or
wget, tar, sha256sum, flock and realpath. It downloads the latest stable release
archive and verifies it against that release's `SHA256SUMS` before installation.
It does not install system packages for you.

Application versions live under `~/.local/opt/linubot-VERSION`, with
`~/.local/opt/linubot` selecting the active version. The installer creates
`~/.local/bin/linubot` and an application-menu entry. Earlier version directories
are retained, and application data stays in its separate location.

The application-menu entry points directly to the installed icon. When desktop
cache utilities are available, the installer refreshes icon and application
listings too. It releases the installation lock before launching Linubot, so the running app
does not keep that lock and block later upgrades.

When a user systemd manager is available, installation writes and enables
`~/.config/systemd/user/linubot.service` for `graphical-session.target`.
The application-menu entry starts the unit, then sends a single-instance show
request so a hidden background window reappears without replacing the supervised
process. The show request exits if no instance owns the lock; it cannot become
an unsupervised primary. `--launch`
and `--activate-only` use `systemctl --user restart linubot`. Without a user
systemd manager, they use the plain `~/.local/bin/linubot` launcher.
If integration, enabling or activation fails, the installer restores the prior
active version and its launcher, menu, icon and service files, and attempts to
restart it. The candidate remains staged. A failed recovery start is logged and
leaves the old version selected for manual retry. Later runtime crashes are
handled by systemd restart policy, not automatic version rollback.

The service clears `ELECTRON_RUN_AS_NODE`, restarts after failures with a
five-second delay, and limits starts to three in five minutes. A normal quit
does not restart the app. During activation, an active legacy transient unit
named `linubot-desktop` is stopped before the new unit starts.

Inspect failures with `journalctl --user -u linubot.service`. After resolving a
repeated startup failure, use `systemctl --user reset-failed linubot` before
starting it again. `KillMode=process` lets an update helper survive app shutdown.

Releasing and installing are separate operations. To stage a version without
changing the active symlink, desktop entry, service or running app:

```sh
bash install.sh --version 2.11.0 --stage-only
```

After finishing active work, explicitly activate the staged version and restart:

```sh
bash install.sh --version 2.11.0 --activate-only
```

Use a fresh installer for these commands. `--stage-only` also remains harmless
when that version is already staged. The in-app updater waits for its old
process to exit before activation. For a manually launched, unsupervised app,
quit it before running `--activate-only` so its single-instance lock is released.

To pin a release instead of selecting the latest:

```sh
bash /tmp/linubot-install.sh --version 2.10.0 --launch
```

The sidebar offers upgrades when a newer suitable release exists. See
[updates](UPDATES.md) for managed installations and manual upgrades.

## Run from source

Install Git, Node.js 24 or newer and npm. Use a supported Linux desktop with
[Electron's system libraries](https://www.electronjs.org/docs/latest/tutorial/quick-start).
The package manifest lists the Debian runtime dependencies.

On Ubuntu 26.04, the desktop GUI libraries are available through:

```sh
sudo apt install libgtk-3-0t64 libnss3 libxss1 libxtst6 \
  libatspi2.0-0t64 libdrm2 libgbm1 libasound2t64
```

With Git, Node and npm ready, clone and start the app:

```sh
git clone https://github.com/agent-sh/linubot.git
cd linubot
npm ci
npm start
```

In **Settings**, add a provider and select a model. **Add a bot** creates a
helper with a role and mascot. Send a simple message to verify the connection
before attaching tools or importing an existing teammate.

Chat and model-backed features can run without the computer workspace backend.
Web access needs a network connection. Remote MCP packages and Python extensions
have additional prerequisites below.

The installer can also build a tagged release:

```sh
bash /tmp/linubot-install.sh --version 2.10.0 --build --launch
```

This needs Git, Node.js 24+, npm and the Electron GUI libraries. It builds the
desktop from the selected tag without bundling the workspace and uv executables;
install those locally if needed. A source build needs its own validation on the
target distribution and does not automatically qualify older Linux systems.
The upgrade button opens the release page for these source builds; rerun the
installer with `--build` to compile a newer tag.
If the same version already exists in a different build mode, the installer
refuses to substitute it. Use a separate `LINUBOT_INSTALL_ROOT` for the other
build.

## Computer tasks and extensions

Install [agent-workspace-linux](https://github.com/agent-sh/agent-workspace-linux)
and its documented Linux dependencies. Make its executable available on `PATH`,
or select its absolute path for development:

```sh
LINUBOT_WORKSPACE_BIN=/path/to/agent-workspace-linux npm start
```

Run `agent-workspace-linux doctor` to check the machine's display utilities,
browser and sandbox support. Linubot uses an owned X11 workspace even when your
main desktop uses Wayland. Chromium or Google Chrome is required for its browser.

During a task, open **Computer** in the conversation to watch or take control of
that workspace. No separate viewer window is needed for this flow. The browser
is disposable and closes with the task; see [computer controls](COMPUTER.md).

Keep npm available for reviewed npm-based MCP servers. Install
[uv](https://docs.astral.sh/uv/getting-started/installation/) for Python-based
extensions; `uvx` is the extension runner. Draft skills are instructions and
supporting files, and installing a skill does not execute its scripts.

## Build a Debian package

The current package configuration requires **Linux x86-64 with glibc 2.39 or
newer**. Packaged desktop and workspace behavior has been tested on Ubuntu
26.04. Packaging does not make arbitrary locally compiled binaries portable to
other systems.

By default, the packager downloads the public **agent-workspace-linux 0.3.2**
release and verifies its pinned SHA-256 before bundling it. A local workspace
installation is not required for packaging. The release build also needs locally
installed **uv and uvx 0.11.7**, read from `~/.local/bin` by default. To select
another directory containing those runners:

```sh
LINUBOT_UV_DIR=/path/to/uv-directory \
npm run package:linux
```

`LINUBOT_UV_DIR` must contain both `uv` and `uvx`. The package includes recorded
versions, SHA-256 hashes and license texts. Building requires network access for
dependency, workspace and license downloads.

`LINUBOT_WORKSPACE_BIN` explicitly overrides the pinned workspace download for
custom builds. Verify the chosen binary's ABI, behavior and public provenance
before distributing it; a different local build does not inherit the default
release's qualification.

Outputs are under `release/`: a Debian installer named for the package version
and an unpacked application at `release/linux-unpacked/linubot`. Install a
specific built installer with your package manager:

```sh
sudo apt install ./release/linubot-2.10.0-amd64.deb
```

For a user installation with versioned directories, use the release installer
or its `--build` option above. To test a local unpacked candidate directly, launch
`release/linux-unpacked/linubot` with a separate data directory and Electron
profile. Conversations and settings remain separate from application files.

## Data and profiles

| Setting | Purpose |
| --- | --- |
| `LINUBOT_DATA` | Application data directory; overrides the default |
| `XDG_DATA_HOME` | Desktop data defaults to `$XDG_DATA_HOME/linubot` when set |
| `LINUBOT_DESKTOP_PROFILE` | Separate Electron profile, useful for isolated tests |
| `LINUBOT_WORKSPACE_BIN` | Workspace executable for development; explicit override of packaging's pinned download |
| `LINUBOT_UV_DIR` | Directory containing the `uv` and `uvx` binaries for packaging |
| `LINUBOT_INSTALL_ROOT` | Parent directory for versioned user installations; defaults to `~/.local/opt` |

Without an override, desktop data is `~/.local/share/linubot`. The Linubot menu
can open this folder. Keep it private: conversations, memories, artifacts and
tool observations may contain sensitive information. Back up the complete data
directory while the app is closed. Encrypted credentials may depend on the
original Linux keyring and may need reconnecting on another machine.

For a separate trial profile, use paths you control:

```sh
LINUBOT_DATA=/path/to/trial-data \
LINUBOT_DESKTOP_PROFILE=/path/to/trial-desktop-profile \
npm start
```

## Troubleshooting

- **Electron does not open:** check the terminal output and install missing GUI
  libraries. Keep Electron's sandbox enabled.
- **Computer tools are unavailable:** check the workspace executable and run its
  doctor command. Verify X11 utilities and a Chromium-based browser are installed.
- **An endpoint has no models:** check the base URL, protocol and authentication;
  use a custom model ID when the provider does not expose a catalog.
- **A packaged binary reports a glibc error:** use the supported baseline or
  rebuild the bundled dependencies against the intended target. Changing the
  package's dependency declaration alone is insufficient.
- **A routine is not running after closing the window:** enable the optional
  background mode. Quitting the application stops task execution.
