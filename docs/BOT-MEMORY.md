# Memory is a bot decision

Linubot gives the conversation agent a `memory` tool. The agent decides
whether a detail will help later, saves it during its ordinary tool loop, and
checks the result before saying it was remembered. There is no separate
fact-extraction pass and no requirement to select Remember in the composer.
Routine answers can finish without a memory write or an additional model call.

## Design references

The following documentation and source revisions informed the implementation.
They were checked on September 6, 2026; the table describes those revisions.

| Reference | Examined approach | What Linubot takes from it |
|---|---|---|
| [Claude Code](https://code.claude.com/docs/en/memory) | Claude selects useful user, feedback, project and reference notes while working. A bounded index loads into future conversations; topic files provide detail on demand. The owner can inspect and change the notes. | The bot decides relevance during conversation; notes remain optional to inspect. |
| [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/) | The agent calls a memory tool to curate persistent notes and user context. Capacity is bounded, edits can correct or remove entries, and overflow requires consolidation. | A small tool with add, replace and remove actions over the existing local stores. |
| [Codex source](https://github.com/openai/codex/blob/9daf7d22ca707c2b2f40860bf2b2035d8cc4deef/codex-rs/memories/README.md) | When enabled, a background pipeline extracts eligible conversations, then consolidates selected records with coordinated writers and source artifacts. This differs from the direct conversation tool pattern. | Durable evidence, bounded memory and coordinated updates; its separate extraction pipeline is not used here. |

The examined [Hermes tool source](https://github.com/NousResearch/hermes-agent/blob/c5594ec4b34097cafbe24deb6dfd9ac4b21d411d/tools/memory_tool.py)
also supports batched changes. Linubot currently makes one entry change per
tool call and checks the complete old entry when replacing or removing it.
This catches a competing bot's edit instead of matching a stale substring.

## Behavior and storage

- `target=user` stores preferences and personal context in USER.md.
- `target=memory` stores shared project facts and decisions in MEMORY.md.
- `add`, `replace`, and `remove` are available in normal user chats and groups.
  The agent can read both stores through `read_memory`.
- The prompt asks the bot to keep durable information, skip temporary questions,
  examples and secrets, and respect requests not to remember.
- A mutation must cite an exact quote from the current user's message. The
  normal tool event records the action, source quote and result. This grounds
  the source; it is not an independent factual assessment of the bot's summary.
- Scheduled jobs, delegated prompts and tool observations cannot directly
  supply the source for personal memory writes.

Model-managed entries are at most 2,000 characters. Shared memory is limited
to 4,000 characters and user context to 3,000. Overflow returns an error, letting
the bot consolidate or remove obsolete entries. Nothing is silently evicted.
Existing larger manual files remain intact and searchable; edits that reduce
their size are allowed. The full-message Remember option remains available.

Writes reload current disk contents and complete synchronously with an atomic
file rename in the Linubot server process. Independent additions are retained.
Replacement and removal require the exact old entry, so conflicting edits fail
instead of overwriting a newer value. Queued turns receive fresh memory before
execution while keeping their chosen provider and profile context.

Owner editing, forgetting and pausing are under Advanced / Memory. These actions
invalidate pending bot writes made from older owner settings, even if updates
are later re-enabled. The control pauses writes while retaining readable saved
context. Forgetting affects saved memory, not messages in existing sessions.

Memory activity stays inside collapsed activity rows. The home page remains a
bot roster; saved details only add to the quiet Advanced indicator. There is no
new task review, score or approval step in the normal conversation path.

## Imported memory

Hermes imports can bring saved user and project notes into a bot's own context.
Those notes remain separate from the team's shared stores. Review or edit them
in **Bot options → About this bot → Imported memories and context**. See
[imports](IMPORTS.md) for supported files and limits.

## Validation and limitations

Tests cover source-quote checks, bounded writes, conflicting edits, owner
changes, pausing, forgetting and restart persistence. Desktop checks exercise
the same owner controls through the interface.

Local xAI OAuth trials used synthetic preferences to exercise bot-chosen saving,
recall by another bot after restart, group use, correction and forgetting.
Unknown values remained unknown before teaching and after forgetting.

Exact-text deduplication is enforced. Consolidating differently worded overlaps
remains the bot's decision. A valid source quote grounds a write in what the
user said; it does not independently prove the bot's interpretation correct.
Review sensitive or consequential saved context when it matters. See
[validation](VALIDATION.md) for test locations and acceptance procedures.
