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

Tasks have no default overall time deadline. If an explicit execution budget is
configured by an embedding caller, approval waiting, manual control and context
maintenance do not consume it. Individual model and tool requests retain their
own timeouts. **Stop** still cancels the task when you explicitly ask.

## Lifetime and access

The workspace and its disposable browser belong to the current task. They close
and are cleaned up when that task ends. Hiding the panel does not extend their
lifetime, and browser logins are not guaranteed to survive into another task.

The workspace uses a separate display and input target from your main desktop.
That separation is not, by itself, a filesystem or network sandbox. Initial
workspace permission covers normal interaction; executable launches and external
commitments have additional approval requirements. See [security](../SECURITY.md)
and [installation prerequisites](INSTALLATION.md#computer-tasks-and-extensions).
