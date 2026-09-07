import { remoteSkillCatalog } from "./catalog.js";
import { api, post, esc, enc, icon, badge, date, markdown, page, tabs, empty, dialog, submit, action, feedback, confirmAction, lines } from "./ui.js";

function executionRows(executions) {
  return executions.length ? executions.map((execution) => `<article class="data-card"><div class="section-heading"><div><h3>${esc(execution.job)}</h3><p class="metadata"><span>${esc(date(execution.at, true))}</span><span>${esc(execution.bot)}</span></p></div>${badge(execution.ok ? "completed" : "failed")}</div><p class="field-hint">Delivery: ${esc(execution.deliver || `bot:${execution.bot}`)}</p><details><summary>Actual result or error</summary><div class="markdown">${markdown(execution.detail || "No result detail was recorded.")}</div></details></article>`).join("") : '<p class="quiet-empty">No executions recorded yet. The server records actual dispatch and delivery results here.</p>';
}

export async function renderRoutines(ctx) {
  const [jobs, history] = await Promise.all([ctx.get("/api/jobs"), ctx.get("/api/jobs/history")]);
  if (!ctx.current()) return;
  const historyPane = ctx.name === "history";
  ctx.root.innerHTML = page("Work with a rhythm.", "Recurring briefs for named teammates, with a clear destination and a record of what happened.", `${tabs([["schedule", "Schedules", "#/routines"], ["history", "Execution history", "#/routines/history"]], historyPane ? "history" : "schedule")}<div class="notice-box">${icon("clock")}<div><strong>All schedules use UTC.</strong><p>Enabled routines run while Linubot is running. Enable background mode in the desktop menu to keep routines active with the window closed. Each due minute is dispatched at most once, including failed attempts.</p></div></div><section class="section" data-routines-content></section>`, `<button type="button" class="primary" data-new-job>${icon("plus")} New routine</button>`, "Routines / Deliberate automation");
  ctx.root.querySelector("[data-new-job]").onclick = () => jobEditor(null, jobs, ctx);
  const content = ctx.root.querySelector("[data-routines-content]");
  if (historyPane) {
    content.innerHTML = `<div class="section-heading"><h2>Execution history</h2><button type="button" class="small" data-refresh>${icon("refresh")} Refresh</button></div>${executionRows(history)}`;
    content.querySelector("[data-refresh]").onclick = ctx.reload;
    return;
  }
  content.innerHTML = `<div class="section-heading"><h2>Scheduled work</h2><button type="button" class="small" data-run-due>Dispatch routines due now</button></div><div data-due-results></div>${jobs.length ? jobs.map((job, index) => `<article class="data-card" data-job="${index}"><div class="section-heading"><div><h3>${esc(job.name)}</h3><p class="metadata"><span>${esc(job.schedule)} UTC</span><a href="#/bot/${enc(job.bot)}">${esc(job.bot)}</a></p></div>${badge(job.enabled === false ? "paused" : "approved", job.enabled === false ? "Paused" : "Enabled")}</div><dl class="detail-list"><div><dt>Next scheduled run</dt><dd>${job.enabled === false ? "Paused" : job.nextRun ? esc(date(job.nextRun, true)) : "No next time reported"}</dd></div><div><dt>Deliver to</dt><dd>${esc(job.deliver || `bot:${job.bot}`)}</dd></div></dl><details><summary>Task prompt</summary><div class="markdown">${markdown(job.prompt)}</div></details><div class="actions"><button type="button" class="small" data-toggle>${job.enabled === false ? "Enable routine" : "Pause routine"}</button><button type="button" class="small subtle" data-edit>Edit</button><button type="button" class="small subtle danger" data-delete>Delete</button></div><div data-feedback hidden></div></article>`).join("") : empty("Start with work worth repeating.", "Schedule a brief you have already found useful, and choose where the result should arrive. Nothing runs until you enable it.", '<button type="button" data-first-job>Create a routine</button>', "clock")}`;
  content.querySelector("[data-first-job]")?.addEventListener("click", () => jobEditor(null, jobs, ctx));
  content.querySelectorAll("[data-job]").forEach((row) => {
    const job = jobs[Number(row.dataset.job)];
    row.querySelector("[data-edit]").onclick = () => jobEditor(job, jobs, ctx);
    row.querySelector("[data-toggle]").onclick = () => {
      const toggle = async () => { await api(`/api/jobs/${enc(job.name)}`, { method: "PATCH", body: { enabled: job.enabled === false } }); ctx.changed(); ctx.reload(); };
      if (job.enabled === false) confirmAction(`Enable ${job.name}?`, "The local server will run this routine automatically when its UTC schedule is due. Real provider requests and configured delivery may occur with this page closed.", async (modal) => { await toggle(); if (modal.alive()) modal.close(); }, { label: "Enable routine" });
      else void action(row, toggle, "Pausing future dispatches...");
    };
    row.querySelector("[data-delete]").onclick = () => confirmAction(`Delete ${job.name}?`, "This removes the schedule, not its recorded execution history. It does not stop a task that was already dispatched.", async (modal) => { await api(`/api/jobs/${enc(job.name)}`, { method: "DELETE" }); ctx.changed(); if (modal.alive()) modal.close(); ctx.reload(); }, { label: "Delete routine", danger: true });
  });
  content.querySelector("[data-run-due]").onclick = () => confirmAction("Dispatch routines due this minute?", "This is not a simulation. Enabled routines due now can make provider requests and deliver real results. A minute already claimed by the timer will not run again.", async (modal) => {
    const executions = await post("/api/jobs/run", {}, { timeout: 135000 });
    ctx.changed();
    if (modal.alive()) {
      modal.root.innerHTML = `<p class="dialog-intro">${executions.length ? "The server returned these execution records." : "Nothing new was due. Scheduled work may already have claimed this minute."}</p>${executionRows(executions)}<div class="form-actions"><a class="button" href="#/routines/history">View execution history</a><button type="button" data-close>Close</button></div>`;
      modal.root.querySelector("[data-close]").onclick = modal.close;
    }
  }, { label: "Dispatch due routines" });
}

