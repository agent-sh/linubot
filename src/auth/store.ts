import { xaiTokenNow } from "./xai.ts";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir, readJson, writeJson } from "../store.ts";
import { chatComplete, configFromEnv, providerBase, providerAuth, PROVIDER_KINDS, providerUrl } from "./providers.ts";
import type { ProviderConfig, ProviderKind, ProviderAuth } from "./providers.ts";
import { getBot, readSoul, listBots } from "../bots/manager.ts";
import { InputError } from "../errors.ts";
import { META_BASE, museCredential, museStatus } from "./muse.ts";
import { CODEX_BASE, codexConfigured } from "./codex.ts";
import { GOOGLE_BASE, googleTokenNow, forgetGoogleCredentials } from "./google.ts";
import { QWEN_PLANS, qwenCredential } from "./qwen.ts";

interface StoredProvider { id: string; name: string; kind: ProviderKind; baseUrl: string; model: string; auth?: ProviderAuth; useEnvironmentKey?: boolean; rememberKey?: boolean; credentialId?: string; credentialSource?: "muse" | "qwen" }
interface Registry { activeId: string; connections: StoredProvider[] }
interface CredentialStorage { load(endpoint: string): string; save(endpoint: string, key: string): void }
export interface ProviderPatch { id?: string; name?: string; kind?: ProviderKind; baseUrl?: string; model?: string; auth?: ProviderAuth; apiKey?: string; clearKey?: boolean; rememberKey?: boolean; newConnection?: boolean }
let credentialStorage: CredentialStorage | undefined;
const managedSecrets = new Map<string, string>();
export function setCredentialStorage(storage: CredentialStorage | undefined) { credentialStorage = storage; }
export function loadManagedSecret(name: string): string { return managedSecrets.get(`${resolve(dataDir())}:${name}`) ?? credentialStorage?.load(`oauth:${name}`) ?? ""; }
export function saveManagedSecret(name: string, value: string): void { credentialStorage?.save(`oauth:${name}`, value); const key = `${resolve(dataDir())}:${name}`; if (value) managedSecrets.set(key, value); else managedSecrets.delete(key); }
const sessionKeys = new Map<string, { key: string; endpoint: string }>();
const identity = (provider: Pick<ProviderConfig, "kind" | "baseUrl" | "auth">) => `${provider.kind}:${providerBase(provider.kind, provider.baseUrl)}:${providerAuth(provider)}`;
const sessionId = (id: string) => `${resolve(dataDir())}:${id}`;

function registry(): Registry {
  const stored = readJson<Registry | null>(join(dataDir(), "providers.json"), null);
  if (stored) {
    if (!Array.isArray(stored.connections) || stored.connections.length < 1 || stored.connections.length > 30 || !stored.connections.some((p) => p.id === stored.activeId) || new Set(stored.connections.map((p) => p.id)).size !== stored.connections.length) throw new Error("Invalid provider connections");
    return stored;
  }
  // Read the old connection in place. Migration happens on the first settings write.
  const legacy = readJson<Omit<StoredProvider, "id" | "name"> | null>(join(dataDir(), "provider.json"), null);
  const env = configFromEnv();
  const source = legacy ?? { kind: env.kind, baseUrl: env.baseUrl, model: env.model, auth: env.auth, useEnvironmentKey: true };
  return { activeId: "default", connections: [{ ...source, id: "default", name: source.kind === "xai-oauth" ? "xAI OAuth" : "Default connection", credentialId: `${source.kind}:${providerUrl(source.baseUrl)}` }] };
}

export function getProvider(id?: string): ProviderConfig {
  const all = registry();
  const stored = all.connections.find((p) => p.id === (id || all.activeId));
  if (!stored) throw new InputError("Provider connection not found", 404);
  const provider: ProviderConfig = { id: stored.id, name: stored.name, kind: stored.kind, baseUrl: stored.baseUrl, model: stored.model, auth: providerAuth(stored), apiKey: "" };
  const session = sessionKeys.get(sessionId(stored.id));
  const env = configFromEnv();
  provider.apiKey = session?.endpoint === identity(provider) ? session.key
    : stored.rememberKey && credentialStorage ? credentialStorage.load(stored.credentialId ?? `${stored.id}:${identity(provider)}`)
    : stored.useEnvironmentKey !== false && identity(provider) === identity(env) ? env.apiKey : "";
  if (provider.kind === "xai-oauth") provider.apiKey = xaiTokenNow();
  if (provider.kind === "openai-codex") provider.apiKey = "";
  if (provider.kind === "google-oauth") provider.apiKey = googleTokenNow(provider.id);
  if (stored.credentialSource === "muse" && providerBase(provider.kind, provider.baseUrl) === META_BASE && ["openai-compat", "responses"].includes(provider.kind) && provider.auth === "bearer") {
    try { provider.apiKey = museCredential() ?? ""; } catch { provider.apiKey = ""; }
  }
  if (stored.credentialSource === "qwen" && QWEN_PLANS[provider.baseUrl] && provider.kind === "openai-compat" && provider.auth === "bearer") {
    try { provider.apiKey = qwenCredential(provider.baseUrl).key; } catch { provider.apiKey = ""; }
  }
  if (provider.auth === "none") provider.apiKey = "";
  return provider;
}

