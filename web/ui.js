import { mascot } from "./mascots.js";
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const enc = encodeURIComponent;
export const lines = (value) => String(value ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
export const activeRun = (run) => ["queued", "running", "awaiting_approval"].includes(run.status);

const paths = {
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  chat: '<path d="M4 4h16v12H9l-5 5z"/>',
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-6v-7h-4v7H4a1 1 0 0 1-1-1z"/>',
  lab: '<path d="M9 3h6m-5 0v7L4 19a1.3 1.3 0 0 0 1 2h14a1.3 1.3 0 0 0 1-2l-6-9V3M7 15h10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  library: '<path d="M4 4h5v17H4zM9 4h5v17H9zM16 5l4-1 3 16-4 1zM5 8h3m2 9h3"/>',
  memory: '<path d="M6 3h14v18H6a3 3 0 0 1 0-6h14M6 3a3 3 0 0 0-3 3v12M9 7h7m-7 4h5"/>',
  computer: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5M7 7l3 3-3 3m6 0h4"/>',
  settings: '<path d="m10 3-1 3-3 1-3 3 2 2-1 4 4 1 2 4h4l2-4 4-1-1-4 2-2-3-3-3-1-1-3z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  send: '<path d="m4 4 17 8-17 8 3-8zM7 12h14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  alert: '<path d="M12 3 2 21h20zM12 9v5m0 3v1"/>',
  file: '<path d="M13 3H5v18h14V9zM13 3v6h6M8 13h8m-8 4h6"/>',
  tool: '<path d="M14 6a5 5 0 0 0-6 6l-5 5a2 2 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-4-4z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  group: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14z"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  refresh: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  leaf: '<path d="M20 3C5 2 1 9 6 16s15 2 14-13ZM5 21 16 9"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',
  camera: '<path d="m8 5 2-2h4l2 2h5v16H3V5z"/><circle cx="12" cy="12" r="4"/>',
  pin: '<path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4zM12 15v7"/>',
};
export function icon(name, extra = "") {
  return `<svg class="icon ${esc(extra)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
}
export function avatar(name, group = false, seed) {
  return `<span class="avatar${group ? " group-avatar" : ""}" aria-hidden="true">${group ? icon("group") : mascot(seed || name || "linubot")}</span>`;
}
export function badge(status, label) {
  const good = ["completed", "done", "approved", "accepted", "useful", "passed"].includes(status);
  const bad = ["failed", "error", "needs_work", "denied"].includes(status);
  const waiting = ["proposed", "pending", "awaiting_approval", "draft"].includes(status);
  const working = ["running", "working", "queued", "recording"].includes(status);
  return `<span class="badge ${good ? "good" : bad ? "bad" : waiting ? "waiting" : working ? "working" : ""}">${esc(label || String(status || "unknown").replaceAll("_", " "))}</span>`;
}
export function date(value, utc = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return "-";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", ...(utc ? { timeZone: "UTC" } : {}) }).format(new Date(value)) + (utc ? " UTC" : "");
}
export function duration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "-";
  const seconds = Math.round(ms / 1000);
  return ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
export function safeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || /[\u0000-\u0020\u007f\\]/.test(raw) || raw.startsWith("//")) return null;
  if (!/^(https?:\/\/|\/(?!\/)|#)/i.test(raw)) return null;
  try {
    const parsed = new URL(raw, globalThis.location?.href || "http://localhost/");
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return raw;
  } catch { return null; }
}
export function safeArtifact(value) {
  return /^\/api\/artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/download$/i.test(String(value || "")) ? value : null;
}
function inline(text) {
  const token = /`([^`\n]+)`|\[([^\[\]\n]+)\]\(([^\s()]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  let out = "", start = 0;
  for (const match of text.matchAll(token)) {
    out += esc(text.slice(start, match.index));
    if (match[1]) out += `<code>${esc(match[1])}</code>`;
    else if (match[2]) {
      const url = safeUrl(match[3]);
      out += url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(match[2])}</a>` : esc(match[0]);
    } else if (match[4]) out += `<strong>${esc(match[4])}</strong>`;
    else out += `<em>${esc(match[5])}</em>`;
    start = match.index + match[0].length;
  }
  return out + esc(text.slice(start));
}

// Only generated tags enter the output. All text and every URL attribute are escaped.
export function markdown(value) {
  const text = String(value ?? "").replaceAll("\r\n", "\n");
  const out = [], paragraph = [];
  let list = "", code = null, language = "";
  const endParagraph = () => { if (paragraph.length) out.push(`<p>${paragraph.splice(0).map(inline).join("<br>")}</p>`); };
  const endList = () => { if (list) out.push(`</${list}>`); list = ""; };
  const endCode = () => { out.push(`<div class="code-block"><div class="code-heading"><span>${esc(language || "Code")}</span><button type="button" class="small subtle" data-copy-code aria-label="Copy code">${icon("copy")} Copy</button></div><pre><code>${esc(code.join("\n"))}</code></pre></div>`); code = null; };
  for (const line of text.split("\n")) {
    const fence = /^\s*```([\w-]*)\s*$/.exec(line);
    if (fence) {
      if (code !== null) endCode();
      else { endParagraph(); endList(); code = []; language = fence[1]; }
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    if (!line.trim()) { endParagraph(); endList(); continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const item = /^\s*(?:([-*+])|\d+\.)\s+(.+)$/.exec(line);
    if (heading) { endParagraph(); endList(); const h = Math.min(heading[1].length + 2, 6); out.push(`<h${h}>${inline(heading[2])}</h${h}>`); }
    else if (item) {
      endParagraph(); const next = item[1] ? "ul" : "ol";
      if (list !== next) { endList(); out.push(`<${next}>`); list = next; }
      out.push(`<li>${inline(item[2])}</li>`);
    } else if (/^>\s?/.test(line)) { endParagraph(); endList(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`); }
    else { endList(); paragraph.push(line); }
  }
  if (code !== null) endCode();
  endParagraph(); endList();
  return out.join("");
}

export async function api(path, { method = "GET", body, signal, timeout = 25000 } = {}) {
  if (!path.startsWith("/api/")) throw new Error("Only local API requests are allowed.");
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  try {
    const response = await fetch(path, { method, signal: controller.signal, credentials: "same-origin", cache: "no-store", headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; }
    catch { throw new Error(`The local server returned an unreadable response (${response.status}).`); }
    if (!response.ok) { const error = new Error(data.error || `Request failed (${response.status}).`); error.status = response.status; throw error; }
    return data;
  } catch (error) {
    if (timedOut) throw new Error(method === "GET" ? "The local server took too long to respond. Please retry." : "The request timed out. It may still be running on the server. Refresh its status before retrying.");
    if (error instanceof TypeError) throw new Error("Cannot reach the local server. Check that linubot is running, then retry. Your input is still here.");
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
export const post = (path, body = {}, options = {}) => api(path, { ...options, method: "POST", body });

export function feedback(root, message = "", kind = "error") {
  if (!root?.isConnected) return;
  let node = root.querySelector("[data-feedback]");
  if (!node) { node = document.createElement("p"); node.dataset.feedback = ""; root.append(node); }
  if (node.textContent === message && node.className === `form-feedback ${kind}` && node.hidden === !message) return;
  node.className = `form-feedback ${kind}`;
  node.setAttribute("role", kind === "error" ? "alert" : "status");
  node.textContent = message;
  node.hidden = !message;
}
export async function action(root, work, pending = "") {
  if (!root || root.dataset.busy === "true") return;
  root.dataset.busy = "true";
  root.setAttribute("aria-busy", "true");
  const buttons = [...root.querySelectorAll("button, input, select, textarea")].filter((n) => !n.disabled);
  if (root.matches("button") && !root.disabled) buttons.push(root);
  buttons.forEach((n) => { n.disabled = true; });
  feedback(root.matches("button") ? root.parentElement : root, pending, "info");
  try { return await work(); }
  catch (error) { if (error.name !== "AbortError") feedback(root.matches("button") ? root.parentElement : root, error.message); }
  finally { buttons.forEach((n) => { n.disabled = false; }); delete root.dataset.busy; root.removeAttribute("aria-busy"); root.dispatchEvent(new Event("actionend")); }
}
export function submit(form, work, pending = "Saving...") {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    void action(form, () => work(data), pending);
  });
}
export function empty(title, description, extra = "", symbol = "file") {
  return `<div class="empty-state"><span class="empty-symbol">${icon(symbol)}</span><h2>${esc(title)}</h2><p>${esc(description)}</p>${extra}</div>`;
}
export function page(title, subtitle, body, actions = "", eyebrow = "Your local team") {
  return `<div class="page"><header class="page-header"><div><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1><p class="page-description">${esc(subtitle)}</p></div>${actions ? `<div class="header-actions">${actions}</div>` : ""}</header>${body}</div>`;
}
export function tabs(items, current) {
  return `<nav class="tabs" aria-label="Section">${items.map(([key, label, href]) => `<a href="${esc(href)}"${key === current ? ' aria-current="page"' : ""}>${esc(label)}</a>`).join("")}</nav>`;
}
export function stats(summary = {}) {
  const count = (value) => Number.isFinite(value) ? value : "-";
  return `<dl class="stats-strip"><div><dt>Completed tasks</dt><dd>${count(summary.completed)}</dd><span>Execution, not a quality score</span></div><div><dt>Rated useful</dt><dd>${summary.reviewed ? `${count(summary.useful)}<small> / ${summary.reviewed}</small>` : "-"}</dd><span>${summary.reviewed ? "From your feedback" : "No feedback yet"}</span></div><div><dt>Awaiting your review</dt><dd>${count(summary.unreviewed)}</dd><span>Completed, not yet rated</span></div><div><dt>Time reported saved</dt><dd>${summary.minutesSaved > 0 ? `${Number(summary.minutesSaved.toFixed(1))}<small> min</small>` : "-"}</dd><span>${summary.minutesSaved > 0 ? "Only what you reported" : "No saved time reported"}</span></div></dl>`;
}
export function runRows(runs, emptyText = "No tasks recorded yet.") {
  if (!runs.length) return `<p class="quiet-empty">${esc(emptyText)}</p>`;
  return `<div class="run-list">${runs.map((run) => `<article class="run-row"><span class="run-symbol">${icon(activeRun(run) ? "clock" : run.status === "completed" ? "file" : "alert")}</span><div class="run-main"><button type="button" class="text-button run-title" data-run="${esc(run.id)}">${esc(run.prompt)}</button><div class="metadata"><a href="#/bot/${enc(run.bot)}">${esc(run.bot)}</a><span>${esc(date(run.createdAt))}</span><span>${esc(duration(run.durationMs))}</span></div></div><div class="run-tail">${badge(run.status)}${run.status === "completed" ? `<button type="button" class="small ${run.feedback ? "subtle" : ""}" data-run="${esc(run.id)}">${run.feedback ? (run.feedback.rating === "useful" ? "Rated useful" : "Needs work") : "Review result"}</button>` : ""}</div></article>`).join("")}</div>`;
}

let dialogState = null;
let toastTimer;
export function toast(message) {
  const node = document.getElementById("toast");
  clearTimeout(toastTimer); node.textContent = message; node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, 6500);
}
export function closeDialog() {
  if (!dialogState) return;
  const old = dialogState;
  dialogState = null;
  old.controller.abort();
  const node = document.getElementById("app-dialog");
  if (node.open) node.close();
  if (old.previous?.isConnected) old.previous.focus();
  else document.getElementById("main-content").focus({ preventScroll: true });
}
export function dialog(title, html, { wide = false, eyebrow = "linubot" } = {}) {
  closeDialog();
  const node = document.getElementById("app-dialog");
  const controller = new AbortController();
  const state = { controller, previous: document.activeElement };
  dialogState = state;
  node.classList.toggle("wide-dialog", wide);
  document.getElementById("dialog-title").textContent = title;
  document.getElementById("dialog-eyebrow").textContent = eyebrow;
  const root = document.getElementById("dialog-content");
  root.innerHTML = html;
  node.showModal(); node.scrollTop = 0;
  const alive = () => dialogState === state && !controller.signal.aborted;
  queueMicrotask(() => { if (alive()) (root.querySelector("[autofocus]") || root.querySelector("input:not([type=hidden]), textarea, select, button, a[href]") || document.getElementById("dialog-close")).focus(); });
  return { root, signal: controller.signal, alive, close: () => { if (alive()) closeDialog(); } };
}
export function confirmAction(title, description, work, { label = "Confirm", danger = false, html = "" } = {}) {
  const modal = dialog(title, `<p class="dialog-intro">${esc(description)}</p>${html}<form><div data-feedback hidden></div><div class="form-actions"><button type="button" data-cancel>Cancel</button><button type="submit" class="${danger ? "danger" : "primary"}">${esc(label)}</button></div></form>`);
  modal.root.querySelector("[data-cancel]").onclick = modal.close;
  submit(modal.root.querySelector("form"), async () => { await work(modal); }, "Working...");
  return modal;
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied to clipboard."); }
  catch {
    const modal = dialog("Copy text", `<p class="dialog-intro">Clipboard access is unavailable. Select and copy the text below.</p><label>Text<textarea rows="9" readonly>${esc(text)}</textarea></label>`);
    const input = modal.root.querySelector("textarea"); input.focus(); input.select();
  }
}
export function initUI() {
  document.querySelectorAll("[data-icon]").forEach((node) => { node.innerHTML = icon(node.dataset.icon); });
  const node = document.getElementById("app-dialog");
  document.getElementById("dialog-close").onclick = closeDialog;
  node.addEventListener("cancel", (event) => { event.preventDefault(); closeDialog(); });
  node.addEventListener("click", (event) => { if (event.target === node) { const r = node.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeDialog(); } });
  node.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusable = [...node.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')].filter((el) => !el.disabled && el.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-copy-code]");
    if (button) void copyText(button.closest(".code-block").querySelector("code").textContent);
  });
}
