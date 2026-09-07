import { api, post, esc, enc, icon, avatar, badge, date, duration, markdown, lines, page, tabs, stats, runRows, empty, dialog, submit, feedback, confirmAction, copyText } from "./ui.js";

const evaluating = new Map();

export function promotionReadiness(proposal, insights) {
  const report = insights.evaluations.find((item) => item.id === proposal.evaluationId && item.proposalId === proposal.id);
  if (!report) return { ready: false, reason: "Evaluate this proposed lesson before accepting it." };
  if (report.status !== "passed" || report.error || report.regressions !== 0 || !report.total || report.candidatePassed !== report.total) return { ready: false, reason: "The candidate must pass every test without regressions." };
  const suite = insights.cases;
  const matches = report.total === suite.length && report.cases.length === suite.length && suite.every((test, index) => {
    const result = report.cases[index];
    const expected = [...test.includes.map((text) => `Includes literal (case-insensitive): ${text}`), ...test.excludes.map((text) => `Excludes literal (case-insensitive): ${text}`)];
    return result.id === test.id && result.name === test.name && result.prompt === test.prompt && result.candidatePassed && result.checks.length === expected.length && result.checks.every((check, i) => check.label === expected[i] && check.candidate === true);
  });
  if (!matches) return { ready: false, reason: "The test suite changed. Evaluate the current suite again." };
  if (insights.proposals.some((item) => item.decidedAt && item.decidedAt > report.createdAt && ["accepted", "rolled_back"].includes(item.status))) return { ready: false, reason: "Active lessons changed after this evaluation. Evaluate again." };
  return { ready: true, reason: "Saved tests passed. Acceptance also rechecks the current model, context, lessons, and suite on the server." };
}

function assessment(run) {
  const self = run.assessment;
  const recorded = run.checks || [];
  return `${recorded.length ? `<section class="section"><h3>Recorded checks</h3><ul class="check-list">${recorded.map((check) => `<li>${badge(check.passed === true ? "passed" : check.passed === false ? "failed" : "unknown")}${esc(check.label)}<p>${esc(check.detail)}</p></li>`).join("")}</ul></section>` : ""}${self ? `<section class="section"><div class="section-heading"><h3>Model self-review</h3>${badge("unknown", "Model-reported")}</div><p class="field-hint">This is the model's own assessment, not independent proof and not your feedback.</p><p>${esc(self.summary)}</p><ul class="check-list">${self.checks.map((check) => `<li>${badge("unknown", check.verdict)}${esc(check.criterion)}<p>${esc(check.evidence || "No evidence supplied.")}</p></li>`).join("")}</ul>${self.limitations.length ? `<h3>Limitations reported by the model</h3><ul>${self.limitations.map((text) => `<li>${esc(text)}</li>`).join("")}</ul>` : ""}</section>` : '<section class="section"><h3>Model self-review</h3><p class="quiet-empty">No self-review was recorded.</p></section>'}`;
}

