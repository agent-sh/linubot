import { api, post, esc, enc, badge, dialog, submit, action, feedback, confirmAction, lines } from "./ui.js";

function configText(server) { return server.transport === "stdio" || !server.transport ? [server.command, ...(server.args || [])].join(" ") : server.url; }
function credentials(form) {
  const env = Object.fromEntries([...form.querySelectorAll("[data-env]")].map((input) => [input.dataset.env, input.value]).filter(([, value]) => value));
  const headers = Object.fromEntries([...form.querySelectorAll("[data-header]")].map((input) => [input.dataset.header, input.value]).filter(([, value]) => value));
  return { ...(Object.keys(env).length ? { env } : {}), ...(Object.keys(headers).length ? { headers } : {}) };
}
function secretFields(server) {
  return [...(server.requiredEnv || []).map((key) => `<label>${esc(key)}<input type="password" data-env="${esc(key)}" autocomplete="off" required></label>`),
    ...(server.requiredHeaders || []).map((key) => `<label>${esc(key)}<input type="password" data-header="${esc(key)}" autocomplete="off" required placeholder="${key.toLowerCase() === 'authorization' ? 'Bearer …' : ''}"></label>`)].join("");
}

export async function mcpSettings(ctx, main) {
  const config = await ctx.get("/api/mcp");
  if (!ctx.current()) return;
  const servers = Object.entries(config.servers || {});
  main.innerHTML = `<section><div class="section-heading"><div><h2>Connected tools</h2><p class="field-hint">Enabled servers make their tools available to your teammates.</p></div><button data-custom>Add custom server</button></div><div data-installed>${servers.map(([name, server], index) => {
    const state = config.connections?.[name] || { state: "disconnected", tools: 0 };
    return `<article class="catalog-row" data-server="${index}"><div class="catalog-info"><h3>${esc(name)}</h3><p class="field-hint">${esc(configText(server))}</p>${state.error ? `<p class="form-feedback error">${esc(state.error)}</p>` : ""}<span class="metadata">${state.tools} tools · ${server.enabled ? "Enabled" : "Disabled"}${server.version ? ` · ${esc(server.version)}` : ""}</span></div>${badge(state.state === "connected" ? "approved" : state.state, state.state)}<div class="actions"><button class="small" data-connect>${state.state === "connected" ? "Inspect tools" : "Connect"}</button><button class="small subtle" data-toggle>${server.enabled ? "Disable" : "Enable"}</button><button class="small subtle danger" data-remove>Remove</button></div><div data-feedback hidden></div></article>`;
  }).join("") || '<p class="quiet-empty">No servers installed. Find a server below or add an endpoint.</p>'}</div></section><section class="section"><div class="section-heading"><div><h2>MCP registry</h2><p class="field-hint">Search the official public registry. Review the publisher, version and transport before installing.</p></div><a href="https://registry.modelcontextprotocol.io" target="_blank" rel="noopener noreferrer">Registry source ↗</a></div><form class="search-form" data-registry><label>Find servers<input type="search" name="query" placeholder="Search, documents, databases…" value="fetch" maxlength="200"></label><button class="primary">Search registry</button><div data-feedback hidden></div></form><div data-registry-results></div><button class="small" data-more hidden>More results</button></section>`;
  main.querySelector("[data-custom]").onclick = () => customServer(ctx);
  main.querySelectorAll("[data-server]").forEach((row) => {
    const [name, server] = servers[Number(row.dataset.server)];
    row.querySelector("[data-connect]").onclick = async () => {
      if (config.connections?.[name]?.state !== "connected") { connectServer(name, server, ctx); return; }
      const modal = dialog(`Tools from ${name}`, '<p class="quiet-empty">Reading connected tools…</p>', { wide: true });
      try { const result = await post(`/api/mcp/${enc(name)}/connect`, {}, { signal: modal.signal, timeout: 30000 }); showTools(modal, name, result.tools); }
      catch (error) { if (modal.alive()) feedback(modal.root, error.message); }
    };
    row.querySelector("[data-toggle]").onclick = () => void action(row, async () => { await post(`/api/mcp/${enc(name)}/enabled`, { enabled: !server.enabled }); ctx.reload(); }, "Updating connection…");
    row.querySelector("[data-remove]").onclick = () => confirmAction(`Remove ${name}?`, "This disconnects the server and removes its registration.", async (modal) => { await api(`/api/mcp/${enc(name)}`, { method: "DELETE" }); modal.close(); ctx.reload(); }, { label: "Remove", danger: true });
  });
  const form = main.querySelector("[data-registry]");
  let cursor;
  async function search(more = false) {
    const response = await ctx.get(`/api/mcp/registry?q=${enc(form.elements.query.value)}${more && cursor ? `&cursor=${enc(cursor)}` : ""}`, { timeout: 30000 });
    if (!ctx.current()) return;
    const results = main.querySelector("[data-registry-results]");
    if (!more) results.innerHTML = "";
    if (!response.hits.length && !more) results.innerHTML = '<p class="quiet-empty">No matching servers. Try another search term.</p>';
    for (const hit of response.hits) {
      const row = document.createElement("article"); row.className = "catalog-row";
      row.innerHTML = `<div class="catalog-info"><h3>${esc(hit.name)}</h3><p>${esc(hit.description)}</p><span class="metadata">${esc(hit.version)} · ${hit.options.length} installation options</span></div><button class="small"${hit.options.length ? "" : " disabled"}>${hit.options.length ? "Review & install" : "Custom setup required"}</button>`;
      row.querySelector("button").onclick = () => installRegistry(hit, ctx); results.append(row);
    }
    cursor = response.cursor; main.querySelector("[data-more]").hidden = !cursor;
  }
  submit(form, () => search(), "Searching the registry…");
  main.querySelector("[data-more]").onclick = () => void action(main.querySelector("[data-more]"), () => search(true));
  await action(form, () => search(), "Loading registry…");
}

