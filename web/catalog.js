import { post, esc, enc, dialog, submit, action, feedback, markdown } from "./ui.js";

export async function remoteSkillCatalog(ctx, main) {
  main.innerHTML = `<div class="section-heading"><div><h2>Discover skills</h2><p class="field-hint">Search the public catalog or browse any GitHub skill repository.</p></div></div><form class="search-form" data-discover><label>Source<select name="source"><option value="catalog">Online catalog</option><option value="github">GitHub repository</option></select></label><label class="grow"><span data-label>Find a skill</span><input name="query" type="search" value="research" required maxlength="200" placeholder="Research, writing, development…"></label><button class="primary">Search</button><div data-feedback hidden></div></form><p class="field-hint">Downloads are pinned to a Git commit. Supporting files are preserved; scripts are never executed during installation.</p><div data-results></div>`;
  const form = main.querySelector("[data-discover]");
  form.elements.source.onchange = () => {
    const github = form.elements.source.value === "github";
    form.querySelector("[data-label]").textContent = github ? "GitHub owner/repository" : "Find a skill";
    form.elements.query.value = github ? "anthropics/skills" : "research";
    form.elements.query.placeholder = github ? "owner/repository" : "Research, writing, development…";
  };
  async function search() {
    const q = enc(form.elements.query.value.trim());
    const hits = await ctx.get(form.elements.source.value === "github" ? `/api/skills/remote/repository?repo=${q}` : `/api/skills/remote/search?q=${q}`, { timeout: 60000 });
    if (!ctx.current()) return;
    const results = main.querySelector("[data-results]");
    results.innerHTML = hits.length ? "" : '<p class="quiet-empty">No matching skills found.</p>';
    for (const hit of hits) {
      const row = document.createElement("article"); row.className = "catalog-row";
      row.innerHTML = `<div class="catalog-info"><h3>${esc(hit.name)}</h3><p>${esc(hit.repository)}</p><span class="metadata">${hit.path ? esc(hit.path) : `${Number(hit.installs || 0).toLocaleString()} catalog installs`}</span></div><button class="small">Preview source</button>`;
      row.querySelector("button").onclick = () => previewSkill(hit, ctx); results.append(row);
    }
  }
  submit(form, search, "Searching remote skills…");
  await action(form, search, "Loading the catalog…");
}

function previewSkill(hit, ctx) {
  const modal = dialog(`Preview ${hit.name}`, '<p class="quiet-empty" role="status">Resolving the source commit and downloading the skill bundle…</p>', { wide: true });
  void (async () => {
    try {
      const preview = await post("/api/skills/remote/preview", hit, { signal: modal.signal, timeout: 180000 });
      if (!modal.alive()) return;
      modal.root.innerHTML = `<div class="section-heading"><h2>${esc(preview.name)}</h2><span class="badge">Remote source</span></div><dl class="detail-list"><div><dt>Repository</dt><dd><a href="https://github.com/${esc(preview.repository)}/tree/${esc(preview.commit)}" target="_blank" rel="noopener noreferrer">${esc(preview.repository)} ↗</a></dd></div><div><dt>Revision</dt><dd><code>${esc(preview.commit)}</code></dd></div></dl><details><summary>Bundle files (${preview.files.length})</summary><ul>${preview.files.map((file) => `<li><code>${esc(file.path)}</code> · ${file.bytes.toLocaleString()} bytes</li>`).join("")}</ul></details><section class="section"><div class="markdown">${markdown(preview.body)}</div></section><form><p class="field-hint">Install a draft, then review and approve it in your library before attaching it to a teammate.</p><div data-feedback hidden></div><div class="form-actions"><button class="primary">Install this revision as a draft</button></div></form>`;
      submit(modal.root.querySelector("form"), async () => {
        await post("/api/skills/remote/install", { id: preview.id });
        ctx.changed();
        if (modal.alive()) modal.root.innerHTML = `<p class="notice-box">${esc(preview.name)} was installed as a draft.</p><div class="form-actions"><a class="button primary" href="#/library">Review in library</a></div>`;
      }, "Installing the reviewed revision…");
    } catch (error) { if (modal.alive()) { modal.root.innerHTML = ""; feedback(modal.root, error.message); } }
  })();
}
