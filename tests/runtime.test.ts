import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatResponse } from "../src/auth/providers.ts";
import { setContextSettings, contextUnits } from "../src/context/manager.ts";
import { appendEvent } from "../src/events/log.ts";

const dir = mkdtempSync(join(tmpdir(), "linubot-rt-"));
process.env.LINUBOT_DATA = dir;
process.env.LINUBOT_API_KEY = "k";
process.env.LINUBOT_MODEL = "m";

const { createAgentRuntime } = await import("../src/agents/runtime.ts");
const { tailEvents } = await import("../src/events/log.ts");
const { createBot } = await import("../src/bots/manager.ts");

after(() => { rmSync(dir, { recursive: true, force: true }); });

describe("agent runtime integrity", () => {
  it("continues unfinished tool work after both compactors time out without repeating a saved artifact", async () => {
    createBot("continuing");
    const scope = "bot:continuing";
    for (let index = 0; index < 4; index++) appendEvent(scope, { kind: "message", from: "user", text: `Earlier step ${index}: ${"Keep the established plan. ".repeat(70)}` });
    setContextSettings({ inputBudget: 10000, targetTokens: 1000, recentUnits: 2, mode: "auto" });
    const { setProvider } = await import("../src/auth/store.ts");
    setProvider({ kind: "responses", baseUrl: "https://api.openai.com/v1", apiKey: "fixture", model: "fixture" });
    const first = JSON.stringify({ title: "Before compaction", content: "BEFORE_COMPACTION " + "Evidence. ".repeat(4000) });
    let turns = 0, nativeCalls = 0, summaries = 0;
    const runtime = createAgentRuntime({ review: false, timeoutMs: 300, contextNative: async () => { nativeCalls++; throw new Error("Native compaction timed out"); }, complete: async (_provider, messages, _tools, _signal, options) => {
      if (messages[0].content.startsWith("Create a continuation checkpoint")) { summaries++; assert.equal(options?.timeoutMs, 180000); await new Promise((resolve) => setTimeout(resolve, 450)); throw new Error("Provider request timed out after 60 seconds"); }
      contextUnits(messages);
      assert.ok(messages.some((m) => m.pinned && m.content === "Complete both deliverables, then report completion."));
      turns++;
      if (turns === 1) return { text: "", toolCalls: [{ id: "before", name: "save_artifact", arguments: first }] };
      assert.ok(messages.some((m) => m.content.includes("Archive recovery checkpoint")));
      if (turns === 2) return { text: "", toolCalls: [{ id: "recover", name: "read_session", arguments: '{"query":"BEFORE_COMPACTION"}' }] };
      if (turns === 3) return { text: "", toolCalls: [{ id: "same-before", name: "save_artifact", arguments: first }, { id: "after", name: "save_artifact", arguments: '{"title":"After compaction","content":"AFTER_COMPACTION"}' }] };
      return { text: "BOTH_DELIVERABLES_COMPLETE", toolCalls: [] };
    } });
    try {
      const [run] = runtime.enqueue({ scope, message: "Complete both deliverables, then report completion." });
      const done = await runtime.wait(run.id); assert.equal(done.status, "completed", done.error ?? ""); assert.equal(done.response, "BOTH_DELIVERABLES_COMPLETE");
      const events = tailEvents(scope, 150).entries;
      assert.equal(nativeCalls, 1); assert.equal(summaries, 1); assert.equal(turns, 4);
      assert.ok(events.some((e) => e.text === "Continuing from the session archive"));
      assert.equal(events.filter((e) => e.kind === "file" && e.name === "Before compaction").length, 1);
      assert.equal(events.filter((e) => e.kind === "file" && e.name === "After compaction").length, 1);
      assert.ok(events.some((e) => e.kind === "tool" && e.name === "read_session" && e.status === "done"));
    } finally { await runtime.close(); setContextSettings({ inputBudget: 32000, targetTokens: 10000, recentUnits: 6, mode: "auto" }); }
  });

  it("delivers the answer even when the remember write fails", async () => {
    createBot("keepsake");
    const complete = async (): Promise<ChatResponse> => ({ text: "the answer", toolCalls: [], usage: { input: 1, output: 1 } });
    const runtime = createAgentRuntime({ complete, review: false });
    // 5000 chars exceeds the 4000-char memory entry max, so appendMemory rejects.
    const longPrompt = "x".repeat(5000);
    const [run] = runtime.enqueue({ scope: "bot:keepsake", message: longPrompt, remember: true });
    const done = await runtime.wait(run.id);
    assert.equal(done.status, "completed", done.error ?? "");
    const feed = tailEvents("bot:keepsake", 50).entries;
    assert.ok(feed.some((e) => e.kind === "message" && e.from === "keepsake" && e.text === "the answer"), "answer delivered");
    assert.ok(feed.some((e) => e.kind === "notice" && e.text?.includes("memory could not be updated")), "honest notice");
    await runtime.close();
  });

  it("denied approvals conclude and are not asked again", async () => {
    createBot("helper");
    let calls = 0;
    const complete = async (provider: unknown, messages: unknown[]): Promise<ChatResponse> => {
      const arr = messages as { role: string }[];
      const toolResults = arr.filter((m) => m.role === "tool").length;
      calls++;
      if (toolResults === 0) return { text: "", toolCalls: [{ id: "c1", name: "start_workspace", arguments: JSON.stringify({ purpose: "p" }) }] };
      if (toolResults === 1) return { text: "", toolCalls: [{ id: "c2", name: "start_workspace", arguments: JSON.stringify({ purpose: "p" }) }] };
      return { text: "gave up politely", toolCalls: [] };
    };
    const fakeComputer = {
      start: async () => { throw new Error("workspace should never be created after a denial"); },
      stop: async () => JSON.stringify({ ok: true }), cleanup: async () => JSON.stringify({ ok: true }),
      doctor: async () => "{}", list: async () => "{}", status: async () => "{}",
    };
    const runtime = createAgentRuntime({ complete, computer: fakeComputer as never });
    const [run] = runtime.enqueue({ scope: "bot:helper", message: "browse something" });
    for (let i = 0; i < 200; i++) {
      const updated = await import("../src/agents/insights.ts").then((m) => m.getRun(run.id));
      if (updated.status === "awaiting_approval") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const approvals = tailEvents("bot:helper", 50).entries.filter((e) => e.kind === "approval" && e.status === "pending");
    assert.equal(approvals.length, 1);
    runtime.decide("bot:helper", approvals[0].seq, "denied");
    assert.throws(() => runtime.decide("bot:helper", approvals[0].seq, "denied"), /expired|already/);
    const done = await runtime.wait(run.id);
    assert.equal(done.status, "completed");
    const feed = tailEvents("bot:helper", 100).entries;
    // Exactly one approval request existed; the second attempt is refused in the tool result, not re-asked.
    assert.equal(feed.filter((e) => e.kind === "approval" && e.status === "pending").length, 1);
    assert.ok(feed.some((e) => e.kind === "tool" && e.status === "error" && e.detail?.includes("not be re-asked")));
    assert.ok(feed.some((e) => e.kind === "message" && e.text === "gave up politely"));
    await runtime.close();
  });

  it("replayed clientId returns the identical run without re-execution", async () => {
    createBot("once");
    let completions = 0;
    const complete = async (): Promise<ChatResponse> => { completions++; return { text: "same", toolCalls: [] }; };
    const runtime = createAgentRuntime({ complete, review: false });
    const clientId = crypto.randomUUID();
    const a = runtime.enqueue({ scope: "bot:once", message: "dedupe me", clientId })[0];
    const b = runtime.enqueue({ scope: "bot:once", message: "dedupe me", clientId })[0];
    assert.equal(a.id, b.id);
    const done = await runtime.wait(a.id);
    assert.equal(done.status, "completed");
    assert.equal(completions, 1);
    await runtime.close();
  });
});
