import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTiyuvtaLogin } from "../src/auth/tiyuvta.ts";
import { preselectCatalogModel } from "../src/auth/catalog.ts";
import { getProvider, providerConnections, providerStatus, setCredentialStorage, setProvider } from "../src/auth/store.ts";

let directory: string;
const previous = process.env.LINUBOT_DATA;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "linubot-signin-test-")); process.env.LINUBOT_DATA = directory; });
afterEach(() => {
  setCredentialStorage(undefined);
  if (previous === undefined) delete process.env.LINUBOT_DATA; else process.env.LINUBOT_DATA = previous;
  rmSync(directory, { recursive: true, force: true });
});
const models = [{ id: "a-EMBED" }, { id: "b-Reranker" }, { id: "c-chat" }, { id: "d-chat" }];
const fixture: typeof fetch = async (url) => String(url).endsWith("/models")
  ? Response.json({ data: models }) : Response.json({ key: "fixture-private-key", label: "Linubot", prefix: "fixture" });
function callback(flow: { authorizationUrl: string; id: string }) {
  const url = new URL(new URL(flow.authorizationUrl).searchParams.get("callback_url")!);
  url.searchParams.set("state", flow.id); url.searchParams.set("code", "one-time-code");
  return url;
}

it("preselects the first non-embedding, non-reranking model in catalog order", () => {
  assert.equal(preselectCatalogModel(models), "c-chat");
  assert.equal(preselectCatalogModel([{ id: "z-chat" }, { id: "a-chat" }]), "z-chat");
  assert.equal(preselectCatalogModel(models.slice(0, 2)), "");
  assert.equal(preselectCatalogModel([]), "");
});

