# Bots and conversations first

Linubot is a place to work with friendly bots. The primary experience should be
understandable without learning about runs, evaluations or improvement loops.

## Main path

1. Open Your bots and choose a helper.
2. Chat through a simple message box.
3. Return through Sessions or the bot roster.

Bots occupy the main screen. Each has a persistent mascot, a name, a short role
and an unobtrusive presence indicator. New bots get random appearances; a user
can shuffle the look before saving. Existing conversations and identities stay
intact. The interface does not seed pretend coworkers or accomplishments.

Sessions open the continuing conversation. They do not open a rating form.
Replies have optional controls for feedback and evaluation, but no review CTA,
review status or test button is shown by default. The session details panel is
closed at every window width until the user opens it.

The composer leads with the message and Send. Criteria, full-message saving, and
queue/redirect controls sit inside Message options. A successful send is clear
from the conversation itself; it does not leave a persistent success banner.

## The bot's computer

The **Computer** button in a bot or group conversation opens a closable sidebar.
It starts in watch mode. **Expand** gives the screen more room without leaving
the conversation.

**Take control** pauses the bot and waits for a fresh view before accepting
pointer, keyboard, paste, scroll or drag input. The bot can also request a
private login step; the request stays visible until the user handles it.
Passwords belong in the workspace's login page, never in chat.

**Return to bot** resumes work from the current screen. Closing the panel returns
control and leaves the task running. Live viewer frames and manual input are
not added as user messages; the bot's subsequent observations use its normal
activity history. Workspaces remain scoped to the task and close when it ends.
See [computer controls](COMPUTER.md) for the full flow and privacy boundary.

## Deleting a bot

**Bot options → Delete bot** is available directly from the conversation.
The confirmation previews the impact on groups and routines. Confirming removes
the bot's profile and instructions, detaches it from groups, deletes affected
routines and removes any groups left empty. Past messages and shared team memory
remain.

Deletion is blocked while the bot has active or queued work, including group
turns, or while a routine is delivering to that bot or a group that would be
removed. Finish or stop the affected work before trying again.

## Background activity

Tools, observable stages and workspace screenshots fold into expandable activity
rows. Deliverables remain easy to open. Approval requests stay visible whenever
an action needs a decision, and errors remain inspectable.

Learning stays noticeable through a quiet note indicator. It does not dominate
navigation or imply that the user needs to review every reply. The underlying
consent, evaluation and lesson-activation rules remain explicit.

Bots decide when useful facts and preferences should enter memory through their
normal tool loop. Memory activity folds with other tool activity, and saved
details contribute to the quiet Advanced indicator. Saving a preference does
not require accepting a lesson or reviewing a task. Advanced / Memory lets the
owner edit, forget, or pause bot updates.

## Deeper controls

Advanced contains learning and evaluations, skills, connections, memory, routines
and workspace demonstrations. These pages can expose detailed evidence and
controls because the user has deliberately entered them. A bot's options also
provide a direct path to its settings and learning notes.

## Visual language

Use open space, readable conversation rows, restrained chrome and one UI accent.
Mascots carry the personality through varied shapes, soft colors and friendly
faces. Their motion is gentle and respects reduced-motion preferences. Main
screens should not become dashboards of scores, warnings, or setup instructions.
