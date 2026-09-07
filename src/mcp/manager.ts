import { join } from "node:path";
import { dataDir, readJson, writeJson } from "../store.ts";
import { InputError, requiredText } from "../errors.ts";
import { xaiWebSearch } from "../network/xai-search.ts";
import { publicSearch } from "../network/web.ts";

export interface McpServer {
  command?: string;
  args?: string[];
  transport?: "stdio" | "streamable-http" | "sse";
  url?: string;
  approved?: boolean;
  source?: string;
  version?: string;
  requiredEnv?: string[];
  requiredHeaders?: string[];
  enabled?: boolean;
  status?: "configured";
}

export interface McpConfig {
  servers: Record<string, McpServer>;
  status?: "configured";
}

export type WebSearchBackend = "bing" | "xai" | "searxng" | "disabled";

export interface WebSearchConfig {
  backend: WebSearchBackend;
  url?: string;
  maxResults: number;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

function checkName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name !== name.trim() || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) {
    throw new InputError("invalid server name");
  }
}

export function serverConfig(server: McpServer): McpServer {
  if (!server || typeof server !== "object" || Array.isArray(server)) throw new InputError("server must be an object");
  const transport = server.transport ?? "stdio";
  if (!["stdio", "streamable-http", "sse"].includes(transport)) throw new InputError("Unknown MCP transport");
  const command = transport === "stdio" ? requiredText(server.command, "server command", 1024) : undefined;
  if (command?.includes("\0")) throw new InputError("invalid server command");
  let url: string | undefined;
  if (transport !== "stdio") {
    const target = new URL(requiredText(server.url, "MCP endpoint", 2048));
    if (target.username || target.password || target.hash || (target.protocol !== "https:" && !(target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)))) throw new InputError("MCP requires HTTPS, or HTTP on loopback");
    url = target.href;
  }
  const args = server.args === undefined ? [] : server.args;
  if (!Array.isArray(args) || args.length > 100 || args.some((arg) => typeof arg !== "string" || arg.length > 2000 || arg.includes("\0"))) {
    throw new InputError("args must be an array of at most 100 strings, each at most 2000 characters");
  }
  if (server.enabled !== undefined && typeof server.enabled !== "boolean") throw new InputError("enabled must be a boolean");
  const names = (values: string[] | undefined) => {
    if (values === undefined) return [];
    if (!Array.isArray(values) || values.length > 30 || values.some((value) => typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,100}$/.test(value))) throw new InputError("Invalid credential names");
    return values;
  };
  return { ...(command ? { command, args: [...args] } : { url }), transport, enabled: server.enabled ?? true, approved: server.approved === true,
    ...(server.source ? { source: requiredText(server.source, "Source", 2000) } : {}), ...(server.version ? { version: requiredText(server.version, "Version", 100) } : {}),
    requiredEnv: names(server.requiredEnv), requiredHeaders: names(server.requiredHeaders), status: "configured" };
}

function config(value: McpConfig): McpConfig {
  if (!value || typeof value !== "object" || Array.isArray(value) || !value.servers || typeof value.servers !== "object" || Array.isArray(value.servers)) {
    throw new InputError("MCP servers must be an object");
  }
  const entries = Object.entries(value.servers);
  if (entries.length > 100) throw new InputError("at most 100 MCP servers may be configured");
  const servers: Record<string, McpServer> = {};
  for (const [name, server] of entries) {
    checkName(name);
    servers[name] = serverConfig(server);
  }
  // Connection state belongs to the live MCP client, never to this file.
  return { servers, status: "configured" };
}

export function readMcp(): McpConfig {
  return config(readJson<McpConfig>(join(dataDir(), "mcp.json"), { servers: {} }));
}

export function writeMcp(cfg: McpConfig): void {
  writeJson(join(dataDir(), "mcp.json"), config(cfg));
}

export function addMcpServer(name: string, server: McpServer): McpConfig {
  checkName(name);
  const validated = serverConfig(server);
  const cfg = readMcp();
  if (!Object.hasOwn(cfg.servers, name) && Object.keys(cfg.servers).length >= 100) throw new InputError("at most 100 MCP servers may be configured");
  cfg.servers[name] = validated;
  writeMcp(cfg);
  return cfg;
}

export function removeMcpServer(name: string): McpConfig {
  checkName(name);
  const cfg = readMcp();
  if (!Object.hasOwn(cfg.servers, name)) throw new InputError(`unknown server: ${name}`, 404);
  delete cfg.servers[name];
  writeMcp(cfg);
  return cfg;
}

export function setMcpEnabled(name: string, enabled: boolean): McpConfig {
  checkName(name);
  if (typeof enabled !== "boolean") throw new InputError("enabled must be a boolean");
  const cfg = readMcp();
  if (!Object.hasOwn(cfg.servers, name)) throw new InputError(`unknown server: ${name}`, 404);
  cfg.servers[name].enabled = enabled;
  writeMcp(cfg);
  return cfg;
}

