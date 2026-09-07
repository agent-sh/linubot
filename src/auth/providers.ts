import { xaiAccessToken } from "./xai.ts";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { InputError } from "../errors.ts";
import { createHash } from "node:crypto";
import { CODEX_BASE, codexAccessToken, codexAccount, codexIdentity, codexTokenFresh, codexConfigured } from "./codex.ts";
import { GOOGLE_BASE, googleAccessToken } from "./google.ts";

export type ProviderKind = "openai-compat" | "responses" | "anthropic" | "converse" | "xai-oauth" | "openai-codex" | "google-oauth";
export type ProviderAuth = "bearer" | "x-api-key" | "none";
export const PROVIDER_KINDS: ProviderKind[] = ["openai-compat", "responses", "anthropic", "converse", "xai-oauth", "openai-codex", "google-oauth"];
export interface ProviderConfig { kind: ProviderKind; baseUrl: string; apiKey: string; model: string; auth?: ProviderAuth; id?: string; name?: string; accountIdentity?: string; quotaProject?: string }
export interface ToolCall { id: string; name: string; arguments: string }
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface ProviderItems { identity: string; items: unknown[]; tokens: number; compacted?: boolean; format?: "responses" | "chat" | "anthropic" }
export interface ChatMessage { role: string; content: string; toolCalls?: ToolCall[]; toolCallId?: string; images?: { mimeType: "image/png" | "image/jpeg"; data: string }[]; providerItems?: ProviderItems; archiveSeq?: number; observation?: boolean; pinned?: boolean }
export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  usage?: { input: number; output: number };
  finishReason?: string;
  providerItems?: ProviderItems;
}
export interface CompletionOptions { timeoutMs?: number; maxOutputTokens?: number }
export type FetchFn = (url: string, init: {
  method: string; headers: Record<string, string>; body: string; signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const MAX_BYTES = 2 * 1024 * 1024;
export async function readProviderJson(response: Response, maxBytes = MAX_BYTES): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > maxBytes) { await response.body?.cancel(); throw new Error("Provider response is too large"); }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    if (reader) for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > maxBytes) throw new Error("Provider response is too large");
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw new Error("Provider returned invalid JSON"); }
  } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
}
const nodeFetch: FetchFn = async (url, init) => {
  const response = await fetch(url, { ...init, redirect: "error" });
  const streaming = response.headers.get("content-type")?.includes("text/event-stream") || (response.ok && JSON.parse(init.body).stream === true);
  return { ok: response.ok, status: response.status, json: () => streaming ? readResponsesStream(response) : readProviderJson(response) };
};

export async function readResponsesStream(response: Response): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("Provider returned no response stream");
  const decoder = new TextDecoder(); let buffer = "", size = 0;
  const completedItems = new Map<number, unknown>();
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 16 * 1024 * 1024) throw new Error("Provider response stream exceeded its limit");
      buffer += decoder.decode(value, { stream: true }); if (buffer.length > 4 * 1024 * 1024) throw new Error("Provider stream event exceeded its limit");
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer); if (!boundary || boundary.index === undefined) break;
        const event = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        let parsed: Record<string, unknown>; try { parsed = JSON.parse(data); } catch { throw new Error("Provider returned an invalid stream event"); }
        if (!parsed || typeof parsed !== "object") throw new Error("Provider returned an invalid stream event");
        if (parsed.type === "response.output_item.done") {
          if (!Number.isInteger(parsed.output_index) || Number(parsed.output_index) < 0 || Number(parsed.output_index) >= 1024 || !parsed.item || typeof parsed.item !== "object" || Array.isArray(parsed.item)) throw new Error("Provider returned an invalid completed item");
          completedItems.set(Number(parsed.output_index), parsed.item);
        }
        if (["response.completed", "response.incomplete", "response.failed"].includes(String(parsed.type)) && parsed.response && typeof parsed.response === "object") {
          if (parsed.type !== "response.completed") throw new Error(`Provider response ${String(parsed.type).slice(9)}`);
          const final = parsed.response as Record<string, unknown>;
          // Some Codex streams carry output only in item.done events; the terminal event carries status and usage.
          if (Array.isArray(final.output) && final.output.length === 0 && completedItems.size) return { ...final, output: [...completedItems].sort(([a], [b]) => a - b).map(([, item]) => item) };
          return final;
        }
        if (parsed.type === "error") throw new Error("Provider response stream failed");
      }
    }
    throw new Error("Provider stream ended before a completed response");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function providerUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new InputError("Provider endpoint must be an http(s) URL"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new InputError("Provider endpoint must not contain credentials, query parameters or a fragment");
  }
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new InputError("Use HTTPS for remote providers; HTTP is allowed only on loopback");
  }
  return url.href.replace(/\/+$/, "");
}

