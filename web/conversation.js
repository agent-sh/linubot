import { computerPanel } from "./computer-panel.js";
import { api, post, esc, enc, icon, avatar, badge, date, duration, markdown, safeArtifact, activeRun, empty, feedback, confirmAction, lines, toast } from "./ui.js";

const conversations = new Map();
const taskTemplates = [
  { title: "Distill a brief", hint: "Find the signal in your notes.", text: "Turn the notes below into a concise brief. Separate established facts, open questions, and a recommended next step.\n\nNotes:\n", criteria: "Separate facts from assumptions\nEnd with one actionable next step" },
  { title: "Review a draft", hint: "Make a piece of writing clearer.", text: "Review the draft below for clarity and unsupported claims. Preserve my meaning and voice. Return an edited version and a short list of material changes.\n\nDraft:\n", criteria: "Preserve the original meaning\nFlag claims that need evidence" },
  { title: "Plan the next step", hint: "Turn a tangle into an action.", text: "Help me turn the situation below into a practical plan. Identify dependencies, the biggest risk, and the smallest useful next step.\n\nSituation:\n", criteria: "Identify the biggest risk\nMake the next step specific and achievable" },
];

function stateFor(scope) {
  if (!conversations.has(scope)) {
    let saved = {};
    try { saved = JSON.parse(sessionStorage.getItem(`linubot:draft:${scope}`) || "{}"); } catch { /* Drafts still work in memory when storage is unavailable. */ }
    const draft = { text: typeof saved.text === "string" ? saved.text : "", criteria: typeof saved.criteria === "string" ? saved.criteria : "", mode: saved.mode === "redirect" ? "redirect" : "queue", remember: saved.remember === true, clientId: saved.clientId || null, fingerprint: saved.fingerprint || "" };
    conversations.set(scope, { draft, events: new Map(), cursor: 0, highSeq: 0, nextBefore: null, initialized: false, scrollTop: null, runs: new Map(), runsLoaded: false, runVersion: 0, sending: false, stopping: false, sendError: "", decisions: new Map(), decisionErrors: new Map(), expired: new Set(), approvalsBusy: new Set(), readSeq: 0, notify: null });
  }
  return conversations.get(scope);
}
function persist(scope, cache) {
  try { sessionStorage.setItem(`linubot:draft:${scope}`, JSON.stringify(cache.draft)); } catch { /* The in-memory draft is retained. */ }
}

// Ref-sequence pairing is independent for every tool, stage, and approval.
// A resolution can arrive before its original row is loaded from older history.
export function projectEvents(events) {
  const rows = new Map();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.kind === "state") continue;
    const paired = Number.isSafeInteger(event.refSeq) && event.refSeq > 0;
    const key = paired ? event.refSeq : event.seq;
    const previous = rows.get(key);
    rows.set(key, previous ? { ...previous, ...event, seq: key, resolvedSeq: event.seq, at: previous.at, text: previous.kind === "approval" ? previous.text : event.text || previous.text, resolution: event.text, name: event.name || previous.name } : { ...event, seq: key, resolvedSeq: event.seq });
  }
  return [...rows.values()].sort((a, b) => a.seq - b.seq);
}

export function groupActivityRows(events) {
  const rows = [];
  for (const event of events) {
    const background = event.kind === "tool" || event.kind === "thinking" || (event.kind === "file" && event.path?.startsWith("/api/screenshots/"));
    const last = rows.at(-1);
    if (background) {
      if (last?.kind === "activity_group" && last.runId === event.runId) last.events.push(event);
      else rows.push({ kind: "activity_group", seq: event.seq, runId: event.runId, events: [event] });
    } else rows.push(event);
  }
  return rows;
}

