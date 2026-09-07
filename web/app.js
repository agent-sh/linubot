import { initUpdates } from "./updates.js";
import { botModelPicker } from "./model-picker.js";
import { renderHome, renderSessions, renderAdvanced, previewText } from "./home.js";
import { api, post, esc, enc, icon, avatar, badge, page, empty, dialog, closeDialog, confirmAction, submit, feedback, toast, initUI } from "./ui.js";
import { renderConversation } from "./conversation.js";
import { renderLab, openRun, saveCase } from "./lab.js";
import { renderRoutines, renderLibrary, renderMemory } from "./resources.js";
import { renderSettings } from "./settings.js";
import { renderWorkspace } from "./workspace.js";
import { renderImports } from "./imports.js";

const stage = document.getElementById("main-content");
const sidebar = document.getElementById("sidebar");
const search = document.getElementById("roster-search");
const mobile = matchMedia("(max-width: 800px)");
let overview = null;
let overviewRequest = null;
let generation = 0;
let current = null;
let routeController = null;
let overviewListener = null;
let drawerReturn = null;
const renderedRosters = new WeakMap();

function routeParts() {
  try { return (location.hash.replace(/^#\/?/, "") || "home").split("/").map(decodeURIComponent); }
  catch { return ["not-found"]; }
}
function navigate(path) {
  const hash = `#/${path.replace(/^\/+/, "")}`;
  if (location.hash === hash) void renderRoute();
  else location.hash = hash;
}
function updateRoster(root, html) {
  if (renderedRosters.get(root) === html) return;
  renderedRosters.set(root, html);
  const focused = root.contains(document.activeElement) ? document.activeElement.getAttribute("href") : null;
  const scroll = root.parentElement.scrollTop;
  root.innerHTML = html;
  if (focused) [...root.querySelectorAll("a")].find((node) => node.getAttribute("href") === focused)?.focus({ preventScroll: true });
  root.parentElement.scrollTop = scroll;
}
function renderSidebar() {
  const [kind, name] = routeParts();
  document.querySelectorAll("[data-nav]").forEach((link) => {
    if (link.dataset.nav === kind || (link.dataset.nav === "advanced" && ["lab", "routines", "library", "memory", "workspace"].includes(kind))) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (!overview) return;
  const query = search.value.trim().toLowerCase();
  const bots = [...overview.bots].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || a.name.localeCompare(b.name));
  const filtered = bots.filter((bot) => `${bot.name} ${bot.topic || ""} ${bot.goal || ""}`.toLowerCase().includes(query));
  const botHTML = filtered.map((bot) => `<a class="roster-link" href="#/bot/${enc(bot.name)}"${kind === "bot" && name === bot.name ? ' aria-current="page"' : ""}>${avatar(bot.name, false, bot.mascotSeed)}<span class="roster-copy"><strong>${esc(bot.name)}${bot.pinned ? '<span class="sr-only">, pinned</span>' : ""}</strong><small>${esc(previewText(bot.preview) || bot.topic || bot.goal || "Ready to chat")}</small></span><span class="roster-tail"><span class="status-dot ${["working", "running", "awaiting_approval"].includes(bot.state) ? bot.state : ""}" title="${esc(bot.state || "idle")}"></span>${bot.unread ? `<span class="unread" aria-label="${Number(bot.unread)} unread messages">${Math.min(Number(bot.unread), 99)}${bot.unread > 99 ? "+" : ""}</span>` : ""}</span></a>`).join("");
  updateRoster(document.getElementById("bot-roster"), botHTML || `<p class="sidebar-note">${query ? "No teammates match your search." : 'Your bots will be here.'}</p>`);
  const groups = overview.groups.filter((group) => `${group.id} ${group.name} ${group.members.join(" ")}`.toLowerCase().includes(query));
  updateRoster(document.getElementById("group-roster"), groups.map((group) => `<a class="roster-link" href="#/group/${enc(group.id)}"${kind === "group" && name === group.id ? ' aria-current="page"' : ""}>${avatar(group.name, true)}<span class="roster-copy"><strong>${esc(group.name)}</strong><small>${esc(group.members.join(", "))}</small></span>${group.unread ? `<span class="unread" aria-label="${Number(group.unread)} unread messages">${Math.min(Number(group.unread), 99)}</span>` : ""}</a>`).join("") || `<p class="sidebar-note">${query ? "No matching groups." : ""}</p>`);
  const notes = overview.proposals.filter((proposal) => proposal.status === "proposed").length;
  const memories = (overview.memory?.counts.memory || 0) + (overview.memory?.counts.user || 0);
  const learningSummary = [notes ? `${notes} learning note${notes === 1 ? "" : "s"}` : "", memories ? `${memories} remembered detail${memories === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
  const indicator = document.querySelector("[data-learning-indicator]");
  indicator.hidden = !learningSummary; indicator.title = learningSummary ? `${learningSummary} available` : "";
  document.querySelector("[data-learning-summary]").textContent = learningSummary ? `${learningSummary} available` : "";
  const provider = document.getElementById("provider-status");
  provider.innerHTML = `<span class="status-dot${overview.provider.ready ? " ready" : ""}" aria-hidden="true"></span><span>${esc(overview.provider.ready ? overview.provider.model : "Connect a model")}</span>`;
  provider.title = overview.provider.ready ? "Provider configured. This does not imply a successful live test." : "Open provider settings";
}
async function refreshOverview(force = false) {
  if (overviewRequest) {
    if (!force) return overviewRequest;
    try { await overviewRequest; } catch { /* A later refresh can recover the connection. */ }
    return refreshOverview();
  }
  overviewRequest = api("/api/overview").then((data) => {
    overview = data;
    document.getElementById("server-status").textContent = "";
    renderSidebar();
    overviewListener?.(data);
    return data;
  }).catch((error) => {
    document.getElementById("server-status").textContent = "Reconnecting…";
    throw error;
  }).finally(() => { overviewRequest = null; });
  return overviewRequest;
}
const changed = () => { void refreshOverview(true).catch(() => {}); };

const services = {
  navigate, changed, getOverview: () => overview,
  createBot, createGroup, editBot, deleteBot, manageGroup,
  openRun: (id, onChange) => openRun(id, { ...services, onChange }),
  saveCase: (bot, run, onChange) => saveCase(bot, { ...services, onChange }, run),
};

function setDrawer(open, returnFocus = true) {
  if (!mobile.matches) open = false;
  if (open && !document.body.classList.contains("drawer-open")) drawerReturn = document.activeElement;
  document.body.classList.toggle("drawer-open", open);
  document.getElementById("drawer-backdrop").hidden = !open;
  document.getElementById("drawer-open").setAttribute("aria-expanded", String(open));
  sidebar.inert = mobile.matches && !open;
  stage.inert = open;
  document.querySelector(".mobile-bar").inert = open;
  if (open) document.getElementById("drawer-close").focus();
  else { if (returnFocus && drawerReturn?.isConnected) drawerReturn.focus(); drawerReturn = null; }
}

async function renderRoute({ refresh = false } = {}) {
  routeController?.abort();
  routeController = new AbortController();
  const signal = routeController.signal;
  const version = ++generation;
  overviewListener = null;
  if (!refresh) closeDialog();
  setDrawer(false, false);
  const [kind, name, pane] = routeParts();
  const ctx = {
    ...services, root: stage, signal, kind, name, pane,
    current: () => version === generation && !signal.aborted,
    get: (path, options = {}) => api(path, { ...options, signal }),
    reload: () => { if (ctx.current()) void renderRoute({ refresh: true }); },
    onCleanup: (fn) => signal.addEventListener("abort", fn, { once: true }),
    watchOverview: (fn) => { if (ctx.current()) overviewListener = fn; },
  };
  current = ctx;
  stage.innerHTML = '<div class="page loading-state"><p class="quiet-empty" role="status">Opening…</p></div>';
  stage.scrollTop = 0;
  renderSidebar();
  document.title = `${kind === "bot" || kind === "group" ? name : ({ home: "Your bots", sessions: "Sessions", advanced: "Advanced", lab: "Learning & evaluations", routines: "Routines", library: "Library", memory: "Memory", workspace: "Workspace", settings: "Settings", imports: "Import bots" }[kind] || "Not found")} | linubot`;
  try {
    if (!overview) await refreshOverview();
    if (!ctx.current()) return;
    if (kind === "home") renderHome(ctx);
    else if (["bot", "group"].includes(kind) && name) await renderConversation(ctx);
    else if (kind === "sessions") await renderSessions(ctx);
    else if (kind === "advanced") renderAdvanced(ctx);
    else if (kind === "lab") await renderLab(ctx);
    else if (kind === "routines") await renderRoutines(ctx);
    else if (kind === "library") await renderLibrary(ctx);
    else if (kind === "memory") await renderMemory(ctx);
    else if (kind === "settings") await renderSettings(ctx);
    else if (kind === "workspace") await renderWorkspace(ctx);
    else if (kind === "imports") await renderImports(ctx);
    else stage.innerHTML = page("This page is not here.", "The link may be incomplete, or the teammate may have been removed.", '<a class="button primary" href="#/home">Back to your bots</a>');
    if (ctx.current() && !refresh && !document.getElementById("app-dialog").open) stage.focus({ preventScroll: true });
  } catch (error) {
    if (!ctx.current() || error.name === "AbortError") return;
    stage.innerHTML = page("Could not open this view.", error.message, `<div class="actions"><button type="button" class="primary" data-retry>${icon("refresh")} Retry</button><a class="button" href="#/home">Your bots</a></div><p class="quiet-empty">Nothing was replaced or submitted. Conversation drafts stay in this tab.</p>`);
    stage.querySelector("[data-retry]").onclick = () => void renderRoute();
  }
}

const templates = [
  { title: "Research", topic: "Research and synthesis", goal: "Turn the sources I provide into a concise, evidence-backed brief. Separate facts, uncertainty, and open questions.", hint: "Make a decision from messy information." },
  { title: "Writing", topic: "Writing and editing", goal: "Help me write clearly in my own voice. Preserve the meaning, flag unsupported claims, and explain material edits.", hint: "Bring clarity without losing your voice." },
  { title: "Planning", topic: "Planning and prioritization", goal: "Turn my project notes into practical next steps with dependencies, risks, and a clear definition of done.", hint: "Get from a long list to the next step." },
  { title: "Your own role", topic: "", goal: "", hint: "Set a specialty that fits your work." },
];
function createBot() {
  setDrawer(false);
  let appearance = crypto.randomUUID();
  const names = ["Milo", "Pip", "Mochi", "Fern", "Nori", "Dot", "Clover", "Ollie", "Pebble", "Juniper", "Remy", "Sunny"];
  const available = names.filter((name) => !overview.bots.some((bot) => bot.name === name));
  const suggested = available.length ? available[Math.floor(Math.random() * available.length)] : "";
  const modal = dialog("Meet your new bot", `<form><div class="mascot-picker"><div data-mascot-preview>${avatar(suggested || "New bot", false, appearance)}</div><button type="button" class="small subtle" data-shuffle>${icon("refresh")} New look</button></div><label>Name<input name="name" aria-label="Bot name" autofocus value="${esc(suggested)}" required maxlength="40" pattern="[A-Za-z0-9](?:[A-Za-z0-9_]|-){0,39}" placeholder="e.g. Milo" autocomplete="off"></label><label>What can they help with?<textarea name="goal" aria-label="What can they help with?" rows="3" maxlength="4000" placeholder="Writing, research, keeping a project moving…"></textarea></label><div class="role-suggestions">${templates.slice(0, 3).map((template, index) => `<button type="button" class="small" data-template="${index}">${esc(template.title)}</button>`).join("")}</div><details class="profile-advanced"><summary>More options</summary><label>Specialty<input name="topic" maxlength="200" placeholder="Optional"></label><div data-model-settings></div></details><div data-feedback hidden></div><div class="form-actions"><button type="submit" class="primary">Add bot</button></div></form>`, { eyebrow: "Your bots" });
  const form = modal.root.querySelector("form");
  const importLink = document.createElement("button"); importLink.type = "button"; importLink.className = "small subtle"; importLink.textContent = "Import from Hermes or Grok Bot";
  importLink.onclick = () => { modal.close(); navigate("imports"); };
  form.querySelector(".form-actions").append(importLink);
  form.querySelector("button[type=submit]").disabled = true;
  const modelSettings = botModelPicker(form.querySelector("[data-model-settings]"), {}, modal.signal).then((picker) => { if (modal.alive()) form.querySelector("button[type=submit]").disabled = false; return picker; }).catch((error) => { if (modal.alive()) feedback(form, error.message); return null; });
  form.querySelector("[data-shuffle]").onclick = () => { appearance = crypto.randomUUID(); form.querySelector("[data-mascot-preview]").innerHTML = avatar(form.elements.name.value || "New bot", false, appearance); };
  form.querySelectorAll("[data-template]").forEach((button) => { button.onclick = () => { const template = templates[Number(button.dataset.template)]; form.elements.topic.value = template.topic; form.elements.goal.value = template.goal; }; });
  submit(form, async (data) => {
    const name = data.get("name").trim();
    if (overview.bots.some((bot) => bot.name === name)) throw new Error("That name is already in your team. Try another one.");
    const model = (await modelSettings)?.value();
    if (!model) throw new Error("Could not load provider choices. Reopen the bot dialog.");
    const bot = await post("/api/bots", { name, providerId: model.providerId || undefined, mascotSeed: appearance, topic: data.get("topic").trim() || undefined, goal: data.get("goal").trim() || undefined, model: model.model });
    changed();
    if (modal.alive()) { modal.close(); navigate(`bot/${enc(bot.name)}`); }
  }, "Adding your bot…");
}

async function deleteBot(name) {
  try {
    const affected = await api(`/api/bots/${enc(name)}/deletion`);
    const changes = [affected.groups.length ? `Removes this bot from ${affected.groups.length} group(s).` : "", affected.routines.length ? `Deletes ${affected.routines.length} affected routine(s).` : "", affected.emptyGroups.length ? "Empty groups are removed." : ""].filter(Boolean).join(" ");
    confirmAction(`Delete ${name}?`, `Deletes this bot’s profile, instructions and saved website logins. ${changes} Past messages and shared team memory are kept.`, async (confirmation) => {
      await api(`/api/bots/${enc(name)}`, { method: "DELETE", body: { detachReferences: true } });
      changed();
      if (confirmation.alive()) { confirmation.close(); navigate("home"); }
    }, { label: "Delete bot", danger: true });
  } catch (error) { toast(error.message); }
}

async function editBot(name) {
  const modal = dialog(`About ${name}`, '<p class="quiet-empty" role="status">Loading profile and approved skills...</p>', { eyebrow: "Teammate / Profile" });
  try {
    const [bot, installed] = await Promise.all([api(`/api/bots/${enc(name)}`, { signal: modal.signal }), api("/api/skills/installed", { signal: modal.signal })]);
    if (!modal.alive()) return;
    const approved = installed.filter((skill) => skill.status === "approved");
    let appearance = bot.mascotSeed || bot.name;
    modal.root.innerHTML = `<form data-profile><div class="mascot-picker"><div data-mascot-preview>${avatar(name, false, appearance)}</div><button type="button" class="small subtle" data-shuffle>${icon("refresh")} New look</button></div><label>What can ${esc(name)} help with?<textarea name="goal" rows="3" maxlength="4000">${esc(bot.goal)}</textarea></label><details class="profile-advanced"><summary>Model, skills & preferences</summary><label>Specialty<input name="topic" maxlength="200" value="${esc(bot.topic)}"></label><div data-model-settings></div><fieldset><legend>Approved skills</legend>${approved.length ? `<div class="skill-choices">${approved.map((skill) => `<label class="check-label"><input type="checkbox" name="skills" value="${esc(skill.name)}"${bot.skills.includes(skill.name) ? " checked" : ""}><span><strong>${esc(skill.name)}</strong><br>${esc(skill.description)}</span></label>`).join("")}</div>` : '<p class="field-hint">No approved skills to attach. Review a skill in the Library first.</p>'}${bot.skills.some((name) => !approved.some((skill) => skill.name === name)) ? '<p class="field-hint">Unavailable or unapproved attachments will be removed when you save this profile.</p>' : ""}</fieldset><label class="check-label"><input name="pinned" type="checkbox"${bot.pinned ? " checked" : ""}>Pin near the top of your bots</label></details><div data-feedback hidden></div><div class="form-actions"><button type="submit" class="primary">Save profile</button></div></form><section class="section"><details><summary>Edit instructions (soul)</summary><p class="field-hint">The teammate reads these instructions as context. Accepted lessons remain separately reviewable in the lab.</p><form data-soul><label>Instructions<textarea name="soul" rows="12" maxlength="100000">${esc(bot.soul)}</textarea></label><div data-feedback hidden></div><div class="form-actions"><button type="submit">Save instructions</button></div></form></details></section><section class="section"><div class="actions"><a class="button small" href="#/lab/${enc(name)}">Learning & tuning</a><button type="button" class="small danger" data-delete>Delete bot</button></div></section>`;
    const profile = modal.root.querySelector("[data-profile]");
    profile.querySelector("button[type=submit]").disabled = true;
    const modelSettings = botModelPicker(profile.querySelector("[data-model-settings]"), bot, modal.signal).then((picker) => { if (modal.alive()) profile.querySelector("button[type=submit]").disabled = false; return picker; }).catch((error) => { if (modal.alive()) feedback(profile, error.message); return null; });
    profile.querySelector("[data-shuffle]").onclick = () => { appearance = crypto.randomUUID(); profile.querySelector("[data-mascot-preview]").innerHTML = avatar(name, false, appearance); };
    submit(profile, async (data) => {
      const model = (await modelSettings)?.value();
      if (!model) throw new Error("Provider choices are unavailable.");
      await api(`/api/bots/${enc(name)}`, { method: "PATCH", body: { mascotSeed: appearance, topic: data.get("topic").trim(), goal: data.get("goal").trim(), model: model.model, providerId: model.providerId, skills: data.getAll("skills"), pinned: data.has("pinned") } });
      if (modal.alive()) feedback(profile, "Profile saved. New tasks will use these settings.", "success");
      changed();
      if (current?.kind === "bot" && current.name === name) current.reload();
    });
    const soul = modal.root.querySelector("[data-soul]");
    if (bot.importedContext) {
      const imported = document.createElement("section"); imported.className = "section";
      imported.innerHTML = `<details><summary>Imported memories and context</summary><p class="field-hint">This context belongs to ${esc(name)}. Edit or clear it here; shared team memory is separate.</p><form><label>Imported context<textarea name="text" rows="12" maxlength="100000">${esc(bot.importedContext)}</textarea></label><div data-feedback hidden></div><div class="form-actions"><button type="submit">Save imported context</button></div></form></details>`;
      soul.closest("section").after(imported);
      const importedForm = imported.querySelector("form");
      submit(importedForm, async (data) => { await api(`/api/bots/${enc(name)}/imported-context`, { method: "PUT", body: { text: data.get("text") } }); if (modal.alive()) feedback(importedForm, "Imported context saved for new tasks.", "success"); });
    }
    submit(soul, async (data) => {
      await api(`/api/bots/${enc(name)}/soul`, { method: "PUT", body: { soul: data.get("soul") } });
      if (modal.alive()) feedback(soul, "Instructions saved. Evaluate proposed lessons again after a context change.", "success");
      changed();
    });
    modal.root.querySelector("[data-delete]").onclick = () => deleteBot(name);
    profile.elements.topic.focus();
  } catch (error) { if (modal.alive()) feedback(modal.root, error.message); }
}

function createGroup() {
  setDrawer(false);
  const bots = overview?.bots || [];
  if (bots.length < 2) { const modal = dialog("A group needs two teammates.", `${empty("Bring complementary roles together.", "Create at least two teammates, then give them a shared brief.", '<button type="button" class="primary" data-new>Create a teammate</button>', "group")}`); modal.root.querySelector("[data-new]").onclick = createBot; return; }
  const modal = dialog("Give the team a shared brief.", `<p class="dialog-intro">Group tasks go to the selected teammates. Each response remains attributable to its author.</p><form>
    <label>Group name<input name="name" maxlength="100" placeholder="e.g. Weekly editorial" required></label><label>Group ID<input name="id" pattern="[A-Za-z0-9](?:[A-Za-z0-9_]|-){0,39}" maxlength="40" placeholder="e.g. editorial" required><small>Letters, numbers, hyphens or underscores.</small></label>
    <fieldset><legend>Members (choose at least two)</legend><div class="skill-choices">${bots.map((bot) => `<label class="check-label"><input type="checkbox" name="members" value="${esc(bot.name)}"><span><strong>${esc(bot.name)}</strong><br>${esc(bot.topic || bot.goal)}</span></label>`).join("")}</div></fieldset><div data-feedback hidden></div><div class="form-actions"><button type="submit" class="primary">Create group</button></div></form>`, { eyebrow: "Your team / New group" });
  submit(modal.root.querySelector("form"), async (data) => {
    if (data.getAll("members").length < 2) throw new Error("Choose at least two teammates.");
    const group = await post("/api/groups", { id: data.get("id").trim(), name: data.get("name").trim(), members: data.getAll("members") });
    changed(); if (modal.alive()) { modal.close(); navigate(`group/${enc(group.id)}`); }
  }, "Creating group...");
}
function manageGroup(group) {
  const modal = dialog(group.name, `<p class="dialog-intro">Members share this conversation. Queue tasks to keep the current work, or explicitly redirect the group.</p><ul class="plain-list">${group.members.map((name) => `<li><a class="button subtle" href="#/bot/${enc(name)}">${avatar(name)} ${esc(name)} ${icon("arrow")}</a></li>`).join("")}</ul><div class="form-actions"><button type="button" class="danger" data-delete>Delete group</button></div>`);
  modal.root.querySelector("[data-delete]").onclick = () => confirmAction(`Delete ${group.name}?`, "This removes the group and its saved website logins. The individual teammates remain in your roster.", async (confirmation) => { await api(`/api/groups/${enc(group.id)}`, { method: "DELETE" }); changed(); if (confirmation.alive()) { confirmation.close(); navigate("home"); } }, { label: "Delete group", danger: true });
}

initUI();
document.getElementById("new-bot").onclick = createBot;
document.getElementById("new-group").onclick = createGroup;
document.getElementById("drawer-open").onclick = () => setDrawer(true);
document.getElementById("drawer-close").onclick = () => setDrawer(false);
document.getElementById("drawer-backdrop").onclick = () => setDrawer(false);
mobile.addEventListener("change", () => setDrawer(false));
setDrawer(false, false);
search.oninput = renderSidebar;
search.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.isComposing) sidebar.querySelector(".roster-link")?.click(); });
document.querySelector(".skip-link").onclick = (event) => { event.preventDefault(); stage.focus(); };
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button?.hasAttribute("data-create-bot")) createBot();
  if (button?.dataset.run) {
    const owner = current;
    services.openRun(button.dataset.run, () => { changed(); if (owner?.current() && owner.kind === "lab") owner.reload(); });
  }
  const link = event.target.closest('a[href^="#/"]');
  if (link) { setDrawer(false, false); if (document.getElementById("app-dialog").open) closeDialog(); }
});
document.addEventListener("keydown", (event) => {
  if (document.getElementById("app-dialog").open) return;
  if (event.key === "Escape") { setDrawer(false); return; }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); if (mobile.matches) setDrawer(true); search.focus(); search.select(); }
  if ((event.metaKey || event.ctrlKey) && event.key === ",") { event.preventDefault(); navigate("settings"); }
  if (document.body.classList.contains("drawer-open") && event.key === "Tab") {
    const focusable = [...sidebar.querySelectorAll("a[href], button, input")].filter((node) => !node.disabled && node.getClientRects().length);
    if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus(); }
  }
});
window.addEventListener("hashchange", () => void renderRoute());
window.addEventListener("online", changed);
document.addEventListener("visibilitychange", () => { if (!document.hidden) changed(); });
setInterval(() => { if (!document.hidden) void refreshOverview().catch(() => {}); }, 15000);
if (!location.hash) history.replaceState(null, "", "#/home");
void renderRoute();

initUpdates();