function installRegistry(hit, ctx) {
  const suggested = hit.name.split("/").at(-1).replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 40);
  const modal = dialog("Install MCP server", `<p>${esc(hit.description)}</p><p class="metadata">${esc(hit.name)} · ${esc(hit.version)}</p><form><label>Local name<input name="name" value="${esc(suggested)}" pattern="[a-z0-9][a-z0-9-]{0,39}" required maxlength="40"></label><label>Connection<select name="option">${hit.options.map((option, index) => `<option value="${index}">${esc(option.label)}</option>`).join("")}</select></label><div data-option></div><div data-feedback hidden></div><div class="form-actions"><button class="primary">Install and connect</button></div></form>`, { wide: true });
  const form = modal.root.querySelector("form");
  function paint() { const config = hit.options[Number(form.elements.option.value)].config; form.querySelector("[data-option]").innerHTML = `<pre class="technical">${esc(configText(config))}</pre><p class="field-hint">${config.transport === "stdio" ? "This downloads and runs publisher code under your Linux account. Review the source before proceeding." : "This connects to the displayed endpoint. Tool calls send their arguments to this server."}</p>${secretFields(config)}${config.requiredEnv?.length || config.requiredHeaders?.length ? '<p class="field-hint">Credentials are kept for this app session.</p>' : ""}`; }
  form.elements.option.onchange = paint; paint();
  submit(form, async (data) => {
    const name = data.get("name").trim();
    await post("/api/mcp/registry/install", { id: hit.id, option: Number(data.get("option")), name });
    ctx.changed();
    try { const result = await post(`/api/mcp/${enc(name)}/connect`, credentials(form), { timeout: 60000 }); if (modal.alive()) showTools(modal, name, result.tools); }
    finally { ctx.reload(); }
  }, "Installing and checking the connection…");
}

function showTools(modal, name, tools) {
  if (!modal.alive()) return;
  modal.root.innerHTML = `<div class="section-heading"><h2>${esc(name)}</h2>${badge("approved", `${tools.length} connected tools`)}</div><div class="tool-list">${tools.map((tool) => `<article class="catalog-row"><div><h3>${esc(tool.name)}</h3><p>${esc(tool.description || "No description")}</p><details><summary>Input schema</summary><pre class="technical">${esc(JSON.stringify(tool.inputSchema, null, 2))}</pre></details></div></article>`).join("") || '<p class="quiet-empty">The server connected but exposed no tools.</p>'}</div>`;
}

function connectServer(name, server, ctx) {
  const modal = dialog(`Connect ${name}`, `<pre class="technical">${esc(configText(server))}</pre><form>${secretFields(server)}<details><summary>Optional bearer token</summary><label>Authorization header<input type="password" data-header="Authorization" autocomplete="off" placeholder="Bearer …"></label></details><div data-feedback hidden></div><div class="form-actions"><button class="primary">Connect and inspect tools</button></div></form>`, { wide: true });
  submit(modal.root.querySelector("form"), async () => {
    if (!server.enabled) await post(`/api/mcp/${enc(name)}/enabled`, { enabled: true });
    const result = await post(`/api/mcp/${enc(name)}/connect`, credentials(modal.root), { timeout: 60000 });
    showTools(modal, name, result.tools); ctx.changed(); ctx.reload();
  }, "Connecting…");
}

function customServer(ctx) {
  const modal = dialog("Add MCP server", `<form><label>Name<input name="name" pattern="[a-z0-9][a-z0-9-]{0,39}" required maxlength="40"></label><label>Transport<select name="transport"><option value="streamable-http">Remote HTTP</option><option value="sse">Remote SSE</option><option value="stdio">Local process</option></select></label><label data-url>Endpoint<input name="url" type="url" placeholder="https://server.example/mcp"></label><div data-process hidden><label>Command<input name="command" placeholder="npx"></label><label>Arguments, one per line<textarea name="args" rows="4"></textarea></label><p class="field-hint">Connecting executes this command under your Linux account.</p></div><div data-feedback hidden></div><div class="form-actions"><button class="primary">Add server</button></div></form>`);
  const form = modal.root.querySelector("form");
  form.elements.transport.onchange = () => { const local = form.elements.transport.value === "stdio"; form.querySelector("[data-url]").hidden = local; form.querySelector("[data-process]").hidden = !local; };
  submit(form, async (data) => {
    const local = data.get("transport") === "stdio";
    await post("/api/mcp", { name: data.get("name"), transport: data.get("transport"), ...(local ? { command: data.get("command"), args: lines(data.get("args")) } : { url: data.get("url") }) });
    modal.close(); ctx.changed(); ctx.reload();
  });
}
