import { api, post, esc, enc, icon, badge, date, page, tabs, empty, dialog, submit, action, feedback, confirmAction } from "./ui.js";

const acknowledgement = "I understand this creates a separate agent-controlled desktop, not my current desktop. It can use the network allowed by its workspace configuration and may open a local viewer.";

export async function renderWorkspace(ctx) {
  const teach = ctx.name === "teach";
  ctx.root.innerHTML = page(teach ? "Show the steps. Keep a draft." : "A separate place to work.", teach ? "Demonstrate a real task, capture the important states, and write down the procedure. Review it before putting it to use." : "Owned, purpose-labeled workspaces for computer tasks. Creation, manual input, and cleanup stay explicit.", `${tabs([["workspaces", "Owned workspaces", "#/workspace"], ["teach", "Teach by demonstration", "#/workspace/teach"]], teach ? "teach" : "workspaces")}<div data-workspace-pane><p class="quiet-empty" role="status">Reading local records...</p></div>`, `<button type="button" class="primary" data-new>${icon("plus")} ${teach ? "New demonstration" : "Start workspace"}</button>`, teach ? "Workspace / Teach" : "Workspace / Separate desktops");
  ctx.root.querySelector("[data-new]").onclick = () => startWorkspace(ctx, teach);
  const main = ctx.root.querySelector("[data-workspace-pane]");
  if (teach) await demonstrations(ctx, main);
  else await ownedWorkspaces(ctx, main);
}

function startWorkspace(ctx, demo = false) {
  const bots = ctx.getOverview().bots;
  if (demo && !bots.length) {
    const modal = dialog("Choose a teammate first.", empty("Teach a named teammate.", "Create a teammate before recording a procedure for it.", '<button type="button" class="primary" data-create>Create teammate</button>', "user"));
    modal.root.querySelector("[data-create]").onclick = ctx.createBot;
    return;
  }
  const modal = dialog(demo ? "Start a manual demonstration." : "Start a separate workspace.", `<p class="dialog-intro">${demo ? "This starts an owned workspace and records an initial screenshot. Open its viewer to demonstrate the task, then capture meaningful steps." : "Use a specific purpose so you can recognize the workspace later. Only workspaces created by linubot appear in this view."}</p><form>${demo ? `<label>Teammate<select name="bot">${bots.map((bot) => `<option>${esc(bot.name)}</option>`).join("")}</select></label>` : ""}<label>Purpose<textarea name="purpose" rows="3" required maxlength="1800" placeholder="${demo ? "What repeatable task are you going to demonstrate?" : "What real task should happen in this workspace?"}"></textarea></label><label class="check-label"><input type="checkbox" name="acknowledge" required><span>${acknowledgement}</span></label><div data-feedback hidden></div><div class="form-actions"><button type="submit" class="primary">${demo ? "Start demonstration" : "Create workspace"}</button></div></form>`);
  submit(modal.root.querySelector("form"), async (data) => {
    if (!data.has("acknowledge")) throw new Error("Explicitly acknowledge the separate desktop and its network access before starting.");
    const result = await post(demo ? "/api/demos" : "/api/computer/start", { purpose: data.get("purpose").trim(), acknowledge: true, ...(demo ? { bot: data.get("bot") } : {}) }, { timeout: 90000 });
    if (!(demo ? result?.workspaceId : result?.id) || result.dryRun === true) throw new Error("No created workspace ID was confirmed. Refresh the workspace records before trying to create another.");
    ctx.changed(); ctx.reload();
    if (modal.alive()) {
      modal.root.innerHTML = `<div class="notice-box">${icon("check")}<div><strong>${demo ? "Demonstration started." : "Workspace created."}</strong><p>${esc(result.purpose || data.get("purpose"))}</p></div></div><dl class="detail-list"><div><dt>Owned workspace ID</dt><dd>${esc(demo ? result.workspaceId : result.id)}</dd></div></dl><p class="quiet-empty">${demo ? "Open the viewer, demonstrate the procedure, and capture each important state. Finishing produces a draft for review, not a learned skill." : "Use the workspace's own controls to open its viewer, stop its apps, or clean up when you are finished."}</p><div class="form-actions"><button type="button" data-close>Close</button><a class="button primary" href="${demo ? "#/workspace/teach" : "#/workspace"}">View ${demo ? "demonstrations" : "workspaces"}</a></div>`;
      modal.root.querySelector("[data-close]").onclick = modal.close;
    }
  }, demo ? "Starting the workspace and capturing its initial state..." : "Starting an owned workspace...");
}

