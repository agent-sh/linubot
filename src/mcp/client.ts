import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition } from "../auth/providers.ts";
import { InputError } from "../errors.ts";
import { readMcp } from "./manager.ts";
import type { McpServer } from "./manager.ts";
import { abortable } from "../network/abort.ts";

interface Connected { client: Client; revision: string; tools: Tool[] }
interface Status { state: "disconnected" | "connecting" | "connected" | "error"; tools: number; error?: string }
type Credentials = { env?: Record<string, string>; headers?: Record<string, string> };
const identity = (server: McpServer) => JSON.stringify([server.transport ?? "stdio", server.command, server.args ?? [], server.url]);
export interface McpTool extends ToolDefinition { server: string; originalName: string; readOnly: boolean }

export function createMcpRuntime() {
  const connections = new Map<string, Connected>();
  const connecting = new Map<string, Promise<Connected>>();
  const statuses = new Map<string, Status>();
  const credentials = new Map<string, { identity: string; value: Credentials }>();
  const attempts = new Map<string, AbortController>();
  let closed = false;

  async function disconnect(name: string) {
    attempts.get(name)?.abort(new Error("MCP connection cancelled"));
    const pending = connecting.get(name);
    if (pending) await pending.catch(() => {});
    const connection = connections.get(name);
    connections.delete(name);
    if (connection) await connection.client.close();
    statuses.set(name, { state: "disconnected", tools: 0 });
  }

  async function connect(name: string, signal?: AbortSignal): Promise<Connected> {
    if (closed) throw new Error("MCP client is closed");
    const server = readMcp().servers[name];
    if (!server || !server.enabled || !server.approved) throw new InputError("Review and enable this MCP server before connecting", 409);
    const savedCredentials = credentials.get(name);
    const secrets = savedCredentials?.identity === identity(server) ? savedCredentials.value : {};
    const revision = JSON.stringify([server, secrets]);
    const current = connections.get(name);
    if (current?.revision === revision) return current;
    const pending = connecting.get(name);
    if (pending) return signal ? abortable(pending, signal) : pending;
    if (current) await disconnect(name);
    const controller = new AbortController();
    attempts.set(name, controller);
    const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    const work = (async () => {
      statuses.set(name, { state: "connecting", tools: 0 });
      const client = new Client({ name: "linubot", version: "2.1.0" }, { capabilities: {} });
      try {
        for (const key of server.requiredEnv ?? []) if (!secrets.env?.[key]) throw new InputError(`Enter ${key} to connect ${name}`, 409);
        for (const key of server.requiredHeaders ?? []) if (!secrets.headers?.[key]) throw new InputError(`Enter the ${key} header to connect ${name}`, 409);
        const transport = server.transport === "streamable-http" || server.transport === "sse"
          ? new (server.transport === "sse" ? SSEClientTransport : StreamableHTTPClientTransport)(new URL(server.url!), {
            requestInit: { headers: secrets.headers },
            fetch: (input, init) => {
              const target = new URL(input instanceof Request ? input.url : String(input));
              if (target.origin !== new URL(server.url!).origin) throw new Error("MCP attempted to send credentials to a different origin");
              return fetch(input, { ...init, redirect: "error" });
            },
          })
          : new StdioClientTransport({ command: server.command === "uvx" ? process.env.LINUBOT_UVX_BIN ?? "uvx" : server.command!, args: server.args ?? [], env: secrets.env, stderr: "pipe" });
        // Drain logs without exposing environment keys or filling the child pipe.
        if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => {});
        await abortable(client.connect(transport, { signal: combined, timeout: 25_000 }), combined, () => { void client.close().catch(() => {}); });
        const found: Tool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
          const result = await client.listTools(cursor ? { cursor } : {}, { signal: combined, timeout: 15_000 });
          found.push(...result.tools);
          cursor = result.nextCursor;
          if (found.length > 1000) throw new InputError("MCP catalog exceeds the 1000-tool limit", 409);
          if (!cursor) break;
        }
        combined.throwIfAborted();
        if (closed) throw new Error("MCP client closed while connecting");
        if (cursor) throw new InputError("MCP tool listing exceeds 20 pages; catalog was not silently truncated", 409);
        const result = { client, revision, tools: found };
        connections.set(name, result);
        statuses.set(name, { state: "connected", tools: result.tools.length });
        client.onclose = () => {
          if (connections.get(name) === result) { connections.delete(name); statuses.set(name, { state: "disconnected", tools: 0 }); }
        };
        return result;
      } catch (error) {
        await client.close().catch(() => {});
        statuses.set(name, { state: "error", tools: 0, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    })();
    const tracked = work.finally(() => { if (connecting.get(name) === tracked) { connecting.delete(name); attempts.delete(name); } });
    connecting.set(name, tracked);
    return signal ? abortable(tracked, signal) : tracked;
  }

  return {
    connect, disconnect,
    async forget(name: string) { credentials.delete(name); await disconnect(name); },
    status: (): Record<string, Status> => Object.fromEntries(Object.keys(readMcp().servers).map((name) => [name, statuses.get(name) ?? { state: "disconnected", tools: 0 }])),
    setCredentials(name: string, input: Credentials) {
      for (const values of [input.env, input.headers]) {
        if (values !== undefined && (!values || typeof values !== "object" || Array.isArray(values) || Object.entries(values).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_-]{0,100}$/.test(key) || typeof value !== "string" || value.length > 10000 || /[\r\n\0]/.test(value)))) throw new InputError("Invalid MCP credentials");
      }
      const server = readMcp().servers[name];
      if (!server) throw new InputError("Unknown MCP server", 404);
      credentials.set(name, { identity: identity(server), value: input });
    },
    async tools(signal?: AbortSignal): Promise<McpTool[]> {
      const result: McpTool[] = [];
      for (const [name, server] of Object.entries(readMcp().servers)) {
        if (!server.enabled || !server.approved) continue;
        try {
          const connection = await connect(name, signal);
          for (const tool of connection.tools) {
            const suffix = createHash("sha256").update(`${name}\0${tool.name}`).digest("hex").slice(0, 10);
            result.push({ name: `mcp_${name.slice(0, 25)}_${tool.name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 16)}_${suffix}`, server: name, originalName: tool.name,
              description: `[${name}/${tool.name}] ${(tool.description ?? tool.name).slice(0, 1500)}`, parameters: tool.inputSchema, readOnly: tool.annotations?.readOnlyHint === true });
          }
        } catch { signal?.throwIfAborted(); /* Failure remains visible in connection status. */ }
      }
      return result;
    },
    async call(tool: McpTool, args: Record<string, unknown>, signal: AbortSignal) {
      const connection = await connect(tool.server, signal);
      const result = await connection.client.callTool({ name: tool.originalName, arguments: args }, undefined, { signal, timeout: 60_000 });
      if (result.isError) throw new Error(JSON.stringify(result.content).slice(0, 4000));
      return { server: tool.server, tool: tool.originalName, content: result.content, structuredContent: result.structuredContent };
    },
    async close() { closed = true; await Promise.allSettled([...new Set([...connections.keys(), ...connecting.keys()])].map(disconnect)); credentials.clear(); },
  };
}

export type McpRuntime = ReturnType<typeof createMcpRuntime>;
