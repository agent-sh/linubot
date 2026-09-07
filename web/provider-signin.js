import { post, esc, enc, action, feedback } from "./ui.js";

const guides = {
  anthropic: ["Create an Anthropic API key", "https://platform.claude.com/settings/keys", "Claude subscriptions do not provide a general third-party OAuth login. Use a Console API key."],
  openai: ["Create an OpenAI API key", "https://platform.openai.com/api-keys", "For a ChatGPT account, choose OpenAI / ChatGPT sign-in instead."],
  gemini: ["Get a Gemini API key", "https://aistudio.google.com/apikey", "The quickest Gemini setup is an AI Studio API key. Google Gemini OAuth is also available with your own Google Cloud client."],
  "qwen-token": ["Set up Qwen Token Plan", "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/", "Qwen plans use API keys. Choose the endpoint for your plan and region."],
  "qwen-coding": ["Set up Qwen Coding Plan", "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/", "Use an international Coding Plan key, or connect your matching Qwen Code configuration."],
  "qwen-coding-cn": ["Set up Qwen Coding Plan", "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/", "Use a China Coding Plan key, or connect your matching Qwen Code configuration."],
  "zai-coding": ["Get a Z.ai Coding Plan key", "https://docs.z.ai/devpack/quick-start", "Use a Coding Plan key with this plan endpoint. Your plan's eligibility and usage rules apply."],
  zai: ["Get a Z.ai API key", "https://z.ai/manage-apikey/apikey-list", "For a Coding Plan, choose the separate Z.ai Coding Plan preset."],
};