function validate(patch: ProviderPatch, current: ProviderConfig): ProviderConfig {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new InputError("Provider settings must be an object");
  const next: ProviderConfig = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
  if (!PROVIDER_KINDS.includes(next.kind)) throw new InputError("Unknown provider format");
  if (typeof next.baseUrl !== "string" || next.baseUrl.length > 2000) throw new InputError("Invalid provider endpoint");
  next.baseUrl = providerBase(next.kind, next.baseUrl);
  if (next.kind === "xai-oauth" && next.baseUrl !== "https://api.x.ai/v1") throw new InputError("xAI OAuth uses https://api.x.ai/v1");
  if (next.kind === "openai-codex" && next.baseUrl !== CODEX_BASE) throw new InputError("ChatGPT sign-in uses the Codex endpoint");
  if (next.kind === "google-oauth" && next.baseUrl !== GOOGLE_BASE) throw new InputError("Google sign-in uses the Gemini API endpoint");
  next.auth = patch.auth ?? (patch.kind && patch.kind !== current.kind ? providerAuth({ kind: next.kind }) : providerAuth(next));
  if (!["bearer", "x-api-key", "none"].includes(next.auth) || (["xai-oauth", "openai-codex", "google-oauth"].includes(next.kind) && next.auth !== "bearer")) throw new InputError("Invalid authentication method for this provider");
  if (["openai-codex", "google-oauth"].includes(next.kind) && typeof patch.apiKey === "string" && patch.apiKey.trim()) throw new InputError("Use this provider's sign-in button; API keys use their own connection preset");
  if (typeof next.model !== "string" || next.model.length > 200) throw new InputError("Model ID must be text of at most 200 characters");
  next.model = next.model.trim();
  if (next.name !== undefined && (typeof next.name !== "string" || !next.name.trim() || next.name.length > 80)) throw new InputError("Connection name must be 1–80 characters");
  if (patch.apiKey !== undefined && (typeof patch.apiKey !== "string" || patch.apiKey.length > 10000 || /[\r\n]/.test(patch.apiKey))) throw new InputError("Invalid API key");
  for (const key of ["clearKey", "rememberKey", "newConnection"] as const) if (patch[key] !== undefined && typeof patch[key] !== "boolean") throw new InputError(`${key} must be a boolean`);
  return next;
}

// Catalog discovery can use an unsaved connection, but never borrows a key across endpoints.
export function previewProvider(patch: ProviderPatch = {}): ProviderConfig {
  const current = patch.newConnection ? { kind: "openai-compat" as const, baseUrl: "https://api.openai.com/v1", model: "", apiKey: "" } : getProvider(patch.id);
  const next = validate(patch, current);
  next.apiKey = patch.clearKey || next.auth === "none" ? "" : patch.apiKey?.trim() || (identity(current) === identity(next) ? current.apiKey : "");
  return next;
}

export function setProvider(patch: ProviderPatch): ProviderConfig {
  const all = registry();
  const current = patch.newConnection ? { kind: "openai-compat" as const, baseUrl: "https://api.openai.com/v1", model: "", apiKey: "" } : getProvider(patch.id);
  const next = validate(patch, current);
  const id = patch.newConnection ? randomUUID() : current.id!;
  const prior = all.connections.find((p) => p.id === id);
  if (!prior && all.connections.length >= 30) throw new InputError("At most 30 provider connections can be saved", 409);
  const changedEndpoint = identity(current) !== identity(next);
  const credentialId = !changedEndpoint && prior?.credentialId ? prior.credentialId : `${id}:${identity(next)}`;
  const rememberKey = ["xai-oauth", "openai-codex", "google-oauth"].includes(next.kind) || next.auth === "none" ? false : patch.rememberKey ?? prior?.rememberKey ?? false;
  if (rememberKey && !credentialStorage) throw new InputError("The Linux keyring is unavailable. Use a session key instead.", 409);
  const key = patch.clearKey || next.auth === "none" ? "" : patch.apiKey !== undefined ? patch.apiKey.trim() : changedEndpoint ? "" : current.apiKey;
  sessionKeys.set(sessionId(id), { key, endpoint: identity(next) });
  if (credentialStorage) {
    if (prior?.credentialId && prior.credentialId !== credentialId) credentialStorage.save(prior.credentialId, "");
    credentialStorage.save(credentialId, rememberKey ? key : "");
  }
  const stored: StoredProvider = { id, name: next.name?.trim() || "New connection", kind: next.kind, baseUrl: next.baseUrl, model: next.model, auth: next.auth,
    credentialId, rememberKey, useEnvironmentKey: patch.clearKey || patch.apiKey !== undefined || changedEndpoint || patch.newConnection ? false : prior?.useEnvironmentKey ?? true,
    ...(!patch.clearKey && patch.apiKey === undefined && !changedEndpoint && prior?.credentialSource ? { credentialSource: prior.credentialSource } : {}) };
  all.connections = [...all.connections.filter((p) => p.id !== id), stored];
  if (prior?.kind === "google-oauth" && (changedEndpoint || patch.clearKey)) forgetGoogleCredentials(id);
  writeJson(join(dataDir(), "providers.json"), all);
  return getProvider(id);
}