function jobEditor(job, jobs, ctx) {
  const { bots, groups } = ctx.getOverview();
  if (!bots.length) { const modal = dialog("Create a teammate first.", empty("A routine needs an owner.", "Choose a named teammate to receive the recurring brief.", '<button type="button" class="primary" data-create>Create teammate</button>', "clock")); modal.root.querySelector("[data-create]").onclick = ctx.createBot; return; }
  const modal = dialog(job ? `Edit ${job.name}` : "Set a useful rhythm.", `<p class="dialog-intro">Use a specific, repeatable brief. All times are UTC. New routines are paused unless you explicitly enable them.</p><form>
    <label>Routine name<input name="name" required maxlength="40" pattern="[A-Za-z0-9](?:[A-Za-z0-9_]|-){0,39}" value="${esc(job?.name)}" placeholder="e.g. weekly-plan"${job ? " readonly" : ""}><small>Letters, numbers, hyphens or underscores.</small></label>
    <div class="split"><label>Teammate<select name="bot">${bots.map((bot) => `<option${bot.name === job?.bot ? " selected" : ""}>${esc(bot.name)}</option>`).join("")}</select></label><label>Deliver result to<select name="deliver"><option value="">The assigned teammate</option>${bots.map((bot) => `<option value="bot:${esc(bot.name)}"${job?.deliver === `bot:${bot.name}` ? " selected" : ""}>Teammate: ${esc(bot.name)}</option>`).join("")}${groups.map((group) => `<option value="group:${esc(group.id)}"${job?.deliver === `group:${group.id}` ? " selected" : ""}>Group: ${esc(group.name)}</option>`).join("")}</select></label></div>
    <label>Schedule<select name="scheduleMode"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="hourly">Hourly, on the hour</option><option value="custom"${job ? " selected" : ""}>5-field cron expression</option></select></label><div class="split"><label data-day hidden>Day (UTC)<select name="day"><option value="mon">Monday</option><option value="tue">Tuesday</option><option value="wed">Wednesday</option><option value="thu">Thursday</option><option value="fri">Friday</option><option value="sat">Saturday</option><option value="sun">Sunday</option></select></label><label data-time>Time (UTC)<input name="time" type="time" value="09:00"></label></div>
    <label data-cron hidden>5-field cron (UTC)<input name="cron" value="${esc(job?.schedule)}" placeholder="0 9 * * 1-5"><small>Minute, hour, day of month, month, day of week. Example: 0 9 * * 1-5.</small></label><label>Task prompt<textarea name="prompt" required rows="5" maxlength="100000" placeholder="What should the teammate produce each time? Include stable context and the output you need.">${esc(job?.prompt)}</textarea></label>
    <label class="check-label"><input type="checkbox" name="enabled"${job && job.enabled !== false ? " checked" : ""}><span><strong>Enable on save.</strong> Dispatch automatically on this schedule while the local server runs. Provider charges may apply.</span></label><div data-feedback hidden></div><div class="form-actions"><button type="submit" class="primary">Save routine</button></div></form>`, { eyebrow: "Routines / Schedule a brief" });
  const form = modal.root.querySelector("form");
  function scheduleFields() {
    const mode = form.elements.scheduleMode.value;
    for (const [key, show] of [["day", mode === "weekly"], ["time", ["weekly", "daily"].includes(mode)], ["cron", mode === "custom"]]) {
      form.querySelector(`[data-${key}]`).hidden = !show;
      form.elements[key].disabled = !show;
      form.elements[key].required = show;
    }
  }
  form.elements.scheduleMode.onchange = scheduleFields;
  scheduleFields();
  submit(form, async (data) => {
    const name = data.get("name").trim();
    if (!job && jobs.some((item) => item.name === name)) throw new Error("A routine with that name already exists. Edit it or choose another name.");
    const mode = data.get("scheduleMode");
    const schedule = mode === "custom" ? data.get("cron").trim() : mode === "hourly" ? "hourly" : mode === "weekly" ? `weekly ${data.get("day")} ${data.get("time")}` : `daily ${data.get("time")}`;
    await post("/api/jobs", { name, bot: data.get("bot"), deliver: data.get("deliver") || undefined, schedule, prompt: data.get("prompt").trim(), enabled: data.has("enabled") });
    ctx.changed(); if (modal.alive()) modal.close(); ctx.reload();
  });
}

