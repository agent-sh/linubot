import { after, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveXaiSession, xaiStatus, disconnectXai, xaiAccessToken } from "../src/auth/xai.ts";
import { chatResponse } from "../src/auth/providers.ts";
import { setProvider } from "../src/auth/store.ts";

const directory = mkdtempSync(join(tmpdir(), "linubot-xai-"));
process.env.LINUBOT_DATA = directory;
after(() => rmSync(directory, { recursive: true, force: true }));

it("uses Responses tool IDs, images and usage without writing OAuth secrets to metadata", async () => {
  saveXaiSession({ access_token: "test-access-secret", refresh_token: "test-refresh-secret" });
  const provider = setProvider({ kind: "xai-oauth", baseUrl: "https://api.x.ai/v1", model: "grok-4.6" });
  assert.equal(xaiStatus().connected, true);
  assert.doesNotMatch(readFileSync(join(directory, "xai-oauth.json"), "utf8"), /test-access|test-refresh/);
  let payload: Record<string, any> = {};
  const result = await chatResponse(provider, [
    { role: "system", content: "Use evidence" },
    { role: "assistant", content: "", toolCalls: [{ id: "call-original", name: "observe", arguments: "{}" }] },
    { role: "tool", toolCallId: "call-original", content: "observed" },
    { role: "user", content: "Screenshot", images: [{ mimeType: "image/png", data: "aW1hZ2U=" }] },
  ], [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }], async (url, request) => {
    assert.equal(url, "https://api.x.ai/v1/responses"); assert.equal(request.headers.authorization, "Bearer test-access-secret");
    payload = JSON.parse(request.body);
    return { ok: true, status: 200, json: async () => ({ status: "completed", output: [{ type: "function_call", id: "item-1", call_id: "call-next", name: "read", arguments: "{}" }], usage: { input_tokens: 12, output_tokens: 4 } }) };
  });
  assert.equal(payload.instructions, "Use evidence"); assert.equal(payload.input[1].call_id, "call-original"); assert.equal(payload.input[2].content[1].type, "input_image");
  assert.equal(payload.tools[0].name, "read"); assert.equal(result.toolCalls[0].id, "call-next"); assert.deepEqual(result.usage, { input: 12, output: 4 });
  assert.throws(() => setProvider({ kind: "xai-oauth", baseUrl: "https://other.example" }), /xAI OAuth/);
  disconnectXai(); assert.equal(xaiStatus().connected, false);
});

const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
it("a delayed OAuth refresh cannot sign back in after disconnect", async (t) => {
  saveXaiSession({ access_token: expired, refresh_token: "refresh" });
  let release!: (value: unknown) => void;
  t.mock.method(globalThis, "fetch", () => new Promise((resolve) => { release = resolve; }));
  const refreshing = xaiAccessToken();
  disconnectXai();
  release({ status: 200, text: async () => JSON.stringify({ access_token: "late-secret" }) });
  await assert.rejects(refreshing, /sign-in changed/);
  assert.equal(xaiStatus().connected, false);
});

it("OAuth refresh waiters cancel independently while sharing one exchange", async (t) => {
  saveXaiSession({ access_token: expired, refresh_token: "refresh" });
  let release!: (value: unknown) => void;
  let exchanges = 0;
  t.mock.method(globalThis, "fetch", () => { exchanges++; return new Promise((resolve) => { release = resolve; }); });
  const first = new AbortController(); const second = new AbortController();
  const a = xaiAccessToken(first.signal); const b = xaiAccessToken(second.signal);
  second.abort(new Error("second cancelled")); await assert.rejects(b, /second cancelled/);
  const c = xaiAccessToken(); first.abort(new Error("first cancelled")); await assert.rejects(a, /first cancelled/);
  release({ status: 200, text: async () => JSON.stringify({ access_token: "fresh-token" }) });
  assert.equal(await c, "fresh-token"); assert.equal(exchanges, 1); disconnectXai();
});
