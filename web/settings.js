import { phoneSettings } from "./phone-settings.js";
import { updateSettings } from "./updates.js";
import { providerSettings } from "./providers.js";
import { mcpSettings } from "./extensions.js";
import { api, post, esc, enc, icon, badge, page, tabs, empty, dialog, submit, action, feedback, confirmAction, safeUrl, lines } from "./ui.js";

export async function renderSettings(ctx) {
  const pane = ["provider", "search", "mcp", "context", "phone", "permissions"].includes(ctx.name) ? ctx.name : "provider";
  ctx.root.innerHTML = page("Settings", "Manage your model, web access and connected tools.", `${tabs([["provider", "Provider & credentials", "#/settings/provider"], ["search", "Web search", "#/settings/search"], ["mcp", "Connected tools", "#/settings/mcp"], ["context", "Long conversations", "#/settings/context"], ["phone", "Phone access", "#/settings/phone"], ["permissions", "Permissions", "#/settings/permissions"]], pane)}<section class="section" data-app-updates></section><div data-settings-pane><p class="quiet-empty" role="status">Reading configuration...</p></div>`, "", "Settings / Local control");
  updateSettings(ctx, ctx.root.querySelector("[data-app-updates]"));
  const main = ctx.root.querySelector("[data-settings-pane]");
  if (pane === "provider") await providerSettings(ctx, main);
  else if (pane === "search") await searchSettings(ctx, main);
  else if (pane === "permissions") await permissionControls(ctx, main);
  else if (pane === "phone") await phoneSettings(ctx, main);
  else if (pane === "context") await contextControls(ctx, main);
  else await mcpSettings(ctx, main);
}

async function contextControls(ctx, main) {
  const settings = await ctx.get("/api/context/settings"); if (!ctx.current()) return;
  main.innerHTML = `<div class="settings-grid"><form class="settings-form" data-context-settings><h2>Long conversations</h2><p>Your bots keep a smaller working context while the full session stays available.</p><label class="check-label"><input type="checkbox" name="enabled"${settings.enabled ? " checked" : ""}>Automatically manage long contexts</label><label>Compaction strategy<select name="mode"><option value="auto">Automatic: native where supported, otherwise portable</option><option value="portable">Portable continuation checkpoint</option><option value="native">Native Responses compaction only</option></select></label><label>Working input budget (tokens)<input name="inputBudget" type="number" min="2000" max="1000000" required value="${settings.inputBudget}"><small>Leave room for the model's output. This is your working budget, not a claim about its maximum context.</small></label><label>Summary target (tokens)<input name="targetTokens" type="number" min="500" max="500000" required value="${settings.targetTokens}"></label><label>Preferred recent exchanges<input name="recentUnits" type="number" min="2" max="20" required value="${settings.recentUnits}"><small>Tool calls and results stay together. The recent tail can shrink when the budget is tight.</small></label><div data-feedback hidden></div><button type="submit" class="primary">Save context settings</button></form><aside class="settings-note"><h2>Keep the conversation going.</h2><p>Older observations can be recovered with the bot's session-history tool. Checkpoints keep references to the original session.</p><p>Current instructions, the active request and live tool permissions stay outside the summarizer's control.</p><p class="field-hint">Changes apply to new tasks. Native mode requires a Responses endpoint with a supported compaction API. Estimates are used when exact token counts are unavailable.</p></aside></div>`;
  const form = main.querySelector("form"); form.elements.mode.value = settings.mode;
  submit(form, async (data) => { await api("/api/context/settings", { method: "PUT", body: { enabled: data.has("enabled"), mode: data.get("mode"), inputBudget: Number(data.get("inputBudget")), targetTokens: Number(data.get("targetTokens")), recentUnits: Number(data.get("recentUnits")) } }); if (ctx.current()) feedback(form, "Context settings saved for new tasks.", "success"); });
}

