import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_BASE, codexAccount, codexConfigured, codexTokenFresh, createCodexLogin } from "../src/auth/codex.ts";
import { GOOGLE_BASE, createGoogleLogin, forgetGoogleCredentials, googleAccessToken, googleProject, googleSetup, googleTokenNow, saveGoogleCredentials } from "../src/auth/google.ts";
import type { GoogleCredentials } from "../src/auth/google.ts";
import { authenticatedProvider, chatResponse, providerHeaders, providerIdentity, readResponsesStream } from "../src/auth/providers.ts";
import { getProvider, providerConnections, removeProvider, setCredentialStorage, setProvider } from "../src/auth/store.ts";
import { QWEN_PLANS, qwenCredential } from "../src/auth/qwen.ts";

type Json = Record<string, unknown>;
let directory: string;
const previous = process.env.LINUBOT_DATA;
const vault = new Map<string, string>();
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "linubot-oauth-services-"));
  process.env.LINUBOT_DATA = directory;
  vault.clear();
  setCredentialStorage({ load: (id) => vault.get(id) || "", save: (id, value) => { if (value) vault.set(id, value); else vault.delete(id); } });
});
afterEach(() => {
  setCredentialStorage(undefined);
  if (previous === undefined) delete process.env.LINUBOT_DATA; else process.env.LINUBOT_DATA = previous;
  rmSync(directory, { recursive: true, force: true });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail("OAuth operation did not reach the expected state");
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
function jwt(expiresIn: number, account = "fixture-account") {
  return `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresIn, sub: "fixture-user", iss: "https://auth.openai.com", aud: "fixture", "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
}
class FakeCodexRpc {
  calls: { method: string; params: Json }[] = [];
  closed = false;
  notice: (method: string, params: Json) => void = () => {};
  handle: (method: string, params: Json) => Promise<Json> = async (method) => {
    if (method === "account/login/start") return { loginId: "native-login", authUrl: "https://auth.openai.com/authorize?fixture=yes" };
    if (method === "getAuthStatus") return { authMethod: "chatgpt", authToken: jwt(3600) };
    if (method === "model/list") return { data: [{ model: "fixture-small" }, { model: "fixture-default", isDefault: true }] };
    return {};
  };
  request(method: string, params: Json) { this.calls.push({ method, params }); return this.handle(method, params); }
  onNotice(fn: (method: string, params: Json) => void) { this.notice = fn; }
  close() { this.closed = true; }
  complete(success = true, loginId = "native-login") { this.notice("account/login/completed", { loginId, success }); }
}
const googleClient = { clientId: "fixture-client.apps.googleusercontent.com", clientSecret: "fixture-client-secret", projectId: "fixture-project" };
const googleCredentials = (patch: Partial<GoogleCredentials> = {}): GoogleCredentials => ({ ...googleClient, accessToken: "fixture-access-token", refreshToken: "fixture-refresh-token", expiresAt: Date.now() + 3600_000, account: "fixture-google-account", ...patch });
function callbackFor(flow: { id: string; authorizationUrl: string }, code = "fixture-code") {
  const callback = new URL(new URL(flow.authorizationUrl).searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", flow.id); callback.searchParams.set("code", code);
  return callback;
}
const exchangeResult = () => Response.json({ access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", expires_in: 3600 });

describe("Codex native sign-in lifecycle", () => {
  it("connects the existing CLI account, refreshes an expired access token and stores no credential in metadata", async () => {
    const rpc = new FakeCodexRpc(), initial = rpc.handle;
    rpc.handle = async (method, params) => method === "getAuthStatus" ? { authMethod: "chatgpt", authToken: jwt(params.refreshToken ? 3600 : -100) } : initial(method, params);
    const connected: unknown[][] = [];
    const login = createCodexLogin((...args) => { connected.push(args); return "saved-codex"; }, async () => rpc);
    try {
      assert.deepEqual(await login.connectExisting("existing-connection"), { connectionId: "saved-codex" });
      assert.deepEqual(connected, [["existing-connection", "fixture-default"]]);
      assert.deepEqual(rpc.calls.filter((c) => c.method === "getAuthStatus").map((c) => c.params.refreshToken), [false, true]);
      assert.equal(rpc.closed, true); assert.equal(codexConfigured(), true);
      assert.deepEqual(JSON.parse(readFileSync(join(directory, "codex-connection.json"), "utf8")), { connected: true });
      assert.equal(vault.size, 0, "Codex owns credential storage");
      assert.equal(codexAccount(jwt(3600)), "fixture-account"); assert.equal(codexTokenFresh(jwt(-100)), false);
      assert.equal(codexAccount("header.bnVsbA.signature"), "");
      assert.equal(codexTokenFresh(`header.${Buffer.from('{"exp":"Infinity"}').toString("base64url")}.signature`), false);
    } finally { await login.close(); }
  });

  it("refuses a CLI API key and an access token that is still expired after refresh", async () => {
    for (const auth of [{ authMethod: "apikey", authToken: "fixture-api-key" }, { authMethod: "chatgpt", authToken: jwt(-100) }]) {
      const rpc = new FakeCodexRpc(), initial = rpc.handle;
      rpc.handle = async (method, params) => method === "getAuthStatus" ? auth : initial(method, params);
      let connections = 0;
      const login = createCodexLogin(() => { connections++; return "should-not-save"; }, async () => rpc);
      try { await assert.rejects(() => login.connectExisting()); assert.equal(connections, 0); assert.equal(rpc.closed, true); }
      finally { await login.close(); }
    }
  });

  it("accepts only its own completion notice and exposes no native token in status", async () => {
    const rpc = new FakeCodexRpc(); let connections = 0;
    const login = createCodexLogin(() => { connections++; return "codex-linked"; }, async () => rpc);
    try {
      const flow = await login.begin(); assert.equal(new URL(flow.authorizationUrl).origin, "https://auth.openai.com");
      rpc.complete(true, "another-login"); await tick(); assert.equal(login.status(flow.id).state, "waiting"); assert.equal(connections, 0);
      rpc.complete(); await until(() => login.status(flow.id).state === "connected");
      assert.deepEqual(login.status(flow.id), { state: "connected", connectionId: "codex-linked", error: undefined });
      assert.equal(connections, 1); assert.equal(rpc.closed, true);
      assert.doesNotMatch(JSON.stringify(login.status(flow.id)), /authToken|native-login|fixture-user|signature/);
    } finally { await login.close(); }
  });

  it("rejects a foreign authorization URL and sanitizes a denied sign-in", async () => {
    const invalid = new FakeCodexRpc(); invalid.handle = async () => ({ loginId: "native-login", authUrl: "https://auth.openai.com.attacker.example/login" });
    const bad = createCodexLogin(() => { assert.fail("Invalid URL must not connect"); }, async () => invalid);
    try { await assert.rejects(() => bad.begin(), /invalid sign-in link/); assert.equal(invalid.closed, true); } finally { await bad.close(); }
    const rpc = new FakeCodexRpc(), login = createCodexLogin(() => { assert.fail("Denied sign-in must not connect"); }, async () => rpc);
    try {
      const flow = await login.begin(); rpc.complete(false); await until(() => login.status(flow.id).state === "failed");
      assert.match(login.status(flow.id).error!, /could not finish/); assert.equal(codexConfigured(), false);
    } finally { await login.close(); }
  });

  it("cancellation during a delayed model lookup cannot save a late login", async () => {
    const rpc = new FakeCodexRpc(), initial = rpc.handle, gate = deferred<Json>(), started = deferred(); let connected = 0;
    rpc.handle = async (method, params) => { if (method === "model/list") { started.resolve(); return gate.promise; } return initial(method, params); };
    const login = createCodexLogin(() => { connected++; return "late-codex"; }, async () => rpc);
    try {
      const flow = await login.begin(); rpc.complete(); await started.promise;
      await login.cancel(flow.id); gate.resolve({ data: [{ model: "late-model" }] }); await tick();
      assert.equal(connected, 0); assert.equal(codexConfigured(), false); assert.equal(rpc.closed, true);
      assert.ok(rpc.calls.some((c) => c.method === "account/login/cancel" && c.params.loginId === "native-login"));
    } finally { gate.resolve({}); await login.close(); }
  });

  it("processes a native completion notice only once even while model lookup is pending", async () => {
    const rpc = new FakeCodexRpc(), initial = rpc.handle, gate = deferred<Json>(), started = deferred(); let connected = 0;
    rpc.handle = async (method, params) => { if (method === "model/list") { started.resolve(); return gate.promise; } return initial(method, params); };
    const login = createCodexLogin(() => { connected++; return "once-codex"; }, async () => rpc);
    try {
      const flow = await login.begin(); rpc.complete(); await started.promise; rpc.complete();
      gate.resolve({ data: [{ model: "fixture-model" }] }); await until(() => login.status(flow.id).state === "connected"); await tick();
      assert.equal(connected, 1, "Duplicate native notifications must not create duplicate connections");
    } finally { gate.resolve({}); await login.close(); }
  });

  it("retains a completion notice delivered with the native login-start response", async () => {
    const rpc = new FakeCodexRpc(), initial = rpc.handle; let connected = 0;
    rpc.handle = async (method, params) => {
      if (method === "account/login/start") {
        rpc.complete();
        return { loginId: "native-login", authUrl: "https://auth.openai.com/authorize?fixture=yes" };
      }
      return initial(method, params);
    };
    const login = createCodexLogin(() => { connected++; return "early-codex"; }, async () => rpc);
    try {
      const flow = await login.begin(); await until(() => login.status(flow.id).state === "connected");
      assert.equal(connected, 1); assert.equal(login.status(flow.id).connectionId, "early-codex");
    } finally { await login.close(); }
  });

  it("shutdown prevents an existing-account connection still waiting for the native service", async () => {
    const rpc = new FakeCodexRpc(), gate = deferred<typeof rpc>(); let connected = 0;
    const login = createCodexLogin(() => { connected++; return "late-existing"; }, () => gate.promise);
    const connecting = login.connectExisting(); const rejected = assert.rejects(connecting, /cancelled|stopping/);
    await login.close(); gate.resolve(rpc); await rejected;
    assert.equal(connected, 0); assert.equal(rpc.closed, true);
  });

  it("cancels queued sign-in before spawning and closes a native service returned after cancellation", { timeout: 2000 }, async () => {
    let factories = 0;
    const rpc = new FakeCodexRpc(), login = createCodexLogin(() => { assert.fail("Cancelled flow must not connect"); }, async () => { factories++; return rpc; });
    try {
      const begin = login.begin(), rejected = assert.rejects(begin, /cancelled/); await login.cancel(); await rejected; assert.equal(factories, 0);
    } finally { await login.close(); }
    for (const existing of [false, true]) {
      const late = new FakeCodexRpc(), factory = deferred<typeof late>(), entered = deferred(); let signal: AbortSignal | undefined;
      const pending = createCodexLogin(() => { assert.fail("Late service must not connect"); }, async (abort) => { signal = abort; entered.resolve(); return factory.promise; });
      try {
        const begin = existing ? pending.connectExisting() : pending.begin(), rejected = assert.rejects(begin, /cancelled/);
        await entered.promise; await pending.cancel(); assert.equal(signal?.aborted, true); factory.resolve(late); await rejected;
        assert.equal(late.closed, true); assert.equal(late.calls.length, 0);
      } finally { factory.resolve(late); await pending.close(); }
    }
  });

  it("does not return a browser URL when cancellation occurs during native login initialization", { timeout: 2000 }, async () => {
    const rpc = new FakeCodexRpc(), started = deferred(), result = deferred<Json>(); let signal: AbortSignal | undefined;
    rpc.request = async (method, _params, abort?: AbortSignal) => { if (method === "account/login/start") { signal = abort; started.resolve(); return result.promise; } return {}; };
    const login = createCodexLogin(() => { assert.fail("Cancelled initialization must not connect"); }, async () => rpc);
    try {
      const beginning = login.begin(), rejected = assert.rejects(beginning, /cancelled/); await started.promise; await login.cancel(); assert.equal(signal?.aborted, true);
      result.resolve({ loginId: "native-login", authUrl: "https://auth.openai.com/authorize" }); await rejected; assert.equal(rpc.closed, true);
    } finally { result.resolve({}); await login.close(); }
  });

  it("an early completion cannot revive an expired sign-in after delayed model discovery", { timeout: 2000 }, async (t) => {
    const realTimeout = globalThis.setTimeout; let expire: (() => void) | undefined;
    t.mock.method(globalThis, "setTimeout", ((callback: () => void, delay?: number) => { if (delay === 600_000) expire = callback; return realTimeout(callback, delay); }) as typeof setTimeout);
    const rpc = new FakeCodexRpc(), initial = rpc.handle, gate = deferred<Json>(), started = deferred(); let connected = 0;
    rpc.handle = async (method, params) => {
      if (method === "account/login/start") { rpc.complete(); return { loginId: "native-login", authUrl: "https://auth.openai.com/authorize" }; }
      if (method === "model/list") { started.resolve(); return gate.promise; }
      return initial(method, params);
    };
    const login = createCodexLogin(() => { connected++; return "expired-codex"; }, async () => rpc);
    try {
      const flow = await login.begin(); await started.promise; assert.ok(expire); expire(); assert.equal(login.status(flow.id).state, "failed");
      gate.resolve({ data: [{ model: "late-model" }] }); await tick();
      assert.equal(connected, 0); assert.equal(login.status(flow.id).state, "failed"); assert.match(login.status(flow.id).error!, /expired/); assert.equal(rpc.closed, true);
    } finally { gate.resolve({}); await login.close(); }
  });
});

describe("Google browser callback and PKCE", () => {
  it("validates callback state and method, uses PKCE once and keeps tokens out of UI status", async () => {
    const gate = deferred(), started = deferred(); let exchanges = 0, challenge = "", redirect = "", saved: GoogleCredentials | undefined;
    const login = createGoogleLogin((credentials, id) => { saved = credentials; assert.equal(id, "google-existing"); saveGoogleCredentials(id!, credentials); return id!; }, async (url, init) => {
      exchanges++; assert.equal(url, "https://oauth2.googleapis.com/token"); assert.equal(init?.redirect, "error"); assert.equal(init?.method, "POST"); assert.ok(init?.signal);
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("grant_type"), "authorization_code"); assert.equal(body.get("redirect_uri"), redirect); assert.equal(body.get("code"), "fixture-code");
      assert.equal(body.get("client_id"), googleClient.clientId); assert.equal(body.get("client_secret"), googleClient.clientSecret);
      assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), challenge);
      started.resolve(); await gate.promise;
      return Response.json({ access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", expires_in: 3600, id_token: `header.${Buffer.from(JSON.stringify({ aud: googleClient.clientId, sub: "google-subject" })).toString("base64url")}.signature` });
    });
    try {
      const flow = await login.begin(googleClient, "google-existing"), auth = new URL(flow.authorizationUrl), callback = callbackFor(flow);
      assert.equal(auth.origin, "https://accounts.google.com"); assert.equal(auth.searchParams.get("access_type"), "offline"); assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
      redirect = auth.searchParams.get("redirect_uri")!; challenge = auth.searchParams.get("code_challenge")!;
      assert.equal(new URL(redirect).hostname, "127.0.0.1");
      const invalid = new URL(callback); invalid.searchParams.set("state", "é".repeat(flow.id.length));
      assert.equal((await fetch(invalid)).status, 400); assert.equal((await fetch(callback, { method: "POST" })).status, 400); assert.equal(exchanges, 0);
      const completing = fetch(callback); await started.promise;
      assert.equal((await fetch(callback)).status, 409); assert.equal(login.status(flow.id).state, "connecting"); gate.resolve();
      const response = await completing; assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store"); assert.match(response.headers.get("content-security-policy")!, /default-src 'none'/);
      assert.deepEqual(login.status(flow.id), { state: "connected", connectionId: "google-existing", error: undefined }); assert.equal(exchanges, 1);
      assert.equal(saved?.account, createHash("sha256").update("google-subject" + googleClient.clientId + googleClient.projectId).digest("hex"));
      assert.equal(googleTokenNow("google-existing"), "fixture-access-token");
      assert.doesNotMatch(JSON.stringify(login.status(flow.id)) + await response.text() + JSON.stringify(googleSetup("google-existing")), /fixture-(access-token|refresh-token|client-secret|code)|google-subject/);
    } finally { gate.resolve(); await login.close(); }
  });

  it("treats denied consent as a failed session without contacting the token endpoint", async () => {
    let exchanges = 0, connected = 0;
    const login = createGoogleLogin(() => { connected++; return "denied"; }, async () => { exchanges++; return exchangeResult(); });
    try {
      const flow = await login.begin(googleClient), callback = callbackFor(flow); callback.searchParams.set("error", "access_denied"); callback.searchParams.set("error_description", "private-provider-description");
      const response = await fetch(callback); assert.equal(response.status, 400); assert.equal(login.status(flow.id).state, "failed");
      assert.equal(exchanges, 0); assert.equal(connected, 0); assert.doesNotMatch(JSON.stringify(login.status(flow.id)) + await response.text(), /private-provider-description/);
    } finally { await login.close(); }
  });

  it("cancellation aborts the exchange and rejects late credentials even when the transport ignores abort", async () => {
    const gate = deferred(), started = deferred(); let connected = 0, signal: AbortSignal | null | undefined;
    const login = createGoogleLogin(() => { connected++; return "late-google"; }, async (_url, init) => { signal = init?.signal; started.resolve(); await gate.promise; return exchangeResult(); });
    try {
      const flow = await login.begin(googleClient), completing = fetch(callbackFor(flow)).catch(() => null); await started.promise;
      await login.cancel(flow.id); assert.equal(signal?.aborted, true); gate.resolve(); await completing; await tick();
      assert.equal(connected, 0); assert.equal(vault.size, 0);
    } finally { gate.resolve(); await login.close(); }
  });

  it("replaces the previous browser flow so an older callback cannot connect", async () => {
    let connected = 0, exchanges = 0;
    const login = createGoogleLogin(() => { connected++; return "google-new"; }, async () => { exchanges++; return exchangeResult(); });
    try {
      const [first, second] = await Promise.all([login.begin(googleClient), login.begin(googleClient)]);
      assert.notEqual(first.id, second.id); assert.notEqual(new URL(first.authorizationUrl).searchParams.get("code_challenge"), new URL(second.authorizationUrl).searchParams.get("code_challenge"));
      await assert.rejects(() => fetch(callbackFor(first))); assert.equal(exchanges, 0);
      assert.equal((await fetch(callbackFor(second))).status, 200); assert.equal(connected, 1);
    } finally { await login.close(); }
  });

  it("rejects malformed or oversized token bodies without exposing provider errors or saving credentials", async () => {
    const responses = [
      () => Response.json({ access_token: "bad\r\nheader", refresh_token: "fixture-refresh", expires_in: 3600 }),
      () => Response.json({ access_token: "fixture-access", expires_in: 3600 }),
      () => new Response("private-provider-token", { status: 400 }),
      () => new Response("private-provider-token"),
      () => new Response("oversized", { headers: { "content-length": String(2 * 1024 * 1024 + 1) } }),
    ];
    for (const response of responses) {
      let connected = 0;
      const login = createGoogleLogin(() => { connected++; return "invalid-google"; }, async () => response());
      try {
        const flow = await login.begin(googleClient), result = await fetch(callbackFor(flow));
        assert.equal(result.status, 400); assert.equal(login.status(flow.id).state, "failed"); assert.equal(connected, 0);
        assert.doesNotMatch(JSON.stringify(login.status(flow.id)) + await result.text(), /private-provider-token|bad|fixture-refresh/);
      } finally { await login.close(); }
    }
  });

  it("validates desktop client and project fields before opening a browser flow", async () => {
    const login = createGoogleLogin(() => { assert.fail("Invalid configuration must not connect"); }, async () => { assert.fail("Invalid configuration must not send a request"); });
    try {
      await assert.rejects(() => login.begin({ ...googleClient, clientId: "https://foreign.example/client" }), /Desktop OAuth client/);
      await assert.rejects(() => login.begin({ ...googleClient, clientSecret: "secret\nheader" }), /Desktop OAuth client/);
      await assert.rejects(() => login.begin({ ...googleClient, projectId: "project/foreign" }), /project ID/);
      await assert.rejects(() => login.begin({ ...googleClient, clientSecret: 123 } as unknown as typeof googleClient), /must be text/);
    } finally { await login.close(); }
  });

  it("cancels Google startup before a callback listener opens or finishes binding", { timeout: 2000 }, async (t) => {
    const login = createGoogleLogin(() => { assert.fail("Cancelled Google startup must not connect"); });
    try {
      const queued = login.begin(googleClient), rejected = assert.rejects(queued, /cancelled/); await login.cancel(); await rejected;
    } finally { await login.close(); }
    const listening = deferred(); let signal: AbortSignal | undefined;
    t.mock.method(Server.prototype, "listen", function (this: Server, options: { signal?: AbortSignal }) { signal = options.signal; listening.resolve(); return this; } as typeof Server.prototype.listen);
    const pending = createGoogleLogin(() => { assert.fail("Cancelled bind must not connect"); });
    try {
      const beginning = pending.begin(googleClient), rejected = assert.rejects(beginning, /cancelled/); await listening.promise;
      await pending.cancel(); await rejected; assert.equal(signal?.aborted, true);
    } finally { await pending.close(); }
  });
});

describe("Google refresh and OAuth transport boundaries", () => {
  it("uses fresh saved credentials and coalesces refreshes without losing the refresh token", async () => {
    saveGoogleCredentials("google-one", googleCredentials());
    assert.equal((await googleAccessToken("google-one", undefined, async () => { assert.fail("Fresh credentials must not refresh"); })).accessToken, "fixture-access-token");
    saveGoogleCredentials("google-one", googleCredentials({ expiresAt: Date.now() - 1000 }));
    const gate = deferred(), started = deferred(); let requests = 0;
    const request: typeof fetch = async (url, init) => {
      requests++; assert.equal(url, "https://oauth2.googleapis.com/token"); assert.equal(init?.redirect, "error"); assert.equal(init?.method, "POST"); assert.ok(init?.signal);
      const form = new URLSearchParams(String(init?.body)); assert.equal(form.get("grant_type"), "refresh_token"); assert.equal(form.get("refresh_token"), "fixture-refresh-token");
      assert.equal(form.get("client_secret"), googleClient.clientSecret); started.resolve(); await gate.promise;
      return Response.json({ access_token: "fixture-refreshed", expires_in: 3600 });
    };
    const first = googleAccessToken("google-one", undefined, request); await started.promise;
    const second = googleAccessToken("google-one", undefined, request); gate.resolve();
    const values = await Promise.all([first, second]);
    assert.equal(requests, 1); assert.deepEqual(values[0], values[1]); assert.equal(values[0].refreshToken, "fixture-refresh-token"); assert.equal(googleTokenNow("google-one"), "fixture-refreshed");
    assert.equal(JSON.parse(vault.get("oauth:google:google-one")!).accessToken, "fixture-refreshed");
  });

  it("allows one caller to cancel without cancelling another caller's shared refresh", async () => {
    saveGoogleCredentials("google-shared", googleCredentials({ expiresAt: 0 }));
    const gate = deferred(), started = deferred(), ctrl = new AbortController(); let requests = 0;
    const request: typeof fetch = async () => { requests++; started.resolve(); await gate.promise; return exchangeResult(); };
    const first = googleAccessToken("google-shared", ctrl.signal, request), rejected = assert.rejects(first, /caller cancelled/);
    await started.promise; const second = googleAccessToken("google-shared", undefined, request); ctrl.abort(new Error("caller cancelled")); await rejected;
    gate.resolve(); assert.equal((await second).accessToken, "fixture-access-token"); assert.equal(requests, 1);
  });

  it("cannot restore a disconnected account or overwrite a new account after an old refresh resolves", async () => {
    for (const replace of [false, true]) {
      const id = replace ? "google-replaced" : "google-forgotten";
      saveGoogleCredentials(id, googleCredentials({ expiresAt: 0 }));
      const gate = deferred(), started = deferred();
      const refreshing = googleAccessToken(id, undefined, async () => { started.resolve(); await gate.promise; return exchangeResult(); });
      const rejected = assert.rejects(refreshing, /changed during refresh/); await started.promise;
      if (replace) saveGoogleCredentials(id, googleCredentials({ accessToken: "new-account-token", account: "new-account" })); else forgetGoogleCredentials(id);
      gate.resolve(); await rejected;
      assert.equal(googleTokenNow(id), replace ? "new-account-token" : "");
      assert.equal(vault.has(`oauth:google:${id}`), replace);
    }
  });

  it("fails an invalid refresh, preserves the existing credential and permits a later retry", async () => {
    saveGoogleCredentials("google-retry", googleCredentials({ expiresAt: 0 }));
    await assert.rejects(() => googleAccessToken("google-retry", undefined, async () => Response.json({ access_token: "broken", expires_in: 0 })), /invalid refresh response/);
    assert.equal(googleTokenNow("google-retry"), "fixture-access-token");
    assert.equal((await googleAccessToken("google-retry", undefined, async () => exchangeResult())).accessToken, "fixture-access-token");
    await assert.rejects(() => googleAccessToken(undefined), /Connect Google/);
    await assert.rejects(() => googleAccessToken("missing-account"), /Sign in to Google/);
  });

  it("rejects oversized or malformed refresh credentials without replacing the stored account", async () => {
    saveGoogleCredentials("google-bounded", googleCredentials({ expiresAt: 0 }));
    const malformed = [null, { access_token: "x".repeat(10001), expires_in: 3600 }, { access_token: "new-token", refresh_token: "x".repeat(10001), expires_in: 3600 }, { access_token: "new-token", refresh_token: 123, expires_in: 3600 }, { access_token: "new-token", refresh_token: "bad\nrefresh", expires_in: 3600 }];
    for (const data of malformed) {
      await assert.rejects(() => googleAccessToken("google-bounded", undefined, async () => Response.json(data)), /invalid refresh response/);
      assert.equal(googleTokenNow("google-bounded"), "fixture-access-token");
    }
    await assert.rejects(() => googleAccessToken("google-bounded", undefined, async () => new Response("oversized", { headers: { "content-length": "65537" } })), /too large/);
    const ctrl = new AbortController(); ctrl.abort(new Error("already cancelled"));
    await assert.rejects(() => googleAccessToken("google-bounded", ctrl.signal, async () => { assert.fail("An already cancelled request must not start a refresh"); }), /already cancelled/);
  });

  it("binds native credentials to their owned endpoints and rejects a changed Google account", async () => {
    const codex = { kind: "openai-codex" as const, baseUrl: CODEX_BASE, apiKey: jwt(3600), model: "fixture-model" };
    assert.equal((await authenticatedProvider(codex)).apiKey, codex.apiKey);
    assert.equal(providerHeaders(codex)["ChatGPT-Account-Id"], "fixture-account");
    await assert.rejects(() => authenticatedProvider({ ...codex, baseUrl: "https://foreign.example/v1" }), /restricted to the Codex endpoint/);
    saveGoogleCredentials("google-owned", googleCredentials());
    const google = { kind: "google-oauth" as const, id: "google-owned", baseUrl: GOOGLE_BASE, apiKey: "", model: "fixture-gemini" };
    const authenticated = await authenticatedProvider(google);
    assert.equal(providerHeaders(authenticated).authorization, "Bearer fixture-access-token"); assert.equal(providerHeaders(authenticated)["x-goog-user-project"], googleClient.projectId); assert.equal(googleProject(google.id), googleClient.projectId);
    await assert.rejects(() => authenticatedProvider({ ...google, baseUrl: "https://foreign.example/v1" }), /restricted to the Gemini API endpoint/);
    await assert.rejects(() => authenticatedProvider({ ...google, accountIdentity: "another-account" }), /account changed/);
    assert.equal(providerIdentity(authenticated), providerIdentity({ ...authenticated, apiKey: "rotated-access-token" }));
    assert.notEqual(providerIdentity(authenticated), providerIdentity({ ...authenticated, accountIdentity: "other-account" }));
    assert.notEqual(providerIdentity(codex), providerIdentity({ ...codex, apiKey: jwt(3600, "different-chatgpt-account") }));
  });

  it("keeps Google connections separate, omits secrets from the registry and forgets only the removed account", () => {
    const first = setProvider({ newConnection: true, name: "Google One", kind: "google-oauth", baseUrl: GOOGLE_BASE, model: "fixture-gemini" });
    const second = setProvider({ newConnection: true, name: "Google Two", kind: "google-oauth", baseUrl: GOOGLE_BASE, model: "fixture-gemini" });
    saveGoogleCredentials(first.id!, googleCredentials());
    saveGoogleCredentials(second.id!, googleCredentials({ accessToken: "second-access-token", account: "second-account" }));
    assert.equal(getProvider(first.id).apiKey, "fixture-access-token"); assert.equal(getProvider(second.id).apiKey, "second-access-token");
    assert.doesNotMatch(JSON.stringify(providerConnections()) + readFileSync(join(directory, "providers.json"), "utf8"), /fixture-(access-token|refresh-token|client-secret)|second-access-token/);
    removeProvider(first.id!); assert.equal(googleTokenNow(first.id), ""); assert.equal(getProvider(second.id).apiKey, "second-access-token");
    assert.equal(vault.has(`oauth:google:${first.id}`), false); assert.equal(vault.has(`oauth:google:${second.id}`), true);
  });

  it("reads a completed Codex SSE response across chunks and rejects incomplete or oversized events", async () => {
    const response = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "STREAM_OK" }] }] };
    const wire = `data: {"type":"response.created"}\r\n\r\ndata: ${JSON.stringify({ type: "response.completed", response })}\r\n\r\n`;
    const bytes = new TextEncoder().encode(wire); let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice(0, 17)); controller.enqueue(bytes.slice(17, 71)); controller.enqueue(bytes.slice(71)); }, cancel() { cancelled = true; } });
    assert.deepEqual(await readResponsesStream(new Response(stream)), response); assert.equal(cancelled, true);
    await assert.rejects(() => readResponsesStream(new Response("data: {\"type\":\"response.created\"}\n\n")), /ended before a completed response/);
    await assert.rejects(() => readResponsesStream(new Response("data: " + "x".repeat(4 * 1024 * 1024 + 1))), /event exceeded its limit/);
    await assert.rejects(() => readResponsesStream(new Response("data: private-malformed-event\n\n")), /invalid stream event/);
  });

  it("accepts the Codex streaming transport when a successful response omits Content-Type", async (t) => {
    const codex = { kind: "openai-codex" as const, baseUrl: CODEX_BASE, apiKey: jwt(3600), model: "fixture-codex" };
    t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(url, `${CODEX_BASE}/responses`); assert.equal(JSON.parse(String(init?.body)).stream, true);
      const response = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "MISSING_MIME_STREAM_OK" }] }] };
      const result = new Response(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`));
      assert.equal(result.headers.has("content-type"), false); return result;
    });
    const result = await chatResponse(codex, [{ role: "user", content: "Reply with the fixture" }]);
    assert.equal(result.text, "MISSING_MIME_STREAM_OK");
  });

  it("recovers completed text, reasoning and ordered tool calls from item events when the terminal output is empty", async (t) => {
    const reasoning = { type: "reasoning", encrypted_content: "fixture-private-reasoning", summary: [] };
    const message = { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Reading both fixtures." }] };
    const first = { type: "function_call", call_id: "fixture-first", name: "read_fixture", arguments: '{"path":"first"}' };
    const second = { type: "function_call", call_id: "fixture-second", name: "read_fixture", arguments: '{"path":"second"}' };
    const terminal = { status: "completed", output: [], usage: { input_tokens: 123, output_tokens: 45 } };
    const events = [
      { type: "response.created", response: { status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 2, item: { ...first, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 2, delta: '{"path":' },
      { type: "response.output_item.done", output_index: 3, item: second },
      { type: "response.output_item.done", output_index: 2, item: first },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      { type: "response.output_item.done", output_index: 2, item: first },
      { type: "response.output_item.done", output_index: 1, item: message },
      { type: "response.completed", response: terminal },
    ];
    t.mock.method(globalThis, "fetch", async () => new Response(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))));
    const result = await chatResponse({ kind: "openai-codex", baseUrl: CODEX_BASE, apiKey: jwt(3600), model: "fixture-codex" }, [{ role: "user", content: "Read both fixtures" }]);
    assert.equal(result.text, "Reading both fixtures."); assert.equal(result.finishReason, "completed"); assert.deepEqual(result.usage, { input: 123, output: 45 });
    assert.deepEqual(result.toolCalls, [{ id: first.call_id, name: first.name, arguments: first.arguments }, { id: second.call_id, name: second.name, arguments: second.arguments }]);
    assert.deepEqual(result.providerItems?.items, [reasoning, message, first, second]); assert.equal(result.providerItems?.tokens, 45);
    assert.doesNotMatch(result.text, /fixture-private-reasoning/);
  });

  it("never converts an incomplete or failed terminal event into a successful item fallback", async (t) => {
    let terminal: Record<string, unknown> = {};
    const item = { type: "message", content: [{ type: "output_text", text: "Partial answer that must not be accepted" }] };
    t.mock.method(globalThis, "fetch", async () => new Response(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\ndata: ${JSON.stringify(terminal)}\n\n`)));
    const cfg = { kind: "openai-codex" as const, baseUrl: CODEX_BASE, apiKey: jwt(3600), model: "fixture-codex" };
    for (const status of ["incomplete", "failed"]) {
      terminal = { type: `response.${status}`, response: { status, output: [], usage: { input_tokens: 12, output_tokens: 3 } } };
      await assert.rejects(() => chatResponse(cfg, [{ role: "user", content: "Complete the fixture" }]), new RegExp(`Provider response ${status}`));
      terminal = { type: `response.${status}`, response: { output: [] } };
      await assert.rejects(() => chatResponse(cfg, [{ role: "user", content: "Complete the fixture" }]), /incomplete|failed|invalid/i);
    }
  });

  it("keeps canonical terminal output authoritative over earlier completed item events", async () => {
    const previous = { type: "message", content: [{ type: "output_text", text: "Earlier completed item" }] };
    const terminal = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Canonical terminal output" }] }], usage: { input_tokens: 5, output_tokens: 9 } };
    const stream = `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: previous })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: terminal })}\n\n`;
    assert.deepEqual(await readResponsesStream(new Response(stream)), terminal);
  });

  it("accepts at most 1024 indexed completed items and rejects overflow instead of returning partial output", async () => {
    const items = Array.from({ length: 1024 }, (_, index) => ({ type: "reasoning", id: `fixture-item-${index}`, summary: [] }));
    const prefix = items.map((item, output_index) => `data: ${JSON.stringify({ type: "response.output_item.done", output_index, item })}\n\n`).join("");
    const terminal = `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`;
    const result = await readResponsesStream(new Response(prefix + terminal)) as { output: unknown[] };
    assert.deepEqual(result.output, items);
    const extra = `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 1024, item: { type: "function_call", call_id: "must-not-drop", name: "read_fixture", arguments: "{}" } })}\n\n`;
    await assert.rejects(() => readResponsesStream(new Response(prefix + extra + terminal)), /limit|index|too many|invalid/i);
  });

  it("sends Codex Responses and Gemini Chat requests with the native authentication contract", async () => {
    const codex = { kind: "openai-codex" as const, baseUrl: CODEX_BASE, apiKey: jwt(3600), model: "fixture-codex" };
    const messages = [{ role: "system", content: "Use tools when needed" }, { role: "user", content: "Find the fixture" }];
    const tools = [{ name: "read_fixture", description: "Read a fixture", parameters: { type: "object", properties: {}, additionalProperties: false } }];
    const first = await chatResponse(codex, messages, tools, async (url, init) => {
      assert.equal(url, `${CODEX_BASE}/responses`); assert.equal(init.headers.authorization, `Bearer ${codex.apiKey}`); assert.equal(init.headers["ChatGPT-Account-Id"], "fixture-account");
      const body = JSON.parse(init.body);
      assert.equal(body.stream, true); assert.equal(body.store, false); assert.equal(body.instructions, messages[0].content); assert.equal(body.max_output_tokens, undefined);
      assert.deepEqual(body.include, ["reasoning.encrypted_content"]); assert.equal(body.tools[0].name, "read_fixture"); assert.equal(body.tools[0].strict, false);
      return { ok: true, status: 200, json: async () => ({ status: "completed", output: [{ type: "function_call", call_id: "native-call", name: "read_fixture", arguments: "{}" }] }) };
    });
    assert.deepEqual(first.toolCalls, [{ id: "native-call", name: "read_fixture", arguments: "{}" }]);
    saveGoogleCredentials("google-chat", googleCredentials());
    const google = { kind: "google-oauth" as const, id: "google-chat", baseUrl: GOOGLE_BASE, apiKey: "", model: "fixture-gemini" };
    const second = await chatResponse(google, messages, tools, async (url, init) => {
      assert.equal(url, `${GOOGLE_BASE}/chat/completions`); assert.equal(init.headers.authorization, "Bearer fixture-access-token"); assert.equal(init.headers["x-goog-user-project"], "fixture-project");
      const body = JSON.parse(init.body); assert.equal(body.messages[0].role, "system"); assert.equal(body.tools[0].function.name, "read_fixture");
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "GEMINI_FIXTURE_OK" } }] }) };
    });
    assert.equal(second.text, "GEMINI_FIXTURE_OK");
  });
});

describe("Qwen plan credential import", () => {
  it("imports only a supported matching plan and ignores malformed model records", () => {
    const config = join(directory, ".qwen", "settings.json"); mkdirSync(join(directory, ".qwen"));
    for (const [base, envKey] of Object.entries(QWEN_PLANS)) {
      const previousKey = process.env[envKey]; delete process.env[envKey];
      try {
        writeFileSync(config, JSON.stringify({ env: { [envKey]: "fixture-plan-key" }, model: { name: "chosen-model" }, modelProviders: { openai: [null, false, { baseUrl: 123 }, { baseUrl: base, envKey, id: "" }, { baseUrl: base, envKey, id: "first-model" }, { baseUrl: `${base}/`, envKey, id: "chosen-model" }] } }));
        assert.deepEqual(qwenCredential(base, directory), { key: "fixture-plan-key", model: "chosen-model" });
        const other = Object.keys(QWEN_PLANS).find((value) => value !== base)!;
        assert.throws(() => qwenCredential(other, directory), /Configure this plan/);
      } finally { if (previousKey === undefined) delete process.env[envKey]; else process.env[envKey] = previousKey; }
    }
  });

  it("rejects invalid settings, inherited endpoint names and symlinks without reading another file", () => {
    const config = join(directory, ".qwen", "settings.json"), base = Object.keys(QWEN_PLANS)[0]; mkdirSync(join(directory, ".qwen"));
    for (const content of ["null", "[]", "1", "broken-json", '{"modelProviders":{"openai":[null,{"baseUrl":3}]}}', '{"modelProviders":{"openai":null}}']) {
      writeFileSync(config, content); assert.throws(() => qwenCredential(base, directory), /No supported Qwen|Configure this plan/);
    }
    assert.throws(() => qwenCredential("toString", directory), /Choose a Qwen/);
    const other = join(directory, "private-fixture.json"); writeFileSync(other, "private-fixture"); rmSync(config); symlinkSync(other, config);
    assert.throws(() => qwenCredential(base, directory), /No supported Qwen/); assert.equal(readFileSync(other, "utf8"), "private-fixture");
  });
});