async function ownedWorkspaces(ctx, main) {
  const result = await ctx.get("/api/computer/list", { timeout: 60000 });
  if (!ctx.current()) return;
  let workspaces;
  try { workspaces = JSON.parse(result.report).workspaces; if (!Array.isArray(workspaces)) throw new Error(); }
  catch { throw new Error("The workspace backend returned an unreadable owned-workspace list. No workspace controls were enabled."); }
  main.innerHTML = `<div class="notice-box">${icon("shield")}<div><strong>Only linubot-owned workspaces.</strong><p>These controls do not adopt or target unrelated desktops. Stop a workspace before cleaning its runtime files.</p></div></div><section class="section"><div class="section-heading"><h2>Owned workspaces</h2><button type="button" class="small" data-refresh>${icon("refresh")} Refresh status</button></div><div class="workspace-list">${workspaces.length ? workspaces.map((workspace, index) => `<article class="workspace-card" data-workspace="${index}"><div class="section-heading"><h3>${esc(workspace.purpose)}</h3>${badge(workspace.error ? "unknown" : workspace.state === "stopped" ? "stopped" : workspace.status?.ready === true ? "running" : "unknown", workspace.error ? "Live status unavailable" : workspace.state === "stopped" ? "Stopped" : workspace.status?.ready === true ? "Running" : "Not confirmed ready")}</div><dl class="detail-list"><div><dt>Owned workspace ID</dt><dd>${esc(workspace.id)}</dd></div><div><dt>Registered state</dt><dd>${esc(workspace.state)}</dd></div></dl>${workspace.error ? `<p class="form-feedback error">${esc(workspace.error)}</p>` : ""}<div class="actions"><button type="button" class="small" data-viewer${workspace.state !== "running" || workspace.error ? " disabled" : ""}>${icon("computer")} Open viewer</button>${workspace.state === "stopped" ? '<button type="button" class="small danger" data-cleanup>Clean up runtime</button>' : '<button type="button" class="small danger" data-stop>Stop workspace</button>'}</div><div data-feedback hidden></div></article>`).join("") : empty("No separate desktops are running here.", "Create an owned workspace when you have a computer task to do. You will approve its purpose and access first.", '<button type="button" data-start>Create workspace</button>', "computer")}</div></section><section class="section" data-doctor-section><div class="section-heading"><div><h2>Backend diagnostics</h2><p>Read the workspace backend's actual readiness report.</p></div><button type="button" class="small" data-doctor>Check backend</button></div><div data-feedback hidden></div><pre class="technical" data-doctor-report hidden></pre></section>`;
  main.querySelector("[data-refresh]").onclick = ctx.reload;
  main.querySelector("[data-start]")?.addEventListener("click", () => startWorkspace(ctx));
  main.querySelectorAll("[data-workspace]").forEach((row) => {
    const workspace = workspaces[Number(row.dataset.workspace)];
    if (!workspace.id) { row.querySelectorAll("button").forEach((button) => { button.disabled = true; }); feedback(row, "No owned workspace ID was returned. Refresh before taking an action."); return; }
    row.querySelector("[data-viewer]").onclick = () => openViewer(workspace.id, workspace.purpose, ctx);
    row.querySelector("[data-stop]")?.addEventListener("click", () => confirmAction("Stop this workspace?", "This stops the workspace and the apps launched inside it. It can interrupt unfinished demonstrations. It does not target your current desktop.", async (modal) => { await post("/api/computer/stop", { id: workspace.id }, { timeout: 45000 }); if (modal.alive()) modal.close(); ctx.reload(); }, { label: "Stop workspace", danger: true, html: `<pre class="technical">${esc(workspace.purpose)}\n${esc(workspace.id)}</pre>` }));
    row.querySelector("[data-cleanup]")?.addEventListener("click", () => confirmAction("Clean this workspace's runtime files?", "This removes the stopped workspace's runtime and saved backend diagnostics. Only this owned workspace is targeted. This cannot be undone here.", async (modal) => { await post("/api/computer/cleanup", { id: workspace.id }, { timeout: 45000 }); if (modal.alive()) modal.close(); ctx.reload(); }, { label: "Clean up this workspace", danger: true, html: `<pre class="technical">${esc(workspace.purpose)}\n${esc(workspace.id)}</pre>` }));
  });
  const doctor = main.querySelector("[data-doctor-section]");
  doctor.querySelector("[data-doctor]").onclick = () => void action(doctor, async () => {
    const result = await ctx.get("/api/computer/doctor", { timeout: 60000 });
    if (!ctx.current()) return;
    const report = doctor.querySelector("[data-doctor-report]"); report.textContent = result.report; report.hidden = false;
    feedback(doctor, "Backend report received. Read its readiness and limitations below.", "success");
  }, "Checking the workspace backend...");
}