export async function renderLibrary(ctx) {
  const installed = await ctx.get("/api/skills/installed");
  if (!ctx.current()) return;
  const installedNames = new Set(installed.map((skill) => skill.name));
  const discover = ["discover", "local"].includes(ctx.name);
  ctx.root.innerHTML = page("Skills", "Discover, review and attach instructions to your teammates.", `${tabs([["installed", `Installed (${installed.length})`, "#/library"], ["discover", "Online catalog", "#/library/discover"], ["local", "On this machine", "#/library/local"]], discover ? ctx.name : "installed")}<div class="notice-box">${icon("library")}<div><strong>Installed does not mean attached. Draft does not mean learned.</strong><p>Review skill instructions before approval. Only approved skills can be selected in a teammate's Manage profile.</p></div></div><section class="section" data-library-content></section>`, '<a class="button small" href="#/workspace/teach">Teach by demonstration</a>', "Library / Inspectable skills");
  const main = ctx.root.querySelector("[data-library-content]");
  if (!discover) {
    main.innerHTML = `<div class="section-heading"><h2>Installed instructions</h2></div>${installed.length ? installed.map((skill, index) => `<article class="data-card"><div class="section-heading"><h3>${esc(skill.name)}</h3>${badge(skill.status || "unknown")}</div><p>${esc(skill.description || "No description supplied.")}</p><div class="actions"><button type="button" class="small" data-review-skill="${index}">Review instructions ${icon("arrow")}</button></div></article>`).join("") : empty("Add only what you need.", "Find a skill online, import a GitHub bundle or record a demonstration. You review them before use.", '<a class="button" href="#/library/discover">Discover skills</a>', "library")}`;
    main.querySelectorAll("[data-review-skill]").forEach((button) => { button.onclick = () => reviewSkill(installed[Number(button.dataset.reviewSkill)].name, ctx); });
    return;
  }
  if (ctx.name === "discover") { await remoteSkillCatalog(ctx, main); return; }
  main.innerHTML = `<form class="search-form"><label>Search discovered skill sources<input name="query" type="search" placeholder="e.g. research, writing, browser" autocomplete="off"></label><button type="submit" class="primary">${icon("search")} Search</button></form><div data-skill-results></div>`;
  const form = main.querySelector("form");
  const results = main.querySelector("[data-skill-results]");
  let request = 0, controller = null;
  async function search() {
    controller?.abort(); controller = new AbortController();
    const seq = ++request;
    results.innerHTML = '<p class="quiet-empty" role="status">Searching local sources...</p>';
    try {
      const hits = await api(`/api/skills?q=${enc(form.elements.query.value.trim())}`, { signal: controller.signal });
      if (!ctx.current() || seq !== request) return;
      results.innerHTML = hits.length ? hits.map((hit, index) => `<article class="data-card" data-hit="${index}"><div class="section-heading"><h3>${esc(hit.name)}</h3><span class="badge">${esc(hit.source)}</span></div><p>${esc(hit.description || "No description supplied.")}</p><details><summary>Source path</summary><pre class="technical">${esc(hit.path)}</pre></details><div class="actions">${installedNames.has(hit.name) ? '<a class="button small" href="#/library">Review installed copy</a>' : '<button type="button" class="small" data-install>Install a local copy</button>'}</div><div data-feedback hidden></div></article>`).join("") : empty("No matching skills found.", "Try a broader term, or create a draft through a manual demonstration.", '<a class="button" href="#/workspace/teach">Open Teach</a>', "search");
      results.querySelectorAll("[data-hit]").forEach((row) => {
        const hit = hits[Number(row.dataset.hit)];
        row.querySelector("[data-install]")?.addEventListener("click", () => void action(row, async () => {
          await post("/api/skills/install", { name: hit.name, path: hit.path });
          installedNames.add(hit.name);
          if (ctx.current() && row.isConnected) { row.querySelector(".actions").innerHTML = '<a class="button small" href="#/library">Review installed copy</a>'; feedback(row, "Copied into the local library. Review the instructions before attaching them.", "success"); }
        }, "Installing a local copy..."));
      });
    } catch (error) { if (ctx.current() && seq === request && error.name !== "AbortError") { results.innerHTML = ""; feedback(results, error.message); } }
  }
  form.onsubmit = (event) => { event.preventDefault(); void search(); };
  ctx.onCleanup(() => controller?.abort());
  void search();
}

