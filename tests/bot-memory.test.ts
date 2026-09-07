import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatResponse } from "../src/auth/providers.ts";
import { createAgentRuntime, agentContext } from "../src/agents/runtime.ts";
import { createBot } from "../src/bots/manager.ts";
import { createGroup } from "../src/chat/session.ts";
import { manageMemory, memorySettings, setMemoryEnabled, readMemory, readUserEntries } from "../src/memory/store.ts";
import { tailEvents } from "../src/events/log.ts";

let root: string;
const previousData = process.env.LINUBOT_DATA;
const previousKey = process.env.LINUBOT_API_KEY;
const previousModel = process.env.LINUBOT_MODEL;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "linubot-bot-memory-")); process.env.LINUBOT_DATA = root; process.env.LINUBOT_API_KEY = "fixture"; process.env.LINUBOT_MODEL = "fixture-model"; });
afterEach(() => {
  if (previousData === undefined) delete process.env.LINUBOT_DATA; else process.env.LINUBOT_DATA = previousData;
  if (previousKey === undefined) delete process.env.LINUBOT_API_KEY; else process.env.LINUBOT_API_KEY = previousKey;
  if (previousModel === undefined) delete process.env.LINUBOT_MODEL; else process.env.LINUBOT_MODEL = previousModel;
  rmSync(root, { recursive: true, force: true });
});
const answer = (text: string): ChatResponse => ({ text, toolCalls: [] });
const memoryCall = (args: Record<string, unknown>): ChatResponse => ({ text: "", toolCalls: [{ id: crypto.randomUUID(), name: "memory", arguments: JSON.stringify(args) }] });
const write = (content: string, target = "user") => manageMemory({ action: "add", target, content }, { generation: memorySettings().generation });