function openViewer(id, purpose, ctx) {
  if (!id) return;
  const modal = dialog("Open this workspace's viewer?", `<p class="dialog-intro">This opens a local monitor for the selected owned workspace. It may not be available on a headless machine.</p><dl class="detail-list"><div><dt>Purpose</dt><dd>${esc(purpose)}</dd></div><div><dt>Workspace ID</dt><dd>${esc(id)}</dd></div></dl><form><label class="check-label"><input type="checkbox" name="inputForwarding"><span><strong>Allow an input-capable viewer.</strong> This can forward my mouse, keyboard, and pasted text into the separate workspace. Input starts disabled and still needs confirmation inside the viewer.</span></label><div data-feedback hidden></div><div class="form-actions"><button type="submit" class="primary">Open viewer</button></div></form>`);
  submit(modal.root.querySelector("form"), async (data) => {
    const result = await post("/api/computer/viewer", { id, ...(data.has("inputForwarding") ? { inputForwarding: true } : {}) }, { timeout: 45000 });
    if (modal.alive()) {
      modal.root.innerHTML = `<p class="notice-box">Viewer request completed. ${data.has("inputForwarding") ? "To demonstrate manually, enable input forwarding inside the viewer after reviewing its confirmation." : "The viewer was requested without input forwarding."}</p><details><summary>Backend response</summary><pre class="technical">${esc(result.report || JSON.stringify(result, null, 2))}</pre></details><div class="form-actions"><button type="button" data-close>Close</button></div>`;
      modal.root.querySelector("[data-close]").onclick = modal.close;
    }
    ctx.changed();
  }, "Opening the selected workspace viewer...");
}

async function demonstrations(ctx, main) {
  const demos = await ctx.get("/api/demos");
  if (!ctx.current()) return;
  main.innerHTML = `<div class="notice-box">${icon("camera")}<div><strong>Demonstrate, capture, explain, review.</strong><p>Open an input-capable viewer to show the task. Capture important states, then write explicit step notes. Finishing creates a draft skill and releases the demonstration workspace. It does not prove the skill works.</p></div></div><section class="section"><div class="section-heading"><h2>Demonstration records</h2><button type="button" class="small" data-refresh>${icon("refresh")} Refresh records</button></div><div class="workspace-list">${demos.length ? [...demos].reverse().map((demo) => `<article class="workspace-card" data-demo="${esc(demo.id)}"><div class="section-heading"><div><h3>${esc(demo.purpose)}</h3><p class="metadata"><a href="#/bot/${enc(demo.bot)}">${esc(demo.bot)}</a><span>${esc(date(demo.startedAt))}</span></p></div>${badge(demo.cancelled ? "cancelled" : demo.skill && demo.finished ? "draft" : demo.state, demo.skill && demo.finished && !demo.cancelled ? "Draft created" : undefined)}</div><dl class="detail-list"><div><dt>Workspace</dt><dd>${esc(demo.workspaceId)}</dd></div><div><dt>Captured states</dt><dd>${demo.shots.length}</dd></div></dl>${demo.errors?.length ? `<details open><summary>Recorded errors (${demo.errors.length})</summary>${demo.errors.map((error) => `<p class="form-feedback error">${esc(error)}</p>`).join("")}</details>` : ""}${demo.shots.length ? `<div class="shot-gallery">${demo.shots.map((_path, index) => `<a href="/api/demos/${enc(demo.id)}/shots/${index}" target="_blank" rel="noopener noreferrer"><img src="/api/demos/${enc(demo.id)}/shots/${index}" alt="Captured state ${index + 1} for ${esc(demo.purpose)}" loading="lazy" decoding="async">Capture ${index + 1}</a>`).join("")}</div>` : '<p class="quiet-empty">No screenshot was recorded.</p>'}<div class="actions">${!demo.finished ? `${demo.state === "recording" ? '<button type="button" class="small" data-demo-viewer>Open viewer</button><button type="button" class="small" data-capture>Capture current state</button>' : ""}${demo.shots.length && ["recording", "failed"].includes(demo.state) ? '<button type="button" class="small primary" data-finish>Write steps and finish</button>' : ""}<button type="button" class="small danger" data-cancel-demo>Cancel and release workspace</button>` : demo.skill && !demo.cancelled ? `<a class="button small" href="#/library">Review draft: ${esc(demo.skill)}</a>` : ""}</div>${demo.skill && !demo.cancelled ? '<p class="field-hint">Draft only. Review, approve, then explicitly attach it from the teammate profile.</p>' : ""}<div data-feedback hidden></div></article>`).join("") : empty("Teach a procedure you actually use.", "Show a task in an owned workspace and record the steps that matter. There are no generated demonstration records here.", '<button type="button" data-start-demo>Start a demonstration</button>', "camera")}</div></section>`;
  main.querySelector("[data-refresh]").onclick = ctx.reload;
  main.querySelector("[data-start-demo]")?.addEventListener("click", () => startWorkspace(ctx, true));
  main.querySelectorAll("[data-demo]").forEach((row) => {
    const demo = demos.find((item) => item.id === row.dataset.demo);
    row.querySelector("[data-demo-viewer]")?.addEventListener("click", () => openViewer(demo.workspaceId, demo.purpose, ctx));
    row.querySelector("[data-capture]")?.addEventListener("click", () => void action(row, async () => {
      await post(`/api/demos/${enc(demo.id)}/capture`, {}, { timeout: 45000 }); ctx.reload();
    }, "Capturing the actual workspace state..."));
    row.querySelector("[data-finish]")?.addEventListener("click", () => finishDemo(demo, ctx));
    row.querySelector("[data-cancel-demo]")?.addEventListener("click", () => confirmAction("Cancel this demonstration?", "This releases its owned workspace without creating a skill. The demonstration record remains available. Unwritten step notes are not saved.", async (modal) => { await post(`/api/demos/${enc(demo.id)}/cancel`, {}, { timeout: 90000 }); if (modal.alive()) modal.close(); ctx.reload(); }, { label: "Cancel and release", danger: true, html: `<p class="technical">${esc(demo.purpose)}</p>` }));
  });
}

