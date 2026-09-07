import { api, post, confirmAction, feedback } from "./ui.js";

export function initUpdates() {
  const button = document.querySelector("[data-upgrade]");
  let state;
  async function check() {
    try {
      state = await api("/api/updates");
      button.hidden = !state.latest;
      if (state.latest) button.textContent = `Upgrade to ${state.latest.version}`;
    } catch { /* Release checks must not interrupt conversations when offline. */ }
  }
  button.onclick = () => {
    if (!state?.latest) return;
    if (!state.canInstall) { window.open(state.latest.url, "_blank", "noopener"); return; }
    confirmAction(`Upgrade to Linubot ${state.latest.version}?`, "Downloads the release, verifies its checksum and restarts Linubot. Your bots, sessions and credentials stay here. Finish active tasks before upgrading.", async (modal) => {
      feedback(modal.root, "Downloading and verifying the update…", "info");
      await post("/api/updates/install", {}, { timeout: 660000 });
      if (modal.alive()) modal.close();
    }, { label: "Download and restart" });
  };
  void check();
  const timer = setInterval(check, 6 * 3600000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
}