export function providerBase(kind: ProviderKind, value: string): string {
  let base = providerUrl(value).replace(/\/(chat\/completions|responses|messages|models)$/, "");
  if (kind === "anthropic" && !base.endsWith("/v1")) base += "/v1";
  return base;
}
export const providerAuth = (cfg: Pick<ProviderConfig, "kind" | "auth">): ProviderAuth => ["xai-oauth", "openai-codex", "google-oauth"].includes(cfg.kind) ? "bearer" : cfg.auth ?? (cfg.kind === "anthropic" ? "x-api-key" : "bearer");
export function providerIdentity(cfg: ProviderConfig): string {
  let credential = cfg.apiKey;
  if (cfg.kind === "google-oauth" && cfg.accountIdentity) credential = cfg.accountIdentity;
  if (cfg.kind === "openai-codex") credential = codexIdentity(cfg.apiKey);
  if (cfg.kind === "xai-oauth") {
    try {
      const claims = JSON.parse(Buffer.from(cfg.apiKey.split(".")[1], "base64url").toString());
      if (typeof claims.sub === "string" && claims.sub) credential = JSON.stringify({ sub: claims.sub, iss: claims.iss, aud: claims.aud });
    } catch { /* Non-JWT tokens remain bound to their exact credential. */ }
  }
  return createHash("sha256").update(JSON.stringify({ id: cfg.id, kind: cfg.kind, base: providerBase(cfg.kind, cfg.baseUrl), model: cfg.model, auth: providerAuth(cfg), credential })).digest("hex");
}
export async function authenticatedProvider(cfg: ProviderConfig, signal?: AbortSignal): Promise<ProviderConfig> {
  if (cfg.kind === "openai-codex") {
    if (providerBase(cfg.kind, cfg.baseUrl) !== CODEX_BASE) throw new InputError("ChatGPT sign-in is restricted to the Codex endpoint");
    if (cfg.apiKey && codexTokenFresh(cfg.apiKey)) return cfg;
    const apiKey = await codexAccessToken(signal);
      if (cfg.apiKey && codexIdentity(cfg.apiKey) !== codexIdentity(apiKey)) throw new InputError("The Codex account changed. Start a new task with the selected account.", 409);
    return { ...cfg, apiKey };
  }
  if (cfg.kind === "google-oauth") {
    if (providerBase(cfg.kind, cfg.baseUrl) !== GOOGLE_BASE) throw new InputError("Google sign-in is restricted to the Gemini API endpoint");
    const value = await googleAccessToken(cfg.id, signal);
    if (cfg.accountIdentity && cfg.accountIdentity !== value.account) throw new InputError("The Google account changed. Start a new task with the selected account.", 409);
    return { ...cfg, apiKey: value.accessToken, accountIdentity: value.account, quotaProject: value.projectId };
  }
  if (cfg.kind !== "xai-oauth") return cfg;
  if (providerUrl(cfg.baseUrl) !== "https://api.x.ai/v1") throw new InputError("xAI OAuth tokens can only be used at api.x.ai");
  return { ...cfg, apiKey: await xaiAccessToken(signal) };
}
export function validateProviderItems(cfg: ProviderConfig, messages: ChatMessage[]) {
  for (const message of messages) if (message.providerItems) {
    const format = message.providerItems.format || "responses";
    const compatible = format === "responses" ? ["responses", "xai-oauth", "openai-codex"].includes(cfg.kind) : format === "chat" ? ["openai-compat", "google-oauth"].includes(cfg.kind) : cfg.kind === "anthropic";
    if (!compatible || message.providerItems.identity !== providerIdentity(cfg)) throw new InputError("Provider context belongs to another connection, account or model. Rebuild from the session archive.", 409);
    if (!Array.isArray(message.providerItems.items) || message.providerItems.items.some((item) => !item || typeof item !== "object" || (Object.hasOwn(item, "role") && !["user", "assistant", "tool"].includes(String((item as Record<string, unknown>).role))))) throw new InputError("Provider context cannot introduce system or developer instructions");
  }
}
export function providerHeaders(cfg: ProviderConfig): Record<string, string> {
  const auth = providerAuth(cfg);
  if (!["bearer", "x-api-key", "none"].includes(auth)) throw new InputError("Unknown provider authentication method");
  if (auth !== "none" && !cfg.apiKey.trim()) throw new InputError("Missing API key. Connect a provider in Settings before starting work.", 409);
  return { ...(auth === "bearer" ? { authorization: `Bearer ${cfg.apiKey}` } : auth === "x-api-key" ? { "x-api-key": cfg.apiKey } : {}),
    ...(cfg.kind === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}), ...(cfg.kind === "xai-oauth" ? { "X-XAI-Token-Auth": "xai-oauth" } : {}),
    ...(cfg.kind === "openai-codex" && codexAccount(cfg.apiKey) ? { "ChatGPT-Account-Id": codexAccount(cfg.apiKey) } : {}),
    ...(cfg.kind === "google-oauth" ? { "x-goog-user-project": cfg.quotaProject || "" } : {}) };
}

