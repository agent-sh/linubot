import { api, post, confirmAction, feedback, action } from "./ui.js";

let state, request;
const listeners = new Set();
async function checkUpdates(force = false) {
  if (request) {
    if (!force || request.force) return request.promise;
    try { await request.promise; } catch { /* Manual refresh still gets its own attempt after a failed status read. */ }
    return checkUpdates(true);
  }
  const next = { force, promise: Promise.resolve().then(async () => {
    state = await (force ? post("/api/updates/check") : api("/api/updates"));
    for (const listener of listeners) listener(state);
    return state;
  }) };
  request = next;
  try { return await next.promise; } finally { if (request === next) request = undefined; }
}

export function updateSettings(ctx, root) {
  root.innerHTML = '<div class="section-heading"><div><h2>App updates</h2><p class="field-hint" data-version></p></div><button type="button" class="small" data-check-updates>Check for updates</button></div><p class="field-hint" data-update-status role="status">Checking the installed version…</p><div data-feedback hidden></div>';
  const button = root.querySelector("[data-check-updates]");
  const render = (value) => {
    if (!ctx.current()) return;
    root.querySelector("[data-version]").textContent = `Linubot ${value.currentVersion}`;
    button.disabled = value.enabled === false;
    root.querySelector("[data-update-status]").textContent = value.enabled === false ? "Update checks are disabled for this launch." : value.error || `${value.latest ? `Version ${value.latest.version} is available. Use the sidebar upgrade button.` : "No compatible update is available."}${value.checkedAt ? ` Last checked ${new Date(value.checkedAt).toLocaleTimeString()}.` : ""}`;
  };
  listeners.add(render); ctx.onCleanup(() => listeners.delete(render));
  if (state) render(state);
  else void checkUpdates().catch((error) => { if (ctx.current()) feedback(root, error.message); });
  button.onclick = () => void action(root, async () => { await checkUpdates(true); }, "Checking GitHub releases…");
}

export function initUpdates() {
  const button = document.querySelector("[data-upgrade]");
  const render = (value) => { button.hidden = !value.latest; if (value.latest) button.textContent = `Upgrade to ${value.latest.version}`; };
  listeners.add(render);
  const check = (force = false) => { void checkUpdates(force).catch(() => {}); };
  button.onclick = () => {
    if (!state?.latest) return;
    if (!state.canInstall) { window.open(state.latest.url, "_blank", "noopener"); return; }
    confirmAction(`Upgrade to Linubot ${state.latest.version}?`, "Downloads the release, verifies its checksum and restarts Linubot. Your bots, sessions and credentials stay here. Finish active tasks before upgrading.", async (modal) => {
      feedback(modal.root, "Downloading and verifying the update…", "info");
      await post("/api/updates/install", {}, { timeout: 660000 });
      if (modal.alive()) modal.close();
    }, { label: "Download and restart" });
  };
  check();
  let lastForegroundCheck = 0;
  const foreground = () => {
    if (document.visibilityState === "hidden" || Date.now() - lastForegroundCheck < 60000) return;
    lastForegroundCheck = Date.now(); check(true);
  };
  window.addEventListener("focus", foreground);
  document.addEventListener("visibilitychange", foreground);
  const timer = setInterval(() => check(), 60000);
  window.addEventListener("pagehide", () => { clearInterval(timer); listeners.delete(render); window.removeEventListener("focus", foreground); document.removeEventListener("visibilitychange", foreground); }, { once: true });
}
