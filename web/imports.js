import { post, esc, enc, page, submit, action, feedback } from "./ui.js";
import { botModelPicker } from "./model-picker.js";

export async function renderImports(ctx) {
  const sources = await ctx.get("/api/imports/sources"); if (!ctx.current()) return;
  ctx.root.innerHTML = page("Bring your bots over", "Choose a source, review what comes across, then open your teammate in Linubot.", `<form class="settings-form" data-import-form><label>Import from<select name="sourceId"><option value="">Choose a bot or group</option>${["hermes", "grok"].map((kind) => `<optgroup label="${kind === "hermes" ? "Hermes profiles" : "Grok Bot"}">${sources.candidates.filter((item) => item.source === kind).map((item) => `<option value="${esc(item.id)}">${esc(item.name)}${item.kind === "group" ? " (group)" : ""}${item.importedAs ? ` · imported as ${esc(item.importedAs)}` : ""}</option>`).join("")}</optgroup>`).join("")}</select></label><p class="field-hint" data-source-detail></p><label data-target-name>Linubot name<input name="name" maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,39}" placeholder="Choose a name"></label><div data-import-model></div><fieldset><legend>Bring along</legend><label class="check-label"><input type="checkbox" name="memory" checked>Saved memories, kept with this bot</label><label class="check-label"><input type="checkbox" name="skills" checked>Skills and supporting files, as drafts in the Library</label><label class="check-label"><input type="checkbox" name="history" checked>Recent conversation history</label><label class="check-label"><input type="checkbox" name="routines">Compatible routines, paused until you enable them</label></fieldset><div data-feedback hidden></div><div class="form-actions"><button class="primary" type="submit">Preview import</button></div></form><section class="section" data-import-preview hidden></section><details class="section"><summary>Source locations and supported data</summary><p>Hermes: <code>${esc(sources.locations.hermes)}</code></p><p>Grok Bot cache: <code>${esc(sources.locations.grok)}</code></p><p>Hermes history includes up to three recent conversations. Grok Bot supplies locally cached descriptions, groups and recent messages. Its cloud-only instructions, memories, workspace files, skills and schedules are not in this cache.</p><p>Source apps keep their data. Account credentials, approvals, active tasks and automatic posting are not transferred.</p>${sources.warnings.map((warning) => `<p>${esc(warning)}</p>`).join("")}</details>`, '<a class="button small" href="#/home">Back to your bots</a>', "Your bots / Import");
  const form = ctx.root.querySelector("[data-import-form]"), review = ctx.root.querySelector("[data-import-preview]");
  form.elements.sourceId.disabled = true; form.querySelector("button[type=submit]").disabled = true;
  let revision = 0, prepared;
  const picker = await botModelPicker(form.querySelector("[data-import-model]"), {}, ctx.signal); if (!ctx.current()) return;
  function invalidate() { revision++; prepared = undefined; review.hidden = true; }
  form.addEventListener("input", invalidate); form.addEventListener("change", invalidate);
  form.elements.sourceId.onchange = () => {
    const source = sources.candidates.find((item) => item.id === form.elements.sourceId.value);
    form.elements.name.value = source?.name.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 32) || (source?.source === "hermes" ? "Hermes" : "Grok");
    form.querySelector("[data-target-name]").hidden = source?.kind === "group";
    form.querySelector("[data-source-detail]").textContent = source ? source.kind === "group" ? "The group and its members come over together. Already imported members are reused." : source.description : "";
    invalidate();
  };
  submit(form, async () => {
    const source = sources.candidates.find((item) => item.id === form.elements.sourceId.value); if (!source) throw new Error("Choose a bot or group to import.");
    const current = revision;
    const value = await post("/api/imports/preview", { sourceId: source.id, name: source.kind === "bot" ? form.elements.name.value : undefined, ...picker.value(), memory: form.elements.memory.checked, skills: form.elements.skills.checked, history: form.elements.history.checked, routines: form.elements.routines.checked }, { timeout: 60000 });
    if (!ctx.current() || current !== revision) return;
    prepared = value; review.hidden = false; feedback(form, "Preview ready. Review the snapshot below.", "success");
    review.innerHTML = `<h2>Review the import</h2><p>${value.group ? `Group: ${esc(value.group)}. ` : ""}New bots will use ${esc(value.provider.name)} · ${esc(value.provider.model)}.</p>${value.bots.map((bot, index) => `<article class="import-preview-bot"><h3>${esc(bot.name)}${value.targets[index].existing ? " · already imported" : ""}</h3><p>${esc(bot.description)}</p><p class="field-hint">${bot.messages} historical messages · ${bot.skills.length} draft skills · ${bot.routines.length} paused routines${bot.sourceModel ? ` · source model: ${esc(bot.sourceModel)}` : ""}</p>${bot.soul ? `<details><summary>Personality and instructions</summary><pre class="technical">${esc(bot.soul)}</pre></details>` : ""}${bot.context ? `<details><summary>Saved context for this bot</summary><pre class="technical">${esc(bot.context)}</pre></details>` : ""}${bot.skills.length ? `<details><summary>Skills to review later in the Library</summary><ul>${bot.skills.map((skill) => `<li>${esc(skill.name)}: ${esc(skill.description)} (${skill.files} supporting files)</li>`).join("")}</ul></details>` : ""}</article>`).join("")}${value.warnings.length ? `<details open><summary>Items to check</summary><ul>${value.warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul></details>` : ""}<div data-feedback hidden></div><div class="form-actions"><button type="button" class="primary" data-confirm-import>Import into Linubot</button></div>`;
    review.querySelector("[data-confirm-import]").onclick = () => void action(review, async () => {
      if (prepared?.id !== value.id) throw new Error("Preview the current choices before importing.");
      const result = await post("/api/imports/commit", { id: value.id }, { timeout: 60000 }); if (!ctx.current()) return;
      prepared = undefined; ctx.changed();
      const [kind, name] = result.scope.split(":");
      review.innerHTML = `<h2>Your teammates are ready</h2><p>${result.bots.map(esc).join(", ")} ${result.bots.length === 1 ? "is" : "are"} now in Linubot.</p>${result.skills.length ? `<p>${result.skills.length} imported skills are drafts. Review them in the Library, then attach approved skills in the bot’s options.</p>` : ""}${result.routines.length ? `<p>${result.routines.length} routines are paused in Routines.</p>` : ""}<div class="actions"><a class="button primary" href="#/${kind}/${enc(name)}">Open ${kind === "group" ? "group" : "bot"}</a>${result.skills.length ? '<a class="button" href="#/library">Review skills</a>' : ""}</div>`;
    }, "Importing the reviewed snapshot…");
    review.scrollIntoView({ behavior: "smooth", block: "start" });
  }, "Preparing an import preview…");
  if (!sources.candidates.length) feedback(form, "No supported Hermes profiles or Grok Bot caches were found at the locations below.", "info");
  form.elements.sourceId.disabled = false; form.querySelector("button[type=submit]").disabled = false;
}
