import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { dataDir, readJson, writeJson } from "../store.ts";
import { abortable } from "../network/abort.ts";
import { InputError } from "../errors.ts";

// xAI's public Grok OAuth client, also used by its supported Hermes integration.
const CLIENT = "b1a00492-073a-47ea-816f-4c329264a828";
const TOKEN = "https://auth.x.ai/oauth2/token";
const DEVICE = "https://auth.x.ai/oauth2/device/code";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
interface Tokens { access_token: string; refresh_token?: string; expires_in?: number }
interface Vault { load(): Tokens | undefined; save(tokens: Tokens | undefined): void }
let vault: Vault | undefined;
export function setXaiVault(value: Vault | undefined) { vault = value; }
const sessions = new Map<string, Tokens>();
const refreshing = new Map<string, Promise<string>>();
const generations = new Map<string, number>();
const refreshControllers = new Map<string, AbortController>();
const generation = () => generations.get(dataDir()) ?? 0;
function invalidate() {
  const value = generation() + 1; generations.set(dataDir(), value);
  refreshControllers.get(dataDir())?.abort(new InputError("xAI sign-in changed", 409));
  refreshing.delete(dataDir()); pending.delete(dataDir()); return value;
}
function requireGeneration(value: number) { if (value !== generation()) throw new InputError("xAI sign-in changed while the request was running", 409); }
const pending = new Map<string, { id: string; code: string; expires: number; nextPoll: number; interval: number; generation: number }>();
const metadataPath = () => join(dataDir(), "xai-oauth.json");
const source = () => readJson<{ source?: "hermes" | "linubot" }>(metadataPath(), {}).source;
const hermesFile = () => join(homedir(), ".hermes", "auth.json");

function hermesTokens(): Tokens | undefined {
  if (!existsSync(hermesFile())) return undefined;
  const stat = lstatSync(hermesFile());
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new InputError("Invalid Hermes credential file");
  const auth = JSON.parse(readFileSync(hermesFile(), "utf8"));
  const tokens = auth.providers?.["xai-oauth"]?.tokens;
  return tokens && typeof tokens.access_token === "string" ? tokens : undefined;
}

export function xaiExpiresAt(token: string): number | undefined {
  try { const exp = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).exp; return typeof exp === "number" ? exp * 1000 : undefined; } catch { return undefined; }
}

function ownTokens() { return sessions.get(dataDir()) ?? vault?.load(); }
export function xaiTokenNow(): string { return (source() === "hermes" ? hermesTokens() : ownTokens())?.access_token ?? ""; }
export function xaiStatus() {
  const token = xaiTokenNow();
  return { connected: Boolean(token), source: source(), expiresAt: token ? xaiExpiresAt(token) : undefined, canImportHermes: existsSync(hermesFile()), persistent: source() === "hermes" || Boolean(vault) };
}

export function importHermesXai() {
  if (!hermesTokens()) throw new InputError("No xAI OAuth session was found in Hermes", 409);
  invalidate();
  writeJson(metadataPath(), { source: "hermes" });
  return xaiStatus();
}

export function saveXaiSession(tokens: Tokens) { invalidate(); saveOwnedTokens(tokens); }
function saveOwnedTokens(tokens: Tokens) {
  if (typeof tokens.access_token !== "string" || !tokens.access_token) throw new Error("xAI did not provide an access token");
  sessions.set(dataDir(), tokens); vault?.save(tokens);
  writeJson(metadataPath(), { source: "linubot" });
}

export function disconnectXai() {
  invalidate();
  sessions.delete(dataDir()); pending.delete(dataDir()); vault?.save(undefined); writeJson(metadataPath(), {});
  return xaiStatus();
}

async function exchange(url: string, parameters: Record<string, string>, signal?: AbortSignal) {
  const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]),
    headers: { "content-type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(parameters) });
  const text = await response.text();
  if (text.length > 64000) throw new Error("Oversized xAI authentication response");
  const body = JSON.parse(text);
  return { status: response.status, body };
}

export async function beginXaiLogin(signal?: AbortSignal) {
  const epoch = invalidate();
  const response = await exchange(DEVICE, { client_id: CLIENT, scope: SCOPE }, signal);
  requireGeneration(epoch);
  if (response.status !== 200) throw new InputError(`xAI sign-in could not start (HTTP ${response.status})`, 502);
  const body = response.body;
  const verification = new URL(body.verification_uri_complete ?? body.verification_uri);
  if (verification.protocol !== "https:" || !["auth.x.ai", "accounts.x.ai"].includes(verification.hostname)) throw new Error("xAI returned an unexpected sign-in URL");
  if (typeof body.device_code !== "string" || typeof body.user_code !== "string" || !Number.isFinite(body.expires_in)) throw new Error("Invalid xAI device-code response");
  const entry = { generation: epoch, id: randomUUID(), code: body.device_code, expires: Date.now() + Math.min(body.expires_in, 1800) * 1000, nextPoll: 0, interval: Math.max(5, Number(body.interval) || 5) };
  pending.set(dataDir(), entry);
  return { id: entry.id, verificationUri: verification.href, userCode: body.user_code, expiresAt: entry.expires, interval: entry.interval };
}