describe("Tiyuvta browser callback", () => {
  it("uses the authorization contract, validates state and PKCE, and saves the first chat model", async () => {
    let challenge = "", exchanges = 0, catalogs = 0, focused = "";
    const login = createTiyuvtaLogin({ connected: (id) => { focused = id; }, request: async (url, init) => {
      assert.equal(init?.redirect, "error");
      if (String(url).endsWith("/models")) {
        catalogs++; assert.equal(url, "https://api.tiyuvta.ai/v1/models"); assert.equal(init?.method, "GET");
        assert.equal(new Headers(init?.headers).has("authorization"), false);
      } else {
        exchanges++; assert.equal(url, "https://inference.tiyuvta.ai/api/connect/exchange"); assert.equal(init?.method, "POST");
        assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(Object.keys(body).sort(), ["code", "code_verifier"]); assert.equal(body.code, "one-time-code");
        assert.equal(createHash("sha256").update(body.code_verifier).digest("base64url"), challenge);
      }
      return fixture(url, init);
    } });
    try {
      const flow = await login.begin(), authorize = new URL(flow.authorizationUrl);
      assert.equal(authorize.origin + authorize.pathname, "https://inference.tiyuvta.ai/app/connect");
      assert.equal(authorize.searchParams.get("app"), "linubot"); assert.equal(authorize.searchParams.get("state"), flow.id);
      assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
      challenge = authorize.searchParams.get("code_challenge")!; assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
      const loopback = new URL(authorize.searchParams.get("callback_url")!);
      assert.equal(loopback.hostname, "127.0.0.1"); assert.equal(loopback.protocol, "http:");
      assert.equal(loopback.pathname, "/callback"); assert.equal(loopback.search, ""); assert.ok(Number(loopback.port) > 0);
      assert.equal(flow.expiresIn, 600); assert.equal(login.status(flow.id).state, "waiting");
      const invalid = callback(flow); invalid.searchParams.set("state", "x".repeat(flow.id.length - 1) + "é");
      assert.equal((await fetch(invalid)).status, 400); assert.equal(exchanges, 0);
      assert.equal((await fetch(callback(flow))).status, 200);
      const state = login.status(flow.id), saved = getProvider(state.connectionId);
      assert.equal(state.state, "connected"); assert.equal(exchanges, 1); assert.equal(catalogs, 1);
      assert.equal(saved.name, "Tiyuvta"); assert.equal(saved.apiKey, "fixture-private-key"); assert.equal(saved.model, "c-chat");
      assert.equal(saved.baseUrl, "https://api.tiyuvta.ai/v1"); assert.equal(saved.auth, "bearer");
      assert.equal(getProvider().id, saved.id); assert.equal(focused, saved.id);
      assert.equal(providerStatus(saved.id).rememberKey, false);
      assert.doesNotMatch(JSON.stringify(state) + readFileSync(join(directory, "providers.json"), "utf8"), /fixture-private-key/);
    } finally { await login.close(); }
  });

  it("updates the chosen connection, retains its model, and remembers the key when storage exists", async () => {
    const keys = new Map<string, string>();
    setCredentialStorage({ load: (id) => keys.get(id) || "", save: (id, key) => { keys.set(id, key); } });
    const other = setProvider({ name: "Other", kind: "openai-compat", baseUrl: "https://example.com/v1", model: "other-chat", apiKey: "other-key" });
    const original = setProvider({ newConnection: true, name: "Tiyuvta work", kind: "openai-compat", baseUrl: "https://api.tiyuvta.ai/v1", model: "chosen-chat", apiKey: "old-key" });
    const login = createTiyuvtaLogin({ request: fixture });
    try {
      const flow = await login.begin(original.id); assert.equal((await fetch(callback(flow))).status, 200);
      assert.equal(login.status(flow.id).connectionId, original.id); assert.equal(providerConnections().connections.length, 2);
      assert.equal(getProvider(original.id).model, "chosen-chat"); assert.equal(getProvider(original.id).apiKey, "fixture-private-key");
      assert.equal(getProvider().id, other.id); assert.equal(providerStatus(original.id).rememberKey, true);
      assert.ok([...keys.values()].includes("fixture-private-key"));
    } finally { await login.close(); }
  });

  it("saves the key with an empty model when the catalog fails", async () => {
    const login = createTiyuvtaLogin({ request: async (url, init) => String(url).endsWith("/models") ? new Response("unavailable", { status: 503 }) : fixture(url, init) });
    try {
      const flow = await login.begin(); assert.equal((await fetch(callback(flow))).status, 200);
      const id = login.status(flow.id).connectionId;
      assert.equal(getProvider(id).apiKey, "fixture-private-key"); assert.equal(getProvider(id).model, "");
      assert.equal(providerStatus(id).ready, false);
    } finally { await login.close(); }
  });

  it("reports a declined callback clearly without exchanging or saving", async () => {
    const login = createTiyuvtaLogin({ request: async () => { assert.fail("Must not exchange a declined callback"); } });
    try {
      const flow = await login.begin(), url = callback(flow); url.searchParams.delete("code"); url.searchParams.set("error", "access_denied");
      assert.equal((await fetch(url)).status, 400); assert.equal(login.status(flow.id).state, "failed");
      assert.equal(login.status(flow.id).error, "Sign-in was declined or did not return a code.");
      assert.equal(providerConnections().connections.length, 1);
    } finally { await login.close(); }
  });

  it("surfaces the console exchange message verbatim", async () => {
    const message = "Connect is not available for this account. Contact support.";
    const login = createTiyuvtaLogin({ request: async () => Response.json({ error: "access_denied", message }, { status: 403 }) });
    try {
      const flow = await login.begin(); assert.equal((await fetch(callback(flow))).status, 400);
      assert.equal(login.status(flow.id).state, "failed"); assert.equal(login.status(flow.id).error, message);
      assert.equal(providerConnections().connections.length, 1);
    } finally { await login.close(); }
  });

  it("expires after ten minutes", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const login = createTiyuvtaLogin({ request: fixture });
    try {
      const flow = await login.begin(); t.mock.timers.tick(600_000);
      assert.equal(login.status(flow.id).state, "failed"); assert.equal(login.status(flow.id).error, "Sign-in expired. Start again.");
      assert.equal(providerConnections().connections.length, 1);
    } finally { await login.close(); t.mock.timers.reset(); }
  });

  it("rejects a repeated callback and cancellation prevents a late catalog from saving", async () => {
    let release!: () => void, ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
    const login = createTiyuvtaLogin({ request: async (url, init) => {
      if (String(url).endsWith("/models")) { ready(); await gate; }
      return fixture(url, init);
    } });
    try {
      const flow = await login.begin(), url = callback(flow), completing = fetch(url).catch(() => null); await started;
      assert.equal((await fetch(url)).status, 409); await login.cancel(flow.id); release(); await completing;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(login.status(flow.id).state, "cancelled"); assert.equal(providerConnections().connections.length, 1);
    } finally { release?.(); await login.close(); }
  });

  it("rejects a different provider and closes pending listeners on shutdown", async () => {
    const original = setProvider({ kind: "openai-compat", baseUrl: "https://example.com/v1", model: "chat" });
    const login = createTiyuvtaLogin({ request: fixture });
    try {
      await assert.rejects(login.begin(original.id), /Choose a Tiyuvta connection/);
      const flow = await login.begin(); await login.close(); assert.equal(login.status(flow.id).state, "cancelled");
      await assert.rejects(fetch(callback(flow))); await assert.rejects(login.begin(), /stopping/);
    } finally { await login.close(); }
  });
});
