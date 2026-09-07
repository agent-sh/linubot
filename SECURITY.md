# Security

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/agent-sh/linubot/security/advisories/new)
for security findings. Include the affected version, a minimal reproduction,
expected and actual behavior, and the impact. Remove credentials and unrelated
personal content from any supporting files.

If private reporting is unavailable, open an issue requesting a private contact
without including exploit details. Maintainers will arrange a private channel.
Do not publish live tokens, session archives or another person's data.

Security fixes target the latest release. Older versions should be upgraded;
there is no commitment to maintain every historical release line.

## Trust model

Linubot runs for one local Linux user. It is not a multi-user service or a
security boundary between processes running as that user. The packaged desktop
serves its interface over an authenticated, private loopback connection. The
browser development server is for local development and must not be exposed as
a public service.

The Electron renderer uses context isolation and sandboxing, with Node access
disabled. Credentials remain in the backend. A separate Linux workspace owns
the agent's display, input and browser, but a separate display alone does not
restrict filesystem or network access. Native applications and executable MCP
packages run under the local account and require trust appropriate to that access.

Task-scoped approval state is enforced by the runtime. Historical approvals,
model text, website instructions and MCP annotations do not grant permission.
An initial workspace grant covers normal interaction in that task's workspace;
exact executable launches and external commitments have additional approval
requirements. Every MCP invocation requires application approval.

## Credentials and data

Provider connections bind credentials to their configured endpoint and identity.
API keys stay in memory unless encrypted persistence is available through the
Linux keyring. Browser sign-in credentials use supported provider-specific
storage and refresh ownership. An unavailable keyring may require reconnecting
after a restart.

Codex manages its own sign-in and refresh credentials; Linubot requests access
through its local app server. Gemini API OAuth uses an operator-supplied Google
Desktop client and quota project. Consumer Claude or Gemini CLI tokens are not
borrowed for third-party API requests. See [providers](docs/PROVIDERS.md) for
each integration's boundaries.

Conversations, memories, artifacts, imported context and tool observations are
stored locally and can contain sensitive data. Configured models receive the
context needed for a request; web and MCP tools contact their selected services.
Do not assume “local application” means every operation stays offline.

Update checks contact the public GitHub releases API. Downloading and restarting
requires confirmation; release archives are checked against their published
SHA-256 digests. The update path does not use sudo. See [updates](docs/UPDATES.md).

Keep data directories and backups private. Forgetting a memory entry changes
future saved context; it does not remove the same text from existing session
archives. Compaction preserves those archives. Do not attach a complete data
directory to an issue or publish it as a test fixture.

Browser profiles contain website sessions and are retained per bot or group
under the private data directory. Approving a later computer task lets that
teammate use its existing signed-in sessions. Deleting the bot or group removes
those profiles once its computer is stopped. Personal desktop Chrome profiles
are separate. Sites can still expire or revoke sessions.

## Extensions and imports

Remote skill previews pin source revisions and bound their contents. Skills
start as drafts and must be reviewed and attached before use. Installing a
skill does not automatically execute its scripts. Executable extensions have
their own dependencies and security implications.

Hermes and Grok Bot imports create reviewed local records, with supported skills
as drafts and routines paused. Credentials, old permissions and historical
requests do not become active grants. Imported instructions can still be wrong
or malicious; review the preview and attached skills before using the bot.

Public page reading rejects private network targets and validates redirects,
with time and size limits. Configured model/MCP endpoints and approved workspace
apps are different trust paths and may intentionally access services you select.

## Security checks

Tests cover credential separation, callback state and cancellation, stale
refreshes, task/workspace ownership, history recovery, import bounds and network
validation. See [validation](docs/VALIDATION.md) for commands and coverage areas.
These checks cover specific behaviors and do not prove universal model safety.
