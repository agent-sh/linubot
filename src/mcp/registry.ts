import { createHash } from "node:crypto";
import { fetchPublicJson, publicUrl } from "../network/http.ts";
import { InputError, requiredText } from "../errors.ts";
import { addMcpServer, readMcp } from "./manager.ts";
import type { McpServer } from "./manager.ts";

interface Variable { name: string; isRequired?: boolean; value?: string; description?: string }
interface Entry {
  name: string; description: string; version: string; repository?: { url?: string };
  remotes?: { type: string; url: string; headers?: Variable[] }[];
  packages?: { registryType: string; identifier: string; version: string; transport?: { type: string }; environmentVariables?: Variable[]; packageArguments?: unknown[]; runtimeArguments?: unknown[] }[];
}
export interface RegistryHit { id: string; name: string; description: string; version: string; repository?: string; options: { label: string; config: McpServer }[] }
const discovered = new Map<string, { hit: RegistryHit; expires: number }>();

export function registryHit(entry: Entry): RegistryHit {
  const name = requiredText(entry.name, "Registry name", 200);
  const version = requiredText(entry.version, "Registry version", 100);
  const options: RegistryHit["options"] = [];
  for (const remote of entry.remotes ?? []) {
    if (!["streamable-http", "sse"].includes(remote.type)) continue;
    try {
      const url = publicUrl(remote.url).href;
      options.push({ label: `Remote ${remote.type}`, config: { transport: remote.type as "streamable-http" | "sse", url,
        requiredHeaders: (remote.headers ?? []).filter((header) => header.isRequired === true).map((header) => header.name), version, source: name } });
    } catch { continue; }
  }
  for (const pkg of entry.packages ?? []) {
    if (pkg.transport?.type !== "stdio" || pkg.packageArguments?.length || pkg.runtimeArguments?.length) continue;
    if (!pkg.version || pkg.version === "latest" || !/^[0-9A-Za-z.+_-]+$/.test(pkg.version)) continue;
    const requiredEnv = (pkg.environmentVariables ?? []).filter((item) => item.isRequired && !item.value).map((item) => item.name);
    if (pkg.registryType === "npm" && /^(?:@[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg.identifier)) {
      options.push({ label: `npm · ${pkg.identifier}@${pkg.version}`, config: { transport: "stdio", command: "npx", args: ["--yes", `${pkg.identifier}@${pkg.version}`], requiredEnv, source: name, version } });
    }
    if (pkg.registryType === "pypi" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pkg.identifier)) {
      options.push({ label: `Python · ${pkg.identifier}==${pkg.version}`, config: { transport: "stdio", command: "uvx", args: [`${pkg.identifier}==${pkg.version}`], requiredEnv, source: name, version } });
    }
  }
  return { id: createHash("sha256").update(JSON.stringify(entry)).digest("hex"), name, version, description: requiredText(entry.description, "Registry description", 4000),
    ...(entry.repository?.url?.startsWith("https://") ? { repository: entry.repository.url } : {}), options };
}

export async function searchMcpRegistry(query: string, cursor?: string, signal?: AbortSignal) {
  if (query.length > 200 || (cursor?.length ?? 0) > 1000) throw new InputError("Registry query is too long");
  const url = new URL("https://registry.modelcontextprotocol.io/v0.1/servers");
  url.searchParams.set("search", query); url.searchParams.set("limit", "30"); url.searchParams.set("version", "latest");
  if (cursor) url.searchParams.set("cursor", cursor);
  const response = await fetchPublicJson<{ servers: { server: Entry }[]; metadata?: { nextCursor?: string } }>(url.href, signal);
  if (!Array.isArray(response.servers)) throw new Error("MCP registry returned an invalid response");
  for (const [id, entry] of discovered) if (entry.expires < Date.now()) discovered.delete(id);
  const hits = response.servers.slice(0, 50).flatMap(({ server }) => {
    try { const hit = registryHit(server); discovered.set(hit.id, { hit, expires: Date.now() + 30 * 60_000 }); return [hit]; } catch { return []; }
  });
  while (discovered.size > 300) discovered.delete(discovered.keys().next().value!);
  return { source: "https://registry.modelcontextprotocol.io", hits, cursor: response.metadata?.nextCursor };
}

export function installRegistryServer(id: string, option: number, name: string) {
  const entry = discovered.get(id);
  if (!entry || entry.expires < Date.now()) throw new InputError("Registry selection expired; search again before installing", 410);
  if (!Number.isInteger(option) || !entry.hit.options[option]) throw new InputError("Choose an available installation option");
  if (readMcp().servers[name]) throw new InputError("An MCP server with this name is already installed", 409);
  return addMcpServer(name, { ...entry.hit.options[option].config, approved: true, enabled: true });
}