async function reviewSkill(name, ctx) {
  const modal = dialog(`Review ${name}`, '<p class="quiet-empty" role="status">Reading the installed instructions...</p>', { wide: true, eyebrow: "Library / Skill review" });
  try {
    const skill = await api(`/api/skills/${enc(name)}`, { signal: modal.signal });
    if (!modal.alive()) return;
    modal.root.innerHTML = `<div class="section-heading"><p>${esc(skill.description || "No description supplied.")}</p>${badge(skill.status || "unknown")}</div>${skill.status === "draft" ? '<div class="notice-box warning"><p>This is a draft, not a verified or learned procedure. Review prerequisites, steps, and safety before approving it.</p></div>' : ""}<section class="section"><div class="markdown">${markdown(skill.body)}</div></section><details><summary>Raw instruction text</summary><pre class="technical">${esc(skill.body)}</pre></details>${skill.status === "draft" ? '<section class="section"><form><label class="check-label"><input type="checkbox" name="reviewed" required><span>I reviewed these instructions and their prerequisites, limitations, and safety. Approval makes this skill selectable; it does not verify the procedure or attach it to a teammate.</span></label><div data-feedback hidden></div><div class="form-actions"><button type="submit" class="primary">Approve for selection</button></div></form></section>' : '<p class="quiet-empty">To use an approved skill, select it in a teammate\'s Manage profile. Approval alone does not attach it.</p>'}`;
    const form = modal.root.querySelector("form");
    if (form) submit(form, async () => {
      await post(`/api/skills/${enc(name)}/approve`);
      ctx.changed(); ctx.reload();
      if (modal.alive()) { form.innerHTML = '<p class="notice-box">Approved for selection. Open a teammate\'s Manage profile to attach it. The procedure has not been automatically tested.</p>'; }
    }, "Saving your approval...");
  } catch (error) { if (modal.alive()) feedback(modal.root, error.message); }
}

