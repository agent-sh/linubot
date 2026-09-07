import { post, enc, esc, icon, feedback, dialog, submit } from "./ui.js";

export function screenPoint(event, image) {
  const rect = image.getBoundingClientRect();
  if (!image.naturalWidth || !image.naturalHeight) return;
  const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
  const left = rect.left + (rect.width - image.naturalWidth * scale) / 2;
  const top = rect.top + (rect.height - image.naturalHeight * scale) / 2;
  const x = Math.floor((event.clientX - left) / scale), y = Math.floor((event.clientY - top) / scale);
  if (x < 0 || y < 0 || x >= image.naturalWidth || y >= image.naturalHeight) return;
  return { x, y };
}
export function computerKey(event) {
  const named = { Enter: "Return", Backspace: "BackSpace", Tab: "Tab", Escape: "Escape", Delete: "Delete", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Home: "Home", End: "End", PageUp: "Page_Up", PageDown: "Page_Down", Insert: "Insert" };
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return { action: "type", text: event.key };
  const key = named[event.key] || (/^F([1-9]|1[0-2])$/.test(event.key) ? event.key : /^[a-zA-Z0-9]$/.test(event.key) ? event.key.toLowerCase() : undefined);
  if (!key) return;
  return { action: "key", keys: [event.ctrlKey ? "ctrl" : "", event.altKey ? "alt" : "", event.metaKey ? "super" : "", event.shiftKey ? "shift" : "", key].filter(Boolean).join("+") };
}

