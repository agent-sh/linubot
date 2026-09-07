# Importing existing teammates

Open **Add a bot → Import from Hermes or Grok Bot**. Select one or more bots or groups, or use **Select all**. Choose a provider/model
for the selection. A single bot can also be renamed before import. The preview shows the snapshot that will be imported.
Changing an option invalidates that preview. Import creates native Linubot bots
and conversations; it does not run the original agent or restart past tasks.

| Data | Hermes profile | Grok Bot local cache |
| --- | --- | --- |
| Name and role | Profile name and SOUL.md | Cached name and description |
| Model | Source model shown; choose a Linubot connection | Choose a Linubot connection |
| Memories | USER.md and MEMORY.md, kept with the imported bot | Available from an exported folder; absent from local cache |
| Skills | Instructions and supporting files, attached after preview | Available from an exported folder; absent from local cache |
| History | Up to three recent conversations, at most 200 visible text messages each | Recent cached text messages |
| Groups | Select multiple profiles together | Group and all locally available members |
| Routines | Compatible UTC cron prompts, imported paused | Cloud schedules are unavailable |
| Logins and tools | Reconnect named MCP tools; credentials and approvals excluded | Cloud logins and permissions excluded |

Imported memories are separate from shared team memory. The bot receives them as
historical context and can search them using read_memory. Edit or clear them in
**Bot options → About this bot → Imported memories and context**. Changes invalidate
the bot's derived conversation checkpoint. Imported conversation messages retain
their timestamps and speakers and never become active requests or approval grants.

Skills receive names scoped to the imported bot and retain their supporting files.
After you confirm the preview, they are approved and attached by default so the
bot can use them. Clear **Attach imported skills** to keep them as Library drafts.
Full skill bodies stay out of the initial prompt. Up to 256 skills can be
attached; the bot can search the full list with
`list_skills` and load instructions/supporting files with `read_skill_file`.
The combined imported memory is preserved up to 256 KiB; individual supported
memory files are bounded during preview rather than silently dropped.
Known credential filenames and hidden files are excluded from skill bundles.
Source-specific tool references may need editing for Linubot.

An import never overwrites an existing teammate. Names get a suffix when needed;
the preview shows the final names. Repeated imports reuse their teammates.
A selection uses one preview and one commit. Overlapping group members appear
once, and all selected groups retain their own membership. If a later item
fails during commit, the entire selection rolls back. Groups reuse members already brought over.
Existing group membership is not synchronized or replaced. Preview tokens last ten minutes; only the reviewed
snapshot is committed. Failed commits roll back their new files and configuration
changes. Successful receipts are retained locally.

## Bring Grok cloud knowledge or a downloaded profile

The Grok desktop cache has descriptions and recent messages, but does not contain
cloud-only memory, skill files or custom instructions. Linubot cannot retrieve
unavailable cloud state from that cache. Grok's public sharing/duplication flow
also does not carry learned memory or conversation history.

Save the bot's actual user-owned knowledge files from Grok's computer, then
choose **Choose exported folder** in the Linux import page. The folder is selected
through a native Linux file picker and becomes another selectable import source.
This is a file-transfer path, not a claim that Grok has a full-state export API.
The expected layout is:

```text
MyBot/
  SOUL.md
  MEMORY.md
  USER.md
  memories/MEMORY.md
  skills/my-skill/SKILL.md
  skills/my-skill/references/guide.md
```

Include only the files that actually exist; do not invent missing memories.
`SOUL.md` contains your bot's custom instructions, and either root-level memory
files or their `memories/` equivalents can be used. Supporting skill files retain
their relative paths. A downloaded Hermes profile can use the same control after
being unpacked on Linux; supported Hermes SQLite history and compatible routines
are handled by the existing adapter. Each selected folder represents one bot.
The preview shows memory size, skills and missing-data warnings before importing.

Grok's [bot sharing documentation](https://docs.x.ai/grok-bot/bots) and
[shared files guide](https://docs.x.ai/grok-bot/files-and-results) describe the
available source mechanisms. Hermes also provides
[profile exports](https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions).
Cloud exports need to be downloaded by the owner; they are not auto-fetched using
undocumented endpoints. Adding a folder does not modify its source files.

For an existing imported conversation, use [Sync latest from source](SYNC.md)
to pull newer sessions and knowledge on demand. Re-importing still reuses an
existing bot; synchronization is a separate, explicit operation.

## Locations and limits

Hermes is discovered under HERMES_HOME or ~/.hermes, including named profiles
under profiles/. Grok Bot is read from the Linux desktop cache at
~/.config/Grok Bot/sand-client-persistence (XDG-aware). For another installation,
set LINUBOT_IMPORT_HERMES or LINUBOT_IMPORT_GROK before starting Linubot.

The Grok adapter targets Grok Bot 0.30.0: roster schema 3,
transcript-cache schema 1. This cache is a partial local view of cloud data.
Cloud-only instructions, workspace files, memories, skills and schedules cannot
be recovered from the cache; use an exported folder for available knowledge files.
The preview calls out missing data. Source applications,
databases, logins and running tasks are left in place.

Select up to 100 sources per import. The combined snapshot is bounded to 24 MiB, 256 skills, bounded supporting-file bundles, and
known regular files. Symlinks and unsafe destinations are refused or excluded.
Optional components can be deselected. Other Hermes history remains in Hermes;
Grok history is limited to the cached window. Scripts, non-UTC schedules and
unsupported schemas are reported instead of enabled or guessed. Images and
attachments are not converted into new observations.

Source references checked September 7, 2026:
[Hermes profile formats](https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions),
[Grok Bot storage and operation](https://docs.x.ai/grok-bot/overview).
The adapters inspect supported SQLite history and cache schemas at import time.
Unsupported formats are reported in the preview rather than guessed.

## Validation

Tests cover preview-only reads, source preservation, credential-file exclusion,
isolated imported memory, draft skills with supporting files, paused routines,
historical requests, name conflicts, unsafe files, retry idempotence and group
speaker mapping. Desktop QA imports a Hermes profile, chats with the resulting
native bot, then selects all sources together and verifies that previously imported bots and
overlapping group members are reused.