function memoryEntries(data, personal) {
  if (Array.isArray(data)) return data;
  const entries = data.entries ?? (personal ? data.user : data.memory);
  if (!Array.isArray(entries)) throw new Error("The server did not return a memory entry list.");
  return entries;
}
export async function renderMemory(ctx) {
  const personal = ctx.name === "user";
  const endpoint = personal ? "/api/user" : "/api/memory";
  let snapshot = await ctx.get("/api/memory");
  let entries = memoryEntries(snapshot, personal);
  if (!ctx.current()) return;
  ctx.root.innerHTML = page("What your bots remember", "Useful details your bots choose to keep from conversation. You can change or forget them here.", `${tabs([["shared", "Shared memory", "#/memory"], ["user", "About you", "#/memory/user"]], personal ? "user" : "shared")}<div class="work-grid"><section><div class="section-heading"><h2>${personal ? "Your preferences and context" : "Shared facts"}</h2><span class="badge" data-entry-count></span></div><label class="search-form">Filter entries<input type="search" data-memory-search placeholder="Find a fact or preference"></label><ol class="plain-list" data-memory-list></ol><p class="field-hint">Forgetting removes a saved detail from future memory context. Existing conversation messages stay in their sessions.</p></section><aside class="page-rail"><section><form data-memory-settings><label class="check-label"><input type="checkbox" name="enabled"${snapshot.settings.enabled ? " checked" : ""}><span>Let bots update memory</span></label><p class="field-hint">Bots decide when a useful fact or preference is worth saving. Turning this off pauses their writes; saved details remain available.</p><div data-feedback hidden></div></form><h2>Add a detail yourself</h2><form class="settings-form" data-add-memory><label>New ${personal ? "preferences" : "facts"}, one per line<textarea name="entries" required rows="4" maxlength="20000" placeholder="${personal ? "e.g. I prefer concise replies." : "e.g. The project review happens each Tuesday."}"></textarea></label><div data-feedback hidden></div><button type="submit" class="primary">Add ${personal ? "context" : "to memory"}</button></form><p class="field-hint" data-memory-usage></p></section></aside></div>`, "", "Advanced / Memory");
  const list = ctx.root.querySelector("[data-memory-list]");
  const search = ctx.root.querySelector("[data-memory-search]");
  const settingsForm = ctx.root.querySelector("[data-memory-settings]");
  function paint() {
    const query = search.value.toLowerCase();
    const visible = entries.map((text, index) => ({ text, index })).filter((item) => String(item.text).toLowerCase().includes(query));
    ctx.root.querySelector("[data-entry-count]").textContent = `${entries.length} entries`;
    list.innerHTML = visible.length ? visible.map((item) => `<li class="memory-entry"><span class="entry-number" aria-hidden="true">${String(item.index + 1).padStart(2, "0")}</span><div class="memory-entry-copy"><p>${esc(item.text)}</p><div class="actions"><button class="small subtle" data-edit-memory="${item.index}">Edit</button><button class="small subtle" data-forget-memory="${item.index}">Forget</button><div data-feedback hidden></div></div></div></li>`).join("") : `<li class="quiet-empty">${entries.length ? "No entries match this filter." : "No saved details yet. Your bots can pick up useful context as you talk."}</li>`;
    const target = personal ? "user" : "memory";
    ctx.root.querySelector("[data-memory-usage]").textContent = `${snapshot.settings.chars[target]} / ${snapshot.settings.limits[target]} characters in the bot's memory context. Saved details are shared with your configured model.`;
    settingsForm.elements.enabled.checked = snapshot.settings.enabled;
  }
  async function reload() {
    const next = await ctx.get("/api/memory");
    if (!ctx.current()) return;
    snapshot = next; entries = memoryEntries(next, personal); paint();
  }
  list.onclick = (event) => {
    const edit = event.target.closest("[data-edit-memory]");
    const forget = event.target.closest("[data-forget-memory]");
    if (edit) {
      const old = entries[Number(edit.dataset.editMemory)];
      const modal = dialog("Edit remembered detail", `<form><label>Detail<textarea name="content" maxlength="2000" rows="5" required autofocus>${esc(old)}</textarea></label><div data-feedback hidden></div><div class="form-actions"><button class="primary" type="submit">Save detail</button></div></form>`);
      submit(modal.root.querySelector("form"), async (data) => {
        await api(endpoint, { method: "PATCH", body: { old_text: old, content: data.get("content") } });
        if (modal.alive()) modal.close();
        await reload(); ctx.changed();
      });
    }
    if (forget) {
      const old = entries[Number(forget.dataset.forgetMemory)];
      void action(forget, async () => { await api(endpoint, { method: "DELETE", body: { old_text: old } }); await reload(); ctx.changed(); });
    }
  };
  settingsForm.elements.enabled.onchange = () => {
    const enabled = settingsForm.elements.enabled.checked;
    void action(settingsForm, async () => {
      try { await api("/api/memory/settings", { method: "PUT", body: { enabled } }); }
      catch (error) { settingsForm.elements.enabled.checked = !enabled; throw error; }
      await reload(); ctx.changed();
    });
  };
  search.oninput = paint;
  const form = ctx.root.querySelector("[data-add-memory]");
  submit(form, async (data) => {
    const additions = lines(data.get("entries"));
    if (!additions.length) throw new Error("Write at least one nonempty entry.");
    await post(endpoint, { entries: additions });
    if (!ctx.current()) return;
    await reload();
    if (!ctx.current()) return;
    form.elements.entries.value = ""; feedback(form, "Detail saved.", "success"); ctx.changed();
  }, "Adding context...");
  let refreshing = false;
  ctx.watchOverview((data) => {
    if (refreshing || !data.memory || data.memory.revision === snapshot.settings.revision) return;
    refreshing = true;
    reload().catch((error) => { if (ctx.current()) feedback(settingsForm, error.message); }).finally(() => { refreshing = false; });
  });
  paint();
}
