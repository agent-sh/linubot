# Validation

Linubot separates deterministic application tests, real desktop/workspace checks
and live provider trials. A fixture test checks application behavior; it does
not establish a provider account's current access or a model's correctness.

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
settings and restart behavior. They do not need your normal Linubot profile.

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
| Native interface and profile persistence | `tests/desktop/` |

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
