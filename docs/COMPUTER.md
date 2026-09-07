# Using a bot's computer

Open **Computer** in a bot or group conversation to see its separate Linux
desktop beside the chat. The panel starts in watch mode. **Expand** makes the
screen larger; the close button hides the panel without stopping the task.

If no computer is open, ask the bot to open a browser or use its computer.
Approve workspace access when requested. When several workspaces are available,
select the one you want from the panel's workspace menu.

## Take control

1. Click **Take control**. Linubot waits for the current computer action to
   finish, pauses the bot and loads a fresh screen.
2. Wait until the panel says you are in control. Click the screen to focus it,
   then use the pointer, keyboard, scrolling or dragging. **Paste text** sends
   text directly to the workspace; keyboard paste is also supported.
3. Complete your step, then click **Return to bot**.

The bot continues from the current screen. It cannot execute a computer action
chosen from a screen that predates your takeover without observing again.
Closing or navigating away while you have control keeps the bot paused. Reopen
Computer and return control explicitly when you are finished.

Input pauses when a fresh screen is unavailable. If the view changes or expires
while input is queued, that input is rejected with a visible message. Wait for
the live view before trying again. If another panel has taken control, your old
control session becomes invalid; you can close this panel or take control again.

## Private sign-in steps

A bot can use `request_user_control` when it needs you to sign in or complete
another private step. The request appears in the conversation and calls attention
to **Computer**. Open the panel, take control, complete the step and return
control. You do not need to put a password or a “done” message in chat.

Enter passwords only in the intended site's form inside the workspace. Live
viewer frames and your manual input are not appended as user messages or model
tool arguments in the session. Finish private entry before returning control:
the temporary workspace clipboard used for pasted text is cleared, and the bot
then observes the current screen. Those subsequent observations can
be retained in its normal task activity and sent to the selected model.

### When a site rejects sign-in

Some sites, including Google, can reject automated browsers even during manual
control. Take control and choose **Open sign-in browser**, then enter the
website you want to use. This opens regular Chrome/Chromium in the same computer
without remote debugging. Sign in yourself and return control. The bot then
uses screenshots, clicking and typing in that browser; it does not continue
reading the older automated tab. Bots can also choose `open_sign_in_browser`
before asking you to sign in.

The regular browser has a separate profile from your main desktop and the
automated browser. Open the destination website first if it uses “Sign in with
Google”; existing tabs and cookies are not transferred. Its cookies and browser state are saved for this bot or group across tasks and
app restarts. Once selected, later tasks use the regular browser too.

This removes Linubot's remote browser automation from that browser. It does not
guarantee that a site will accept a login: account, device and organization
restrictions still apply. See [Google's supported-browser guidance](https://support.google.com/accounts/answer/7675428).
For provider connections, use the supported browser OAuth flow in Settings.

Tasks have no default overall time deadline. If an explicit execution budget is
configured by an embedding caller, approval waiting, manual control and context
maintenance do not consume it. Individual model and tool requests retain their
own timeouts. **Stop** still cancels the task when you explicitly ask.

A run allows 200 model steps and 400 tool calls. If it reaches either limit,
**Continue task** appears above the message box. It starts another run in the
same conversation with the original request, success criteria and saved session
context. The prior run stays in history. Saved browser profiles can be reopened;
permissions that require approval must be granted again. Continue also works for
saved failures from the old 30-step/60-call limits. Repeated clicks reuse the same
continuation request.

## Lifetime and access

The desktop and its running applications close when the task ends. Browser
profiles live separately under the Linubot data directory in
`computer-profiles/bot_NAME/` or `computer-profiles/group_ID/`. Cookies, local
storage and browser sessions are retained across tasks, computer restarts and
application upgrades. Chrome is asked to quit before the desktop stops so it can
save session changes. A forced shutdown may lose the newest changes.

Each bot and group has its own profiles. Your personal Chrome profile is not
used. Regular and automated browsers remain separate; an account signed into
one does not automatically sign into the other. A site can expire a session or
require you to authenticate again. Existing disposable profiles from older
releases are not migrated while running; persistence starts when you sign in
with this release. Other desktop applications are not suspended or restored.

Deleting a bot or group removes its saved browser profiles, after its computer
has stopped. Standalone workspaces created without a bot/group retain disposable
browsers. Hiding the Computer panel does not change this lifetime.

The workspace uses a separate display and input target from your main desktop.
That separation is not, by itself, a filesystem or network sandbox. Initial
workspace permission covers normal interaction; executable launches and external
commitments have additional approval requirements. See [security](../SECURITY.md)
and [installation prerequisites](INSTALLATION.md#computer-tasks-and-extensions).
