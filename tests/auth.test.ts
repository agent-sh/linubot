import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchFn, ProviderConfig } from "../src/auth/providers.ts";

const { candidateMachineConfigs, chatComplete, readMachineKey } =
  await import("../src/auth/providers.ts");

function stub(seen: { url: string; init: { headers: Record<string, string>; body: string } }[], payload: unknown): FetchFn {
  return async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, json: async () => payload };
  };
}

const msgs = [{ role: "user", content: "hi" }];

describe("auth v2", () => {
  it("openai-compat posts bearer chat completions", async () => {
    const seen: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
    const cfg: ProviderConfig = { kind: "openai-compat", baseUrl: "https://x/v1/", apiKey: "k", model: "m" };
    assert.equal(await chatComplete(cfg, msgs, stub(seen, { choices: [{ message: { content: "yo" } }] })), "yo");
    assert.equal(seen[0].url, "https://x/v1/chat/completions");
    assert.equal(seen[0].init.headers.authorization, "Bearer k");
  });

  it("anthropic splits system out with x-api-key", async () => {
    const seen: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
    const cfg: ProviderConfig = { kind: "anthropic", baseUrl: "https://a", apiKey: "k", model: "m" };
    const text = await chatComplete(cfg, [{ role: "system", content: "terse" }, ...msgs], stub(seen, { content: [{ text: "ok" }] }));
    assert.equal(text, "ok");
    const b = JSON.parse(seen[0].init.body) as { system: string; messages: unknown[] };
    assert.equal(b.system, "terse");
    assert.equal(b.messages.length, 1);
  });

  it("converse posts bedrock shape", async () => {
    const seen: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
    const cfg: ProviderConfig = { kind: "converse", baseUrl: "https://b", apiKey: "k", model: "m" };
    const text = await chatComplete(cfg, msgs, stub(seen, { output: { message: { content: [{ text: "done" }] } } }));
    assert.equal(text, "done");
    assert.equal(seen[0].url, "https://b/model/m/converse");
  });

  it("refuses without key, surfaces http errors", async () => {
    const cfg: ProviderConfig = { kind: "openai-compat", baseUrl: "https://x", apiKey: "", model: "m" };
    await assert.rejects(() => chatComplete(cfg, msgs, stub([], {})), /missing api key/i);
    const bad: FetchFn = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await assert.rejects(() => chatComplete({ ...cfg, apiKey: "k" }, msgs, bad), /HTTP 401/i);
  });

  it("machine reads need approval and only listed candidate files", (t) => {
    const home = mkdtempSync(join(tmpdir(), "linubot-home-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "s3cret" }));
    const prior = process.env.HOME;
    process.env.HOME = home;
    try {
      const listed = candidateMachineConfigs();
      assert.equal(listed.length, 1);
      const target = listed[0];
      assert.throws(() => readMachineKey(target, false), /user approval/i);
      assert.equal(readMachineKey(target, true), "s3cret");
      // An unlisted file is refused even with approval=true.
      const other = join(home, "auth.json");
      writeFileSync(other, JSON.stringify({ apiKey: "nope" }));
      assert.throws(() => readMachineKey(other, true), /listed/i);
    }
    finally { if (prior === undefined) delete process.env.HOME; else process.env.HOME = prior; }
  });
});