export async function pollXaiLogin(id: string, signal?: AbortSignal) {
  const entry = pending.get(dataDir());
  if (!entry || entry.id !== id || entry.expires < Date.now()) throw new InputError("xAI sign-in expired; start again", 410);
  requireGeneration(entry.generation);
  if (Date.now() < entry.nextPoll) return { state: "pending", interval: entry.interval };
  entry.nextPoll = Date.now() + entry.interval * 1000;
  const response = await exchange(TOKEN, { client_id: CLIENT, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: entry.code }, signal);
  requireGeneration(entry.generation);
  if (pending.get(dataDir()) !== entry) throw new InputError("xAI sign-in was replaced", 409);
  if (response.status === 200) { saveXaiSession(response.body); pending.delete(dataDir()); return { state: "connected", ...xaiStatus() }; }
  if (response.body.error === "authorization_pending") return { state: "pending", interval: entry.interval };
  if (response.body.error === "slow_down") { entry.interval += 5; return { state: "pending", interval: entry.interval }; }
  pending.delete(dataDir());
  throw new InputError("xAI sign-in was declined or expired; start again", 401);
}

export async function xaiAccessToken(signal?: AbortSignal, force = false): Promise<string> {
  signal?.throwIfAborted();
  const token = xaiTokenNow();
  if (!token) throw new InputError("Sign in with xAI in Settings", 409);
  if (!force && (xaiExpiresAt(token) ?? Infinity) > Date.now() + 120_000) return token;
  const key = dataDir();
  const inFlight = refreshing.get(key);
  if (inFlight) return signal ? abortable(inFlight, signal) : inFlight;
  const epoch = generation();
  const controller = new AbortController();
  refreshControllers.set(key, controller);
  const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]);
  const work = (async () => {
    if (source() === "hermes") {
      // Let the owning client refresh under its own lock. Never rotate a borrowed refresh token independently.
      const root = join(homedir(), ".hermes", "hermes-agent");
      const python = join(root, "venv", "bin", "python");
      if (!existsSync(python)) throw new InputError("Refresh the xAI login in Hermes, or sign in directly in Linubot", 409);
      await new Promise<void>((resolve, reject) => execFile(python, ["-c", `from hermes_cli.auth import resolve_xai_oauth_runtime_credentials; resolve_xai_oauth_runtime_credentials(force_refresh=${force ? "True" : "False"})`], { cwd: root, signal: combined, timeout: 45000, maxBuffer: 64000 }, (error) => error ? reject(new InputError("The Hermes xAI session needs a new sign-in", 401)) : resolve()));
      requireGeneration(epoch);
      return hermesTokens()?.access_token ?? "";
    }
    const tokens = ownTokens();
    if (!tokens?.refresh_token) throw new InputError("The xAI session expired; sign in again", 401);
    const response = await exchange(TOKEN, { client_id: CLIENT, grant_type: "refresh_token", refresh_token: tokens.refresh_token }, combined);
    requireGeneration(epoch);
    if (response.status !== 200) { if (response.status === 400 || response.status === 401) disconnectXai(); throw new InputError("xAI could not refresh this session; sign in again", 401); }
    const updated = { ...tokens, ...response.body }; saveOwnedTokens(updated); return updated.access_token as string;
  })();
  const tracked = work.finally(() => { if (refreshing.get(key) === tracked) { refreshing.delete(key); refreshControllers.delete(key); } });
  refreshing.set(key, tracked);
  return signal ? abortable(tracked, signal) : tracked;
}

export async function xaiModels(signal?: AbortSignal) {
  const token = await xaiAccessToken(signal);
  const response = await fetch("https://api.x.ai/v1/models", { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]), redirect: "error", headers: { Authorization: `Bearer ${token}`, "X-XAI-Token-Auth": "xai-oauth" } });
  if (!response.ok) throw new InputError(`xAI model list returned HTTP ${response.status}`, 502);
  const body = await response.json() as { data: { id: string }[] };
  return body.data.map((model) => model.id).filter((model) => !model.includes("imagine"));
}
