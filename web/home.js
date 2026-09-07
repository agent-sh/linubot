import { esc, enc, icon, avatar, date, page } from "./ui.js";

export const previewText = (value = "") => String(value).replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
const active = (state) => ["working", "running", "queued", "awaiting_approval"].includes(state);
const presence = (state) => state === "awaiting_approval" ? "Needs you" : active(state) ? "Working on it" : "Ready to chat";

/** A session is the continuing conversation with a bot or group, not one reply. */
export function sessionList(overview, runs = overview.runs || []) {
  const latest = new Map();
  for (const run of runs) if (!latest.has(run.scope) || run.createdAt > latest.get(run.scope).createdAt) latest.set(run.scope, run);
  return [
    ...overview.bots.map((bot) => ({ ...bot, kind: "bot", scope: `bot:${bot.name}`, route: bot.name })),
    ...overview.groups.map((group) => ({ ...group, kind: "group", scope: `group:${group.id}`, route: group.id })),
  ].flatMap((item) => {
    const last = latest.get(item.scope);
    if (!last && !item.preview) return [];
    return [{ ...item, snippet: previewText(item.preview || last?.response || last?.prompt), at: last?.finishedAt || last?.startedAt || last?.createdAt }];
  }).sort((a, b) => (b.at || "").localeCompare(a.at || ""));
}

function sessionRows(sessions) {
  return `<div class="session-list">${sessions.map((session) => `<a class="session-row" href="#/${session.kind}/${enc(session.route)}" aria-label="Open session with ${esc(session.name)}">${avatar(session.name, session.kind === "group", session.mascotSeed)}<span class="session-copy"><strong>${esc(session.name)}</strong><span>${esc(session.snippet || "Continue the conversation")}</span></span><span class="session-tail">${session.at ? `<time datetime="${esc(session.at)}">${esc(date(session.at))}</time>` : ""}${active(session.state) ? `<span class="session-presence"><span class="status-dot ${esc(session.state)}"></span>${presence(session.state)}</span>` : session.unread ? `<span class="unread">${Math.min(session.unread, 99)}</span>` : icon("arrow")}</span></a>`).join("")}</div>`;
}

export function renderHome(ctx) {
  ctx.root.innerHTML = `<div class="page bot-home"><header class="simple-page-header"><div><h1>Your bots</h1></div><button class="primary" type="button" data-create-bot>${icon("plus")} Add a bot</button></header><div data-connect></div><section data-home-team aria-label="Your bots"></section><section class="recent-sessions" data-home-sessions></section></div>`;
  let previous = "";
  const paint = (data) => {
    if (!ctx.current()) return;
    const signature = JSON.stringify([data.bots, data.groups, data.runs, data.provider.ready]);
    if (signature === previous) return; previous = signature;
    const focus = ctx.root.contains(document.activeElement) ? document.activeElement.getAttribute("href") : null;
    ctx.root.querySelector("[data-connect]").innerHTML = data.provider.ready ? "" : `<div class="connect-line">${icon("tool")}<span>Connect a model to start chatting.</span><div class="connect-actions"><a class="button primary" href="#/settings/provider?preset=tiyuvta">Connect Tiyuvta ${icon("arrow")}</a><a href="#/settings/provider">Other providers</a></div></div>`;
    ctx.root.querySelector("[data-home-team]").innerHTML = data.bots.length ? `<ul class="bot-grid">${data.bots.map((bot) => `<li><a class="bot-tile${active(bot.state) ? " is-working" : ""}" href="#/bot/${enc(bot.name)}" aria-label="Chat with ${esc(bot.name)}">${avatar(bot.name, false, bot.mascotSeed)}<h2>${esc(bot.name)}</h2><p>${esc(bot.topic || bot.goal || "Your everyday helper")}</p><span class="bot-presence"><span class="status-dot ${esc(bot.state || "idle")}"></span>${presence(bot.state)}${bot.unread ? `<span class="unread">${Math.min(bot.unread, 99)}</span>` : ""}</span></a></li>`).join("")}<li><button class="bot-tile bot-add" type="button" data-create-bot><span class="add-bot-symbol">${icon("plus")}</span><span>Add a bot</span></button></li></ul>` : `<div class="bot-welcome">${avatar("welcome", false, "friendly-welcome")}<h2>Who would you like a hand from?</h2><p>A writing buddy, a curious researcher, a planner.<br>Make a bot that fits your day.</p><button type="button" class="primary" data-create-bot>Add your first bot</button></div>`;
    const sessions = sessionList(data).slice(0, 3);
    ctx.root.querySelector("[data-home-sessions]").innerHTML = sessions.length ? `<div class="section-heading"><h2>Pick up a conversation</h2><a class="text-button" href="#/sessions">All sessions ${icon("arrow")}</a></div>${sessionRows(sessions)}` : "";
    if (focus) [...ctx.root.querySelectorAll("a[href]")].find((link) => link.getAttribute("href") === focus)?.focus({ preventScroll: true });
  };
  paint(ctx.getOverview()); ctx.watchOverview(paint);
}