export async function openRun(id, ctx) {
  const modal = dialog("Task record", '<p class="quiet-empty" role="status">Loading the recorded task...</p>', { wide: true, eyebrow: "Work / Evidence and feedback" });
  try {
    let run = await api(`/api/runs/${enc(id)}`, { signal: modal.signal });
    if (!modal.alive()) return;
    const scope = run.scope.split(":");
    modal.root.innerHTML = `<div class="section-heading"><div class="metadata"><a href="#/${scope[0] === "group" ? "group" : "bot"}/${enc(scope.slice(1).join(":"))}">Open conversation</a><span>${esc(run.bot)}</span><span>${esc(date(run.createdAt))}</span></div>${badge(run.status)}</div>
      <dl class="detail-list"><div><dt>Model used</dt><dd>${esc(run.model || "Not recorded")}</dd></div><div><dt>Execution time</dt><dd>${esc(duration(run.durationMs))}</dd></div><div><dt>Tool calls</dt><dd>${Number.isFinite(run.toolCalls) ? run.toolCalls : "-"}</dd></div><div><dt>Source</dt><dd>${esc(run.source)}</dd></div></dl>
      <section class="section"><div class="section-heading"><h3>The brief</h3><button type="button" class="small subtle" data-copy-prompt>${icon("copy")} Copy prompt</button></div><div class="markdown">${markdown(run.prompt)}</div>${run.criteria.length ? `<details><summary>Success criteria (${run.criteria.length})</summary><ul>${run.criteria.map((text) => `<li>${esc(text)}</li>`).join("")}</ul></details>` : '<p class="field-hint">No success criteria were supplied.</p>'}</section>
      <section class="section"><h3>Recorded result</h3>${run.error ? `<p class="form-feedback error">${esc(run.error)}</p>` : ""}<div class="markdown">${run.response ? markdown(run.response) : `<p class="quiet-empty">${["queued", "running", "awaiting_approval"].includes(run.status) ? "The task is still in progress. Follow its conversation for live activity." : "No final response was recorded."}</p>`}</div></section>
      ${run.status === "completed" ? `<section class="section"><div class="section-heading"><div><h2>Was this actually useful?</h2><p>Your feedback measures benefit. Finishing a task does not.</p></div><span data-rating-summary>${run.feedback ? badge(run.feedback.rating) : badge("unknown", "Unreviewed")}</span></div><form data-feedback-form><fieldset><legend>Your assessment</legend><div class="rating-options"><label><input type="radio" name="rating" value="useful" required${run.feedback?.rating === "useful" ? " checked" : ""}>Useful</label><label><input type="radio" name="rating" value="needs_work" required${run.feedback?.rating === "needs_work" ? " checked" : ""}>Needs work</label></div></fieldset><label>What worked, or what should change?<textarea name="note" rows="3" maxlength="4000" placeholder="A specific correction is more useful than a score.">${esc(run.feedback?.note)}</textarea></label><label>Minutes this saved you (optional)<input type="number" name="minutesSaved" min="0" step="any" max="1000000" value="${run.feedback?.minutesSaved != null ? esc(run.feedback.minutesSaved) : ""}" placeholder="Leave blank if you cannot estimate"><small>Only your reported time is counted. Execution time is not time saved.</small></label><div data-feedback hidden></div><div class="form-actions"><button type="submit" class="primary">Save feedback</button></div></form><div class="notice-box"><div><strong>Turn a correction into something durable.</strong><p>Save a concrete test, then propose a lesson backed by a quote from this task. Nothing is promoted automatically.</p><div class="actions"><button type="button" class="small" data-save-test>${icon("lab")} Save as test</button><button type="button" class="small" data-propose>${icon("leaf")} Propose a lesson</button></div></div></div></section>` : ""}${assessment(run)}<details><summary>Record identifiers</summary><dl class="detail-list"><div><dt>Task ID</dt><dd>${esc(run.id)}</dd></div><div><dt>Scope</dt><dd>${esc(run.scope)}</dd></div></dl></details>`;
    modal.root.querySelector("[data-copy-prompt]").onclick = () => void copyText(run.prompt);
    const form = modal.root.querySelector("[data-feedback-form]");
    if (form) {
      submit(form, async (data) => {
        const raw = data.get("minutesSaved").trim();
        const minutesSaved = raw === "" ? null : Number(raw);
        if (minutesSaved !== null && (!Number.isFinite(minutesSaved) || minutesSaved < 0)) throw new Error("Enter a nonnegative number of minutes, or leave it blank.");
        const result = await post(`/api/runs/${enc(id)}/feedback`, { rating: data.get("rating"), note: data.get("note").trim(), minutesSaved });
        if (result.id) run = result;
        if (modal.alive()) { feedback(form, "Your feedback was saved.", "success"); modal.root.querySelector("[data-rating-summary]").innerHTML = badge(data.get("rating")); }
        ctx.changed(); ctx.onChange?.();
      });
      modal.root.querySelector("[data-save-test]").onclick = () => saveCase(run.bot, ctx, run);
      modal.root.querySelector("[data-propose]").onclick = () => proposeLesson(run, ctx);
    }
  } catch (error) { if (modal.alive()) feedback(modal.root, error.message); }
}