export async function renderConversation(ctx) {
  const scope = `${ctx.kind}:${ctx.name}`;
  const base = `/api/${ctx.kind === "bot" ? "bots" : "groups"}/${enc(ctx.name)}`;
  const profile = await ctx.get(base);
  if (!ctx.current()) return;
  const cache = stateFor(scope);
  if (!cache.runsLoaded) (ctx.getOverview().runs || []).filter((run) => run.scope === scope).forEach((run) => cache.runs.set(run.id, run));
    const displayName = profile.name || ctx.name;
  const subtitle = ctx.kind === "group" ? profile.members.join(", ") : profile.topic || "Here to help";
  ctx.root.innerHTML = `<header class="conversation-header"><div class="conversation-identity">${avatar(displayName, ctx.kind === "group", profile.mascotSeed)}<div><h1>${esc(displayName)}</h1><p data-bot-status>${esc(subtitle)}</p></div>${ctx.kind === "bot" ? `<a class="quiet-learning" data-bot-learning href="#/lab/${enc(ctx.name)}" aria-label="Learning notes" title="Learning notes" hidden>${icon("leaf")}</a>` : ""}</div><div class="actions"><button type="button" class="small subtle" data-computer-toggle aria-expanded="false">${icon("computer")} Computer</button><details class="conversation-menu popover" data-popover><summary class="icon-button" aria-label="Bot options">${icon("more")}</summary><div class="popover-panel"><button type="button" data-manage>${icon("user")} ${ctx.kind === "bot" ? "About this bot" : "Group settings"}</button><button type="button" data-rail-toggle aria-controls="conversation-insights" aria-expanded="false">${icon("panel")} Session details</button>${ctx.kind === "bot" ? `<a href="#/lab/${enc(ctx.name)}">${icon("leaf")} Learning & tuning</a>` : ""}<a href="#/sessions">${icon("chat")} All sessions</a>${ctx.kind === "bot" ? `<button type="button" class="danger" data-delete-bot>Delete bot</button>` : ""}</div></details></div></header>
    <div class="chat-layout"><section class="conversation-area" aria-label="Conversation"><div class="feed-toolbar"><span class="stream-state" data-stream role="status">Connecting…</span><div class="actions"><button type="button" class="small subtle" data-reconnect hidden>Reconnect</button><button type="button" class="small subtle" data-mark-read>Mark read</button></div></div><div data-history-error hidden></div><div data-run-status-error hidden></div>
    <div class="feed-scroll" tabindex="0" aria-label="Conversation history"><div class="older-row"><button type="button" class="small" data-older hidden>Earlier messages</button></div><div class="feed-inner" data-events></div><div class="feed-empty" data-empty hidden><div class="chat-welcome">${avatar(displayName, ctx.kind === "group", profile.mascotSeed)}<h2>${ctx.kind === "group" ? "Bring everyone into the conversation." : `Say hello to ${esc(displayName)}.`}</h2><p>What would you like a hand with?</p></div><div class="prompt-templates">${taskTemplates.map((template, index) => `<button type="button" class="prompt-template" data-template="${index}">${esc(template.title)}</button>`).join("")}</div></div></div>
    <div class="composer-wrap"><button type="button" class="new-messages" data-new-messages hidden>${icon("down")} New messages</button><div data-provider-gate></div><form class="composer"><div class="composer-box"><label><span class="sr-only">Message ${esc(displayName)}</span><textarea name="message" rows="2" maxlength="100000" placeholder="Message ${esc(displayName)}…" aria-describedby="composer-help">${esc(cache.draft.text)}</textarea></label><div class="composer-footer"><details class="composer-settings popover" data-popover><summary class="icon-button" aria-label="Message options">${icon("plus")}<span data-options-active class="options-dot" hidden></span></summary><div class="popover-panel"><h3>Message options</h3><label>When ${esc(displayName)} is busy<select name="mode"><option value="queue"${cache.draft.mode === "queue" ? " selected" : ""}>Send after the current message</option><option value="redirect"${cache.draft.mode === "redirect" ? " selected" : ""}>Stop and redirect</option></select></label><p class="redirect-hint" data-redirect-warning hidden>Redirect stops current and queued work in this chat.</p><label>Success criteria <span class="field-hint">Optional, one per line</span><textarea name="criteria" rows="3" maxlength="20000" placeholder="Anything the answer should include?">${esc(cache.draft.criteria)}</textarea></label>${ctx.kind === "bot" ? `<label class="check-label"><input type="checkbox" name="remember"${cache.draft.remember ? " checked" : ""}>Remember this message in shared memory</label>` : ""}</div></details><div class="actions"><button type="button" class="small danger" data-stop hidden>${icon("stop")} Stop</button><button type="submit" class="primary" data-send>${icon("send")} Send</button></div></div></div><div data-feedback hidden></div><div class="composer-hint" id="composer-help">Enter to send · Shift + Enter for a new line</div></form></div></section><aside class="insight-rail" id="conversation-insights" aria-label="Session details" hidden></aside></div>`;

  const root = ctx.root;
  const feed = root.querySelector(".feed-scroll");
  const inner = root.querySelector("[data-events]");
  const composer = root.querySelector(".composer");
  const input = composer.elements.message;
  const controls = { send: root.querySelector("[data-send]"), stop: root.querySelector("[data-stop]"), older: root.querySelector("[data-older]"), more: root.querySelector("[data-new-messages]"), rail: root.querySelector(".insight-rail") };
  const nodes = new Map();
  let source = null, reconnectTimer = null, renderFrame = null, readTimer = null, runsTimer = null;
  let retryDelay = 1000, newMessages = 0, historyBusy = false, fetchingRuns = false, runAgain = false;
  let renderReason = "mount", streamStarted = false, currentConnection = 0, railMarkup = "", providerReady = null;
  const nearBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 32;

  function gate() {
    if (!ctx.current()) return;
    const data = ctx.getOverview();
    const provider = ctx.kind === "bot" ? data.bots.find((bot) => bot.name === ctx.name)?.provider || profile.provider || data.provider
      : { ready: profile.members.every((name) => (data.bots.find((bot) => bot.name === name)?.provider || data.provider).ready) };
    if (providerReady === provider.ready) return;
    providerReady = provider.ready;
    root.querySelector("[data-provider-gate]").innerHTML = !provider.ready ? `<div class="notice-box warning provider-gate">${icon("shield")}<div><strong>Connect a model to start chatting.</strong><br><a href="#/settings/provider">Open settings</a>. Your message will stay here.</div></div>` : "";
  }
  function paintControls() {
    if (!ctx.current()) return;
    const active = [...cache.runs.values()].filter(activeRun);
    const busy = active.length > 0 || (!cache.runsLoaded && ["working", "queued", "awaiting_approval"].includes(profile.state));
    controls.stop.hidden = !busy;
    controls.stop.disabled = cache.stopping;
    controls.stop.title = "Stop current and queued tasks in this conversation";
    controls.send.disabled = cache.sending;
    controls.send.innerHTML = `${icon(cache.sending ? "clock" : "send")} ${cache.sending ? "Sending…" : cache.draft.mode === "redirect" ? "Redirect" : "Send"}`;
    root.querySelector("[data-redirect-warning]").hidden = cache.draft.mode !== "redirect";
    root.querySelector("[data-options-active]").hidden = !cache.draft.criteria && !cache.draft.remember && cache.draft.mode === "queue";
    root.querySelector("[data-bot-status]").textContent = active.some((run) => run.status === "awaiting_approval") ? "Needs you for a moment" : busy ? "Working on it…" : subtitle;
    root.querySelector(".conversation-identity").classList.toggle("is-working", busy);
    const learning = root.querySelector("[data-bot-learning]");
    if (learning) { const count = ctx.getOverview().proposals.filter((proposal) => proposal.bot === ctx.name && proposal.status === "proposed").length; learning.hidden = !count; learning.title = `${count} learning note${count === 1 ? "" : "s"}`; }
    if (cache.sendError) feedback(composer, cache.sendError);
    gate();
    paintRail();
  }
  function paintRail() {
    const runs = [...cache.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const active = runs.filter(activeRun);
    const run = active.find((item) => item.status !== "queued") || active[0] || runs[0];
    const html = `<div class="section-heading"><h2>Session details</h2><button type="button" class="icon-button" data-close-rail aria-label="Close session details">${icon("close")}</button></div>${ctx.kind === "bot" ? `<section class="section"><h3>About ${esc(profile.name)}</h3><p>${esc(profile.goal || profile.topic || "Your everyday helper.")}</p></section>` : ""}<section class="section">${run ? `<h3>${active.length ? "In progress" : "Latest exchange"}</h3><p>${esc(run.prompt.slice(0, 300))}${run.prompt.length > 300 ? "…" : ""}</p>${active.length > 1 ? `<p class="muted">${active.filter((item) => item.status === "queued").length} messages queued</p>` : ""}<dl class="detail-list"><div><dt>Time</dt><dd>${esc(duration(run.durationMs))}</dd></div><div><dt>Tool calls</dt><dd>${run.toolCalls ?? "—"}</dd></div></dl>${run.criteria?.length ? `<details><summary>Success criteria</summary><ul>${run.criteria.map((criterion) => `<li>${esc(criterion)}</li>`).join("")}</ul></details>` : ""}<button type="button" class="text-button" data-run="${esc(run.id)}">Feedback & evaluation ${icon("arrow")}</button>` : '<p class="muted">Messages and activity will appear as you chat.</p>'}</section><section class="section"><a class="text-button" href="#/settings/context">Long conversation settings</a></section>${ctx.kind === "bot" ? `<section class="section"><a class="text-button" href="#/lab/${enc(ctx.name)}">${icon("leaf")} Learning & tuning</a></section>` : ""}`;

    if (html === railMarkup) return;
    railMarkup = html;
    const focused = controls.rail.contains(document.activeElement);
    controls.rail.innerHTML = html;
    controls.rail.querySelector("[data-close-rail]").onclick = () => toggleRail(false);
    if (focused) controls.rail.querySelector("[data-close-rail]").focus({ preventScroll: true });
  }
  function toggleRail(open) {
    controls.rail.hidden = !open;
    root.querySelector(".chat-layout").classList.toggle("rail-open", open);
    root.querySelector("[data-rail-toggle]").setAttribute("aria-expanded", String(open));
  }
  const computer = computerPanel(ctx, root.querySelector("[data-computer-toggle]"), () => toggleRail(false));
  root.querySelector("[data-delete-bot]")?.addEventListener("click", () => { root.querySelector(".conversation-menu").open = false; ctx.deleteBot(ctx.name); });
  root.querySelector("[data-rail-toggle]").onclick = async () => { if (await computer.close()) toggleRail(controls.rail.hidden); root.querySelector(".conversation-menu").open = false; };
  root.querySelector("[data-manage]").onclick = () => { root.querySelector(".conversation-menu").open = false; ctx.kind === "bot" ? ctx.editBot(ctx.name) : ctx.manageGroup(profile); };
  root.addEventListener("click", (event) => { root.querySelectorAll("[data-popover][open]").forEach((details) => { if (!details.contains(event.target)) details.open = false; }); });
  root.addEventListener("keydown", (event) => { if (event.key === "Escape") root.querySelectorAll("[data-popover][open]").forEach((details) => { details.open = false; details.querySelector("summary").focus(); }); });

  function eventNode(event) {
    const node = document.createElement("article");
    node.dataset.seq = event.seq;
    if (event.kind === "message") {
      const fromUser = event.from === "user" || String(event.from || "").startsWith("cron:");
      node.className = `message${fromUser ? " user-message" : ""}`;
      const run = cache.runs.get(event.runId);
      const bot = ctx.getOverview().bots.find((item) => item.name === event.from);
      node.innerHTML = `<header class="message-head">${fromUser ? "" : avatar(event.from, false, bot?.mascotSeed)}<strong>${esc(event.from === "user" ? "You" : event.from || displayName)}</strong><time datetime="${esc(event.at)}">${esc(date(event.at))}</time></header><div class="message-body${fromUser ? "" : " markdown"}">${fromUser ? esc(event.text) : markdown(event.text)}</div>${!fromUser && event.runId ? `<div class="message-tools"><details class="message-menu popover" data-popover><summary class="icon-button" aria-label="Reply options">${icon("more")}</summary><div class="popover-panel"><button type="button" data-run="${esc(event.runId)}">Feedback & evaluation</button>${run?.status === "completed" ? `<button type="button" data-case="${esc(run.id)}">Use for an evaluation</button>` : ""}</div></details></div>` : ""}`;
    } else if (event.kind === "activity_group") {
      node.className = "activity-group";
      const pending = event.events.findLast((item) => item.status === "pending");
      const count = event.events.filter((item) => item.kind === "tool").length;
      const labels = { web_search: "Searching the web", read_webpage: "Reading a page", save_artifact: "Putting something together", propose_learning: "Finishing up", start_workspace: "Opening a workspace", observe_workspace: "Taking a look", browse_workspace: "Browsing", workspace_action: "Working in the browser" };
      const label = pending ? (labels[pending.name] || (pending.kind === "thinking" ? "Working on it…" : "Using a tool")) : "Activity";
      node.innerHTML = `<details data-disclosure="group-${event.seq}"><summary><span class="activity-dot${pending ? " active" : ""}"></span><span>${label}</span>${count ? `<small>${count} tool${count === 1 ? "" : "s"}</small>` : ""}${icon("down")}</summary><div class="activity-items"></div></details>`;
      const items = node.querySelector(".activity-items");
      event.events.forEach((item) => items.append(eventNode(item)));

    } else if (event.kind === "tool" || event.kind === "thinking") {
      node.className = `activity${event.status === "error" ? " error" : ""}`;
      const label = event.kind === "tool" ? (event.name || "Tool call").replaceAll("_", " ") : event.text || event.stage || "Observable activity";
      node.innerHTML = `<details data-disclosure="event-${event.seq}"><summary>${icon(event.kind === "tool" ? "tool" : "clock")}<span>${esc(label)}</span>${badge(event.status || "unknown")}${icon("down", "chevron")}</summary><div class="activity-detail">${esc(event.detail || event.preview || (event.kind === "tool" ? event.text : "") || "No further detail was recorded.")}${event.durationMs != null ? `<p>Duration: ${esc(duration(event.durationMs))}</p>` : ""}${event.runId ? `<p>Task: ${esc(event.runId)}</p>` : ""}</div></details>`;
    } else if (event.kind === "approval") {
      const decided = event.status !== "pending" ? event.status : cache.decisions.get(event.seq);
      const pending = !decided && !cache.expired.has(event.seq);
      if (!pending) {
        node.className = "approval-record";
        node.innerHTML = `<details><summary>${icon(decided === "approved" ? "check" : "shield")} ${decided === "approved" ? "Permission granted" : "Permission closed"}</summary><p>${esc(event.detail || event.text)}</p></details>`;
        return node;
      }
      node.className = "approval";
      node.innerHTML = `<h3>${icon("shield")} ${pending ? "Your approval is needed" : "Approval record"} ${badge(decided || (cache.expired.has(event.seq) ? "unavailable" : "pending"))}</h3><p>${esc(event.text)}</p>${event.detail ? `<details><summary>Review action details</summary><pre class="technical">${esc(event.detail)}</pre></details>` : ""}<p class="field-hint">${pending ? "This permission is for this action only. Review the target and network access before approving." : "This request is no longer actionable."}</p>${pending ? `<div class="actions"><button type="button" class="primary" data-decision="approved" data-approval="${event.seq}"${cache.approvalsBusy.has(event.seq) ? " disabled" : ""}>Approve once</button><button type="button" data-decision="denied" data-approval="${event.seq}"${cache.approvalsBusy.has(event.seq) ? " disabled" : ""}>Deny</button></div>` : ""}${cache.decisionErrors.has(event.seq) ? `<p class="form-feedback error" role="alert">${esc(cache.decisionErrors.get(event.seq))}</p>` : ""}`;
    } else if (event.kind === "file") {
      node.className = "file-event";
      const href = safeArtifact(event.path);
      node.innerHTML = href ? `<a class="artifact" href="${esc(href)}" download>${icon("file")}<span>${esc(event.name || event.text || "Download artifact")}</span>${icon("arrow")}</a>` : `<p class="feed-notice">Artifact link unavailable: ${esc(event.name || event.path || "No safe download path was recorded.")}</p>`;
    } else {
      node.className = `feed-notice${event.status === "error" ? " error" : ""}`;
      node.textContent = event.kind === "handoff" ? `${event.from || "Teammate"} handed work to ${event.to || "another teammate"}. ${event.text || ""}` : event.text || event.status || "Recorded activity";
    }
    return node;
  }
  function paintEvents(reason = "live") {
    if (!ctx.current()) return;
    const bottom = nearBottom();
    const top = feed.getBoundingClientRect().top;
    const anchor = [...inner.children].find((node) => node.getBoundingClientRect().bottom > top);
    const anchorSeq = anchor?.dataset.seq;
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - top : 0;
    const oldScroll = feed.scrollTop;
    const projected = groupActivityRows(projectEvents(cache.events.values()));
    const keep = new Set();
    let cursor = inner.firstChild;
    for (const event of projected) {
      keep.add(event.seq);
      const signature = JSON.stringify([event, cache.runs.get(event.runId)?.status, cache.runs.get(event.runId)?.feedback, cache.decisions.get(event.seq), cache.decisionErrors.get(event.seq), cache.approvalsBusy.has(event.seq), cache.expired.has(event.seq)]);
      let entry = nodes.get(event.seq);
      if (!entry || entry.signature !== signature) {
        const node = eventNode(event);
        if (entry) {
          const disclosures = new Set([...entry.node.querySelectorAll("[data-disclosure][open]")].map((details) => details.dataset.disclosure));
          node.querySelectorAll("[data-disclosure]").forEach((details) => { details.open = disclosures.has(details.dataset.disclosure); });
          const opened = entry.node.querySelector("details")?.open;
          if (opened && node.querySelector("details")) node.querySelector("details").open = true;
          if (cursor === entry.node) cursor = node;
          const focused = entry.node.contains(document.activeElement);
          entry.node.replaceWith(node);
          if (focused) { node.tabIndex = -1; node.focus({ preventScroll: true }); }
        }
        entry = { node, signature }; nodes.set(event.seq, entry);
      }
      if (entry.node !== cursor) inner.insertBefore(entry.node, cursor);
      cursor = entry.node.nextSibling;
    }
    for (const [seq, entry] of nodes) if (!keep.has(seq)) { entry.node.remove(); nodes.delete(seq); }
    root.querySelector("[data-empty]").hidden = projected.length > 0 || !cache.initialized;
    controls.older.hidden = !cache.nextBefore;
    controls.older.disabled = historyBusy;
    if (reason === "mount") feed.scrollTop = cache.scrollTop ?? feed.scrollHeight;
    else if (reason === "initial" || (bottom && reason !== "older")) { feed.scrollTop = feed.scrollHeight; newMessages = 0; }
    else {
      const nextAnchor = anchorSeq && nodes.get(Number(anchorSeq))?.node;
      feed.scrollTop = nextAnchor ? oldScroll + nextAnchor.getBoundingClientRect().top - top - anchorOffset : oldScroll;
    }
    controls.more.hidden = newMessages === 0;
    controls.more.innerHTML = `${icon("down")} ${newMessages} new message${newMessages === 1 ? "" : "s"}`;
    if (nearBottom()) scheduleRead();
  }
  function scheduleRender(reason = "live") {
    if (["older", "initial"].includes(reason)) renderReason = reason;
    else if (!renderFrame) renderReason = reason;
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => { renderFrame = null; paintEvents(renderReason); paintControls(); });
  }
  function mergeEvents(events, live = false) {
    for (const event of events) {
      if (!Number.isSafeInteger(event.seq) || event.seq < 1) continue;
      if (live) cache.cursor = Math.max(cache.cursor, event.seq);
      cache.highSeq = Math.max(cache.highSeq, event.seq);
      if (cache.events.has(event.seq)) continue;
      cache.events.set(event.seq, event);
      if (live && event.kind === "message" && !nearBottom()) newMessages++;
      if (live && (event.kind === "state" || event.kind === "message")) {
        cache.runVersion++;
        if (event.kind === "state" && event.runId && cache.runs.has(event.runId)) {
          const mapped = event.status === "working" ? "running" : event.status;
          if (["queued", "running", "awaiting_approval", "completed", "failed", "cancelled", "interrupted"].includes(mapped)) cache.runs.set(event.runId, { ...cache.runs.get(event.runId), status: mapped });
        }
        clearTimeout(runsTimer); runsTimer = setTimeout(refreshRuns, 200);
      }
    }
  }

  async function history(older = false) {
    if (historyBusy || (older && !cache.nextBefore)) return;
    historyBusy = true; controls.older.disabled = true;
    const initial = !cache.initialized;
    try {
      const result = await ctx.get(`/api/feed/${enc(scope)}?limit=50${older ? `&before=${cache.nextBefore}` : ""}`);
      if (!ctx.current()) return;
      mergeEvents(result.entries);
      if (initial || older) cache.nextBefore = result.nextBeforeSeq;
      cache.initialized = true;
      if (!streamStarted) {
        cache.cursor = Math.max(cache.cursor, Number(result.lastSeq) || cache.highSeq);
        connect();
      }
      const errorBox = root.querySelector("[data-history-error]"); errorBox.hidden = true; errorBox.textContent = "";
      scheduleRender(older ? "older" : initial ? "initial" : "history");
    } catch (error) {
      if (!ctx.current() || error.name === "AbortError") return;
      const errorBox = root.querySelector("[data-history-error]"); errorBox.hidden = false;
      errorBox.innerHTML = `<div class="form-feedback error" role="alert">${esc(error.message)} <button type="button" class="small" data-retry-history>Retry ${older ? "earlier activity" : "history"}</button></div>`;
      errorBox.querySelector("button").onclick = () => void history(older);
      if (!streamStarted) setConnection("History unavailable. Retry to reconnect.", true);
    } finally { historyBusy = false; if (ctx.current()) controls.older.disabled = false; }
  }
  function setConnection(message, error = false) {
    if (!ctx.current()) return;
    const node = root.querySelector("[data-stream]"); node.classList.toggle("error", error);
    node.innerHTML = `<span class="status-dot${error ? "" : " ready"}" aria-hidden="true"></span>${esc(message)}`;
    root.querySelector("[data-reconnect]").hidden = !error;
  }
  function connect() {
    if (!ctx.current()) return;
    clearTimeout(reconnectTimer); source?.close();
    const connection = ++currentConnection;
    streamStarted = true;
    setConnection("Connecting to activity...");
    source = new EventSource(`/api/stream?scope=${enc(scope)}&after=${cache.cursor}`);
    source.onopen = () => { if (!ctx.current() || connection !== currentConnection) return; retryDelay = 1000; setConnection("Connected"); void refreshRuns(); };
    source.onmessage = (message) => {
      if (!ctx.current() || connection !== currentConnection) return;
      try {
        const event = JSON.parse(message.data);
        if (!Number.isSafeInteger(event.seq)) throw new Error("Missing sequence");
        mergeEvents([event], true); scheduleRender();
      } catch { reconnect("Activity could not be read. Reconnecting..."); }
    };
    source.onerror = () => { if (ctx.current() && connection === currentConnection) reconnect("Disconnected. Replaying missed activity on reconnect."); };
  }
  function reconnect(message) {
    source?.close(); currentConnection++;
    setConnection(message, true);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  }
  root.querySelector("[data-reconnect]").onclick = () => { if (!cache.initialized) void history(); else connect(); };

  async function refreshRuns() {
    if (!ctx.current()) return;
    if (fetchingRuns) { runAgain = true; return; }
    fetchingRuns = true;
    const version = cache.runVersion;
    try {
      const runs = await ctx.get(`/api/runs?scope=${enc(scope)}&limit=200`);
      if (!ctx.current()) return;
      if (version === cache.runVersion) {
        runs.filter((run) => run.scope === scope).forEach((run) => cache.runs.set(run.id, run));
        cache.runsLoaded = true;
        root.querySelector("[data-run-status-error]").hidden = true;
        paintControls(); scheduleRender("runs");
      } else runAgain = true;
    } catch (error) {
      if (ctx.current() && error.name !== "AbortError") {
        const box = root.querySelector("[data-run-status-error]");
        if (box.hidden) {
          box.hidden = false;
          box.innerHTML = '<p class="form-feedback error" role="alert">Could not refresh this session. <button type="button" class="small">Retry status</button></p>';
          box.querySelector("button").onclick = () => void refreshRuns();
        }
      }
    } finally {
      fetchingRuns = false;
      if (runAgain && ctx.current()) { runAgain = false; clearTimeout(runsTimer); runsTimer = setTimeout(refreshRuns, 300); }
    }
  }
  async function markRead(force = false) {
    if (!ctx.current() || !cache.initialized || (!force && (!nearBottom() || document.hidden)) || cache.highSeq <= cache.readSeq) return;
    const seq = cache.highSeq;
    try { await post(`${base}/read`, { seq }); cache.readSeq = Math.max(cache.readSeq, seq); ctx.changed(); }
    catch (error) { if (force && ctx.current()) feedback(composer, `Could not mark read: ${error.message}`); }
  }
  function scheduleRead() { clearTimeout(readTimer); readTimer = setTimeout(() => void markRead(), 650); }
  root.querySelector("[data-mark-read]").onclick = () => void markRead(true);
  controls.older.onclick = () => void history(true);
  controls.more.onclick = () => { feed.scrollTop = feed.scrollHeight; newMessages = 0; controls.more.hidden = true; scheduleRead(); };
  feed.addEventListener("scroll", () => { cache.scrollTop = feed.scrollTop; if (nearBottom()) { newMessages = 0; controls.more.hidden = true; scheduleRead(); } }, { passive: true });

  function saveDraft() {
    cache.draft.text = input.value;
    cache.draft.criteria = composer.elements.criteria.value;
    cache.draft.mode = composer.elements.mode.value;
    cache.draft.remember = composer.elements.remember?.checked || false;
    persist(scope, cache); paintControls();
  }
  composer.addEventListener("input", saveDraft);
  composer.elements.mode.addEventListener("change", saveDraft);
  root.querySelectorAll("[data-template]").forEach((button) => { button.onclick = () => {
    if (input.value.trim()) { toast("Your draft is already in progress. Clear it before choosing a template."); input.focus(); return; }
    const template = taskTemplates[Number(button.dataset.template)];
    input.value = template.text; composer.elements.criteria.value = template.criteria;
    saveDraft(); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  }; });

  async function sendTask() {
    if (cache.sending || !cache.draft.text.trim()) return;
    if (lines(cache.draft.criteria).length > 20) { feedback(composer, "Use at most 20 success criteria, one per line."); return; }
    const execute = async () => {
      const payload = { criteria: lines(cache.draft.criteria), mode: cache.draft.mode, ...(ctx.kind === "bot" ? { bot: ctx.name, message: cache.draft.text, remember: cache.draft.remember } : { text: cache.draft.text }) };
      const fingerprint = JSON.stringify(payload);
      if (fingerprint !== cache.draft.fingerprint || !cache.draft.clientId) { cache.draft.fingerprint = fingerprint; cache.draft.clientId = crypto.randomUUID(); }
      payload.clientId = cache.draft.clientId;
      persist(scope, cache);
      cache.sending = true; cache.sendError = "";
      feedback(composer, "");
      paintControls();
      try {
        const result = await post(ctx.kind === "bot" ? "/api/chat" : `${base}/post`, payload);
        const acceptedRuns = (result?.runs || [result?.run]).filter(Boolean);
        if (!acceptedRuns.length || acceptedRuns.some((run) => !run.id || run.scope !== scope || typeof run.prompt !== "string" || typeof run.createdAt !== "string" || !["queued", "running", "awaiting_approval", "completed", "failed", "cancelled", "interrupted"].includes(run.status))) {
          throw new Error("The server did not return a complete task record. Your draft and request ID were kept so a retry will not intentionally submit a new task.");
        }
        cache.runVersion++;
        acceptedRuns.forEach((run) => { if (!cache.runs.has(run.id)) cache.runs.set(run.id, run); });
        if (cache.draft.text === (payload.message ?? payload.text) && cache.draft.clientId === payload.clientId) {
          cache.draft.text = ""; cache.draft.clientId = null; cache.draft.fingerprint = "";
          if (cache.draft.remember === payload.remember) cache.draft.remember = false;
          persist(scope, cache);
        }
        cache.notify?.("accepted");
        if (ctx.current()) { feedback(composer, ""); void refreshRuns(); }
        ctx.changed();
      } catch (error) {
        cache.sendError = error.status === 409 && /provider|model|key/i.test(error.message) ? `${error.message} Open Settings to configure a provider and exact model. Your draft has been kept.` : error.message;
        cache.notify?.("error"); ctx.changed();
      } finally { cache.sending = false; cache.notify?.("controls"); }
    };
    if (cache.draft.mode === "redirect") {
      confirmAction("Replace the work in this conversation?", "Redirect cancels current and queued tasks here before submitting this new brief. Choose Queue next task instead if you want to keep that work.", async (modal) => { modal.close(); if (ctx.current()) await execute(); }, { label: "Cancel old work and redirect", danger: true });
    } else await execute();
  }
  composer.addEventListener("submit", (event) => { event.preventDefault(); saveDraft(); void sendTask(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!cache.sending) composer.requestSubmit(); }
  });
  controls.stop.onclick = async () => {
    if (cache.stopping) return;
    cache.stopping = true; paintControls();
    try {
      const result = await post("/api/stop", { scope });
      cache.runVersion++;
      if (ctx.current()) { feedback(composer, result.stopped ? `Stop requested for ${result.count ?? "active"} task${result.count === 1 ? "" : "s"}. Updating their recorded status...` : "No active tasks were stopped.", "info"); void refreshRuns(); }
      ctx.changed();
    } catch (error) { if (ctx.current()) feedback(composer, error.message); }
    finally { cache.stopping = false; cache.notify?.("controls"); }
  };
  feed.addEventListener("click", async (event) => {
    const decision = event.target.closest("[data-decision]");
    if (decision) {
      const seq = Number(decision.dataset.approval);
      if (cache.approvalsBusy.has(seq) || cache.decisions.has(seq) || cache.expired.has(seq)) return;
      cache.approvalsBusy.add(seq); cache.decisionErrors.delete(seq); scheduleRender();
      try {
        await post("/api/approvals", { scope, seq, decision: decision.dataset.decision });
        cache.decisions.set(seq, decision.dataset.decision);
        if (ctx.current()) { void history(); void refreshRuns(); }
        ctx.changed();
      } catch (error) {
        cache.decisionErrors.set(seq, error.message);
        if ([404, 410].includes(error.status) || /expired|already|no longer|not pending/i.test(error.message)) cache.expired.add(seq);
      } finally { cache.approvalsBusy.delete(seq); cache.notify?.("events"); if (ctx.current()) input.focus({ preventScroll: true }); }
    }
    const test = event.target.closest("[data-case]");
    if (test) { const run = cache.runs.get(test.dataset.case); if (run) ctx.saveCase(run.bot, run, ctx.changed); }
  });

  const notify = (kind) => {
    if (!ctx.current()) return;
    if (kind === "accepted") { input.value = cache.draft.text; if (composer.elements.remember) composer.elements.remember.checked = cache.draft.remember; }
    paintControls(); scheduleRender();
  };
  cache.notify = notify;
  paintControls(); paintEvents("mount");
  if (cache.initialized) connect();
  void history(); void refreshRuns();
  const poll = setInterval(() => { if (!document.hidden) void refreshRuns(); }, 5000);
  ctx.watchOverview(() => { gate(); paintControls(); });
  ctx.onCleanup(() => {
    cache.scrollTop = feed.scrollTop;
    if (cache.notify === notify) cache.notify = null;
    source?.close(); currentConnection++;
    clearTimeout(reconnectTimer); clearTimeout(readTimer); clearTimeout(runsTimer); clearInterval(poll);
    if (renderFrame) cancelAnimationFrame(renderFrame);
  });
}
