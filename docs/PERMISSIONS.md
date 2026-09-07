# Permission modes

Open **Settings → Permissions** to choose the default for your bots:

- **Ask first** is the default. Runtime actions that require approval pause for you.
- **Always approve (skip prompts)** lets the bot open its workspace, launch
  applications, use MCP tools and perform external actions without an approval
  prompt each time. These are real actions under your Linux account.

You can override the default for an individual bot. A pending approval also
has **Always approve for this bot**. That choice approves the current request
and saves automatic approval for that bot across conversations, including groups.
Changing a mode resolves already-pending requests that the new setting covers.
Return to Ask first in Settings to require prompts for subsequent actions.

The mode is shown beside the bot's conversation status. Automatic approvals are
still recorded in task activity. Stop/cancellation, workspace ownership checks,
manual sign-in handoffs, input validation and execution limits remain in place.
A denied action is not silently retried by changing the mode. The setting does
not activate uninstalled tools or grant access to another bot's computer.

Defaults are saved in `permissions.json`; per-bot overrides live inside that
bot's profile. Deleting a bot removes its override. Imported source permissions
are not copied. Paired phones have owner access and may change this setting.
