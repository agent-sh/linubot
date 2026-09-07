# Sync an imported conversation

Open an imported bot or group, choose its options menu, then **Sync latest from
source**. Linubot checks the current source and previews new history and changed
knowledge. Choose **Sync now** to apply that snapshot.

The action is on demand. It does not run in the background or restart old tasks.
It pulls from the original Hermes profile, the current Grok desktop cache, or the
registered export folder. Update downloaded export files in that same folder
before syncing. Cloud-only Grok knowledge still needs an owner-downloaded export.

## What comes across

- Unseen messages from the source's supported history window.
- Changed imported memory and custom instructions.
- New and updated skills, including supporting files.

Unchanged messages are not duplicated, even if the same sync request is retried.
A changed source message is retained as another historical revision rather than
rewriting an older record. Hermes still supplies up to three recent conversations
and 200 visible messages per conversation; Grok supplies its available cache.
Sync cannot recover history that is no longer in that source window.

Provider/model choices, permission modes, routine settings, group membership and
native Linubot messages are preserved. Items removed from the source are not
automatically deleted locally. New imported skills are approved and attached as
part of the confirmed sync; existing approval and attachment choices are retained.

## Local edits and conflicts

New imports record a baseline. Sync compares source updates and current local
content against it. Local-only edits are kept. When both sides changed, the
preview marks a conflict and keeps Linubot's version by default. You can explicitly
choose **Replace conflicting Linubot knowledge with the source versions shown
above** after reviewing them.

Older imports have no baseline. Their existing content is preserved when its
origin cannot be determined; the first sync may therefore show conflicts even if
you never edited the Linubot copy. Identical content establishes a baseline safely.

Active work must finish before a sync that affects those bots or their shared
skills. If Linubot changes after the preview, check the source again. Ordinary
write failures roll back before new history is broadcast. Successful receipts
make retries idempotent; a fresh preview after restart checks current records.

Sync receipts are stored in `import-sync/`, and per-bot baselines are stored in
`profiles/NAME/import.json`, inside Linubot's private data directory. Destination
backups are bounded to 64 MiB per sync. No model call is needed to check or apply
source updates.
