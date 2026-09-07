import { api, post, esc, icon } from "./ui.js";

export function modelPicker(root, { model = "", defaultLabel = "", getCatalog, signal } = {}) {
  let selected = model, models = [], generation = 0, request, disabled = false;
  root.innerHTML = `<label>Model<select name="modelChoice" required></select></label><label data-custom-model hidden>Custom model ID<input name="customModel" maxlength="200" autocomplete="off" placeholder="Enter the exact model ID"></label><input type="hidden" name="model"><div class="model-catalog-actions"><button type="button" class="small" data-load-models>${icon("refresh")} Refresh models</button><span class="field-hint" data-model-status role="status"></span></div>`;
  const choice = root.querySelector("select"), custom = root.querySelector("[name=customModel]"), hidden = root.querySelector("[name=model]"), button = root.querySelector("button"), status = root.querySelector("[data-model-status]");
  function sync() {
    const manual = choice.value === "__custom__";
    root.querySelector("[data-custom-model]").hidden = !manual;
    custom.required = manual; custom.disabled = disabled || !manual;
    hidden.value = manual ? custom.value.trim() : choice.value;
    selected = hidden.value;
    hidden.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function paint() {
    const known = models.some((item) => item.id === selected);
    choice.innerHTML = `${defaultLabel ? `<option value="default">${esc(defaultLabel)}</option>` : '<option value="" disabled>Choose a model</option>'}${selected && selected !== "default" && !known ? `<option value="${esc(selected)}">${esc(selected)} (saved ID)</option>` : ""}${models.map((item) => `<option value="${esc(item.id)}">${esc(item.name === item.id ? item.id : `${item.name} · ${item.id}`)}</option>`).join("")}<option value="__custom__">Enter a custom model ID…</option>`;
    choice.value = selected || (defaultLabel ? "default" : ""); choice.disabled = disabled; button.disabled = disabled;
    sync();
  }
  choice.onchange = () => { if (choice.value === "__custom__") custom.value = selected === "default" ? "" : selected; sync(); if (choice.value === "__custom__") custom.focus(); };
  custom.oninput = sync;
  function reset(nextModel = "", label = defaultLabel, isDisabled = false) {
    generation++; request?.abort(); selected = nextModel; defaultLabel = label; disabled = isDisabled; models = []; status.textContent = ""; paint();
  }
  async function load() {
    if (disabled || signal?.aborted) return;
    request?.abort(); request = new AbortController(); const epoch = ++generation;
    button.disabled = true; status.textContent = "Reading this connection’s model list…";
    try {
      const catalog = await getCatalog(AbortSignal.any([request.signal, ...(signal ? [signal] : [])]));
      if (epoch !== generation || signal?.aborted) return;
      models = catalog.models; paint();
      status.textContent = catalog.supported === false ? catalog.message : `${models.length} models from this endpoint${catalog.truncated ? " (list limited)" : ""}.`;
    } catch (error) {
      if (epoch === generation && !signal?.aborted && error.name !== "AbortError") status.textContent = `${error.message} Custom model IDs are available.`;
    } finally { if (epoch === generation) button.disabled = disabled; }
  }
  signal?.addEventListener("abort", () => { generation++; request?.abort(); }, { once: true });
  button.onclick = () => void load(); paint();
  return { value: () => hidden.value, reset, load };
}

export async function botModelPicker(root, bot = {}, signal) {
  const all = await api("/api/provider/connections", { signal });
  if (signal?.aborted) return;
  const initial = bot.providerId || (bot.model && bot.model !== "default" ? all.activeId : "");
  root.innerHTML = `<label>Provider connection<select name="providerId"><option value="">Use app default</option>${all.connections.map((p) => `<option value="${esc(p.id)}"${initial === p.id ? " selected" : ""}>${esc(p.name)}${p.ready ? "" : " (setup needed)"}</option>`).join("")}</select></label><div data-bot-model-picker></div>`;
  const provider = root.querySelector("[name=providerId]");
  const picker = modelPicker(root.querySelector("[data-bot-model-picker]"), { model: bot.model || "default", defaultLabel: "Use connection default", signal,
    getCatalog: (requestSignal) => post("/api/provider/models", { id: provider.value || all.activeId }, { signal: requestSignal, timeout: 25000 }) });
  function select(model = "default") {
    const connection = all.connections.find((p) => p.id === (provider.value || all.activeId));
    picker.reset(model, `Use connection default${connection.model ? ` (${connection.model})` : ""}`, !provider.value);
    if (provider.value && (connection.hasKey || connection.auth === "none")) void picker.load();
  }
  provider.onchange = () => select(); select(bot.model || "default");
  return { value: () => ({ providerId: provider.value || null, model: picker.value() }) };
}
