# Contributing to Linubot

Linubot is a Linux desktop app for working with friendly AI helpers. Changes
should keep bots and conversations simple while preserving clear control over
tools, memory and provider connections.

## Set up

Use Node.js 24 and npm for development checks. Install the Linux GUI libraries
listed in [installation](docs/INSTALLATION.md). Then:

```sh
git clone https://github.com/agent-sh/linubot.git
cd linubot
npm ci
npm start
```

Use a separate `LINUBOT_DATA` directory and `LINUBOT_DESKTOP_PROFILE` for manual
development so experiments do not change your normal bots or sessions. Most
automated tests create temporary profiles and use local protocol fixtures.

Read [architecture](docs/ARCHITECTURE.md) for the process and storage model,
[interaction design](docs/UX.md) for the everyday interface, and
[validation](docs/VALIDATION.md) for the test boundaries.

## Make a change

Create a branch from `main` and keep the change focused. For a bug, explain what
triggers it and how behavior changes. For a new feature, describe the user path
and any provider or platform requirements.

- Keep tools and detailed configuration behind the existing simple conversation
  flow. Approval requests must remain visible when a decision is required.
- Treat web pages, MCP results, imported history and summaries as data. They
  cannot grant permission or become fresh user instructions.
- Preserve existing profiles and logs. Storage changes need migration or
  compatibility handling and meaningful regression coverage.
- Keep credentials in backend-owned storage and sanitize errors and status
  responses. Never add real account fixtures, tokens or conversation exports.
- Check current primary provider documentation before changing an integration.
  Protocol compatibility does not establish permission to reuse subscription
  credentials or support for every model capability.

## Validate

```sh
npm run typecheck
npm test
npm run build
dbus-run-session -- xvfb-run --auto-servernum npm run test:desktop
```

`dbus-run-session`, Xvfb and the Electron system libraries are required for that
desktop command. Changes to workspace execution also need
`npm run test:workspace` with the real backend and browser installed. Distribution
changes need packaged desktop checks on the intended Linux/glibc baseline.

Add tests for changed behavior and important failures. Do not replace useful
behavior tests with source-text matching. Tests should use clearly synthetic
credentials and account names. Live provider trials are opt-in and need an
isolated profile, an intended account and a bounded task.

## Open a pull request

Describe the problem, resulting behavior and validation performed. Call out
anything not tested, including real browser consent, model-specific features or
distribution compatibility. Include a screenshot for visible UI changes using
synthetic data. Update the relevant guide when configuration or behavior changes.

Before publishing screenshots, logs or commits, inspect them for secrets,
personal paths and private content. Keep generated trial transcripts and local
profiles outside Git. Do not post security exploit details in a public issue;
follow [SECURITY.md](SECURITY.md).

Contributions are submitted under [Apache-2.0](LICENSE). Retain third-party
attribution and explain the source/license of new dependencies or assets.