export function saveCase(bot, ctx, run = null) {
  const modal = dialog(run ? "Keep this task as a test." : "Add a regression test.", `<p class="dialog-intro">Use a representative prompt and literal text checks. These tests catch specific regressions, not every kind of error. Up to eight cases per teammate.</p><form><label>Test name<input name="name" required maxlength="200" placeholder="e.g. Keeps uncertainty explicit"></label><label>Prompt<textarea name="prompt" required rows="6" maxlength="100000" placeholder="A repeatable task with enough context to answer it.">${esc(run?.prompt)}</textarea></label><label>Must include, one literal phrase per line<textarea name="includes" rows="3" maxlength="20000" placeholder="e.g. Open questions"></textarea><small>Case-insensitive literal matching. Not a description such as 'be accurate'.</small></label><label>Must not include, one literal phrase per line<textarea name="excludes" rows="3" maxlength="20000" placeholder="Optional forbidden phrases"></textarea><small>At least one include or exclude assertion is required.</small></label><div data-feedback hidden></div><div class="form-actions"><button type="submit" class="primary">Save test</button></div></form>`, { eyebrow: `Improvement lab / ${bot}` });
  const form = modal.root.querySelector("form");
  submit(form, async (data) => {
    const includes = lines(data.get("includes")), excludes = lines(data.get("excludes"));
    if (!includes.length && !excludes.length) throw new Error("Add at least one literal phrase to include or exclude.");
    await post(`/api/agents/${enc(bot)}/cases`, { name: data.get("name").trim(), prompt: data.get("prompt").trim(), includes, excludes });
    ctx.changed(); ctx.onChange?.();
    if (modal.alive()) {
      modal.root.innerHTML = `<div class="notice-box">${icon("check")}<div><strong>Test saved.</strong><p>Existing proposal evaluations must match this new suite before a lesson can be accepted.</p></div></div><div class="form-actions"><a class="button primary" href="#/lab/${enc(bot)}/tests">Open test suite</a><button type="button" data-close>Close</button></div>`;
      modal.root.querySelector("[data-close]").onclick = modal.close;
    }
  });
}

function proposeLesson(run, ctx) {
  const modal = dialog("Propose a lesson, not a hunch.", `<p class="dialog-intro">The lesson stays inactive until you evaluate it and explicitly accept it. Ground it in this task's prompt or response.</p><details><summary>Read the source prompt and response</summary><h3>Prompt</h3><div class="markdown">${markdown(run.prompt)}</div><h3>Response</h3><div class="markdown">${markdown(run.response || "No response recorded.")}</div></details><form><label>Proposed lesson<textarea name="text" required rows="3" maxlength="2000" placeholder="A specific instruction that should apply to future work."></textarea></label><label>Why this lesson matters<textarea name="reason" required rows="3" maxlength="4000" placeholder="Explain the failure or repeatable benefit.">${esc(run.feedback?.note)}</textarea></label><label>Evidence: an exact quote<textarea name="evidence" required rows="3" maxlength="4000" placeholder="Paste a literal quote from the source prompt or response."></textarea><small>The server checks that this quote appears in the source task.</small></label><div data-feedback hidden></div><div class="form-actions"><button type="submit" class="primary">Save proposed lesson</button></div></form>`, { wide: true, eyebrow: `Improvement lab / ${run.bot}` });
  submit(modal.root.querySelector("form"), async (data) => {
    const evidence = data.get("evidence").trim();
    if (!run.prompt.includes(evidence) && !run.response?.includes(evidence)) throw new Error("The evidence must be an exact quote from this task's prompt or response.");
    await post(`/api/agents/${enc(run.bot)}/proposals`, { runId: run.id, text: data.get("text").trim(), reason: data.get("reason").trim(), evidence });
    ctx.changed(); ctx.onChange?.();
    if (modal.alive()) { modal.close(); ctx.navigate(`lab/${enc(run.bot)}/lessons`); }
  });
}