export async function renderSessions(ctx) {
  const runs = await ctx.get("/api/runs?limit=200");
  if (!ctx.current()) return;
  ctx.root.innerHTML = `<div class="page sessions-page"><header class="simple-page-header"><div><h1>Sessions</h1><p>Pick up where you left off.</p></div></header><label class="session-search">${icon("search")}<span class="sr-only">Search sessions</span><input type="search" name="sessions" placeholder="Find a conversation" autocomplete="off"></label><div data-sessions></div></div>`;
  const search = ctx.root.querySelector("input");
  let previous = "";
  function paint() {
    const focused = ctx.root.contains(document.activeElement) ? document.activeElement.getAttribute("href") : null;
    const data = ctx.getOverview();
    const merged = new Map([...runs, ...data.runs].map((run) => [run.id, run]));
    const sessions = sessionList(data, [...merged.values()]).filter((item) => `${item.name} ${item.snippet}`.toLowerCase().includes(search.value.toLowerCase().trim()));
    const signature = JSON.stringify([sessions, search.value]);
    if (signature === previous) return; previous = signature;
    ctx.root.querySelector("[data-sessions]").innerHTML = sessions.length ? sessionRows(sessions) : `<div class="session-empty">${icon("chat")}<h2>${search.value ? "No matching conversations" : "Your conversations will be here"}</h2><p>${search.value ? "Try another name or a few words from a chat." : 'Choose a bot and say hello.'}</p><a class="text-button" href="#/home">Back to your bots ${icon("arrow")}</a></div>`;
    if (focused) [...ctx.root.querySelectorAll("a[href]")].find((link) => link.getAttribute("href") === focused)?.focus({ preventScroll: true });
  }
  search.oninput = paint; ctx.watchOverview(paint); paint();
}

export function renderAdvanced(ctx) {
  const notes = ctx.getOverview().proposals.filter((proposal) => proposal.status === "proposed").length;
  const memory = ctx.getOverview().memory;
  const memories = (memory?.counts.memory || 0) + (memory?.counts.user || 0);
  const sections = [
    ["leaf", "Learning & evaluations", "Notes your bots pick up, optional feedback, and tests.", "lab", notes ? `${notes} learning note${notes === 1 ? "" : "s"}` : ""],
    ["library", "Skills", "Find and choose what your bots know how to do.", "library", ""],
    ["tool", "Connected tools", "Add and manage MCP connections.", "settings/mcp", ""],
    ["memory", "Memory", "What your bots remember. Edit, forget, or pause updates.", "memory", memories ? `${memories} saved detail${memories === 1 ? "" : "s"}` : ""],
    ["chat", "Long conversations", "Tune compaction and working context budgets.", "settings/context", ""],
    ["clock", "Routines", "Set up recurring help and delivery.", "routines", ""],
    ["computer", "Workspaces & demonstrations", "Inspect desktops or show a bot a procedure.", "workspace", ""],
  ];
  ctx.root.innerHTML = page("Advanced", "Tools and tuning, when you want a closer look.", `<nav class="advanced-list" aria-label="Advanced tools">${sections.map(([symbol, title, text, path, note]) => `<a href="#/${path}">${icon(symbol)}<span><strong>${title}</strong><small>${text}</small></span>${note ? `<span class="learning-note">${esc(note)}</span>` : ""}${icon("arrow")}</a>`).join("")}</nav>`, "", "Your bots / Settings");
}
