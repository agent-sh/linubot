# Validation

Linubot separates deterministic application tests, real desktop/workspace checks
and live provider trials. A fixture test checks application behavior; it does
not establish a provider account's current access or a model's correctness.

## Release acceptance: 2.9.0

Checked on 2026-09-07: 311 source tests, seven source and packaged desktop
scenarios, and Android release build/lint passed. A phone-sized browser passed real private HTTPS
pairing, chat, reload persistence and revocation. The signed Android APK passed
HTTPS setup, pairing, task submission, authenticated Markdown artifact download
and Android sharing in an Android 15 emulator; downloaded bytes matched the
created artifact. Pairing survived an app force-stop/restart. Physical phone and
cellular connectivity remain user acceptance checks.

Gateway tests cover origin/host checks, desktop-only management, hashed devices,
one-use codes, attempt limits, restart persistence, revocation and upstream stream
abortion. Existing Tailscale mappings were inspected before setup and preserved.
The release signing key is retained outside the repository.

## Release acceptance: 2.8.0

Checked on 2026-09-07: 307 source tests and six desktop scenarios passed
from source and the packaged executable.

Real Chrome testing confirms that session cookies survive desktop teardown and
a fresh adapter, for both regular and automated browser profiles. Another bot
starts with separate cookies. Profile deletion is blocked while an owned
computer is running; graceful browser-quit failure still reaches desktop
teardown. Google account acceptance remains unverified.

Bulk import tests cover one combined snapshot, overlapping group membership,
receipt retries and rollback after a later item fails. Continuation tests retain
the original brief, criteria and archived progress after restart. Desktop QA
covers Select all/Clear selection and continuing an old 30-step failure without
replacing a draft.

## Release acceptance: 2.7.2

Checked on 2026-09-07: 299 source tests and five desktop scenarios passed
from source and the packaged executable. The regular sign-in browser is tested
against a real local Chrome fixture:
remote automation is absent, its cookies are separate from the automated
browser, same-task continuation retains those cookies, and cleanup removes the
profile. The fixture also uses a relative data-directory override. Google account
acceptance is not tested. The Computer panel test also
covers opening the website under manual control, and runtime regression checks
prevent returning to the old automated tab after switching browser modes.

## Release acceptance: 2.7.1

Checked on 2026-09-07: 297 source tests and five desktop scenarios passed
from both source and the packaged executable.
Update checks cover manual discovery, foreground refresh, retry timing and
coalesced requests. Virtual-clock tests verify that approval waiting does not
consume an explicit execution budget and normal tasks remain stoppable after an
hour without a default deadline. Per-call timeouts and model/tool step limits
remain in place.

## Release acceptance: 2.7.0

Checked on 2026-09-07: 293 source tests and four packaged desktop scenarios
passed. A real Chromium sign-in through the embedded panel passed with both a
fixture model and ChatGPT. The bot waited for the owner, continued the same task,
and cleaned up its workspace; the password was absent from conversation logs.
Control-race tests cover deadlines, stale frames/actions, clipboard clearing,
shutdown and ownership recovery. Deletion checks cover group work and routine
deliveries as well as preservation of unrelated data.

## Release acceptance: 2.6.1

Checked on 2026-09-07:

- 272 source tests and three desktop scenarios passed, including the packaged
  executable installed from the public release.
- The public wget installer built and staged the tagged source. The curl path
  resolved the latest stable release successfully.
- A real managed upgrade from 2.6.0 to 2.6.1 blocked active work, installed the
  checked release, restarted and preserved a fixture bot and its conversation.
- A real ChatGPT request and the workspace browser smoke test passed. Google
  OAuth exchange and cancellation are fixture-tested; live access still requires
  the account and client setup described in the provider guide.
- Source/history secret scans and package build-path checks passed. The tar and
  Debian payloads matched the checked unpacked application. Required ELF symbols
  set the glibc minimum to 2.39; packaged behavior was tested on Ubuntu 26.04.

Raw trials stay outside the public source because they can contain local paths,
credentials or provider output.

Normal tasks have no fixed overall time deadline. Tests cover approval waiting
and manual control separately from active execution, including explicit budgets.

## Local checks

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The Node test suite covers task lifecycle, groups, memory, imports, context
recovery, network bounds and provider/MCP protocols. Local HTTP and stdio fixtures
exercise actual request shapes without requiring provider credentials.

Desktop tests launch Electron with temporary data and a fixture model:

```sh
xvfb-run --auto-servernum npm run test:desktop
```