function reportHTML(report) {
  return `<div class="section-heading"><div><h3>${report.proposalId ? "Baseline versus proposed lesson" : "Current instructions: baseline evaluation"}</h3><p class="metadata">${esc(date(report.createdAt))} / ${esc(report.model)}</p></div>${badge(report.status)}</div><p class="field-hint">A pass means the explicit literal assertions passed. It does not prove general correctness or usefulness.</p><dl class="detail-list evaluation-meta"><div><dt>Baseline cases passed</dt><dd>${report.baselinePassed} / ${report.total}</dd></div><div><dt>Candidate cases passed</dt><dd>${report.candidatePassed} / ${report.total}</dd></div><div><dt>Regressions</dt><dd>${report.regressions}</dd></div><div><dt>Improvements on these tests</dt><dd>${report.improvements}</dd></div></dl>${report.error ? `<p class="form-feedback error">${esc(report.error)}</p>` : ""}${report.cases.map((test, index) => `<section class="section"><div class="section-heading"><h3>${esc(test.name)}</h3><button type="button" class="small subtle" data-copy-case="${index}">${icon("copy")} Copy prompt</button></div><details><summary>Test prompt</summary><div class="markdown">${markdown(test.prompt)}</div></details><div class="comparison"><section><h4>Baseline ${badge(test.baselinePassed ? "passed" : "failed")}</h4><div class="markdown">${markdown(test.baseline)}</div></section><section><h4>${report.proposalId ? "With proposed lesson" : "Same context (baseline only)"} ${badge(test.candidatePassed ? "passed" : "failed")}</h4><div class="markdown">${markdown(test.candidate)}</div></section></div><div class="table-wrap"><table><thead><tr><th scope="col">Concrete check</th><th scope="col">Baseline</th><th scope="col">Candidate</th></tr></thead><tbody>${test.checks.map((check) => `<tr><td>${esc(check.label)}</td><td>${badge(check.baseline ? "passed" : "failed")}</td><td>${badge(check.candidate ? "passed" : "failed")}</td></tr>`).join("")}</tbody></table></div></section>`).join("") || '<p class="quiet-empty">No case results were recorded.</p>'}<details><summary>Evaluation context</summary><p class="field-hint">The server verifies this context is still current before promotion.</p><pre class="technical">Report: ${esc(report.id)}\nRevision: ${esc(report.revision)}\nModel: ${esc(report.model)}</pre></details>`;
}
function showReport(report) {
  const modal = dialog("Look at the actual difference.", reportHTML(report), { wide: true, eyebrow: "Improvement lab / Evaluation" });
  modal.root.querySelectorAll("[data-copy-case]").forEach((button) => { button.onclick = () => void copyText(report.cases[Number(button.dataset.copyCase)].prompt); });
}

function evaluate(bot, proposal, data, ctx) {
  if (evaluating.has(bot)) return;
  const count = data.cases.length * (proposal ? 2 : 1);
  confirmAction(proposal ? "Evaluate this proposed lesson?" : "Evaluate the current instructions?", `This makes ${count} real provider request${count === 1 ? "" : "s"} using the saved ${data.cases.length}-case suite. Provider charges may apply. It can take up to two minutes. Evaluation never accepts a lesson for you.`, async (modal) => {
    if (evaluating.has(bot)) throw new Error("An evaluation is already running for this teammate.");
    evaluating.set(bot, proposal?.id || "baseline");
    ctx.reload?.();
    feedback(modal.root.querySelector("form"), "Running the actual tests. You may close this dialog; inspect saved evaluation reports before starting another request.", "info");
    try {
      const report = await post(`/api/agents/${enc(bot)}/evaluations`, proposal ? { proposalId: proposal.id } : {}, { timeout: 135000 });
      ctx.changed();
      if (modal.alive()) showReport(report);
    } finally {
      evaluating.delete(bot);
      window.dispatchEvent(new CustomEvent("linubot:evaluation-finished", { detail: bot }));
    }
  }, { label: "Run evaluation" });
}

