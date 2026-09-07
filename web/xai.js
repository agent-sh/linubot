import { post, esc, badge, action, feedback } from "./ui.js";

export async function xaiAccount(ctx, root) {
  const status = await ctx.get("/api/xai");
  if (!ctx.current()) return;
  const controller = new AbortController();
  let timer;
  ctx.onCleanup(() => { controller.abort(); clearTimeout(timer); });
  root.innerHTML = `<section class="section xai-account"><div class="section-heading"><div><h2>xAI account</h2><p class="field-hint">Use your Grok subscription through OAuth.</p></div>${badge(status.connected ? "approved" : "pending", status.connected ? "Signed in" : "Not signed in")}</div>${status.connected ? `<p class="field-hint">${status.source === "hermes" ? "Using your existing Hermes sign-in. Refresh stays coordinated with Hermes." : status.persistent ? "Session protected by the Linux keyring." : "Session kept in memory until the app closes."}</p>` : ""}<div class="actions"><button type="button" data-login>Sign in with xAI</button>${status.canImportHermes ? '<button type="button" data-import>Use existing Hermes sign-in</button>' : ""}${status.connected ? '<button type="button" class="subtle" data-disconnect>Disconnect here</button>' : ""}</div><div data-feedback hidden></div><div data-login-status></div></section>`;
  const section = root.querySelector("section");
  root.querySelector("[data-import]")?.addEventListener("click", () => void action(section, async () => {
    await post("/api/xai/import", { approved: true }); ctx.changed(); ctx.reload();
  }, "Connecting the existing xAI sign-in…"));
  root.querySelector("[data-disconnect]")?.addEventListener("click", () => void action(section, async () => {
    await post("/api/xai/disconnect"); ctx.changed(); ctx.reload();
  }));
  root.querySelector("[data-login]").onclick = () => void action(section, async () => {
    const login = await post("/api/xai/login", {}, { signal: controller.signal });
    if (!ctx.current()) return;
    window.open(login.verificationUri, "_blank", "noopener");
    root.querySelector("[data-login-status]").innerHTML = `<div class="notice-box"><div><p>Open xAI, sign in, and approve this device.</p><p><strong>${esc(login.userCode)}</strong></p><a class="button primary" href="${esc(login.verificationUri)}" target="_blank" rel="noopener noreferrer">Open xAI sign-in ↗</a><p class="field-hint">This page updates after you finish signing in.</p></div></div>`;
    async function poll() {
      if (controller.signal.aborted) return;
      try {
        const result = await post("/api/xai/poll", { id: login.id }, { signal: controller.signal });
        if (result.state === "connected") { ctx.changed(); ctx.reload(); return; }
        timer = setTimeout(poll, Math.max(5, result.interval) * 1000);
      } catch (error) { if (!controller.signal.aborted) feedback(section, error.message); }
    }
    clearTimeout(timer); timer = setTimeout(poll, login.interval * 1000);
  }, "Starting xAI sign-in…");
}