export function configFromEnv(): ProviderConfig {
  const kind = process.env.LINUBOT_PROVIDER ?? "openai-compat";
  if (!PROVIDER_KINDS.includes(kind as ProviderKind)) throw new InputError("Unknown provider format");
  const auth = process.env.LINUBOT_AUTH as ProviderAuth | undefined;
  if (auth && !["bearer", "x-api-key", "none"].includes(auth)) throw new InputError("Unknown provider authentication method");
  return {
    kind: kind as ProviderKind,
    baseUrl: providerUrl(process.env.LINUBOT_BASE_URL ?? (kind === "anthropic" ? "https://api.anthropic.com" : kind === "xai-oauth" ? "https://api.x.ai/v1" : kind === "openai-codex" ? CODEX_BASE : kind === "google-oauth" ? GOOGLE_BASE : "https://api.openai.com/v1")),
    apiKey: process.env.LINUBOT_API_KEY ?? "",
    model: process.env.LINUBOT_MODEL?.trim() ?? "",
    ...(auth ? { auth } : {}),
  };
}

export function assertProviderReady(cfg: ProviderConfig): void {
  if (cfg.kind !== "openai-codex" || cfg.apiKey || !codexConfigured()) providerHeaders(cfg);
  if (!cfg.model.trim() || cfg.model === "default") throw new InputError("Choose an exact model ID in Settings before starting work.", 409);
  providerUrl(cfg.baseUrl);
  if (!PROVIDER_KINDS.includes(cfg.kind)) throw new InputError("Unknown provider format");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid provider response shape");
  return value as Record<string, unknown>;
}
function blocks(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Invalid provider content blocks");
  return value.map(object);
}
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return blocks(value).map((block) => typeof block.text === "string" ? block.text : "").join("");
}
function toolCall(id: unknown, name: unknown, args: unknown): ToolCall {
  if (typeof id !== "string" || !id || id.length > 200 || typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(name)) {
    throw new Error("Invalid provider tool call");
  }
  return { id, name, arguments: typeof args === "string" ? args : JSON.stringify(object(args)) };
}