function finishDemo(demo, ctx) {
  const modal = dialog("Write down what you demonstrated.", `<p class="dialog-intro">Screenshots alone are not instructions. Describe the exact controls, inputs, prerequisites, expected result, and anything that could go wrong.</p><p class="notice-box">Finishing stops and cleans the demonstration workspace, then creates a draft skill for review. It does not automatically approve, attach, or test the skill.</p><form>
    <label>New skill name<input name="skill" required pattern="[a-z0-9](?:[a-z0-9]|-){0,39}" maxlength="40" placeholder="e.g. prepare-weekly-brief"><small>Lowercase letters, numbers, or hyphens. Up to 40 characters. Existing skills are not overwritten.</small></label>
    <label>Explicit steps and notes<textarea name="notes" required rows="10" maxlength="20000" placeholder="Prerequisites:\n\n1. Open ...\n2. Select ...\n3. Check that ...\n\nExpected result:\nLimitations:"></textarea><small>${demo.shots.length} captured state${demo.shots.length === 1 ? "" : "s"} will remain as evidence.</small></label><div data-feedback hidden></div><div class="form-actions"><button type="submit" class="primary">Finish to draft skill</button></div></form>`, { wide: true, eyebrow: `Teach / ${demo.bot}` });
  submit(modal.root.querySelector("form"), async (data) => {
    const notes = data.get("notes").trim();
    if (!notes) throw new Error("Explicit step notes are required. Screenshots alone are not a procedure.");
    const result = await post(`/api/demos/${enc(demo.id)}/finish`, { skill: data.get("skill").trim(), notes }, { timeout: 90000 });
    ctx.reload();
    if (modal.alive()) {
      modal.root.innerHTML = `<div class="notice-box">${icon("file")}<div><strong>${result.created ? "Draft created." : "This demonstration already has a draft."}</strong><p>${esc(result.skill)}</p><p>Review its instructions in the Library. It has not been automatically learned, tested, approved, or attached.</p></div></div><div class="form-actions"><button type="button" data-close>Close</button><a class="button primary" href="#/library">Review in Library</a></div>`;
      modal.root.querySelector("[data-close]").onclick = modal.close;
    }
  }, "Releasing the workspace and saving the draft procedure...");
}
