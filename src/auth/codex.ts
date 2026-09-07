import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { dataDir, readJson, writeJson } from "../store.ts";
import { InputError } from "../errors.ts";

export const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
type Json = Record<string, unknown>;
type Notice = (method: string, params: Json) => void;
interface Rpc { request(method: string, params: Json, signal?: AbortSignal): Promise<Json>; onNotice(fn: Notice): void; close(): void }
const metadata = () => join(dataDir(), "codex-connection.json");
export const codexConfigured = () => readJson<{ connected?: boolean }>(metadata(), {}).connected === true;
export function codexClaims(token: string): Json { try { const value = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; } }
export function codexAccount(token: string): string {
  const auth = codexClaims(token)["https://api.openai.com/auth"] as Json | undefined;
  return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : "";
}
export function codexIdentity(token: string): string {
  const claims = codexClaims(token), auth = claims["https://api.openai.com/auth"] as Json | undefined;
  const identity = claims.sub || auth?.chatgpt_user_id || auth?.user_id ? { sub: claims.sub, user: auth?.chatgpt_user_id || auth?.user_id, account: codexAccount(token), iss: claims.iss, aud: claims.aud } : token;
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
export function codexTokenFresh(token: string): boolean { const expiry = codexClaims(token).exp; return typeof expiry === "number" && Number.isFinite(expiry) && expiry * 1000 > Date.now() + 60000; }

export async function createCodexRpc(signal?: AbortSignal): Promise<Rpc> {
  signal?.throwIfAborted();
  // Codex owns its existing login, callback and refresh-token storage. No threads are started.
  const child = spawn(process.env.LINUBOT_CODEX_BIN || "codex", ["app-server", "--stdio", "-c", 'model_provider="openai"'], { cwd: homedir(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map<number, { resolve(value: Json): void; reject(error: Error): void }>();
  let next = 0, buffer = "", closed = false, notice: Notice = () => {};
  function fail(error: Error) { for (const item of pending.values()) item.reject(error); pending.clear(); }
  const terminate = () => { child.kill("SIGTERM"); const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2000); timer.unref(); child.once("exit", () => clearTimeout(timer)); };
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", () => { closed = true; fail(new Error("Codex protocol pipe closed")); terminate(); });
  child.once("error", () => { closed = true; fail(new InputError("Codex CLI is unavailable. Install it or set LINUBOT_CODEX_BIN, then try again.", 409)); });
  child.once("exit", () => { closed = true; fail(new Error("Codex sign-in service stopped")); });
  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) { closed = true; fail(new Error("Codex protocol response exceeded its limit")); terminate(); return; }
    for (;;) {
      const newline = buffer.indexOf("\n"); if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue;
      let value: { id?: number; result?: Json; error?: { code?: number }; method?: string; params?: Json };
      try { value = JSON.parse(line); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid message"); } catch { closed = true; fail(new Error("Codex returned invalid protocol data")); terminate(); return; }
      if (typeof value.method === "string") { if (value.id !== undefined) child.stdin.write(JSON.stringify({ id: value.id, error: { code: -32601, message: "This client only handles authentication and model discovery" } }) + "\n"); else notice(value.method, value.params || {}); }
      else if (typeof value.id === "number" && pending.has(value.id)) {
        const item = pending.get(value.id)!; pending.delete(value.id);
        if (value.error) item.reject(new Error(`Codex request failed (${value.error.code ?? "unknown"})`)); else item.resolve(value.result || {});
      }
    }
  });
  const rpc: Rpc = {
    request(method, params, parent) {
      const signal = AbortSignal.any([...(parent ? [parent] : []), AbortSignal.timeout(30000)]);
      if (closed) return Promise.reject(new Error("Codex sign-in service stopped"));
      const id = ++next;
      return new Promise<Json>((resolve, reject) => {
        const aborted = () => { pending.delete(id); reject(new Error("Codex request was cancelled or timed out")); };
        if (signal.aborted) { aborted(); return; }
        signal.addEventListener("abort", aborted, { once: true });
        const done = () => signal.removeEventListener("abort", aborted);
        pending.set(id, { resolve: (value) => { done(); resolve(value); }, reject: (error) => { done(); reject(error); } });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => { if (error) { pending.delete(id); done(); reject(new Error("Could not contact Codex")); } });
      });
    },
    onNotice(fn) { notice = fn; },
    close() { if (closed) return; closed = true; fail(new Error("Codex connection closed")); child.stdin.end(); terminate(); },
  };
  try { await rpc.request("initialize", { clientInfo: { name: "linubot", title: "Linubot", version: "1" }, capabilities: {} }, signal); child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n"); return rpc; }
  catch (error) { rpc.close(); throw error; }
}
async function token(rpc: Rpc, signal?: AbortSignal, refresh = false): Promise<string> {
  const auth = await rpc.request("getAuthStatus", { includeToken: true, refreshToken: refresh }, signal);
  if (auth.authMethod !== "chatgpt" || typeof auth.authToken !== "string" || !auth.authToken || auth.authToken.length > 10000 || /[\r\n]/.test(auth.authToken)) throw new InputError("Sign in to ChatGPT with Codex, or use the OpenAI API-key connection.", 409);
  if (!refresh && !codexTokenFresh(auth.authToken)) return token(rpc, signal, true);
  if (!codexTokenFresh(auth.authToken)) throw new InputError("Codex returned an expired sign-in. Reconnect ChatGPT.", 409);
  return auth.authToken;
}
export async function codexAccessToken(signal?: AbortSignal): Promise<string> {
  const rpc = await createCodexRpc(signal);
  try { return await token(rpc, signal); } finally { rpc.close(); }
}
export async function codexModels(signal?: AbortSignal) {
  const rpc = await createCodexRpc(signal);
  try {
    await token(rpc, signal);
    const result = await rpc.request("model/list", { limit: 100, includeHidden: false }, signal);
    const rows = Array.isArray(result.data) ? result.data as Json[] : [];
    const models = rows.filter((m) => typeof m.model === "string" && m.model.length <= 200).map((m) => ({ id: String(m.model), name: typeof m.displayName === "string" ? m.displayName : String(m.model) }));
    return { models, source: "Codex model/list", supported: true, truncated: Boolean(result.nextCursor), defaultModel: String(rows.find((m) => m.isDefault)?.model || models[0]?.id || "") };
  } finally { rpc.close(); }
}

export function createCodexLogin(connected: (id?: string, model?: string) => string, factory: (signal?: AbortSignal) => Promise<Rpc> = createCodexRpc) {
  let active: { id: string; rpc: Rpc; ctrl: AbortController; loginId?: string; earlyNotice?: Json; state: string; connectionId?: string; timer?: NodeJS.Timeout; error?: string } | undefined;
  let starting: Promise<unknown> = Promise.resolve(), stopping = false;
  const pending = new Set<AbortController>();
  async function releaseActive() {
    if (!active) return;
    const entry = active; active = undefined; clearTimeout(entry.timer); entry.ctrl.abort(new Error("Sign-in was cancelled"));
    if (entry.loginId) await entry.rpc.request("account/login/cancel", { loginId: entry.loginId }, AbortSignal.timeout(2000)).catch(() => {});
    entry.rpc.close();
  }
  async function cancel(id?: string) {
    if (id && active?.id !== id) return;
    for (const ctrl of pending) ctrl.abort(new Error("Sign-in was cancelled"));
    await releaseActive();
  }
  async function finish(rpc: Rpc, ctrl: AbortController, id?: string, current = () => !stopping) {
    ctrl.signal.throwIfAborted();
    await token(rpc, ctrl.signal);
    ctrl.signal.throwIfAborted();
    const result = await rpc.request("model/list", { limit: 100, includeHidden: false }, ctrl.signal);
    const rows = Array.isArray(result.data) ? result.data as Json[] : [];
    const model = String(rows.find((m) => m.isDefault)?.model || rows[0]?.model || "");
    if (!current() || ctrl.signal.aborted) throw new Error("Sign-in was cancelled");
    const connectionId = connected(id, model);
    writeJson(metadata(), { connected: true }); return connectionId;
  }
  return {
    connectExisting: async (id?: string) => {
      if (stopping) throw new Error("Sign-in service is stopping");
      const ctrl = new AbortController(); pending.add(ctrl); let rpc: Rpc | undefined;
      try { rpc = await factory(ctrl.signal); return { connectionId: await finish(rpc, ctrl, id) }; }
      finally { pending.delete(ctrl); rpc?.close(); }
    },
    begin(id?: string) {
      const ctrl = new AbortController(); pending.add(ctrl);
      const work = starting.then(async () => {
        if (stopping) throw new Error("Sign-in service is stopping"); ctrl.signal.throwIfAborted(); await releaseActive(); ctrl.signal.throwIfAborted();
        const rpc = await factory(ctrl.signal);
        if (ctrl.signal.aborted || stopping) { rpc.close(); throw new Error("Sign-in was cancelled"); }
        const entry = { id: randomUUID(), rpc, ctrl, state: "waiting" } as NonNullable<typeof active>; active = entry;
        const completed = (method: string, params: Json) => {
          if (method !== "account/login/completed" || active !== entry || entry.state !== "waiting") return;
          if (!entry.loginId) { entry.earlyNotice = params; return; }
          if (params.loginId !== entry.loginId) return;
          entry.state = "connecting";
          void (async () => {
            try { if (params.success !== true) throw new Error("ChatGPT sign-in was not completed"); const connectionId = await finish(rpc, ctrl, id, () => active === entry && entry.state === "connecting" && !stopping); if (active !== entry) return; entry.connectionId = connectionId; entry.state = "connected"; }
            catch { if (active === entry && entry.state === "connecting") { entry.state = "failed"; entry.error = "ChatGPT sign-in could not finish. Try again."; } }
            finally { clearTimeout(entry.timer); rpc.close(); }
          })();
        }; rpc.onNotice(completed);
        try {
          const result = await rpc.request("account/login/start", { type: "chatgpt" }, ctrl.signal);
          if (ctrl.signal.aborted || active !== entry || stopping) throw new Error("Sign-in was cancelled");
          const url = new URL(String(result.authUrl));
          if (!["https://auth.openai.com", "https://chatgpt.com"].includes(url.origin) || typeof result.loginId !== "string") throw new Error("Codex returned an invalid sign-in link");
          entry.loginId = result.loginId;
          entry.timer = setTimeout(() => { if (active === entry && ["waiting", "connecting"].includes(entry.state)) { entry.state = "failed"; entry.error = "Sign-in expired. Start again."; ctrl.abort(new Error("Sign-in expired")); rpc.close(); } }, 10 * 60_000); entry.timer.unref();
          if (entry.earlyNotice) { const notice = entry.earlyNotice; entry.earlyNotice = undefined; completed("account/login/completed", notice); }
          return { id: entry.id, authorizationUrl: url.href };
        } catch (error) { if (active === entry) await releaseActive(); throw error; }
      }).finally(() => pending.delete(ctrl)); starting = work.catch(() => {}); return work;
    },
    status(id: string) { if (!active || active.id !== id) throw new InputError("Sign-in session not found", 404); return { state: active.state, connectionId: active.connectionId, error: active.error }; },
    cancel,
    close: async () => { stopping = true; await cancel(); },
  };
}