export function selectProvider(id: string): void {
  const all = registry();
  if (!all.connections.some((p) => p.id === id)) throw new InputError("Provider connection not found", 404);
  writeJson(join(dataDir(), "providers.json"), { ...all, activeId: id });
}
export function removeProvider(id: string): void {
  const all = registry(); const connection = all.connections.find((p) => p.id === id);
  if (!connection) throw new InputError("Provider connection not found", 404);
  if (all.activeId === id) throw new InputError("Choose another app default before removing this connection", 409);
  if (listBots().some((bot) => bot.providerId === id)) throw new InputError("A bot uses this connection. Change its model settings first.", 409);
  if (connection.credentialId) credentialStorage?.save(connection.credentialId, "");
  if (connection.kind === "google-oauth") forgetGoogleCredentials(id);
  sessionKeys.delete(sessionId(id));
  writeJson(join(dataDir(), "providers.json"), { ...all, connections: all.connections.filter((p) => p.id !== id) });
}
export function providerStatus(id?: string) {
  const provider = getProvider(id); const all = registry();
  const hasKey = provider.kind === "openai-codex" ? codexConfigured() : Boolean(provider.apiKey.trim());
  return { id: provider.id!, name: provider.name!, kind: provider.kind, baseUrl: provider.baseUrl, model: provider.model, auth: providerAuth(provider), hasKey,
    ready: (hasKey || providerAuth(provider) === "none") && Boolean(provider.model.trim()) && provider.model !== "default", credentialStorage: Boolean(credentialStorage),
    rememberKey: all.connections.find((p) => p.id === provider.id)?.rememberKey ?? false, active: provider.id === all.activeId };
}
export function providerConnections() { const all = registry(), bots = listBots(); return { activeId: all.activeId, connections: all.connections.map((p) => ({ ...providerStatus(p.id), usedBy: bots.filter((bot) => (bot.providerId || all.activeId) === p.id).map((bot) => bot.name) })) }; }
export function connectMuse(id?: string) {
  if (!museCredential()) throw new InputError("Sign in with muse login, then use the Muse Code sign-in here.", 409);
  const existing = id ? getProvider(id) : registry().connections.find((p) => p.credentialSource === "muse");
  if (existing && (providerBase(existing.kind, existing.baseUrl) !== META_BASE || !["openai-compat", "responses"].includes(existing.kind) || providerAuth(existing) !== "bearer")) throw new InputError("Choose a Meta connection for Muse Code sign-in");
  const saved = setProvider(existing ? { id: existing.id, model: existing.model || museStatus().model, clearKey: true, rememberKey: false }
    : { newConnection: true, name: "Muse Code", kind: "openai-compat", baseUrl: META_BASE, auth: "bearer", model: museStatus().model, rememberKey: false });
  const all = registry();
  all.connections = all.connections.map((p) => p.id === saved.id ? { ...p, credentialSource: "muse", useEnvironmentKey: false } : p);
  writeJson(join(dataDir(), "providers.json"), all);
  return providerStatus(saved.id);
}
export function connectQwen(baseUrl: string, id?: string) {
  const source = qwenCredential(baseUrl), current = id ? getProvider(id) : undefined;
  if (current && (current.baseUrl !== baseUrl || current.kind !== "openai-compat" || current.auth !== "bearer")) throw new InputError("Choose the matching Qwen plan connection");
  const saved = setProvider(current ? { id, model: current.model || source.model, clearKey: true, rememberKey: false } : { newConnection: true, name: baseUrl.includes("token-plan") ? "Qwen Token Plan" : "Qwen Coding Plan", kind: "openai-compat", baseUrl, auth: "bearer", model: source.model, rememberKey: false });
  const all = registry(); all.connections = all.connections.map((p) => p.id === saved.id ? { ...p, credentialSource: "qwen", useEnvironmentKey: false } : p);
  writeJson(join(dataDir(), "providers.json"), all); return providerStatus(saved.id);
}
export function connectXai(): void {
  const needsDefault = !providerStatus().ready;
  const existing = registry().connections.find((p) => p.kind === "xai-oauth");
  const connection = existing ? getProvider(existing.id) : setProvider({ newConnection: true, name: "xAI OAuth", kind: "xai-oauth", baseUrl: "https://api.x.ai/v1", model: "grok-4.6", rememberKey: false });
  if (needsDefault) selectProvider(connection.id!);
}

export async function speak(bot: string, text: string, signal?: AbortSignal): Promise<string> {
  const profile = getBot(bot);
  if (!profile) throw new InputError("Unknown teammate", 404);
  const provider = getProvider(profile.providerId);
  if (profile.model !== "default") provider.model = profile.model;
  return chatComplete(provider, [{ role: "system", content: readSoul(bot) }, { role: "user", content: text }], undefined, signal);
}