async function searchSettings(ctx, main) {
  let saved = await ctx.get("/api/websearch");
  if (!ctx.current()) return;
  main.innerHTML = `<div class="settings-grid"><div><div class="section-heading"><h2>Web search</h2>${badge(saved.backend !== "disabled" ? "approved" : "disabled", saved.backend !== "disabled" ? "Available" : "Disabled")}</div><form class="settings-form" data-config><label>Search backend<select name="backend"><option value="xai"${saved.backend === "xai" ? " selected" : ""}>xAI Web Search (Grok OAuth)</option><option value="bing"${saved.backend === "bing" ? " selected" : ""}>Bing public web search (no key)</option><option value="disabled"${saved.backend === "disabled" ? " selected" : ""}>Disabled</option><option value="searxng"${saved.backend === "searxng" ? " selected" : ""}>SearXNG</option></select></label><label>SearXNG base URL<input name="url" type="url" value="${esc(saved.url)}" placeholder="https://your-search-instance.example"><small>Queries go to this instance when search is enabled.</small></label><label>Maximum results<input name="maxResults" type="number" min="1" max="20" step="1" required value="${Number(saved.maxResults) || 5}"></label><div data-feedback hidden></div><div class="form-actions"><button type="submit" class="primary">Save search settings</button></div></form><section class="section"><h2>Try the saved search configuration</h2><p class="field-hint">A manual search sends your query to the configured search endpoint.</p><form class="search-form" data-search><label>Test query<input type="search" name="query" required maxlength="2000" placeholder="Enter a real search query"></label><button type="submit" data-search-button>Search</button><div data-feedback hidden></div></form><div data-results></div></section></div><aside class="settings-note"><h2>Web access</h2><p>Choose xAI Web Search with your signed-in Grok account, public Bing search without a key, or your own SearXNG instance. xAI search uses subscription quota. Teammates can also read public HTTPS pages and browse in their workspace.</p><p>Search results are external source material, not verified facts. Ask your teammate to cite sources and distinguish uncertainty.</p></aside></div>`;
  const config = main.querySelector("[data-config]");
  const search = main.querySelector("[data-search]");
  const button = main.querySelector("[data-search-button]");
  const dirty = () => config.elements.backend.value !== saved.backend || (config.elements.url.value.trim() || "") !== (saved.url || "") || Number(config.elements.maxResults.value) !== saved.maxResults;
  function sync() {
    const disabled = config.elements.backend.value !== "searxng";
    config.elements.url.disabled = disabled; config.elements.url.required = !disabled;
    button.disabled = saved.backend === "disabled" || dirty();
    button.title = dirty() ? "Save the changed settings before searching." : saved.backend === "disabled" ? "Enable and save a search backend first." : "Run a search";
  }
  config.addEventListener("input", sync); config.elements.backend.onchange = sync;
  config.addEventListener("actionend", () => { if (ctx.current()) sync(); });
  submit(config, async (data) => {
    await post("/api/websearch", { backend: data.get("backend"), url: data.get("url")?.trim() || undefined, maxResults: Number(data.get("maxResults")) });
    ctx.changed();
    if (!ctx.current()) return;
    saved = await ctx.get("/api/websearch");
    if (ctx.current()) {
      config.elements.backend.value = saved.backend;
      config.elements.url.value = saved.url || "";
      config.elements.maxResults.value = saved.maxResults;
      feedback(config, "Search settings saved. No test query was sent.", "success"); sync();
    }
  });
  submit(search, async (data) => {
    if (saved.backend === "disabled" || dirty()) throw new Error("Enable and save the search configuration first.");
    const hits = await ctx.get(`/api/websearch/search?q=${enc(data.get("query").trim())}`);
    if (!ctx.current()) return;
    main.querySelector("[data-results]").innerHTML = hits.length ? hits.map((hit) => {
      const url = safeUrl(hit.url);
      return `<article class="data-card"><h3>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(hit.title || hit.url)}</a>` : esc(hit.title || "Unusable source link")}</h3><p>${esc(hit.snippet)}</p></article>`;
    }).join("") : '<p class="quiet-empty">The search returned no results.</p>';
    feedback(search, `${hits.length} search result${hits.length === 1 ? "" : "s"} returned.`, "success");
  }, "Searching the configured endpoint...");
  sync();
}

async function permissionControls(ctx, main) {
  const value = await ctx.get("/api/permissions"); if (!ctx.current()) return;
  const choices = (inherited = false) => `${inherited ? '<option value="inherit">Use default</option>' : ''}<option value="ask">Ask first</option><option value="auto">Always approve (skip prompts)</option>`;
  main.innerHTML = `<section class="section"><h2>Permission mode</h2><p>Always approve lets bots open workspaces, launch applications, call MCP tools and perform external actions without asking each time. Use it only for bots and tools you trust. Manual sign-in handoffs and Stop still work.</p><form data-default-permission><label>Default for bots<select name="mode" aria-label="Default for bots">${choices()}</select></label><button class="primary">Save permission mode</button><div data-feedback hidden></div></form><h3>Individual bots</h3>${value.bots.map(bot => `<form class="section-heading" data-bot-permission="${esc(bot.name)}"><label>${esc(bot.name)}<select name="mode">${choices(true)}</select></label><button class="small">Save for ${esc(bot.name)}</button><div data-feedback hidden></div></form>`).join("")}</section>`;
  const form = main.querySelector('[data-default-permission]'); form.elements.mode.value = value.mode;
  submit(form, async data => { await api('/api/permissions',{method:'PUT',body:{mode:data.get('mode')}});ctx.changed();if(ctx.current())feedback(form,'Permission mode saved. Pending requests covered by automatic approval can continue.','success'); });
  main.querySelectorAll('[data-bot-permission]').forEach(form => { form.elements.mode.value=value.bots.find(bot=>bot.name===form.dataset.botPermission).override;submit(form,async data=>{await api('/api/permissions',{method:'PUT',body:{mode:data.get('mode'),bot:form.dataset.botPermission}});ctx.changed();if(ctx.current())feedback(form,'Bot permission mode saved.','success');}); });
}