export function computerPanel(ctx, button, beforeOpen) {
  const layout = ctx.root.querySelector(".chat-layout"), panel = document.createElement("aside");
  panel.className = "computer-panel"; panel.hidden = true; panel.setAttribute("aria-label", "Bot computer");
  panel.innerHTML = `<div class="section-heading"><h2>Computer</h2><div class="actions"><button type="button" class="small subtle" data-expand aria-pressed="false">Expand</button><button type="button" class="icon-button" data-close aria-label="Close computer">${icon("close")}</button></div></div><label class="sr-only" for="computer-select">Workspace</label><select id="computer-select" data-select></select><p class="field-hint" data-state role="status"></p><div class="computer-screen"><img alt="Live view of the bot’s separate computer" draggable="false" tabindex="-1" data-screen hidden><p class="quiet-empty" data-empty>No computer is open for this conversation. Ask the bot to open a browser or use its computer.</p></div><div class="computer-controls"><button type="button" class="primary" data-take disabled>Take control</button><button type="button" class="primary" data-return hidden>Return to bot</button><button type="button" class="small" data-paste hidden>Paste text</button></div><p class="field-hint" data-hint>Watch here, or take control to sign in yourself. Closing the view leaves the task running.</p><div data-feedback hidden></div>`;
  layout.append(panel);
  const screen = panel.querySelector("[data-screen]"), select = panel.querySelector("[data-select]"), take = panel.querySelector("[data-take]"), giveBack = panel.querySelector("[data-return]");
  let entries = [], selected = "", token, frameTimer, statusTimer, imageUrl, frameController, openingController, disposed = false, sequence = 0, frameReady = false, frameLoadedAt = 0, frameExpiry, inputQueue = Promise.resolve(), pendingInputs = 0;
  const live = () => !disposed && ctx.current();
  const entry = () => entries.find((item) => item.id === selected);
  function controls() {
    const current = entry();
    panel.querySelector("[data-paste]").disabled = !frameReady;
    take.disabled = !current || Boolean(openingController);
    take.hidden = Boolean(token); giveBack.hidden = !token;
    panel.querySelector("[data-paste]").hidden = !token;
    select.disabled = Boolean(token) || Boolean(openingController);
    screen.tabIndex = token && frameReady ? 0 : -1;
    screen.classList.toggle("controlling", Boolean(token && frameReady));
    panel.querySelector("[data-state]").textContent = token ? frameReady ? "You’re in control. The bot is paused." : "Waiting for a fresh computer view. Input is paused." : current?.requested ? `Needs you: ${current.requested}` : current?.manual ? "User control is active. Take control here to continue." : current ? "Watching the bot’s computer" : "";
    button.classList.toggle("needs-attention", entries.some((item) => item.requested || item.manual));
    button.setAttribute("aria-expanded", String(!panel.hidden));
    button.title = entries.some((item) => item.manual) ? "Computer paused for you" : "Open the bot’s computer";
    panel.querySelector("[data-hint]").textContent = token ? "Close this view whenever you need. The bot waits until you explicitly return control." : "Watch here, or take control to sign in yourself. Closing a watch-only view leaves the task running.";
  }
  async function returnControl() {
    openingController?.abort();
    if (!token) return;
    const held = token, id = selected;
    giveBack.disabled = true; screen.tabIndex = -1;
    await inputQueue;
    try { await post("/api/computer/control", { id, token: held, action: "release" }); }
    catch (error) { if (![403, 404, 409].includes(error.status) && entry()) throw error; }
    finally { giveBack.disabled = false; }
    if (token === held) token = undefined;
    if (live()) controls();
  }
  async function refresh() {
    try {
      const result = await ctx.get(`/api/computer/views?scope=${enc(`${ctx.kind}:${ctx.name}`)}`);
      if (!live()) return;
      entries = result.workspaces;
      if (!entries.some((item) => item.id === selected)) { selected = entries[0]?.id || ""; token = undefined; sequence++; clearFrame(); }
      const options = entries.map((item) => `<option value="${esc(item.id)}">${esc(item.purpose)}</option>`).join("");
      if (select.innerHTML !== options) { select.innerHTML = options; select.value = selected; }
      select.hidden = entries.length < 2;
      panel.querySelector("[data-empty]").hidden = Boolean(selected);
      if (!selected) screen.hidden = true;
      controls();
      if (!panel.hidden && selected && !frameTimer && !frameController) void frame();
    } catch (error) { if (live() && !panel.hidden) feedback(panel, error.message); }
    finally { if (live()) statusTimer = setTimeout(refresh, 1500); }
  }
  function clearFrame() {
    frameReady = false; clearTimeout(frameExpiry);
    clearTimeout(frameTimer); frameTimer = undefined; frameController?.abort(); frameController = undefined;
    if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = undefined; }
    screen.removeAttribute("src"); screen.hidden = true;
  }
  async function frame() {
    frameTimer = undefined;
    if (!live() || panel.hidden || !selected) return;
    const id = selected, version = sequence, ctrl = new AbortController(); frameController = ctrl;
    try {
      const response = await fetch(`/api/computer/frame?id=${enc(id)}`, { credentials: "same-origin", cache: "no-store", signal: ctrl.signal });
      if (!response.ok) throw new Error("The computer view is unavailable. The task may have finished.");
      const blob = await response.blob();
      if (!live() || panel.hidden || version !== sequence || id !== selected) return;
      if (blob.size > 8 * 1024 * 1024 || blob.type !== "image/png") throw new Error("Invalid computer frame");
      const next = URL.createObjectURL(blob), prior = imageUrl;
      imageUrl = next;
      screen.onload = () => {
        if (!live() || imageUrl !== next || version !== sequence || id !== selected) return;
        frameReady = true; frameLoadedAt = Date.now(); clearTimeout(frameExpiry); controls();
        frameExpiry = setTimeout(() => { frameReady = false; if (live()) controls(); }, 3000);
      };
      screen.src = next; screen.hidden = false;
      if (prior) URL.revokeObjectURL(prior);
    } catch (error) { if (live() && !ctrl.signal.aborted) { clearFrame(); controls(); feedback(panel, error.message); } }
    finally {
      if (frameController === ctrl) frameController = undefined;
      if (live() && !panel.hidden && id === selected && version === sequence) frameTimer = setTimeout(frame, token ? 350 : 900);
    }
  }
  async function close() {
    try {
      openingController?.abort();
      giveBack.disabled = true;
      await inputQueue;
      giveBack.disabled = false;
      panel.hidden = true; panel.classList.remove("wide"); layout.classList.remove("computer-open");
      sequence++; clearFrame(); controls(); button.focus(); return true;
    } catch (error) { feedback(panel, error.message); return false; }
  }
  button.onclick = () => {
    if (!panel.hidden) { void close(); return; }
    beforeOpen(); panel.hidden = false; layout.classList.add("computer-open"); controls();
    if (selected) void frame();
  };
  panel.querySelector("[data-close]").onclick = () => { void close(); };
  panel.querySelector("[data-expand]").onclick = (event) => {
    const wide = panel.classList.toggle("wide"); event.currentTarget.setAttribute("aria-pressed", String(wide)); event.currentTarget.textContent = wide ? "Shrink" : "Expand";
  };
  select.onchange = () => { selected = select.value; sequence++; clearFrame(); controls(); void frame(); };
  take.onclick = async () => {
    const id = selected, version = sequence, ctrl = new AbortController(); openingController = ctrl; controls(); feedback(panel, "Waiting for the bot’s current computer action…", "info");
    try {
      const result = await post("/api/computer/control", { id, action: "take" }, { signal: ctrl.signal, timeout: 120000 });
      if (!live() || version !== sequence || id !== selected || panel.hidden) { await post("/api/computer/control", { id, token: result.token, action: "release" }); return; }
      token = result.token; sequence++; clearFrame(); feedback(panel, "", "info"); controls(); void frame();
    } catch (error) { if (live() && !ctrl.signal.aborted) feedback(panel, error.message); }
    finally { if (openingController === ctrl) openingController = undefined; if (live()) controls(); }
  };
  giveBack.onclick = () => { void returnControl().catch((error) => feedback(panel, error.message)); };
  function input(value) {
    if (!value) return Promise.resolve();
    if (!token || !frameReady || Date.now() - frameLoadedAt >= 3000 || giveBack.disabled || pendingInputs >= 64) return Promise.reject(new Error("Wait for a fresh computer view before entering more input."));
    const id = selected, held = token;
    pendingInputs++;
    const work = inputQueue.then(async () => {
      if (!live() || held !== token || id !== selected || !frameReady || Date.now() - frameLoadedAt >= 3000) throw new Error("The computer view changed. Check the live screen and try again.");
      await post("/api/computer/input", { ...value, id, token: held });
    });
    inputQueue = work.catch((error) => {
      if (live()) {
        if ([403, 404, 409].includes(error.status) && token === held) { token = undefined; controls(); }
        feedback(panel, error.message);
      }
    }).finally(() => { pendingInputs--; });
    return work;
  }
  const sendInput = (value) => { void input(value).catch((error) => { if (live()) feedback(panel, error.message); }); };
  let pointerDown;
  screen.onpointerdown = (event) => {
    if (!token || !frameReady) return;
    const point = screenPoint(event, screen);
    if (point) { pointerDown = { ...point, pointerId: event.pointerId, button: event.button }; screen.setPointerCapture(event.pointerId); screen.focus(); event.preventDefault(); }
  };
  screen.onpointerup = (event) => {
    const start = pointerDown; pointerDown = undefined;
    if (!start || start.pointerId !== event.pointerId) return;
    screen.releasePointerCapture(event.pointerId);
    const point = screenPoint(event, screen); if (!point) return;
    if (start.button === 0 && Math.hypot(point.x - start.x, point.y - start.y) > 4) sendInput({ action: "drag", fromX: start.x, fromY: start.y, toX: point.x, toY: point.y });
    else sendInput({ action: "click", ...point, button: start.button === 2 ? 3 : start.button === 1 ? 2 : 1 });
  };
  screen.onpointercancel = () => { pointerDown = undefined; };
  screen.oncontextmenu = (event) => event.preventDefault();
  screen.addEventListener("keydown", (event) => { if (!token) return; event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return; event.preventDefault(); sendInput(computerKey(event)); });
  screen.addEventListener("paste", (event) => { if (!token) return; event.preventDefault(); sendInput({ action: "paste", text: event.clipboardData.getData("text/plain").slice(0, 16000) }); });
  screen.addEventListener("wheel", (event) => {
    if (!token || !frameReady) return;
    event.preventDefault(); const point = screenPoint(event, screen);
    if (point) sendInput({ action: "scroll", ...point, direction: event.deltaY < 0 ? "up" : "down", amount: Math.min(6, Math.max(1, Math.ceil(Math.abs(event.deltaY) / 100))) });
  }, { passive: false });
  panel.querySelector("[data-paste]").onclick = () => {
    const modal = dialog("Paste into the computer", '<form><label>Text<textarea name="text" rows="4" maxlength="16000" spellcheck="false" autocomplete="off" autofocus></textarea></label><p class="field-hint">This is typed into the workspace, without adding it to the conversation.</p><div data-feedback hidden></div><div class="form-actions"><button type="submit" class="primary">Paste into computer</button></div></form>');
    submit(modal.root.querySelector("form"), async (data) => { await input({ action: "paste", text: data.get("text") }); if (modal.alive()) modal.close(); screen.focus(); });
  };
  ctx.onCleanup(() => {
    disposed = true; openingController?.abort(); clearTimeout(statusTimer); sequence++; clearFrame();
    // Manual ownership remains paused across navigation; a reopened panel can reclaim it.
  });
  void refresh();
  return { close };
}