export function providerSignin(ctx, root, draft, connected) {
  root.className = "section browser-connect";
  let flow, timer, generation = 0, pending, selection = "", googleClient;
  async function cancel() {
    generation++; pending?.abort(); pending = undefined; clearTimeout(timer);
    const prior = flow; flow = undefined;
    if (prior) await post(`/api/oauth/${prior.provider}/cancel`, { id: prior.id }).catch(() => {});
  }
  ctx.onCleanup(() => { googleClient = undefined; void cancel(); });
  function render(preset) {
    const value = draft(), key = `${value.id || "new"}:${value.kind}:${value.baseUrl}:${value.auth}:${preset}`;
    if (selection === key) return;
    selection = key; void cancel(); googleClient = undefined;
    const codex = value.kind === "openai-codex", google = value.kind === "google-oauth", guide = guides[preset];
    root.hidden = !codex && !google && !guide;
    if (root.hidden) { root.innerHTML = ""; return; }
    const heading = codex ? "Connect ChatGPT" : google ? "Connect Google Gemini" : guide[0];
    root.innerHTML = `<h2>${esc(heading)}</h2>${codex ? '<p class="field-hint">Sign in in your browser, or use the ChatGPT account already connected in Codex. Install the official Codex CLI first. Codex handles sign-in and renewal.</p><p class="field-hint"><a href="https://developers.openai.com/codex/cli" target="_blank" rel="noopener noreferrer">Install Codex CLI</a></p><div class="actions"><button type="button" class="primary" data-start>Sign in with ChatGPT</button><button type="button" data-existing>Use existing Codex sign-in</button></div>' : google ? '<p class="field-hint">Use your own Google Cloud Desktop OAuth client and Gemini API project. This uses Gemini API billing and quotas.</p><p><a href="https://ai.google.dev/gemini-api/docs/oauth" target="_blank" rel="noopener noreferrer">Create a Google Desktop OAuth client</a></p><label>OAuth client JSON<input type="file" accept=".json,application/json" data-google-client></label><label>Google Cloud project ID<input data-google-project autocomplete="off" spellcheck="false" maxlength="128"></label><p class="field-hint" data-google-setup>Choose the downloaded client JSON. You can reconnect with saved settings.</p><button type="button" class="primary" data-start>Sign in with Google</button>' : `<p class="field-hint">${esc(guide[2])}</p><a href="${esc(guide[1])}" target="_blank" rel="noopener noreferrer">${esc(guide[0])}</a>${preset.startsWith("qwen-") ? '<p><button type="button" data-qwen>Use Qwen Code key</button></p><p class="field-hint">Reads the matching plan key from your local Qwen Code settings when needed. The key is never shown here.</p>' : ""}`}<button type="button" data-cancel hidden>Cancel sign-in</button><div data-feedback hidden></div><div data-login-link></div>`;
    const owner = generation, current = () => ctx.current() && owner === generation;
    if (google) {
      ctx.get(`/api/oauth/google/config${value.id ? `?id=${enc(value.id)}` : ""}`).then((config) => {
        if (!current()) return;
        if (!root.querySelector("[data-google-project]").value) root.querySelector("[data-google-project]").value = config.projectId;
        if (config.configured) root.querySelector("[data-google-setup]").textContent = "OAuth client available. Choose a new JSON file only to change it.";
      }).catch((error) => { if (current()) feedback(root, error.message); });
      root.querySelector("[data-google-client]").onchange = async (event) => {
        try {
          const file = event.target.files[0]; googleClient = undefined;
          if (!file) return;
          if (file.size > 65536) throw new Error("Choose the small Desktop OAuth client JSON from Google Cloud.");
          const json = JSON.parse(await file.text());
          if (!current()) return;
          if (!json?.installed?.client_id || !json.installed.client_secret) throw new Error("This must be a Desktop OAuth client JSON file.");
          googleClient = { clientId: json.installed.client_id, clientSecret: json.installed.client_secret };
          if (!root.querySelector("[data-google-project]").value) root.querySelector("[data-google-project]").value = json.installed.project_id || "";
          feedback(root, "OAuth client ready. Sign in to connect.", "success");
        } catch (error) { if (current()) feedback(root, error.message); }
      };
    }
    const qwen = root.querySelector("[data-qwen]");
    if (qwen) qwen.onclick = () => void action(root, async () => {
      const result = await post("/api/provider/qwen", { id: value.id, baseUrl: value.baseUrl });
      if (current()) await connected(result.id);
    });
    const existing = root.querySelector("[data-existing]");
    if (existing) existing.onclick = () => void action(root, async () => {
      const result = await post("/api/oauth/codex/existing", { id: value.id }, { timeout: 70000 });
      if (current()) await connected(result.connectionId);
    }, "Connecting your Codex account…");
    const start = root.querySelector("[data-start]");
    if (!start) return;
    const cancelButton = root.querySelector("[data-cancel]");
    cancelButton.onclick = () => { void cancel(); selection = ""; render(preset); feedback(root, "Sign-in cancelled.", "info"); };
    start.onclick = () => void action(root, async () => {
      if (flow || pending) return;
      const provider = codex ? "codex" : "google", attempt = generation;
      const controller = new AbortController(); pending = controller;
      let result;
      try {
        result = await post(`/api/oauth/${provider}/start`, { id: value.id, ...(google ? { ...googleClient, projectId: root.querySelector("[data-google-project]").value.trim() } : {}) }, { signal: controller.signal, timeout: 70000 });
      } catch (error) {
        if (!ctx.current() || attempt !== generation) return;
        throw error;
      } finally { if (pending === controller) pending = undefined; }
      if (!ctx.current() || attempt !== generation) { await post(`/api/oauth/${provider}/cancel`, { id: result.id }); return; }
      flow = { ...result, provider }; googleClient = undefined;
      cancelButton.hidden = false; start.disabled = true;
      root.querySelector("[data-login-link]").innerHTML = `<p class="field-hint">Finish signing in, then return here. <a href="${esc(result.authorizationUrl)}" target="_blank" rel="noopener noreferrer">Open sign-in again</a></p>`;
      window.open(result.authorizationUrl, "_blank", "noopener");
      async function poll() {
        if (!ctx.current() || flow?.id !== result.id) return;
        try {
          const status = await ctx.get(`/api/oauth/${provider}/status?id=${enc(result.id)}`);
          if (!ctx.current() || flow?.id !== result.id) return;
          if (status.state === "connected") { flow = undefined; cancelButton.hidden = true; await connected(status.connectionId); }
          else if (["failed", "cancelled"].includes(status.state)) { flow = undefined; cancelButton.hidden = true; start.disabled = false; feedback(root, status.error || "Sign-in cancelled."); }
          else timer = setTimeout(poll, 1000);
        } catch (error) { if (current()) { await cancel(); selection = ""; render(preset); feedback(root, error.message); } }
      }
      timer = setTimeout(poll, 500);
    }, "Opening browser sign-in…");
  }
  return { render, cancel: async () => { selection = ""; await cancel(); } };
}