function wireMessages(messages: ChatMessage[], kind: ProviderKind): unknown[] {
  for (const message of messages) {
    if (!["system", "user", "assistant", "tool"].includes(message.role) || typeof message.content !== "string") throw new InputError("Invalid chat message");
    if (message.role === "tool" && !message.toolCallId) throw new InputError("Tool result needs its call ID");
  }
  if (kind === "openai-compat" || kind === "google-oauth") return messages.map((message) => message.providerItems?.format === "chat" ? message.providerItems.items[0] : ({
    role: message.role, content: message.images?.length ? [{ type: "text", text: message.content }, ...message.images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } }))] : message.content || (message.toolCalls?.length ? null : ""),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({
      id: call.id, type: "function", function: { name: call.name, arguments: call.arguments },
    })) } : {}),
  }));
  const output: { role: string; content: unknown[] }[] = [];
  for (const message of messages.filter((item) => item.role !== "system")) {
    const role = message.role === "assistant" ? "assistant" : "user";
    const content: unknown[] = [];
    if (kind === "anthropic" && message.providerItems?.format === "anthropic") {
      if (output.at(-1)?.role === role) output.at(-1)!.content.push(...message.providerItems.items);
      else output.push({ role, content: message.providerItems.items });
      continue;
    }
    if (message.role === "tool") {
      content.push(kind === "anthropic"
        ? { type: "tool_result", tool_use_id: message.toolCallId, content: message.content }
        : { toolResult: { toolUseId: message.toolCallId, content: [{ text: message.content }] } });
    } else {
      if (message.content) content.push(kind === "anthropic" ? { type: "text", text: message.content } : { text: message.content });
      for (const image of message.images ?? []) content.push(kind === "anthropic"
        ? { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } }
        : { image: { format: image.mimeType === "image/png" ? "png" : "jpeg", source: { bytes: image.data } } });
      for (const call of message.toolCalls ?? []) {
        let input: unknown;
        try { input = JSON.parse(call.arguments); } catch { throw new Error("Provider sent malformed tool arguments"); }
        content.push(kind === "anthropic"
          ? { type: "tool_use", id: call.id, name: call.name, input }
          : { toolUse: { toolUseId: call.id, name: call.name, input } });
      }
    }
    if (!content.length) content.push(kind === "anthropic" ? { type: "text", text: "(empty)" } : { text: "(empty)" });
    if (output.at(-1)?.role === role) output.at(-1)!.content.push(...content);
    else output.push({ role, content });
  }
  return output;
}

