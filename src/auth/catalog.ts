import { providerBase, providerHeaders, readProviderJson } from "./providers.ts";
import type { ProviderKind, ProviderAuth, ProviderConfig } from "./providers.ts";
import { xaiAccessToken } from "./xai.ts";
import { InputError } from "../errors.ts";
import { CODEX_BASE, codexModels } from "./codex.ts";
import { GOOGLE_BASE } from "./google.ts";
import { authenticatedProvider } from "./providers.ts";

export const providerPresets: { id: string; name: string; kind: ProviderKind; baseUrl: string; auth: ProviderAuth; featured?: boolean; publicCatalog?: boolean }[] = [
  { id: "tiyuvta", name: "Tiyuvta", kind: "openai-compat", baseUrl: "https://api.tiyuvta.ai/v1", auth: "bearer", featured: true, publicCatalog: true },
  { id: "xai-oauth", name: "xAI OAuth", kind: "xai-oauth", baseUrl: "https://api.x.ai/v1", auth: "bearer" },
  { id: "openai", name: "OpenAI", kind: "responses", baseUrl: "https://api.openai.com/v1", auth: "bearer" },
  { id: "openai-codex", name: "OpenAI / ChatGPT sign-in", kind: "openai-codex", baseUrl: CODEX_BASE, auth: "bearer" },
  { id: "anthropic", name: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", auth: "x-api-key" },
  { id: "xai", name: "xAI API key", kind: "responses", baseUrl: "https://api.x.ai/v1", auth: "bearer" },
  { id: "openrouter", name: "OpenRouter", kind: "openai-compat", baseUrl: "https://openrouter.ai/api/v1", auth: "bearer" },
  { id: "muse", name: "Meta / Muse Code", kind: "openai-compat", baseUrl: "https://api.meta.ai/v1", auth: "bearer" },
  { id: "groq", name: "Groq", kind: "openai-compat", baseUrl: "https://api.groq.com/openai/v1", auth: "bearer" },
  { id: "together", name: "Together AI", kind: "openai-compat", baseUrl: "https://api.together.ai/v1", auth: "bearer" },
  { id: "deepseek", name: "DeepSeek", kind: "openai-compat", baseUrl: "https://api.deepseek.com/v1", auth: "bearer" },
  { id: "mistral", name: "Mistral", kind: "openai-compat", baseUrl: "https://api.mistral.ai/v1", auth: "bearer" },
  { id: "gemini", name: "Google Gemini (OpenAI API)", kind: "openai-compat", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", auth: "bearer" },
  { id: "google-oauth", name: "Google Gemini OAuth", kind: "google-oauth", baseUrl: GOOGLE_BASE, auth: "bearer" },
  { id: "qwen-token", name: "Qwen Token Plan", kind: "openai-compat", baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", auth: "bearer" },
  { id: "qwen-coding", name: "Qwen Coding Plan (international)", kind: "openai-compat", baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1", auth: "bearer" },
  { id: "qwen-coding-cn", name: "Qwen Coding Plan (China)", kind: "openai-compat", baseUrl: "https://coding.dashscope.aliyuncs.com/v1", auth: "bearer" },
  { id: "zai-coding", name: "Z.ai Coding Plan", kind: "openai-compat", baseUrl: "https://api.z.ai/api/coding/paas/v4", auth: "bearer" },
  { id: "zai", name: "Z.ai API", kind: "openai-compat", baseUrl: "https://api.z.ai/api/paas/v4", auth: "bearer" },
  { id: "ollama", name: "Ollama", kind: "openai-compat", baseUrl: "http://localhost:11434/v1", auth: "none" },
  { id: "lmstudio", name: "LM Studio", kind: "openai-compat", baseUrl: "http://localhost:1234/v1", auth: "none" },
  { id: "local", name: "vLLM / local OpenAI server", kind: "openai-compat", baseUrl: "http://localhost:8000/v1", auth: "none" },
];

export interface CatalogModel { id: string; name: string }
export async function listProviderModels(config: ProviderConfig, parentSignal?: AbortSignal, request: typeof fetch = fetch) {
  const base = providerBase(config.kind, config.baseUrl);
  if (config.kind === "openai-codex") { if (base !== CODEX_BASE) throw new InputError("Invalid ChatGPT endpoint"); return codexModels(parentSignal); }
  if (config.kind === "google-oauth") config = await authenticatedProvider(config, parentSignal);
  if (config.kind === "converse") return { models: [] as CatalogModel[], source: base, supported: false, truncated: false, message: "This Converse endpoint does not expose a model catalog. Enter its model ID manually." };
  const signal = AbortSignal.any([...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(20_000)]);
  if (config.kind === "xai-oauth") {
    if (base !== "https://api.x.ai/v1") throw new InputError("xAI OAuth tokens can only be used at api.x.ai");
    config = { ...config, apiKey: await xaiAccessToken(signal) };
  }
  const headers: Record<string, string> = { Accept: "application/json", ...providerHeaders(config.apiKey ? config : { ...config, auth: "none" }) };
  const models = new Map<string, CatalogModel>();
  const cursors = new Set<string>();
  let cursor = "", truncated = false;
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${base}/models`);
    if (config.kind === "anthropic") { url.searchParams.set("limit", "1000"); if (cursor) url.searchParams.set("after_id", cursor); }
    let response = await request(url.href, { method: "GET", headers, redirect: "error", signal });
    if (response.status === 401 && config.kind === "xai-oauth") {
      await response.body?.cancel();
      headers.authorization = `Bearer ${await xaiAccessToken(signal, true)}`;
      response = await request(url.href, { method: "GET", headers, redirect: "error", signal });
    }
    if (!response.ok) { await response.body?.cancel(); throw new InputError(`Model list returned HTTP ${response.status}. Check this connection or enter a model ID manually.`, 502); }
    const data = await readProviderJson(response, 8 * 1024 * 1024) as { data?: unknown[]; has_more?: boolean; last_id?: string };
    if (!data || !Array.isArray(data.data)) throw new InputError("The endpoint did not return a compatible model list. You can enter a model ID manually.", 502);
    for (const value of data.data) {
      if (!value || typeof value !== "object") continue;
      const model = value as Record<string, unknown>;
      if (typeof model.id !== "string" || !model.id.trim() || model.id.length > 200) continue;
      const name = typeof model.display_name === "string" ? model.display_name : typeof model.name === "string" ? model.name : model.id;
      models.set(model.id, { id: model.id, name: name.slice(0, 250) });
      if (models.size >= 2000) { truncated = true; break; }
    }
    if (truncated || config.kind !== "anthropic" || data.has_more !== true) break;
    if (typeof data.last_id !== "string" || !data.last_id || data.last_id.length > 200 || cursors.has(data.last_id)) throw new InputError("The provider returned an invalid model-list cursor", 502);
    cursor = data.last_id; cursors.add(cursor); truncated = page === 9;
  }
  return { models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)), source: `${base}/models`, supported: true, truncated };
}
