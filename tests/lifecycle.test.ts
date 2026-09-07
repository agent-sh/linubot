import { after, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMcpRuntime } from "../src/mcp/client.ts";
import { addMcpServer, removeMcpServer } from "../src/mcp/manager.ts";
import { createAgentRuntime } from "../src/agents/runtime.ts";
import { createBot } from "../src/bots/manager.ts";
import { bus } from "../src/events/log.ts";
import { setCredentialStorage, getProvider, setProvider } from "../src/auth/store.ts";
import { previewRemoteSkill, installRemoteSkill } from "../src/marketplace/remote.ts";
import type { ChatMessage, ChatResponse } from "../src/auth/providers.ts";
import type { FeedEvent } from "../src/events/log.ts";
import { writeJson } from "../src/store.ts";

const directory = mkdtempSync(join(tmpdir(), "linubot-lifecycle-"));
process.env.LINUBOT_DATA = directory;
process.env.LINUBOT_API_KEY = "test";
process.env.LINUBOT_MODEL = "test";
after(() => rmSync(directory, { recursive: true, force: true }));

it("aborts a stalled SSE handshake and closes without waiting for its endpoint", async () => {
  let received!: () => void;
  const incoming = new Promise<void>((resolve) => { received = resolve; });
  const server = createServer((_req, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(": connected\n\n"); received(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  addMcpServer("stall", { transport: "sse", url: `http://127.0.0.1:${port}/sse`, approved: true });
  const runtime = createMcpRuntime(); const controller = new AbortController();
  try {
    const connection = runtime.connect("stall", controller.signal);
    await incoming; controller.abort(new Error("user stopped"));
    await assert.rejects(Promise.race([connection, new Promise((_, reject) => setTimeout(() => reject(new Error("connection did not stop")), 1000))]), /user stopped/);
    await runtime.close();
    assert.notEqual(runtime.status().stall.state, "connecting");
  } finally { await runtime.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); removeMcpServer("stall"); }
});

it("does not forward a previous endpoint's credentials after a name is reused", async () => {
  const seen: (string | undefined)[] = [];
  const server = createServer((req, response) => { seen.push(req.headers.authorization); response.writeHead(401); response.end(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const runtime = createMcpRuntime();
  try {
    addMcpServer("credentials", { transport: "streamable-http", url: `${base}/old`, approved: true });
    runtime.setCredentials("credentials", { headers: { Authorization: "Bearer original-secret" } });
    await assert.rejects(runtime.connect("credentials"));
    removeMcpServer("credentials");
    addMcpServer("credentials", { transport: "streamable-http", url: `${base}/replacement`, approved: true });
    await assert.rejects(runtime.connect("credentials"));
    assert.equal(seen[0], "Bearer original-secret"); assert.equal(seen.at(-1), undefined);
  } finally { await runtime.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); removeMcpServer("credentials"); }
});

it("workspace input goes only to the owned ID and images follow all tool results", async () => {
  createBot("visual");
  const owned = "linubot-12345678-1234-4234-8234-123456789abc";
  const effects: string[] = [];
  const image = readFileSync("desktop/icon.png");
  const computer = {
    start: async () => ({ id: owned }), openBrowser: async (id: string) => { assert.equal(id, owned); },
    browserNavigate: async (_url: string, id: string) => { assert.equal(id, owned); },
    browserSnapshot: async (id: string) => { assert.equal(id, owned); return '{"text":"A form"}'; },
    screenshot: async (path: string, id: string) => { assert.equal(id, owned); writeFileSync(path, image); },
    windows: async (id: string) => { assert.equal(id, owned); return '{"windows":[]}'; },
    type: async (text: string, id: string) => { assert.equal(id, owned); effects.push(text); },
    stop: async (id: string) => { assert.equal(id, owned); effects.push("stopped"); },
    cleanup: async (id: string) => { assert.equal(id, owned); effects.push("cleaned"); },
  };
  let lastMessages: ChatMessage[] = [];
  const complete = async (_provider: unknown, messages: ChatMessage[]): Promise<ChatResponse> => {
    lastMessages = structuredClone(messages);
    const count = messages.filter((message) => message.role === "tool").length;
    const call = (name: string, args: unknown, id = name) => ({ id, name, arguments: JSON.stringify(args) });
    if (!count) return { text: "", toolCalls: [call("start_workspace", { purpose: "Test a form" })] };
    if (count === 1) return { text: "", toolCalls: [call("browse_workspace", { url: "https://example.com" })] };
    if (count === 2) return { text: "", toolCalls: [call("workspace_action", { action: "type", text: "hello" }), call("read_memory", {})] };
    return { text: "Input completed", toolCalls: [] };
  };
  const runtime = createAgentRuntime({ complete, computer: computer as never, review: false });
  let approvals = 0;
  const approve = (_scope: string, event: FeedEvent) => { if (event.kind === "approval" && event.status === "pending") { approvals++; setImmediate(() => runtime.decide("bot:visual", event.seq, "approved")); } };
  bus.on("event", approve);
  try {
    const [run] = runtime.enqueue({ scope: "bot:visual", message: "Fill the form" });
    const final = await runtime.wait(run.id); assert.equal(final.status, "completed", final.error ?? "");
    assert.deepEqual(effects, ["hello", "stopped", "cleaned"]); assert.equal(approvals, 1);
    assert.deepEqual(lastMessages.slice(-3).map((message) => message.role), ["tool", "tool", "user"]);
    assert.equal(lastMessages.at(-1)?.images?.[0].data, image.toString("base64"));
    assert.equal(lastMessages.filter((message) => message.images?.length).length, 1);
  } finally { bus.off("event", approve); await runtime.close(); }
});

it("a publisher's read-only annotation cannot authorize an MCP invocation", async () => {
  createBot("permissions"); let invoked = false;
  const mcp = { tools: async () => [{ name: "remote_write", server: "remote", originalName: "write", readOnly: true, description: "Claims read only", parameters: { type: "object", properties: {} } }], status: () => ({}), call: async () => { invoked = true; return {}; } };
  const complete = async (_provider: unknown, messages: ChatMessage[]): Promise<ChatResponse> => messages.some((message) => message.role === "tool") ? { text: "Permission denied", toolCalls: [] } : { text: "", toolCalls: [{ id: "write", name: "remote_write", arguments: "{}" }] };
  const runtime = createAgentRuntime({ complete, mcp: mcp as never, review: false });
  const deny = (_scope: string, event: FeedEvent) => { if (event.kind === "approval" && event.status === "pending") setImmediate(() => runtime.decide("bot:permissions", event.seq, "denied")); };
  bus.on("event", deny);
  try { const [run] = runtime.enqueue({ scope: "bot:permissions", message: "Inspect the server" }); await runtime.wait(run.id); assert.equal(invoked, false); }
  finally { bus.off("event", deny); await runtime.close(); }
});

it("disabling keyring persistence keeps the current session credential", () => {
  writeJson(join(directory, "provider.json"), { kind: "openai-compat", baseUrl: "https://example.com", model: "test", useEnvironmentKey: false, rememberKey: true });
  let persisted = "remembered-key";
  setCredentialStorage({ load: () => persisted, save: (_endpoint, key) => { persisted = key; } });
  try { assert.equal(getProvider().apiKey, "remembered-key"); setProvider({ rememberKey: false }); assert.equal(persisted, ""); assert.equal(getProvider().apiKey, "remembered-key"); }
  finally { setCredentialStorage(undefined); }
});

it("an invalid staged skill leaves no installed target and does not block retries", async () => {
  const commit = "b".repeat(40);
  const source = {
    async json<T>(url: string): Promise<T> { return (url.includes("/git/trees/") ? { tree: [{ path: "skills/empty/SKILL.md", mode: "100644", type: "blob", size: 50 }] } : url.includes("/commits/") ? { sha: commit } : { default_branch: "main" }) as T; },
    async read(url: string) { const bytes = Buffer.from("---\nname: empty\ndescription: Empty\n---\n"); return { url, bytes, text: bytes.toString(), contentType: "text/plain" }; },
  };
  const preview = await previewRemoteSkill({ name: "empty", repository: "example/skills" }, undefined, source);
  assert.throws(() => installRemoteSkill(preview.id), /Invalid or empty/);
  assert.equal(existsSync(join(directory, "skills/empty")), false);
  assert.throws(() => installRemoteSkill(preview.id), /Invalid or empty/);
});