function httpUrl(value: unknown, label: string, backend = false): string {
  const text = requiredText(value, label, 2048);
  if (!/^https?:\/\//i.test(text) || /[\x00-\x20\x7f\\]/.test(text)) throw new InputError(`${label} must be an http(s) URL`);
  let url: URL;
  try { url = new URL(text); } catch { throw new InputError(`${label} must be an http(s) URL`); }
  if (!url.hostname || url.username || url.password || (backend && (url.search || url.hash))) throw new InputError(`invalid ${label}`);
  return backend ? url.href.replace(/\/+$/, "") : url.href;
}

function searchConfig(value: WebSearchConfig): WebSearchConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("websearch config must be an object");
  if (!["bing", "xai", "searxng", "disabled"].includes(value.backend)) throw new InputError("unknown websearch backend");
  if (!Number.isInteger(value.maxResults) || value.maxResults < 1 || value.maxResults > 20) throw new InputError("maxResults must be 1-20");
  const url = value.url === undefined || value.url === "" ? undefined : httpUrl(value.url, "searxng URL", true);
  if (value.backend === "searxng" && !url) throw new InputError("no searxng URL configured");
  return { backend: value.backend, ...(url ? { url } : {}), maxResults: value.maxResults };
}

export function readWebSearch(): WebSearchConfig {
  const stored = readJson<WebSearchConfig | undefined>(join(dataDir(), "websearch.json"), undefined);
  if (stored !== undefined) return searchConfig(stored);
  const url = process.env.LINUBOT_SEARXNG_URL?.trim();
  return searchConfig({ backend: url ? "searxng" : "bing", ...(url ? { url } : {}), maxResults: 5 });
}

export function writeWebSearch(patch: Partial<WebSearchConfig>): WebSearchConfig {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new InputError("websearch patch must be an object");
  const current = readWebSearch();
  const cfg = searchConfig({
    backend: patch.backend === undefined ? current.backend : patch.backend,
    url: patch.url === undefined ? current.url : patch.url,
    maxResults: patch.maxResults === undefined ? current.maxResults : patch.maxResults,
  });
  writeJson(join(dataDir(), "websearch.json"), cfg);
  return cfg;
}

export type FetchJson = (url: string, options?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
}>;

const MAX_RESPONSE_BYTES = 1024 * 1024;
const defaultFetch: FetchJson = (url, options) => fetch(url, { signal: options?.signal, redirect: "error", headers: { Accept: "application/json" } });

export async function webSearch(query: string, f: FetchJson = defaultFetch, signal?: AbortSignal, onUsage?: (usage: { input: number; output: number }) => void): Promise<SearchHit[]> {
  const q = requiredText(query, "search query", 2000);
  if (typeof f !== "function") throw new InputError("websearch fetch must be a function");
  const cfg = readWebSearch();
  if (cfg.backend === "disabled") throw new InputError("websearch is disabled", 409);
  if (cfg.backend === "xai") { const result = await xaiWebSearch(q, cfg.maxResults, signal); if (result.usage) onUsage?.(result.usage); return result.hits; }
  if (cfg.backend === "bing") return publicSearch(q, cfg.maxResults, signal);
  const url = `${cfg.url}/search?q=${encodeURIComponent(q)}&format=json`;
  const timeout = new AbortController();
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  combined.throwIfAborted();
  const timer = setTimeout(() => timeout.abort(new DOMException("websearch timed out after 15 seconds", "TimeoutError")), 15_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      void reader?.cancel(combined.reason).catch(() => {});
      reject(combined.reason);
    };
    combined.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([aborted, (async () => {
      let res: Awaited<ReturnType<FetchJson>>;
      try { res = await f(url, { signal: combined }); } catch (error) {
        combined.throwIfAborted();
        throw new Error(`websearch unreachable at ${cfg.url}: ${String(error)}`, { cause: error });
      }
      combined.throwIfAborted();
      if (!res || typeof res.ok !== "boolean" || !Number.isInteger(res.status) || typeof res.json !== "function") throw new Error("websearch invalid response");
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        throw new Error(`websearch http ${res.status}`);
      }
      if (Number(res.headers?.get("content-length")) > MAX_RESPONSE_BYTES) {
        void res.body?.cancel().catch(() => {});
        throw new Error("websearch response exceeds 1 MiB");
      }
      let data: unknown;
      if (res.body) {
        reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            combined.throwIfAborted();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) throw new Error("websearch response exceeds 1 MiB");
            chunks.push(value);
          }
          try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (error) {
            throw new Error("websearch returned invalid JSON", { cause: error });
          }
        } finally {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
          reader = undefined;
        }
      } else {
        try { data = await res.json(); } catch (error) {
          combined.throwIfAborted();
          throw new Error("websearch returned invalid JSON", { cause: error });
        }
        const encoded = JSON.stringify(data);
        if (encoded === undefined) throw new Error("websearch returned invalid JSON");
        if (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) throw new Error("websearch response exceeds 1 MiB");
      }
      combined.throwIfAborted();
      if (!data || typeof data !== "object" || !("results" in data) || !Array.isArray(data.results) || data.results.length > 1000) {
        throw new Error("websearch invalid response: expected a results array of at most 1000 items");
      }
      const hits: SearchHit[] = [];
      for (const result of data.results) {
        if (!result || typeof result !== "object" || typeof result.title !== "string" || !result.title.trim() ||
            typeof result.url !== "string" || (result.content !== undefined && typeof result.content !== "string")) continue;
        let link: string;
        try { link = httpUrl(result.url, "result URL"); } catch (error) {
          if (error instanceof InputError) continue;
          throw error;
        }
        hits.push({ title: result.title.trim().slice(0, 500), url: link, snippet: (result.content ?? "").slice(0, 4000) });
        if (hits.length === cfg.maxResults) break;
      }
      return hits;
    })()]);
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", onAbort);
  }
}
