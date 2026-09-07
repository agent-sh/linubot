import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server, RequestListener } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeJson } from "../src/store.ts";
import { chatResponse, providerBase } from "../src/auth/providers.ts";
import { listProviderModels } from "../src/auth/catalog.ts";
import { getProvider, previewProvider, setProvider, selectProvider, removeProvider, providerConnections, providerStatus, setCredentialStorage, connectXai } from "../src/auth/store.ts";
import { createOpenRouterLogin } from "../src/auth/openrouter.ts";
import { createBot } from "../src/bots/manager.ts";
import { createAgentRuntime } from "../src/agents/runtime.ts";

let directory: string;
const previous = process.env.LINUBOT_DATA;
const servers: Server[] = [];
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "linubot-providers-")); process.env.LINUBOT_DATA = directory; });
afterEach(async () => {
  setCredentialStorage(undefined);
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  if (previous === undefined) delete process.env.LINUBOT_DATA; else process.env.LINUBOT_DATA = previous;
  rmSync(directory, { recursive: true, force: true });
});
async function endpoint(handler: RequestListener) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}`;
}

describe("provider connections and catalogs", () => {
  it("runs two bots on different providers concurrently and preserves both credentials", async () => {
    const arrivals: { url: string; key: string | undefined; model: string }[] = [];
    const replies: (() => void)[] = [];
    const base = await endpoint(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      arrivals.push({ url: request.url!, key: request.headers.authorization, model: body.model });
      replies.push(() => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body.model === "model-a" ? { choices: [{ message: { content: "PROVIDER_A" } }] } : { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "PROVIDER_B" }] }] })); });
      if (replies.length === 2) for (const send of replies) send();
    });
    const a = setProvider({ name: "Provider A", kind: "openai-compat", baseUrl: `${base}/v1`, apiKey: "key-a", model: "model-a" });
    const b = setProvider({ newConnection: true, name: "Provider B", kind: "responses", baseUrl: `${base}/responses/v1`, apiKey: "key-b", model: "model-b" });
    createBot("ParallelA", { providerId: a.id }); createBot("ParallelB", { providerId: b.id });
    const runtime = createAgentRuntime({ review: false, timeoutMs: 3000, maxParallel: 2 });
    try {
      const [one] = runtime.enqueue({ scope: "bot:ParallelA", message: "Hello A" });
      const [two] = runtime.enqueue({ scope: "bot:ParallelB", message: "Hello B" });
      const results = await Promise.all([runtime.wait(one.id), runtime.wait(two.id)]);
      assert.deepEqual(results.map((r) => r.status), ["completed", "completed"]);
      assert.deepEqual(results.map((r) => r.response), ["PROVIDER_A", "PROVIDER_B"]);
      assert.deepEqual(arrivals.map((r) => r.key).sort(), ["Bearer key-a", "Bearer key-b"]);
      assert.equal(getProvider().id, a.id); assert.equal(getProvider(b.id).apiKey, "key-b");
      assert.deepEqual(providerConnections().connections.find((p) => p.id === b.id)?.usedBy, ["ParallelB"]);
      connectXai(); assert.equal(getProvider().id, a.id, "connecting xAI does not replace a ready default");
    } finally { await runtime.close(); }
  });

  it("honors a bounded completion deadline and summary output allowance", async () => {
    const provider = { kind: "responses" as const, baseUrl: "https://example.com/v1", apiKey: "fixture", model: "fixture" };
    let outputLimit = 0;
    const complete = async (_url: string, init: { body: string }) => {
      outputLimit = JSON.parse(init.body).max_output_tokens;
      return { ok: true, status: 200, json: async () => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "CHECKPOINT" }] }] }) };
    };
    assert.equal((await chatResponse(provider, [{ role: "user", content: "Summarize" }], [], complete, undefined, { timeoutMs: 180000, maxOutputTokens: 8192 })).text, "CHECKPOINT");
    assert.equal(outputLimit, 8192);
    await assert.rejects(() => chatResponse(provider, [{ role: "user", content: "Summarize" }], [], async () => new Promise(() => {}), undefined, { timeoutMs: 10 }), /timed out/);
  });

  it("migrates the legacy connection without losing keys and keeps multiple accounts separate", () => {
    const keys = new Map([["openai-compat:https://one.example/v1", "legacy-private-key"]]);
    setCredentialStorage({ load: (id) => keys.get(id) || "", save: (id, key) => { if (key) keys.set(id, key); else keys.delete(id); } });
    writeJson(join(directory, "provider.json"), { kind: "openai-compat", baseUrl: "https://one.example/v1", model: "model-a", rememberKey: true, useEnvironmentKey: false });
    assert.equal(getProvider().apiKey, "legacy-private-key");
    const other = setProvider({ newConnection: true, name: "Other account", kind: "responses", baseUrl: "https://two.example/v1/responses", model: "model-b", apiKey: "second-private-key", rememberKey: true });
    assert.equal(getProvider().id, "default");
    selectProvider(other.id!); assert.equal(getProvider().apiKey, "second-private-key");
    selectProvider("default"); assert.equal(getProvider().apiKey, "legacy-private-key");
    assert.equal(previewProvider({ id: "default", baseUrl: "https://different.example/v1" }).apiKey, "");
    assert.equal(previewProvider({ newConnection: true, baseUrl: "https://one.example/v1" }).apiKey, "");
    setProvider({ id: other.id, clearKey: true });
    assert.equal(getProvider(other.id).apiKey, ""); assert.equal(getProvider().apiKey, "legacy-private-key");
    const data = readFileSync(join(directory, "providers.json"), "utf8") + JSON.stringify(providerConnections());
    assert.doesNotMatch(data, /legacy-private-key|second-private-key/);
  });

  it("does not move an existing credential when only a new endpoint is supplied", () => {
    setProvider({ kind: "openai-compat", baseUrl: "https://first.example/v1", apiKey: "private-first", model: "m" });
    const changed = setProvider({ baseUrl: "https://second.example/v1" });
    assert.equal(changed.apiKey, ""); assert.equal(providerStatus().ready, false);
  });

  it("supports a local server with no key and discovers its actual model IDs", async () => {
    const paths: string[] = [];
    const base = await endpoint((req, res) => {
      paths.push(req.url!); assert.equal(req.headers.authorization, undefined);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.method === "GET" ? { data: [{ id: "local-b" }, { id: "local-a", name: "Local A" }, { id: "local-a" }] } : { choices: [{ message: { content: "LOCAL_OK" } }] }));
    });
    const provider = setProvider({ kind: "openai-compat", baseUrl: `${base}/v1/chat/completions`, auth: "none", model: "local-a" });
    assert.equal(providerStatus().ready, true);
    assert.deepEqual((await listProviderModels(provider)).models.map((m) => m.id), ["local-a", "local-b"]);
    assert.equal((await chatResponse(provider, [{ role: "user", content: "Hello" }])).text, "LOCAL_OK");
    assert.deepEqual(paths, ["/v1/models", "/v1/chat/completions"]);
  });

  it("runs generic Responses tool calls without xAI authentication or strict optional fields", async () => {
    const payloads: Record<string, unknown>[] = [];
    const base = await endpoint(async (req, res) => {
      assert.equal(req.url, "/v1/responses"); assert.equal(req.headers.authorization, "Bearer response-key"); assert.equal(req.headers["x-xai-token-auth"], undefined);
      const parts = []; for await (const part of req) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString()); payloads.push(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "completed", output: payloads.length === 1 ? [{ type: "function_call", call_id: "response-call", name: "read_memory", arguments: "{}" }] : [{ type: "message", content: [{ type: "output_text", text: "RESPONSES_OK" }] }], usage: { input_tokens: 10, output_tokens: 5 } }));
    });
    const provider = { kind: "responses" as const, baseUrl: `${base}/v1`, apiKey: "response-key", model: "response-model" };
    const messages = [{ role: "system", content: "Use the tools." }, { role: "user", content: "Recall" }];
    const tools = [{ name: "read_memory", description: "Recall", parameters: { type: "object", properties: { query: { type: "string" } }, required: [], additionalProperties: false } }];
    const first = await chatResponse(provider, messages, tools);
    assert.equal(first.toolCalls[0].id, "response-call");
    const second = await chatResponse(provider, [...messages, { role: "assistant", content: "", toolCalls: first.toolCalls }, { role: "tool", content: "Saved fact", toolCallId: "response-call" }], tools);
    assert.equal(second.text, "RESPONSES_OK");
    assert.equal((payloads[0].tools as { strict: boolean }[])[0].strict, false);
    assert.equal(payloads[0].instructions, "Use the tools.");
    assert.ok((payloads[1].input as { type: string; call_id?: string }[]).some((p) => p.type === "function_call_output" && p.call_id === "response-call"));
    assert.equal(payloads[1].store, false);
  });

  it("discovers paginated Anthropic models with the correct headers and custom prefix", async () => {
    const base = await endpoint((req, res) => {
      assert.equal(req.headers["x-api-key"], "ant-key"); assert.equal(req.headers["anthropic-version"], "2023-06-01");
      const url = new URL(req.url!, "http://local"); assert.equal(url.pathname, "/proxy/v1/models");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(url.searchParams.has("after_id") ? { data: [{ id: "ant-b", display_name: "Model B" }], has_more: false } : { data: [{ id: "ant-a", display_name: "Model A" }], has_more: true, last_id: "ant-a" }));
    });
    const catalog = await listProviderModels({ kind: "anthropic", baseUrl: `${base}/proxy/v1/messages`, apiKey: "ant-key", model: "" });
    assert.deepEqual(catalog.models, [{ id: "ant-a", name: "Model A" }, { id: "ant-b", name: "Model B" }]);
    assert.equal(providerBase("anthropic", `${base}/proxy`), `${base}/proxy/v1`);
  });

  it("preserves chat reasoning and tool signatures in the private continuation", async () => {
    const cfg = { kind: "openai-compat" as const, baseUrl: "https://example.com/v1", model: "thinking-model", apiKey: "k" };
    const message = { role: "assistant", content: null, reasoning_content: "private provider continuation", reasoning_details: [{ type: "reasoning.encrypted", data: "opaque" }], tool_calls: [{ id: "sig-call", type: "function", function: { name: "read_memory", arguments: "{}" }, extra_content: { google: { thought_signature: "opaque-signature" } } }] };
    const first = await chatResponse(cfg, [{ role: "user", content: "Recall" }], [], async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message }] }) }));
    assert.equal(first.text, ""); assert.ok(first.providerItems);
    await chatResponse(cfg, [{ role: "user", content: "Recall" }, { role: "assistant", content: "", toolCalls: first.toolCalls, providerItems: first.providerItems }, { role: "tool", toolCallId: "sig-call", content: "Result" }], [], async (_url, init) => {
      const sent = JSON.parse(init.body).messages[1]; assert.deepEqual(sent, message);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "Done" } }] }) };
    });
  });

  it("keeps Anthropic thinking blocks and signatures with tool use", async () => {
    const cfg = { kind: "anthropic" as const, baseUrl: "https://example.com/v1", model: "ant", apiKey: "k" };
    const content = [{ type: "thinking", thinking: "private continuation", signature: "signed" }, { type: "tool_use", id: "ant-call", name: "read_memory", input: {} }];
    const first = await chatResponse(cfg, [{ role: "user", content: "Recall" }], [], async () => ({ ok: true, status: 200, json: async () => ({ content, stop_reason: "tool_use" }) }));
    assert.equal(first.text, "");
    await chatResponse(cfg, [{ role: "user", content: "Recall" }, { role: "assistant", content: "", toolCalls: first.toolCalls, providerItems: first.providerItems }, { role: "tool", toolCallId: "ant-call", content: "Result" }], [], async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body).messages[1].content, content);
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "Done" }] }) };
    });
  });

  it("bounds catalogs, rejects redirects, and keeps unavailable catalogs explicit", async () => {
    const cfg = { kind: "openai-compat" as const, baseUrl: "https://example.com/v1", auth: "none" as const, apiKey: "", model: "" };
    await assert.rejects(() => listProviderModels(cfg, undefined, async () => new Response("{}", { headers: { "content-length": "9000000" } })), /too large/);
    await assert.rejects(() => listProviderModels(cfg, undefined, async (_url, init) => { assert.equal(init?.redirect, "error"); return new Response("{}", { status: 404 }); }), /HTTP 404/);
    assert.equal((await listProviderModels({ ...cfg, kind: "converse" })).supported, false);
  });

  it("a bot can use another connection while the app default stays unchanged", async () => {
    setProvider({ name: "Default", kind: "openai-compat", baseUrl: "https://default.example/v1", apiKey: "default-key", model: "default-model" });
    const other = setProvider({ newConnection: true, name: "Bot connection", kind: "anthropic", baseUrl: "https://bot.example/v1", apiKey: "bot-key", model: "connection-model" });
    createBot("specific", { providerId: other.id, model: "bot-model" });
    assert.throws(() => removeProvider(other.id!), /bot uses/);
    const runtime = createAgentRuntime({ review: false, complete: async (provider) => { assert.equal(provider.id, other.id); assert.equal(provider.apiKey, "bot-key"); assert.equal(provider.model, "bot-model"); return { text: "BOT_PROVIDER_OK", toolCalls: [] }; } });
    try { const [run] = runtime.enqueue({ scope: "bot:specific", message: "Hello" }); const done = await runtime.wait(run.id); assert.equal(done.status, "completed", done.error || ""); }
    finally { await runtime.close(); }
    assert.equal(getProvider().model, "default-model");
  });
});

describe("OpenRouter browser callback", () => {
  it("validates state and PKCE, consumes the callback once, and stores no key in browser status", async () => {
    let exchanges = 0, release!: () => void, ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let challenge = "";
    const login = createOpenRouterLogin({ request: async (url, init) => {
      exchanges++; assert.equal(url, "https://openrouter.ai/api/v1/auth/keys");
      const body = JSON.parse(String(init?.body)); assert.equal(body.code, "one-time-code"); assert.equal(body.code_challenge_method, "S256");
      assert.equal(createHash("sha256").update(body.code_verifier).digest("base64url"), challenge);
      ready(); await gate; return Response.json({ key: "callback-private-key" });
    } });
    try {
      const flow = await login.begin(); const authorize = new URL(flow.authorizationUrl); challenge = authorize.searchParams.get("code_challenge")!;
      const callback = new URL(authorize.searchParams.get("callback_url")!); callback.searchParams.set("code", "one-time-code");
      const invalid = new URL(callback); invalid.searchParams.set("state", "x".repeat(flow.id.length - 1) + "é");
      assert.equal((await fetch(invalid)).status, 400); assert.equal(exchanges, 0);
      const completing = fetch(callback); await started;
      assert.equal((await fetch(callback)).status, 409); release(); assert.equal((await completing).status, 200);
      const state = login.status(flow.id); assert.equal(state.state, "connected"); assert.equal(exchanges, 1);
      assert.equal(getProvider(state.connectionId).apiKey, "callback-private-key");
      assert.doesNotMatch(JSON.stringify(state) + readFileSync(join(directory, "providers.json"), "utf8"), /callback-private-key/);
    } finally { release?.(); await login.close(); }
  });

  it("cancellation prevents an exchange that ignores abort from creating a connection", async () => {
    let release!: () => void, ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
    const login = createOpenRouterLogin({ request: async () => { ready(); await gate; return Response.json({ key: "late-private-key" }); } });
    try {
      const flow = await login.begin(); const callback = new URL(new URL(flow.authorizationUrl).searchParams.get("callback_url")!); callback.searchParams.set("code", "late-code");
      const completing = fetch(callback).catch(() => null); await started; await login.cancel(flow.id); release(); await completing;
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(login.status(flow.id).state, "cancelled"); assert.equal(providerConnections().connections.length, 1);
    } finally { release?.(); await login.close(); }
  });
});
