import { api, post, esc, enc, badge, submit, action, feedback, confirmAction } from "./ui.js";
import { modelPicker } from "./model-picker.js";
import { providerSignin } from "./provider-signin.js";
import { xaiAccount } from "./xai.js";

const formats = {
  "openai-compat": ["OpenAI Chat Completions", "Appends /chat/completions to the API base URL."],
  responses: ["OpenAI Responses", "Appends /responses. Works with Responses-compatible endpoints."],
  anthropic: ["Anthropic Messages", "Uses /v1/messages and the Anthropic API version header."],
  "xai-oauth": ["xAI OAuth", "Uses your signed-in xAI account and its Responses API."],
  "openai-codex": ["ChatGPT / Codex", "Uses the ChatGPT account managed by the official Codex CLI."],
  "google-oauth": ["Google Gemini OAuth", "Uses Google OAuth with the Gemini API and your quota project."],
  converse: ["Converse (bearer token)", "Uses /model/{model}/converse. Model IDs are entered manually."],
};

export async function providerSettings(ctx, main) {
  const [initial, presets] = await Promise.all([ctx.get("/api/provider/connections"), ctx.get("/api/provider/presets")]);
  if (!ctx.current()) return;
  const featured = presets.find((p) => p.featured);
  const presetOption = (p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`;
  let connections = initial, saved = initial.connections.find((p) => p.id === initial.activeId), isNew = false;
  main.innerHTML = `<div class="provider-connections"><div class="connection-picker"><label>Saved connections<select data-connection></select></label><button type="button" data-new-connection>Add connection</button></div><div data-xai-account></div><div class="settings-grid"><div><div class="section-heading"><h2>Connection settings</h2><span data-ready></span></div><form class="settings-form" data-provider><div class="split"><label>Provider<select name="preset">${featured ? presetOption(featured) : ""}<option value="custom">Custom endpoint</option>${presets.filter((p) => p !== featured).map(presetOption).join("")}</select></label><label>Connection name<input name="name" maxlength="80" required></label></div><label>Endpoint base URL<input name="baseUrl" type="url" required placeholder="https://your-provider.example/v1"></label><div class="split"><label>API format<select name="kind">${Object.entries(formats).map(([id, [name]]) => `<option value="${id}">${esc(name)}</option>`).join("")}</select></label><label data-auth-label>Authentication<select name="auth"><option value="bearer">Bearer token / API key</option><option value="x-api-key">x-api-key header</option><option value="none">No authentication</option></select></label></div><p class="field-hint" data-format-hint></p><label data-key-label>API key or bearer token<input name="apiKey" type="password" autocomplete="new-password" spellcheck="false"></label><div data-provider-model></div><div class="credential-options"><label class="check-label" data-remember-label><input name="rememberKey" type="checkbox"><span>Remember key with the Linux keyring</span></label><label class="check-label" data-clear-label><input name="clearKey" type="checkbox"><span>Clear this connection’s key on save</span></label></div><div data-feedback hidden></div><div class="form-actions"><button type="submit" class="primary">Save connection</button></div></form><section class="section" data-test-section><button type="button" data-test>Test connection</button><p class="field-hint">Sends one short prompt using this saved connection.</p><div data-feedback hidden></div><pre class="technical" data-test-output hidden></pre></section><details class="section" data-machine-section><summary>Use a local credential file</summary><p class="field-hint">Choose a file to review before its credential is read.</p><button type="button" data-find-configs>Find local credential files</button><div data-feedback hidden></div><div data-config-list></div></details></div><aside class="settings-note"><p class="eyebrow">App default</p><h2 data-default-name></h2><p data-default-model></p><button type="button" data-use-default>Use this connection as default</button><p class="field-hint">Bots follow the app default unless you choose a connection in their model settings.</p><section class="section"><h3>Your endpoint, your model</h3><p>Choose a prepared provider or a custom API base URL. Refresh models to read that endpoint’s catalog. Custom IDs work when a catalog is unavailable.</p><p class="field-hint">Model availability and tool or image support depend on the provider. HTTPS is required for remote endpoints; local servers can use HTTP.</p></section><section class="section"><button type="button" class="small danger" data-remove>Remove connection</button><div data-feedback hidden></div></section></aside></div></div>`;
  const form = main.querySelector("[data-provider]"), connectionSelect = main.querySelector("[data-connection]"), useDefault = main.querySelector("[data-use-default]"), test = main.querySelector("[data-test]"), remove = main.querySelector("[data-remove]");
  const xaiRoot = main.querySelector("[data-xai-account]");
  const roster = document.createElement("section"); roster.className = "provider-roster";
  roster.innerHTML = '<h2>Your providers</h2><p class="field-hint">All ready connections stay available at the same time. Choose a provider for each bot; the app default is for bots that follow it.</p><div data-provider-roster></div>';
  main.querySelector(".provider-connections").prepend(roster);
  let featuredRoot;
  if (featured) {
    const card = document.createElement("section"); card.className = "provider-featured";
    card.innerHTML = `<h2>${esc(featured.name)}</h2><p>Tiyuvta is Linubot's own hosted inference. OpenAI-compatible, pay per use, new accounts start with free credit.</p><div class="actions"><button type="button" class="primary" data-browser-login>Connect in browser</button><button type="button" data-connect-featured>Paste a key instead</button><button type="button" data-cancel-login hidden>Cancel sign-in</button><a href="https://inference.tiyuvta.ai/login?next=/app/keys" target="_blank" rel="noopener noreferrer">Get an API key</a></div><div data-feedback hidden></div><div data-login-link></div>`;
    roster.before(card); featuredRoot = card;
    card.querySelector("[data-connect-featured]").onclick = () => newConnection(featured);
  }
  const browserRoot = document.createElement("section"); browserRoot.className = "section browser-connect";
  browserRoot.innerHTML = '<div class="section-heading"><div><h2>Connect OpenRouter</h2><p class="field-hint">Sign in in your browser. Linubot receives the callback and loads your models.</p></div></div><div class="actions"><button type="button" class="primary" data-browser-login>Connect in browser</button><button type="button" data-cancel-login hidden>Cancel sign-in</button></div><div data-feedback hidden></div><div data-login-link></div>';
  xaiRoot.after(browserRoot);
  const museRoot = document.createElement("section"); museRoot.className = "section browser-connect";
  museRoot.innerHTML = '<div class="section-heading"><div><h2>Connect Muse Code</h2><p class="field-hint">Use the account you already signed in to with Meta’s Muse Code.</p></div></div><button type="button" class="primary" data-muse-connect>Use Muse Code sign-in</button><p class="field-hint">If you have not signed in yet, run <code>muse login</code> in your terminal and finish in your browser. You can also enter a Meta API key below.</p><div data-feedback hidden></div>';
  browserRoot.after(museRoot);
  const signinRoot = document.createElement("section"); museRoot.after(signinRoot);
  const signin = providerSignin(ctx, signinRoot, draft, async (id) => {
    connections = await ctx.get("/api/provider/connections");
    const updated = connections.connections.find((p) => p.id === id);
    if (!ctx.current() || !updated) return;
    if (updated.ready && !connections.connections.some((p) => p.id !== id && p.ready)) { await post("/api/provider/select", { id }); connections = await ctx.get("/api/provider/connections"); }
    show(updated); feedback(form, "Connected. Choose a model below.", "success"); ctx.changed();
  });
  const controller = new AbortController(); ctx.onCleanup(() => controller.abort());
  let login, loginTimer, loginEpoch = 0;
  async function cancelLogin() {
    const epoch = ++loginEpoch, prior = login; login = undefined; clearTimeout(loginTimer);
    if (prior) { prior.root.querySelector("[data-cancel-login]").hidden = true; prior.root.querySelector("[data-login-link]").innerHTML = ""; }
    if (prior) await post(`/api/oauth/${prior.provider}/cancel`, { id: prior.id }).catch(() => { /* App shutdown also closes the callback listener. */ });
    return epoch;
  }
  ctx.onCleanup(() => { void cancelLogin(); });
  let picker;
  function draft() { return { id: isNew ? undefined : saved.id, newConnection: isNew, name: form.elements.name.value.trim(), kind: form.elements.kind.value,
    baseUrl: form.elements.baseUrl.value.trim(), auth: form.elements.auth.value, model: picker?.value() || "", apiKey: form.elements.apiKey.value || undefined,
    clearKey: form.elements.clearKey.checked, rememberKey: form.elements.rememberKey.checked }; }
  function dirty() {
    const value = draft();
    return isNew || ["name", "kind", "baseUrl", "auth", "model"].some((key) => value[key] !== saved[key]) || Boolean(value.apiKey) || value.clearKey || value.rememberKey !== saved.rememberKey;
  }
  function controls() {
    const oauth = ["xai-oauth", "openai-codex", "google-oauth"].includes(form.elements.kind.value), noKey = form.elements.auth.value === "none";
    xaiRoot.hidden = form.elements.kind.value !== "xai-oauth";
    signin.render(form.elements.preset.value);
    browserRoot.hidden = !["openai-compat", "responses"].includes(form.elements.kind.value) || form.elements.baseUrl.value.replace(/\/+$/, "") !== "https://openrouter.ai/api/v1";
    museRoot.hidden = !["openai-compat", "responses"].includes(form.elements.kind.value) || form.elements.baseUrl.value.replace(/\/+$/, "") !== "https://api.meta.ai/v1" || form.elements.auth.value !== "bearer";
    form.elements.baseUrl.readOnly = oauth;
    for (const name of ["auth", "key", "remember", "clear"]) main.querySelector(`[data-${name}-label]`).hidden = oauth || (name !== "auth" && noKey);
    form.elements.apiKey.disabled = form.elements.clearKey.checked || oauth || noKey;
    form.elements.rememberKey.disabled = !saved.credentialStorage || oauth || noKey;
    form.elements.clearKey.disabled = !saved.hasKey || oauth || noKey;
    main.querySelector("[data-format-hint]").textContent = formats[form.elements.kind.value][1];
    test.disabled = dirty() || !saved.ready;
    useDefault.disabled = dirty() || !saved.ready || saved.id === connections.activeId;
    remove.disabled = isNew || saved.id === connections.activeId;
  }
  picker = modelPicker(main.querySelector("[data-provider-model]"), { model: saved.model, signal: controller.signal,
    getCatalog: (signal) => post("/api/provider/models", draft(), { signal, timeout: 25000 }),
    preselect: (models) => publicCatalog() ? { model: models.find((item) => !/embed|rerank/i.test(item.id))?.id, hint: "Preselected from the Tiyuvta catalog. Change it any time." } : undefined });
  function publicCatalog() {
    return presets.some((p) => p.id === form.elements.preset.value && p.publicCatalog && p.kind === form.elements.kind.value && p.baseUrl.replace(/\/+$/, "") === form.elements.baseUrl.value.replace(/\/+$/, ""));
  }
  function connectionOptions() {
    roster.querySelector("[data-provider-roster]").innerHTML = connections.connections.map((p) => `<button type="button" class="provider-row${!isNew && p.id === saved.id ? " selected" : ""}" data-edit-provider="${esc(p.id)}"><span><strong>${esc(p.name)}</strong><small>${esc(p.model || "Choose a model")}${p.usedBy?.length ? ` · ${esc(p.usedBy.join(", "))}` : ""}</small></span><span>${p.id === connections.activeId ? "Default · " : ""}${p.ready ? "Ready" : "Setup needed"}</span></button>`).join("");
    roster.querySelectorAll("[data-edit-provider]").forEach((button) => { button.onclick = () => { void cancelLogin(); const connection = connections.connections.find((p) => p.id === button.dataset.editProvider); if (connection) show(connection); }; });
    connectionSelect.innerHTML = `${isNew ? '<option value="">New connection</option>' : ""}${connections.connections.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.id === connections.activeId ? " (app default)" : ""}</option>`).join("")}`;
    connectionSelect.value = isNew ? "" : saved.id;
    const active = connections.connections.find((p) => p.id === connections.activeId);
    main.querySelector("[data-default-name]").textContent = active.name;
    main.querySelector("[data-default-model]").textContent = active.model || "Choose a model to get started.";
  }
  function show(connection, fresh = false) {
    void cancelLogin(); void signin.cancel();
    saved = connection; isNew = fresh;
    for (const key of ["name", "kind", "baseUrl", "auth"]) form.elements[key].value = saved[key];
    form.elements.apiKey.value = ""; form.elements.apiKey.placeholder = saved.hasKey ? "A key is set. Leave blank to keep it here." : "Enter a key if this endpoint needs one";
    form.elements.clearKey.checked = false; form.elements.rememberKey.checked = saved.rememberKey;
    form.elements.preset.value = presets.find((p) => p.kind === saved.kind && p.baseUrl.replace(/\/$/, "") === saved.baseUrl.replace(/\/$/, ""))?.id || "custom";
    picker.reset(saved.model === "default" ? "" : saved.model);
    connectionOptions(); controls();
    main.querySelector("[data-ready]").innerHTML = badge(saved.ready ? "approved" : "pending", saved.ready ? "Configured" : "Setup needed");
    main.querySelector("[data-test-output]").hidden = true; feedback(form, "");
    if (!fresh && (saved.hasKey || saved.auth === "none" || presets.find((p) => p.id === form.elements.preset.value)?.publicCatalog)) void picker.load();
  }
  form.addEventListener("input", controls);
  form.addEventListener("actionend", controls);
  main.querySelector(".settings-note").addEventListener("actionend", controls);
  main.querySelector("[data-test-section]").addEventListener("actionend", controls);
  const invalidate = () => { void cancelLogin(); picker.reset(); main.querySelector("[data-test-output]").hidden = true; controls(); };
  form.elements.baseUrl.addEventListener("input", invalidate);
  form.elements.apiKey.addEventListener("input", () => { if (publicCatalog()) { void cancelLogin(); controls(); } else invalidate(); });
  form.elements.clearKey.onchange = () => { if (form.elements.clearKey.checked) form.elements.apiKey.value = ""; invalidate(); };
  form.elements.auth.onchange = () => { form.elements.apiKey.value = ""; if (form.elements.auth.value === "none") form.elements.rememberKey.checked = false; invalidate(); };
  form.elements.kind.onchange = () => {
    const kind = form.elements.kind.value;
    form.elements.auth.value = kind === "anthropic" ? "x-api-key" : "bearer";
    const fixed = { "xai-oauth": "https://api.x.ai/v1", "openai-codex": "https://chatgpt.com/backend-api/codex", "google-oauth": "https://generativelanguage.googleapis.com/v1beta/openai" };
    if (fixed[kind]) form.elements.baseUrl.value = fixed[kind];
    form.elements.preset.value = "custom"; form.elements.apiKey.value = ""; invalidate();
  };
  form.elements.preset.onchange = () => {
    const preset = presets.find((p) => p.id === form.elements.preset.value);
    if (!preset) return;
    if (!isNew && (preset.kind !== saved.kind || preset.baseUrl !== saved.baseUrl || preset.auth !== saved.auth)) {
      show({ name: preset.name, kind: preset.kind, baseUrl: preset.baseUrl, auth: preset.auth, model: "", hasKey: false, ready: false, rememberKey: false, credentialStorage: saved.credentialStorage }, true);
    }
    if (isNew || ["Default connection", ...presets.map((p) => p.name)].includes(form.elements.name.value)) form.elements.name.value = preset.name;
    for (const key of ["kind", "baseUrl", "auth"]) form.elements[key].value = preset[key];
    form.elements.apiKey.value = ""; form.elements.clearKey.checked = false;
    if (preset.auth === "none") form.elements.rememberKey.checked = false;
    invalidate();
    if (preset.publicCatalog) void picker.load();
  };
  connectionSelect.onchange = () => { void cancelLogin(); const connection = connections.connections.find((p) => p.id === connectionSelect.value); if (connection) show(connection); };
  function newConnection(preset = featured) {
    show({ name: "New connection", kind: "openai-compat", baseUrl: "", auth: "bearer", model: "", hasKey: false, ready: false, rememberKey: false, credentialStorage: saved.credentialStorage }, true);
    if (preset) { form.elements.preset.value = preset.id; form.elements.preset.onchange(); }
    form.elements.apiKey.focus();
  }
  main.querySelector("[data-new-connection]").onclick = () => newConnection();
  async function save(makeDefault) {
    const value = draft();
    if (!value.model || value.model === "default") throw new Error("Choose a model from the endpoint or enter its exact ID.");
    const updated = await post("/api/provider", value);
    if (makeDefault || !connections.connections.some((p) => p.ready)) await post("/api/provider/select", { id: updated.id });
    connections = await ctx.get("/api/provider/connections");
    if (!ctx.current()) return;
    show(updated); feedback(form, "Connection saved.", "success"); ctx.changed();
  }
  form.querySelector("button[type=submit]").textContent = "Save connection";
  const saveOnly = document.createElement("button"); saveOnly.type = "button"; saveOnly.textContent = "Save and use as default";
  form.querySelector(".form-actions").append(saveOnly);
  submit(form, () => save(false));
  saveOnly.onclick = () => void action(form, () => save(true));
  useDefault.onclick = () => void action(main.querySelector(".settings-note"), async () => { await post("/api/provider/select", { id: saved.id }); connections = await ctx.get("/api/provider/connections"); if (ctx.current()) { connectionOptions(); controls(); ctx.changed(); } });
  remove.onclick = () => confirmAction("Remove this connection?", "Its saved credential will be removed. Bots using this connection must be changed first.", async (modal) => {
    await api(`/api/provider/${enc(saved.id)}`, { method: "DELETE" }); connections = await ctx.get("/api/provider/connections");
    if (modal.alive()) modal.close(); if (ctx.current()) show(connections.connections.find((p) => p.id === connections.activeId)); ctx.changed();
  }, { label: "Remove connection", danger: true });
  test.onclick = () => void action(main.querySelector("[data-test-section]"), async () => {
    const result = await post("/api/provider/test", { id: saved.id }, { timeout: 70000 });
    if (!ctx.current()) return;
    const output = main.querySelector("[data-test-output]"); output.textContent = `${result.model}: ${result.response}\n${result.durationMs} ms`; output.hidden = false;
  }, "Testing this connection…");
  const machine = main.querySelector("[data-machine-section]");
  machine.querySelector("[data-find-configs]").onclick = () => void action(machine, async () => {
    const paths = await ctx.get("/api/machine-configs"); if (!ctx.current()) return;
    machine.querySelector("[data-config-list]").innerHTML = paths.map((path, index) => `<p><code>${esc(path)}</code> <button type="button" class="small" data-load-key="${index}">Review and load</button></p>`).join("") || '<p class="quiet-empty">No supported credential files found.</p>';
    machine.querySelectorAll("[data-load-key]").forEach((button) => { button.onclick = () => {
      if (dirty()) { feedback(machine, "Save this connection before loading a credential."); return; }
      const path = paths[Number(button.dataset.loadKey)];
      confirmAction("Read this credential file?", `Use its key with ${saved.baseUrl}. No test is sent automatically.`, async (modal) => {
        await post("/api/machine-key", { id: saved.id, path, approved: true });
        connections = await ctx.get("/api/provider/connections"); if (ctx.current()) show(connections.connections.find((p) => p.id === saved.id));
        if (modal.alive()) modal.close(); ctx.changed();
      }, { label: "Read and use key", html: `<p><code>${esc(path)}</code></p>` });
    }; });
  });
  museRoot.querySelector("[data-muse-connect]").onclick = () => void action(museRoot, async () => {
    const updated = await post("/api/muse/connect", { id: !isNew && saved.baseUrl.replace(/\/+$/, "") === "https://api.meta.ai/v1" ? saved.id : undefined });
    connections = await ctx.get("/api/provider/connections");
    if (ctx.current()) { show(updated); feedback(museRoot, "Connected through Muse Code. Choose a model below.", "success"); ctx.changed(); }
  });
  function browserLogin(root, provider, baseUrl) {
    root.querySelector("[data-cancel-login]").onclick = () => void action(root, async () => { await cancelLogin(); feedback(root, "Sign-in cancelled.", "info"); });
    root.querySelector("[data-browser-login]").onclick = () => void action(root, async () => {
      const epoch = await cancelLogin();
      if (!ctx.current() || epoch !== loginEpoch) return;
      const flow = await post(`/api/oauth/${provider}/start`, { id: !isNew && saved.baseUrl.replace(/\/+$/, "") === baseUrl ? saved.id : undefined });
      if (!ctx.current() || epoch !== loginEpoch) { await post(`/api/oauth/${provider}/cancel`, { id: flow.id }); return; }
      login = { ...flow, root, provider };
      root.querySelector("[data-cancel-login]").hidden = false;
      root.querySelector("[data-login-link]").innerHTML = `<p class="field-hint">Finish signing in, then return here. <a href="${esc(flow.authorizationUrl)}" target="_blank" rel="noopener noreferrer">Open sign-in again</a></p>`;
      window.open(flow.authorizationUrl, "_blank", "noopener");
      async function poll() {
        if (!ctx.current() || login?.id !== flow.id) return;
        try {
          const state = await ctx.get(`/api/oauth/${provider}/status?id=${enc(flow.id)}`);
          if (!ctx.current() || login?.id !== flow.id) return;
          if (state.state === "connected") {
            const refreshed = await ctx.get("/api/provider/connections");
            if (!ctx.current() || login?.id !== flow.id) return;
            connections = refreshed;
            show(connections.connections.find((p) => p.id === state.connectionId));
            feedback(root, provider === "tiyuvta" && saved.model ? "Connected to Tiyuvta. You can change the model below." : "Connected. Choose a model below.", "success"); ctx.changed();
          } else if (["failed", "cancelled"].includes(state.state)) { login = undefined; root.querySelector("[data-cancel-login]").hidden = true; root.querySelector("[data-login-link]").innerHTML = ""; feedback(root, state.error || "Sign-in cancelled."); }
          else loginTimer = setTimeout(poll, 1000);
        } catch (error) { if (ctx.current() && login?.id === flow.id) { await cancelLogin(); feedback(root, error.message); } }
      }
      loginTimer = setTimeout(poll, 1000);
    }, "Opening browser sign-in…");
  }
  browserLogin(browserRoot, "openrouter", "https://openrouter.ai/api/v1");
  if (featuredRoot && featured.id === "tiyuvta") browserLogin(featuredRoot, "tiyuvta", featured.baseUrl);
  const requested = new URLSearchParams(location.hash.split("?")[1] || "").get("preset");
  const requestedPreset = presets.find((p) => p.id === requested);
  if (requestedPreset) newConnection(requestedPreset); else show(saved);
  await xaiAccount(ctx, xaiRoot);
}