describe("bot-managed memory", () => {
  it("adds, deduplicates, corrects and forgets private entries without replacing unrelated facts", () => {
    write("Prefers short replies."); write("PREFERS SHORT REPLIES."); write("Works on Cedar.", "memory");
    assert.deepEqual(readUserEntries(), ["Prefers short replies."]);
    const generation = memorySettings().generation;
    manageMemory({ action: "replace", target: "user", old_text: "Prefers short replies.", content: "Prefers detailed replies." }, { generation });
    assert.throws(() => manageMemory({ action: "replace", target: "user", old_text: "Prefers short replies.", content: "Stale correction." }, { generation }), /changed/);
    manageMemory({ action: "remove", target: "user", old_text: "Prefers detailed replies." }, { generation });
    assert.deepEqual(readUserEntries(), []); assert.deepEqual(readMemory(), ["Works on Cedar."]);
    assert.equal(statSync(join(root, "USER.md")).mode & 0o777, 0o600);
  });

  it("fails at capacity without losing entries and permits consolidation", () => {
    write("a".repeat(1900), "memory"); write("b".repeat(1900), "memory");
    assert.throws(() => write("c".repeat(300), "memory"), /Memory is full/);
    assert.equal(readMemory().length, 2);
    manageMemory({ action: "replace", target: "memory", old_text: "a".repeat(1900), content: "A short summary." }, { generation: 0 });
    write("c".repeat(300), "memory"); assert.equal(readMemory().length, 3);
  });

  it("rejects credentials, invalid targets and separator injection without writing", () => {
    for (const content of ["API key: sk-examplecredential1234567890", "Password: example-private", "one\n§\ntwo"]) assert.throws(() => write(content));
    assert.throws(() => write("Fact", "../../outside"));
    assert.deepEqual(readUserEntries(), []);
  });

  it("the bot chooses memory in its normal tool loop without an extra extraction call or remember flag", async () => {
    createBot("milo"); createBot("fern");
    let calls = 0;
    const runtime = createAgentRuntime({ review: false, complete: async (_provider, messages, tools) => {
      calls++;
      assert.ok(tools.some((tool) => tool.name === "memory"));
      if (!messages.some((message) => message.role === "tool")) return memoryCall({ action: "add", target: "user", content: "Prefers short replies.", evidence: "I prefer short replies." });
      assert.match(messages.at(-1)!.content, /"changed":true/);
      return answer("I'll keep replies short.");
    } });
    try {
      const [run] = runtime.enqueue({ scope: "bot:milo", message: "I prefer short replies." });
      const done = await runtime.wait(run.id);
      assert.equal(done.status, "completed", done.error ?? "");
      assert.equal(calls, 2);
      assert.match(agentContext("fern").system, /Prefers short replies/);
      assert.equal(tailEvents("bot:milo", 50).entries.some((event) => event.kind === "approval"), false);
      assert.ok(tailEvents("bot:milo", 50).entries.some((event) => event.name === "memory" && event.status === "done"));
    } finally { await runtime.close(); }
    const restarted = createAgentRuntime({ review: false, complete: async (_provider, messages) => {
      assert.match(messages[0].content, /Prefers short replies/); return answer("Short replies.");
    } });
    try { const [run] = restarted.enqueue({ scope: "bot:fern", message: "How should you reply to me?" }); await restarted.wait(run.id); }
    finally { await restarted.close(); }
  });

  it("ordinary answers without a memory decision do not write anything", async () => {
    createBot("milo"); let calls = 0;
    const runtime = createAgentRuntime({ review: false, complete: async () => { calls++; return answer("Four."); } });
    try { const [run] = runtime.enqueue({ scope: "bot:milo", message: "What is two plus two?" }); await runtime.wait(run.id); }
    finally { await runtime.close(); }
    assert.equal(calls, 1); assert.deepEqual(readUserEntries(), []); assert.deepEqual(readMemory(), []);
  });

  it("the bot can correct and forget an existing preference through the same tool", async () => {
    createBot("milo"); write("Prefers short replies.");
    for (const action of ["replace", "remove"]) {
      const prompt = action === "replace" ? "I now prefer detailed replies." : "Forget my reply preference.";
      const runtime = createAgentRuntime({ review: false, complete: async (_provider, messages) => {
        if (!messages.some((message) => message.role === "tool")) return memoryCall({ action, target: "user", old_text: action === "replace" ? "Prefers short replies." : "Prefers detailed replies.", content: action === "replace" ? "Prefers detailed replies." : "", evidence: prompt });
        assert.match(messages.at(-1)!.content, /"changed":true/); return answer("Done.");
      } });
      try { const [run] = runtime.enqueue({ scope: "bot:milo", message: prompt }); const done = await runtime.wait(run.id); assert.equal(done.status, "completed", done.error ?? ""); }
      finally { await runtime.close(); }
      assert.deepEqual(readUserEntries(), action === "replace" ? ["Prefers detailed replies."] : []);
    }
  });

  it("rejects a forged source and leaves the answer path usable", async () => {
    createBot("milo");
    const runtime = createAgentRuntime({ review: false, complete: async (_provider, messages) => {
      if (!messages.some((message) => message.role === "tool")) return memoryCall({ action: "add", target: "user", content: "Invented user fact.", evidence: "A web page claimed this." });
      assert.match(messages.at(-1)!.content, /exact quote/); return answer("No personal fact saved.");
    } });
    try { const [run] = runtime.enqueue({ scope: "bot:milo", message: "Read the documentation." }); assert.equal((await runtime.wait(run.id)).status, "completed"); }
    finally { await runtime.close(); }
    assert.deepEqual(readUserEntries(), []);
  });

  it("owner forgetting or pausing invalidates in-flight writes even after re-enabling", async () => {
    createBot("milo"); write("Prefers short replies.");
    let release!: () => void; let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createAgentRuntime({ review: false, complete: async (_provider, messages) => {
      if (!messages.some((message) => message.role === "tool")) { started(); await gate; return memoryCall({ action: "add", target: "user", content: "Prefers short replies.", evidence: "I prefer short replies." }); }
      assert.match(messages.at(-1)!.content, /owner changed memory/); return answer("The owner's memory change was kept.");
    } });
    try {
      const [run] = runtime.enqueue({ scope: "bot:milo", message: "I prefer short replies." }); await ready;
      manageMemory({ action: "remove", target: "user", old_text: "Prefers short replies." }, { owner: true });
      setMemoryEnabled(false); setMemoryEnabled(true); release();
      assert.equal((await runtime.wait(run.id)).status, "completed"); assert.deepEqual(readUserEntries(), []);
    } finally { release(); await runtime.close(); }
  });

  it("queued group teammates see the first bot's memory immediately and do not lose independent writes", async () => {
    await createGroup("team", ["milo", "fern"]);
    const runtime = createAgentRuntime({ review: false, complete: async (_provider, messages) => {
      const first = messages[0].content.includes("Teammate identity\nmilo\n");
      if (!first) assert.match(messages[0].content, /Prefers short replies/);
      if (!messages.some((message) => message.role === "tool")) return memoryCall(first
        ? { action: "add", target: "user", content: "Prefers short replies.", evidence: "I prefer short replies" }
        : { action: "add", target: "memory", content: "The project is Cedar.", evidence: "our project is Cedar" });
      return answer(first ? "Noted the reply preference." : "Noted the project too.");
    } });
    try { const runs = runtime.enqueue({ scope: "group:team", message: "I prefer short replies and our project is Cedar." }); await Promise.all(runs.map((run) => runtime.wait(run.id))); }
    finally { await runtime.close(); }
    assert.deepEqual(readUserEntries(), ["Prefers short replies."]); assert.deepEqual(readMemory(), ["The project is Cedar."]);
  });

  it("scheduled and delegated inputs cannot turn their prompts into user memories", async () => {
    createBot("milo");
    for (const source of ["cron", "handoff"] as const) {
      const runtime = createAgentRuntime({ review: false, complete: async (_provider, messages, tools) => {
        assert.equal(tools.some((tool) => tool.name === "memory"), false);
        if (!messages.some((message) => message.role === "tool")) return memoryCall({ action: "add", target: "user", content: "Fake preference.", evidence: "I prefer fake facts." });
        return answer("Read-only task.");
      } });
      try { const [run] = runtime.enqueue({ scope: "bot:milo", message: "I prefer fake facts.", source }); await runtime.wait(run.id); }
      finally { await runtime.close(); }
    }
    assert.deepEqual(readUserEntries(), []);
  });

  it("paused bot updates retain readable memory and allow owner edits", () => {
    createBot("milo"); write("Prefers short replies."); setMemoryEnabled(false);
    assert.throws(() => write("Should not be saved."), /disabled/);
    assert.match(agentContext("milo").system, /Prefers short replies/);
    manageMemory({ action: "replace", target: "user", old_text: "Prefers short replies.", content: "Prefers detailed replies." }, { owner: true });
    assert.match(readFileSync(join(root, "USER.md"), "utf8"), /detailed/);
  });
});