export function responsesMessages(messages: ChatMessage[]): unknown[] {
  return messages.filter((message) => message.role !== "system").flatMap((message) => {
    if (message.providerItems) return message.providerItems.items;
    if (message.role === "tool") return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
    const output: unknown[] = [];
    if (message.content || message.images?.length) output.push({ role: message.role, content: message.images?.length ? [{ type: "input_text", text: message.content }, ...message.images.map((image) => ({ type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}` }))] : message.content });
    for (const call of message.toolCalls ?? []) output.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
    return output;
  });
}

export async function chatResponse(
  cfg: ProviderConfig, messages: ChatMessage[], tools: ToolDefinition[] = [], f: FetchFn = nodeFetch, signal?: AbortSignal,
  options: CompletionOptions = {},
): Promise<ChatResponse> {
  cfg = await authenticatedProvider(cfg, signal);
  validateProviderItems(cfg, messages);
  assertProviderReady(cfg);
  const base = providerBase(cfg.kind, cfg.baseUrl);
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const responses = ["xai-oauth", "responses", "openai-codex"].includes(cfg.kind);
  const rest = responses ? responsesMessages(messages) : wireMessages(messages, cfg.kind);
  let url: string;
  let payload: Record<string, unknown>;
  const headers: Record<string, string> = { "content-type": "application/json", ...providerHeaders(cfg) };
  if (responses) {
    url = `${base}/responses`;
    payload = { model: cfg.model, instructions: system, input: rest, store: false, stream: false, max_output_tokens: options.maxOutputTokens ?? 8192,
      ...(["https://api.openai.com/v1", "https://api.x.ai/v1"].includes(base) ? { include: ["reasoning.encrypted_content"] } : {}),
      ...(tools.length ? { tools: tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })) } : {}) };
    if (cfg.kind === "openai-codex") { delete payload.max_output_tokens; payload.stream = true; payload.tools ??= []; payload.tool_choice = "auto"; payload.parallel_tool_calls = true; payload.include = ["reasoning.encrypted_content"]; }
  } else if (cfg.kind === "anthropic") {
    url = `${base}/messages`;
    payload = { model: cfg.model, system, messages: rest, max_tokens: options.maxOutputTokens ?? 4096,
      ...(tools.length ? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
    };
  } else if (cfg.kind === "converse") {
    url = `${base}/model/${encodeURIComponent(cfg.model)}/converse`;
    payload = { system: system ? [{ text: system }] : [], messages: rest, inferenceConfig: { maxTokens: options.maxOutputTokens ?? 4096 },
      ...(tools.length ? { toolConfig: { tools: tools.map((tool) => ({ toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: tool.parameters } } })) } } : {}),
    };
  } else {
    url = `${base}/chat/completions`;
    payload = { model: cfg.model, messages: rest, max_tokens: options.maxOutputTokens ?? 4096,
      ...(tools.length ? { tools: tools.map((tool) => ({ type: "function", function: tool })) } : {}),
    };
  }
  const timeout = new AbortController();
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  combined.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const timer = setTimeout(() => timeout.abort(new Error(`Provider request timed out after ${timeoutMs / 1000} seconds`)), timeoutMs);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(combined.reason);
    combined.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const data = await Promise.race([aborted, (async () => {
      let response = await f(url, { method: "POST", headers, body: JSON.stringify(payload), signal: combined });
      if (response.status === 401 && cfg.kind === "xai-oauth") {
        cfg = { ...cfg, apiKey: await xaiAccessToken(combined, true) };
        validateProviderItems(cfg, messages);
        headers.authorization = `Bearer ${cfg.apiKey}`;
        response = await f(url, { method: "POST", headers, body: JSON.stringify(payload), signal: combined });
      }
      combined.throwIfAborted();
      if (!response.ok) throw new Error(`Provider HTTP ${response.status}${response.status === 401 || response.status === 403 ? ": check your API key and permissions" : response.status === 429 ? ": rate limit reached" : ""}`);
      return object(await response.json());
    })()]);
    combined.throwIfAborted();
    const result: ChatResponse = { text: "", toolCalls: [] };
    let usage: Record<string, unknown> | undefined;
    if (data.usage && typeof data.usage === "object") usage = object(data.usage);
    if (responses) {
      const output = blocks(data.output);
      result.text = output.filter((item) => item.type === "message").flatMap((item) => blocks(item.content)).filter((item) => item.type === "output_text").map((item) => String(item.text ?? "")).join("\n");
      result.toolCalls = output.filter((item) => item.type === "function_call").map((item) => toolCall(item.call_id, item.name, item.arguments));
      if (data.status === "incomplete" || data.status === "failed") throw new Error(`Provider response ${data.status}`);
      result.finishReason = typeof data.status === "string" ? data.status : undefined;
      if (output.some((item) => typeof item.encrypted_content === "string" && item.encrypted_content)) {
        const outputTokens = usage?.output_tokens;
        result.providerItems = { identity: providerIdentity(cfg), items: output, tokens: Number.isSafeInteger(outputTokens) && Number(outputTokens) >= 0 ? Number(outputTokens) : Math.ceil(JSON.stringify(output.filter((item) => item.type !== "reasoning")).length / 3) };
      }
    } else if (cfg.kind === "anthropic") {
      const content = blocks(data.content);
      result.text = content.map((block) => typeof block.text === "string" ? block.text : "").join("");
      result.toolCalls = content.filter((block) => block.type === "tool_use").map((block) => toolCall(block.id, block.name, block.input));
      result.finishReason = typeof data.stop_reason === "string" ? data.stop_reason : undefined;
      if (result.toolCalls.length && content.some((block) => ["thinking", "redacted_thinking"].includes(String(block.type)))) result.providerItems = { identity: providerIdentity(cfg), format: "anthropic", items: content, tokens: Number.isSafeInteger(usage?.output_tokens) && Number(usage?.output_tokens) >= 0 ? Number(usage?.output_tokens) : Math.ceil(JSON.stringify(content).length / 3) };
    } else if (cfg.kind === "converse") {
      const content = blocks(object(object(data.output).message).content);
      result.text = content.map((block) => typeof block.text === "string" ? block.text : "").join("");
      result.toolCalls = content.filter((block) => block.toolUse).map((block) => {
        const call = object(block.toolUse);
        return toolCall(call.toolUseId, call.name, call.input);
      });
      result.finishReason = typeof data.stopReason === "string" ? data.stopReason : undefined;
    } else {
      const choice = blocks(data.choices)[0];
      if (!choice) throw new Error("Empty provider response");
      const message = object(choice.message);
      result.text = textOf(message.content);
      result.toolCalls = message.tool_calls === undefined ? [] : blocks(message.tool_calls).map((call) => {
        const fn = object(call.function);
        return toolCall(call.id, fn.name, fn.arguments);
      });
      result.finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;
      if (result.toolCalls.length && (typeof message.reasoning_content === "string" || typeof message.reasoning === "string" || Array.isArray(message.reasoning_details) || message.extra_content || blocks(message.tool_calls).some((call) => call.extra_content))) {
        const continuation = { role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls,
          ...(typeof message.reasoning_content === "string" ? { reasoning_content: message.reasoning_content } : {}),
          ...(typeof message.reasoning === "string" ? { reasoning: message.reasoning } : {}),
          ...(Array.isArray(message.reasoning_details) ? { reasoning_details: message.reasoning_details } : {}),
          ...(message.extra_content ? { extra_content: message.extra_content } : {}) };
        result.providerItems = { identity: providerIdentity(cfg), format: "chat", items: [continuation], tokens: Number.isSafeInteger(usage?.completion_tokens) && Number(usage?.completion_tokens) >= 0 ? Number(usage?.completion_tokens) : Math.ceil(JSON.stringify(continuation).length / 3) };
      }
    }
    if (["length", "max_tokens", "maxTokens", "content_filter", "guardrail_intervened"].includes(result.finishReason ?? "")) {
      throw new Error(`Provider stopped before a complete answer (${result.finishReason})`);
    }
    if (!result.text.trim() && !result.toolCalls.length) throw new Error("Empty provider response");
    if (result.toolCalls.length > 8 || new Set(result.toolCalls.map((call) => call.id)).size !== result.toolCalls.length) throw new Error("Invalid or excessive provider tool calls");
    if (result.text.length > 200_000 || result.toolCalls.some((call) => call.arguments.length > 100_000)) throw new Error("Provider response is too large");
    if (usage) {
      const input = cfg.kind === "anthropic" ? Number(usage.input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0) : usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens;
      const output = usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens;
      if (Number.isSafeInteger(input) && Number.isSafeInteger(output) && Number(input) >= 0 && Number(output) >= 0) {
        result.usage = { input: Number(input), output: Number(output) };
      }
    }
    return result;
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", onAbort);
  }
}

export async function chatComplete(cfg: ProviderConfig, messages: ChatMessage[], f?: FetchFn, signal?: AbortSignal): Promise<string> {
  const result = await chatResponse(cfg, messages, [], f, signal);
  if (result.toolCalls.length || !result.text.trim()) throw new Error("Expected a text response, not a tool call");
  return result.text;
}

export function candidateMachineConfigs(): string[] {
  const home = homedir();
  return [join(home, ".codex", "auth.json"), join(home, ".config", "opencode", "auth.json"), join(home, ".local", "share", "muse", "auth.json")]
    .filter((path) => { const stat = lstatSync(path, { throwIfNoEntry: false }); return stat?.isFile() && !stat.isSymbolicLink() && stat.size <= 256 * 1024; });
}

export function readMachineKey(path: string, approved: boolean): string {
  if (approved !== true) throw new InputError("Machine config read needs user approval", 403);
  if (typeof path !== "string" || !candidateMachineConfigs().includes(resolve(path))) throw new InputError("Select one of the listed machine configuration files", 403);
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new InputError("Cannot read this machine configuration as JSON"); }
  const keys = new Set<string>();
  function visit(node: unknown, depth = 0): void {
    if (!node || typeof node !== "object" || depth > 5) return;
    for (const [name, item] of Object.entries(node)) {
      if (["OPENAI_API_KEY", "apiKey", "api_key", "key"].includes(name) && typeof item === "string" && item.trim()) keys.add(item.trim());
      else if (item && typeof item === "object") visit(item, depth + 1);
    }
  }
  visit(value);
  if (keys.size !== 1) throw new InputError("No single unambiguous API key found. Paste an API key explicitly; OAuth sessions are not API keys.");
  return [...keys][0];
}