export async function renderLab(ctx) {
  const roster = ctx.getOverview().bots;
  if (!ctx.name) {
    ctx.root.innerHTML = page("Learning & evaluations", "Choose a bot to explore its notes, feedback and tests.", `<div class="notice-box">${icon("lab")}<div><strong>No mystery scores. No automatic promotion.</strong><p>Execution rate says whether tasks finished. Your feedback says whether they helped. A test suite checks specific behavior before a lesson becomes active.</p></div></div><section class="section"><div class="section-heading"><h2>Choose a teammate</h2></div>${roster.length ? `<div class="teammate-list">${roster.map((bot) => `<a class="teammate" href="#/lab/${enc(bot.name)}">${avatar(bot.name, false, bot.mascotSeed)}<div><h3>${esc(bot.name)}</h3><p>${esc(bot.goal || bot.topic || "Review this teammate's work and instructions.")}</p></div>${icon("arrow")}</a>`).join("")}</div>` : empty("A teammate comes first.", "Create a teammate and give it useful work. Completed tasks become evidence for improvement.", '<button type="button" class="primary" data-create-bot>Create a teammate</button>', "lab")}</section>`, "", "Improvement lab");
    return;
  }
  const name = ctx.name;
  const data = await ctx.get(`/api/agents/${enc(name)}/insights`);
  if (!ctx.current()) return;
  const pane = ["work", "lessons", "tests", "evaluations"].includes(ctx.pane) ? ctx.pane : "work";
  const evaluatingNow = evaluating.has(name);
  const tabList = [["work", "Work & feedback"], ["lessons", `Lessons (${data.proposals.filter((p) => p.status === "proposed").length} proposed)`], ["tests", `Test suite (${data.cases.length}/8)`], ["evaluations", "Evaluations"]].map(([key, label]) => [key, label, `#/lab/${enc(name)}/${key}`]);
  ctx.root.innerHTML = page(`${name} · Learning`, "Notes, optional feedback, and evaluations.", `<label class="search-form">Teammate<select data-agent-select aria-label="Choose a teammate for the lab">${roster.map((bot) => `<option value="${esc(bot.name)}"${bot.name === name ? " selected" : ""}>${esc(bot.name)}</option>`).join("")}</select></label>${stats(data.summary)}${tabs(tabList, pane)}${evaluatingNow ? '<p class="notice-box" role="status">An evaluation request is in progress for this teammate. Results will appear when the server responds.</p>' : ""}<div data-lab-pane></div>`, `<a class="button small" href="#/bot/${enc(name)}">${icon("arrow")} Conversation</a><button type="button" class="icon-button" data-refresh aria-label="Refresh lab records">${icon("refresh")}</button>`, "Improvement lab / Evidence over scores");
  const main = ctx.root.querySelector("[data-lab-pane]");
  ctx.root.querySelector("[data-refresh]").onclick = ctx.reload;
  ctx.root.querySelector("[data-agent-select]").onchange = (event) => ctx.navigate(`lab/${enc(event.target.value)}/${pane}`);
  const updates = (event) => { if (event.detail === name && ctx.current()) ctx.reload(); };
  window.addEventListener("linubot:evaluation-finished", updates);
  ctx.onCleanup(() => window.removeEventListener("linubot:evaluation-finished", updates));
  const service = { ...ctx, onChange: ctx.reload };
  if (pane === "work") {
    const summary = data.summary;
    main.innerHTML = `<div class="section-heading"><div><h2>Work to learn from</h2><p>${summary.successRate == null ? "No execution rate yet." : `${Math.round(summary.successRate * 100)}% execution completion. This is not a correctness or usefulness score.`}</p></div></div><div class="filter-row"><button type="button" data-work-filter="all" aria-pressed="true">All tasks</button><button type="button" data-work-filter="unreviewed" aria-pressed="false">Unreviewed</button><button type="button" data-work-filter="needs_work" aria-pressed="false">Needs work</button><button type="button" data-work-filter="useful" aria-pressed="false">Useful</button></div><div data-work-list>${runRows(data.runs, "No tasks recorded. Start a conversation, then review what comes back.")}</div>`;
    main.querySelectorAll("[data-work-filter]").forEach((button) => { button.onclick = () => {
      main.querySelectorAll("[data-work-filter]").forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
      const filter = button.dataset.workFilter;
      main.querySelector("[data-work-list]").innerHTML = runRows(data.runs.filter((run) => filter === "all" || (filter === "unreviewed" ? run.status === "completed" && !run.feedback : run.feedback?.rating === filter)), "No tasks match this filter.");
    }; });
  } else if (pane === "lessons") {
    main.innerHTML = `<div class="section-heading"><div><h2>Propose. Compare. Decide.</h2><p>Propose a lesson from a completed task's record, with an exact source quote.</p></div><a class="button small" href="#/lab/${enc(name)}/work">Find a source task</a></div>${data.proposals.length ? data.proposals.map((proposal) => {
      const gate = promotionReadiness(proposal, data);
      return `<article class="data-card" data-proposal="${esc(proposal.id)}"><div class="section-heading"><h3>${esc(proposal.text)}</h3>${badge(proposal.status)}</div><p>${esc(proposal.reason)}</p><blockquote>${esc(proposal.evidence)}</blockquote><div class="metadata"><button type="button" class="text-button" data-run="${esc(proposal.runId)}">Inspect source task</button><span>Proposed ${esc(date(proposal.createdAt))}</span></div>${proposal.status === "proposed" ? `<p class="field-hint">${esc(gate.reason)}</p><div class="actions"><button type="button" class="small" data-evaluate="${esc(proposal.id)}"${!data.cases.length || evaluatingNow || !ctx.getOverview().provider.ready ? " disabled" : ""}>${icon("lab")} ${proposal.evaluationId ? "Evaluate again" : "Evaluate lesson"}</button>${proposal.evaluationId ? `<button type="button" class="small subtle" data-report="${esc(proposal.evaluationId)}">View comparison</button>` : ""}<button type="button" class="small primary" data-decision="accept"${!gate.ready || evaluatingNow ? " disabled" : ""}>Accept lesson</button><button type="button" class="small subtle" data-decision="reject">Reject</button></div>${!data.cases.length ? `<a class="text-button" href="#/lab/${enc(name)}/tests">Add a test before evaluating</a>` : ""}${!ctx.getOverview().provider.ready ? '<a class="text-button" href="#/settings/provider">Configure a provider to evaluate</a>' : ""}` : proposal.status === "accepted" ? '<p class="field-hint">Active for future tasks. Rolling back does not undo earlier outputs.</p><div class="actions"><button type="button" class="small" data-decision="rollback">Roll back lesson</button></div>' : '<p class="field-hint">Archived. Rejected and rolled-back lessons cannot be reactivated.</p>'}<div data-feedback hidden></div></article>`;
    }).join("") : empty("No proposed lessons yet.", "Review a completed task and use Propose a lesson to preserve a specific correction with evidence.", `<a class="button" href="#/lab/${enc(name)}/work">Review work</a>`, "leaf")}<section class="section"><h2>Active lesson text</h2>${data.lessons.length ? `<ol>${data.lessons.map((lesson) => `<li>${esc(lesson)}</li>`).join("")}</ol>` : '<p class="quiet-empty">No accepted lessons. The base instructions and attached approved skills still apply.</p>'}</section>`;
    main.querySelectorAll("[data-evaluate]").forEach((button) => { button.onclick = () => evaluate(name, data.proposals.find((proposal) => proposal.id === button.dataset.evaluate), data, ctx); });
    main.querySelectorAll("[data-decision]").forEach((button) => { button.onclick = () => {
      const proposal = data.proposals.find((p) => p.id === button.closest("[data-proposal]").dataset.proposal);
      const decision = button.dataset.decision;
      confirmAction(decision === "accept" ? "Accept this lesson for future tasks?" : decision === "reject" ? "Reject this proposed lesson?" : "Roll back this active lesson?", decision === "accept" ? "The server will recheck the current suite and context. A stale or incomplete evaluation will block acceptance. Passing literal tests is not proof of general improvement." : decision === "reject" ? "The lesson remains in the record but cannot be activated later." : "The lesson will no longer be included in future work. Earlier outputs are unchanged. This decision cannot be reversed.", async (modal) => {
        await post(`/api/agents/${enc(name)}/proposals/${enc(proposal.id)}/decision`, { decision });
        ctx.changed(); if (modal.alive()) modal.close(); ctx.reload();
      }, { label: decision === "accept" ? "Accept lesson" : decision === "reject" ? "Reject lesson" : "Roll back", danger: decision !== "accept", html: `<blockquote class="technical">${esc(proposal.text)}</blockquote>` });
    }; });
  } else if (pane === "tests") {
    main.innerHTML = `<div class="section-heading"><div><h2>Small tests, concrete checks.</h2><p>Case-insensitive literal assertions. ${data.cases.length} of 8 cases saved.</p></div><div class="actions"><button type="button" class="small" data-baseline${!data.cases.length || evaluatingNow || !ctx.getOverview().provider.ready ? " disabled" : ""}>Run baseline</button><button type="button" class="small primary" data-add-case${data.cases.length >= 8 ? " disabled" : ""}>${icon("plus")} Add test</button></div></div><p class="field-hint">Tests use the current saved context. Updating a test, instructions, provider, or active lesson may invalidate an older evaluation.</p>${!ctx.getOverview().provider.ready ? '<p class="quiet-empty"><a href="#/settings/provider">Configure a provider</a> before running paid evaluations.</p>' : ""}${data.cases.length ? data.cases.map((test) => `<article class="data-card" data-test="${esc(test.id)}"><div class="section-heading"><h3>${esc(test.name)}</h3><div class="actions"><button type="button" class="small subtle" data-copy-test>${icon("copy")} Copy prompt</button><button type="button" class="small danger" data-delete-test>Delete</button></div></div><details><summary>Prompt</summary><div class="markdown">${markdown(test.prompt)}</div></details><div class="test-assertions">${test.includes.map((text) => `<div><strong>Must include:</strong> <code>${esc(text)}</code></div>`).join("")}${test.excludes.map((text) => `<div><strong>Must exclude:</strong> <code>${esc(text)}</code></div>`).join("")}</div></article>`).join("") : empty("What must not regress?", "Add a representative prompt and a phrase the result must include or avoid. You can also save a completed task as a test.", "", "lab")}`;
    main.querySelector("[data-add-case]").onclick = () => saveCase(name, service);
    main.querySelector("[data-baseline]").onclick = () => evaluate(name, null, data, ctx);
    main.querySelectorAll("[data-test]").forEach((row) => {
      const test = data.cases.find((item) => item.id === row.dataset.test);
      row.querySelector("[data-copy-test]").onclick = () => void copyText(test.prompt);
      row.querySelector("[data-delete-test]").onclick = () => confirmAction(`Delete the test "${test.name}"?`, "Changing the suite invalidates evaluations made against the old suite. The test prompt will not be retained here.", async (modal) => { await api(`/api/agents/${enc(name)}/cases/${enc(test.id)}`, { method: "DELETE" }); if (modal.alive()) modal.close(); ctx.reload(); }, { label: "Delete test", danger: true });
    });
  } else {
    main.innerHTML = `<div class="section-heading"><div><h2>Read the comparison, not just the pass.</h2><p>Saved evaluations show the actual baseline, candidate, and checks.</p></div></div>${data.evaluations.length ? data.evaluations.map((report) => `<article class="data-card"><div class="section-heading"><div><h3>${report.proposalId ? "Proposed lesson comparison" : "Current instructions baseline"}</h3><p class="metadata">${esc(date(report.createdAt))} / ${esc(report.model)}</p></div>${badge(report.status)}</div><p>${report.candidatePassed} / ${report.total} candidate cases passed. ${report.regressions} regressions.</p>${report.error ? `<p class="form-feedback error">${esc(report.error)}</p>` : ""}<div class="actions"><button type="button" class="small" data-report="${esc(report.id)}">Inspect actual responses ${icon("arrow")}</button></div></article>`).join("") : empty("No evaluations recorded.", "Build a small suite, then evaluate the current instructions or compare a proposed lesson with the baseline.", `<a class="button" href="#/lab/${enc(name)}/tests">Open test suite</a>`, "lab")}`;
  }
  main.querySelectorAll("[data-report]").forEach((button) => { button.onclick = () => { const report = data.evaluations.find((item) => item.id === button.dataset.report); if (report) showReport(report); else feedback(button.closest("article"), "The referenced report is unavailable. Refresh the lab to retry."); }; });
}