Use an isolated Linux display. The desktop tests cover bot creation, mascots,
conversations, artifacts, approvals, sessions, connection selection, imports,
settings and restart behavior. Embedded computer checks exercise the panel,
control transfer and direct bot deletion using synthetic data. Tests do not
need your normal Linubot profile.

After [packaging](INSTALLATION.md#build-a-debian-package), run the same desktop
suite against the executable that will be distributed:

```sh
LINUBOT_TEST_EXECUTABLE="$PWD/release/linux-unpacked/linubot" \
xvfb-run --auto-servernum npm run test:desktop
```

The separate workspace smoke test requires a working `agent-workspace-linux`
installation and browser dependencies:

```sh
npm run test:workspace
```

It checks the real workspace command boundary, literal input, keyboard
navigation, observations and cleanup. A green Electron fixture test alone does
not cover that backend.

## Behavior map

| Boundary | Relevant tests |
| --- | --- |
| Provider connections, credentials and wire formats | `tests/provider-connections.test.ts`, `tests/oauth-services.test.ts`, `tests/auth.test.ts`, `tests/xai.test.ts`, `tests/muse.test.ts` |
| Compaction, archive recovery and repeated continuation | `tests/context.test.ts`, `tests/runtime.test.ts` |
| Durable memory and owner controls | `tests/bot-memory.test.ts`, `tests/memory.test.ts` |
| Groups, task lifecycle and restart | `tests/chat.test.ts`, `tests/lifecycle.test.ts`, `tests/crons.test.ts` |
| Imports, source preservation and inactive historical data | `tests/imports.test.ts`, `tests/desktop/imports.test.mjs` |
| MCP and remote skill installation | `tests/mcp.test.ts`, `tests/market.test.ts`, `tests/capabilities.test.ts` |
| Public network reads and workspace scope | `tests/network.test.ts`, `tests/computer.test.ts` |
| Embedded frames, owner control and fresh-screen actions | `tests/computer-view.test.ts`, `tests/desktop/computer.test.mjs` |
| Bot deletion, reference cleanup and active delivery | `tests/bot-deletion.test.ts` |
| Native interface and profile persistence | `tests/desktop/` |

Embedded computer coverage includes serialized input, stale control sessions,
revision checks after takeover, temporary frame cleanup, authenticated routes
and keeping manual control through model failures. Deletion checks cover group
detachment, affected routines, empty groups and refusal during active work or
delivery. These additions do not change the historical 2.6.1 acceptance record.

## Live acceptance testing

Use a separate data directory and Electron profile, an isolated display, and
provider accounts you intend to use for the test. Live inference and external
tools may incur charges. Keep generated transcripts and credentials outside
the public repository.

A useful acceptance sequence is:

1. Load the connected endpoint's model catalog and send a short real request.
2. Give two bots different providers and run them together; verify both remain
   connected and the app default stays unchanged.
3. Exercise one bounded web or workspace task, checking the actual observed
   result and workspace cleanup.
4. Teach a synthetic preference, restart, ask a different bot to recall it,
   correct it and then forget it.
5. Use synthetic long history to trigger compaction more than once, restart
   between tasks, and recover an exact original detail through `read_session`.
6. Inject a compaction-service failure and verify the same task continues its
   remaining work without duplicating completed actions.
7. In the embedded Computer panel, take control, enter synthetic text, drag,
   scroll and return control. Verify a fresh observation before bot actions
   resume, stale-frame input refusal and cleanup when the task ends.
8. Delete a fixture bot through Bot options. Verify the previewed group/routine
   cleanup, retained prior messages/shared memory and refusal while affected
   work or routine delivery is active.

Before the initial public release, local xAI OAuth trials exercised web/MCP
tools, workspace actions, group replies, memory updates, repeated compaction,
restarts and archive recovery. A Meta / Muse Code request and simultaneous
xAI/Meta calls also completed. These are scoped historical checks, not standing
guarantees about every account, endpoint, model or Linux distribution.

Browser consent completion must be verified separately for each supported flow.
Testing callback state and token exchange with a fixture does not establish
live account consent. New connection methods should report which of those
checks were actually performed.

## Before distributing a build

Run the relevant local and packaged checks on the candidate. Check production
dependencies with `npm audit --omit=dev`; inspect any findings in context.
Compare the packaged application and bundled runtime versions with what was
tested. Review generated artifacts, metadata and the exact Git history to be
published for private data or credentials.

No benchmark here ranks Linubot against other agents. Model self-review and
literal regression checks are evidence for specific criteria, not independent
proof of usefulness or general safety.
