# Recoverable long-session context

Linubot uses a working context window backed by the complete session archive.
Compaction makes room for continuing work while original events remain available
for recovery. See the [method research](research/compaction/README.md) for the
primary references and design decisions.

## Working window

Completed task blocks are ordered by their terminal event, with references to
their original request. A queued request posted before a checkpoint cursor is
still included when that task finishes. Failed/cancelled requests are marked as
inactive historical work, with original request references for explicit recovery.

Older bulky observations can be replaced by archive pointers. Native compaction
is used for known OpenAI/xAI Responses endpoints in automatic mode. If native
compaction is unavailable or does not fit the working budget, the selected model
produces a structured portable checkpoint. Other protocols use this portable
path. Anthropic's native beta strategy was researched but is not enabled by this
generic Messages adapter.

Native windows are forwarded intact. The client does not decode encrypted
content or treat its byte size as a token count. Portable checkpoints capture
objectives, decisions, completed and remaining work, constraints, references and
uncertainties, with deterministic reference anchors.

System instructions and current requests are retained separately. Tool calls and
results are kept in complete groups. Live approvals, denials, workspaces and
side-effect bookkeeping stay in the runtime; a checkpoint cannot grant authority
or mechanically replay an action. Oversized irreducible protected context stops
with an explicit error instead of silently dropping it.

## Persistence and recovery

The original JSONL logs remain intact. New tool observations are archived in full;
working excerpts carry exact event references. Earlier-version logs retain the
content originally recorded by those versions.

Derived windows live under contexts/. A source checksum, payload checksum,
connection/model/account identity and shared-memory stamp validate reuse. The
head switches atomically after the new snapshot is written, and the previous
snapshot is retained. New terminal activity arriving after the source snapshot
prevents advancing its cached cursor. The next task rebuilds from the archive.

Provider/model/account changes, owner memory edits and corrupt derived data
invalidate cached state. Failed summary attempts have a short persisted cooldown;
empty, malformed, cancelled and non-reducing candidates cannot replace a working
window. Snapshot storage and history recovery responses are bounded.

The read_session tool searches or opens original events with pagination. It is
restricted to the current bot/group conversation. The compact_context tool lets
a bot request a checkpoint at a completed subtask; the manager waits for a safe
tool boundary and may skip a context that is already small.

Search and reconstructed history omit read_session's own retrieval receipts,
which otherwise recursively duplicate the original evidence. Those receipts
remain in the archive and can still be opened by exact event sequence.

## Controls and limits

Settings / Long conversations configures automatic handling, strategy, input
budget, summary target and preferred recent exchanges. Changes apply to new
tasks. Defaults are a 32,000-token working input budget, 10,000-token summary
target and six preferred recent units. These are application budgets, not claims
about an endpoint's maximum context. Recent units can be reduced when needed.

Reported usage calibrates estimates, and image/token estimates are labeled.
Providers with smaller windows need a suitable working budget with output room.
The existing task time and step limits still apply. The archive is recoverable;
no lossy summary guarantees that every historical detail will always be recalled
without consulting it.

Compaction starts at 80% of the working budget. Native and portable
requests each have a 180-second deadline. Compaction time uses a separate,
bounded 600-second maintenance allowance per task, so it does not consume the
ordinary execution budget. The session shows maintenance progress and remains
cancellable.

If both compaction paths fail while the context is full, an archive recovery
checkpoint retains the system instructions, current request, recent complete
exchanges that fit, and references to recorded tool results. The same task keeps
running; its approval decisions, completed effects and tool budget stay intact.
The bot can recover omitted facts with read_session. This fallback does not
pretend to contain a successful model summary. Protected instructions or a
request that cannot fit even by themselves still produce an explicit error.

## Validation

Unit and integration checks cover repeated compaction, restart, current-request
and system retention, tool-group integrity, source/payload corruption, concurrent
appends, queued requests crossing cursors, cancellation, failure cooldowns,
archive pagination, provider changes and native canonical-output preservation.

Local acceptance trials used synthetic historical notes and real xAI OAuth
requests, with durable memory disabled to isolate context behavior. They checked
repeated native compaction, corrected facts after restart, unchanged archive
prefixes and exact recovery through read_session.

A continuation regression combined real model calls with injected failures in
both compaction paths. It checked that the same task recovered recorded evidence,
executed remaining tools and saved a single artifact. The service failures were
injected; they were not observed live outages during that test.

These are scoped behavior checks, not a reproduction of the research benchmarks.
See [validation](VALIDATION.md) for the test map and live acceptance procedure.
