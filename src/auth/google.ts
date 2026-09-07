import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { loadManagedSecret, saveManagedSecret } from "./store.ts";
import { readProviderJson } from "./providers.ts";
import { InputError } from "../errors.ts";
import { dataDir } from "../store.ts";

export const GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = "openid email https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/generative-language.retriever";
export interface GoogleCredentials { accessToken: string; refreshToken: string; expiresAt: number; clientId: string; clientSecret: string; projectId: string; account: string }
interface ClientOptions { clientId?: string; clientSecret?: string; projectId?: string }
const pendingRefresh = new Map<string, Promise<GoogleCredentials>>(), generation = new Map<string, number>();
const key = (id: string) => `${dataDir()}:google:${id}`;
const validToken = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 10000 && !/[\r\n]/.test(value);
function stored(id?: string): GoogleCredentials | undefined {
  if (!id) return; const raw = loadManagedSecret(`google:${id}`); if (!raw || raw.length > 50000) return;
  try {
    const value = JSON.parse(raw);
    if (!value || !validToken(value.accessToken) || !validToken(value.refreshToken) || typeof value.account !== "string" || !value.account || value.account.length > 1024 || !Number.isFinite(value.expiresAt) || value.expiresAt < 0) return;
    if (!["clientId", "clientSecret", "projectId"].every((field) => typeof value[field] === "string" && value[field])) return;
    clientOptions(value); return value;
  } catch { return; }
}
export const googleTokenNow = (id?: string) => stored(id)?.accessToken || "";
export const googleProject = (id?: string) => stored(id)?.projectId || "";
export function saveGoogleCredentials(id: string, value: GoogleCredentials) { generation.set(key(id), (generation.get(key(id)) || 0) + 1); saveManagedSecret(`google:${id}`, JSON.stringify(value)); }
export function forgetGoogleCredentials(id: string) { generation.set(key(id), (generation.get(key(id)) || 0) + 1); pendingRefresh.delete(key(id)); saveManagedSecret(`google:${id}`, ""); }
export function googleSetup(id?: string) {
  const value = stored(id);
  return { configured: Boolean(value || (process.env.LINUBOT_GOOGLE_CLIENT_ID && process.env.LINUBOT_GOOGLE_CLIENT_SECRET)), projectId: value?.projectId || process.env.LINUBOT_GOOGLE_PROJECT_ID || "" };
}
function clientOptions(input: ClientOptions, id?: string) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("Google OAuth client settings must be an object");
  for (const field of ["clientId", "clientSecret", "projectId"] as const) if (input[field] !== undefined && typeof input[field] !== "string") throw new InputError("Google OAuth client fields must be text");
  const value = stored(id), clientId = input.clientId || value?.clientId || process.env.LINUBOT_GOOGLE_CLIENT_ID || "", clientSecret = input.clientSecret || value?.clientSecret || process.env.LINUBOT_GOOGLE_CLIENT_SECRET || "", projectId = input.projectId || value?.projectId || process.env.LINUBOT_GOOGLE_PROJECT_ID || "";
  if (clientId.length > 500 || !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId) || !clientSecret || clientSecret.length > 4000 || /[\r\n]/.test(clientSecret)) throw new InputError("Choose a Google Desktop OAuth client JSON file, or configure Linubot's Google OAuth client.", 409);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(projectId)) throw new InputError("Enter the Google Cloud project ID used for Gemini API requests");
  return { clientId, clientSecret, projectId };
}
export async function googleAccessToken(id: string | undefined, signal?: AbortSignal, request: typeof fetch = fetch): Promise<GoogleCredentials> {
  signal?.throwIfAborted();
  if (!id) throw new InputError("Connect Google before using this model", 409);
  const value = stored(id); if (!value) throw new InputError("Sign in to Google in provider settings", 409);
  if (value.expiresAt > Date.now() + 60000) return value;
  const identity = key(id), version = generation.get(identity) || 0;
  let refresh = pendingRefresh.get(identity);
  if (!refresh) {
    refresh = (async () => {
      const response = await request(TOKEN_URL, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20000), headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: value.refreshToken, client_id: value.clientId, client_secret: value.clientSecret }) });
      if (!response.ok) { await response.body?.cancel(); throw new InputError(`Google sign-in refresh returned HTTP ${response.status}. Reconnect Google.`, 409); }
      const data = await readProviderJson(response, 64 * 1024) as { access_token?: string; expires_in?: number; refresh_token?: string };
      if (!data || !validToken(data.access_token) || (data.refresh_token !== undefined && !validToken(data.refresh_token)) || !Number.isFinite(data.expires_in) || data.expires_in! <= 0) throw new Error("Google returned an invalid refresh response");
      if ((generation.get(identity) || 0) !== version) throw new Error("Google connection changed during refresh");
      const next = { ...value, accessToken: data.access_token, refreshToken: data.refresh_token || value.refreshToken, expiresAt: Date.now() + Math.min(data.expires_in!, 86400) * 1000 };
      saveManagedSecret(`google:${id}`, JSON.stringify(next)); return next;
    })(); pendingRefresh.set(identity, refresh);
    void refresh.finally(() => { if (pendingRefresh.get(identity) === refresh) pendingRefresh.delete(identity); }).catch(() => {});
  }
  if (!signal) return refresh;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => { const aborted = () => reject(signal.reason); signal.addEventListener("abort", aborted, { once: true }); refresh!.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted)); });
}

export function createGoogleLogin(connected: (credentials: GoogleCredentials, id?: string) => string, request: typeof fetch = fetch) {
  let active: { id: string; state: string; server: Server; ctrl: AbortController; timer?: NodeJS.Timeout; connectionId?: string; error?: string } | undefined;
  let starting: Promise<unknown> = Promise.resolve(), stopping = false;
  const pending = new Set<AbortController>();
  const page = (message: string) => `<!doctype html><meta charset="utf-8"><title>Linubot</title><h1>${message}</h1><p>Return to Linubot. You may close this tab.</p>`;
  async function releaseActive() {
    if (!active) return;
    const entry = active; active = undefined; clearTimeout(entry.timer); entry.ctrl.abort(new Error("Sign-in was cancelled")); entry.server.closeAllConnections();
    await new Promise<void>((resolve) => entry.server.close(() => resolve()));
  }
  async function cancel(id?: string) {
    if (id && id !== active?.id) return;
    for (const ctrl of pending) ctrl.abort(new Error("Sign-in was cancelled"));
    await releaseActive();
  }
  return {
    begin(input: ClientOptions, connection?: string) {
      const ctrl = new AbortController(); pending.add(ctrl);
      const work = starting.then(async () => {
        if (stopping) throw new Error("Sign-in service is stopping"); ctrl.signal.throwIfAborted(); const config = clientOptions(input, connection); await releaseActive(); ctrl.signal.throwIfAborted();
        const id = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
        const entry = { id, state: "waiting", server: createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 2000 }), ctrl } as NonNullable<typeof active>; active = entry; entry.server.maxConnections = 16;
        let redirect = "";
        entry.server.on("request", (req, res) => {
          res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
          let url: URL; try { url = new URL(req.url || "/", "http://127.0.0.1"); } catch { res.writeHead(400); res.end(page("Invalid callback")); return; }
          const state = url.searchParams.get("state") || "";
          if (req.method !== "GET" || url.pathname !== "/callback" || Buffer.byteLength(state) !== Buffer.byteLength(id) || !timingSafeEqual(Buffer.from(state), Buffer.from(id))) { res.writeHead(400); res.end(page("Invalid callback")); return; }
          if (active !== entry || entry.state !== "waiting") { res.writeHead(409); res.end(page("This sign-in is no longer active")); return; }
          const code = url.searchParams.get("code");
          if (!code || code.length > 4096 || url.searchParams.has("error")) { entry.state = "failed"; entry.error = "Google sign-in was declined."; clearTimeout(entry.timer); res.writeHead(400); res.end(page("Sign-in was not completed")); entry.server.close(); return; }
          entry.state = "connecting";
          void (async () => {
            try {
              const response = await request(TOKEN_URL, { method: "POST", redirect: "error", signal: AbortSignal.any([entry.ctrl.signal, AbortSignal.timeout(20000)]), headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: redirect, code_verifier: verifier }) });
              if (!response.ok) { await response.body?.cancel(); throw new Error("Google token exchange failed"); }
              const data = await readProviderJson(response, 64 * 1024) as { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string };
              if (!data || !validToken(data.access_token) || !validToken(data.refresh_token) || !Number.isFinite(data.expires_in) || data.expires_in! <= 0) throw new Error("Invalid Google token response");
              if (active !== entry || entry.ctrl.signal.aborted || stopping) throw new Error("Sign-in was cancelled");
              let subject = data.refresh_token;
              if (data.id_token) { try { const claims = JSON.parse(Buffer.from(data.id_token.split(".")[1], "base64url").toString()); if (claims.aud === config.clientId && typeof claims.sub === "string") subject = claims.sub; } catch { /* Opaque refresh credentials provide a conservative identity fallback. */ } }
              entry.connectionId = connected({ ...config, accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + Math.min(data.expires_in!, 86400) * 1000, account: createHash("sha256").update(subject + config.clientId + config.projectId).digest("hex") }, connection);
              entry.state = "connected"; clearTimeout(entry.timer); res.writeHead(200); res.end(page("Google connected")); entry.server.close(); entry.server.closeIdleConnections();
            } catch { if (active === entry) { entry.state = "failed"; entry.error = "Google sign-in could not finish. Check the OAuth client, project and API access, then try again."; } clearTimeout(entry.timer); if (!res.destroyed) { res.writeHead(400); res.end(page("Sign-in was not completed")); } entry.server.close(); }
          })();
        });
        try {
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => { ctrl.signal.removeEventListener("abort", aborted); entry.server.removeListener("error", failed); };
            const aborted = () => { cleanup(); reject(ctrl.signal.reason); };
            const failed = (error: Error) => { cleanup(); reject(error); };
            ctrl.signal.addEventListener("abort", aborted, { once: true }); entry.server.once("error", failed);
            entry.server.listen({ port: 0, host: "127.0.0.1", signal: ctrl.signal }, () => { cleanup(); resolve(); });
          });
          ctrl.signal.throwIfAborted();
        } catch (error) { if (active === entry) await releaseActive(); throw error; }
        const address = entry.server.address(); if (!address || typeof address === "string") throw new Error("Could not open Google callback");
        redirect = `http://127.0.0.1:${address.port}/callback`;
        const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirect, response_type: "code", scope: SCOPES, state: id, access_type: "offline", prompt: "consent", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
        entry.timer = setTimeout(() => { if (active === entry && entry.state !== "connected") { entry.state = "failed"; entry.error = "Sign-in expired. Start again."; entry.ctrl.abort(); entry.server.closeAllConnections(); entry.server.close(); } }, 10 * 60_000); entry.timer.unref();
        return { id, authorizationUrl: url.href };
      }).finally(() => pending.delete(ctrl)); starting = work.catch(() => {}); return work;
    },
    status(id: string) { if (!active || active.id !== id) throw new InputError("Sign-in session not found", 404); return { state: active.state, connectionId: active.connectionId, error: active.error }; },
    cancel,
    close: async () => { stopping = true; await cancel(); },
  };
}
