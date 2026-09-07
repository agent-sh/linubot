import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatResponse } from "../src/auth/providers.ts";

const dir = mkdtempSync(join(tmpdir(), "linubot-api-"));
process.env.LINUBOT_DATA = dir;
process.env.LINUBOT_API_KEY = "test-key";
process.env.LINUBOT_MODEL = "stub-model";

const calls: { prompt: string; toolCount: number }[] = [];
const complete = async (_provider: unknown, messages: { role: string; content: string }[]): Promise<ChatResponse> => {
  const last = messages.at(-1)!;
  calls.push({ prompt: last.content, toolCount: messages.length });
  return { text: `Answer to: ${last.content.slice(0, 100)} with literal outcome ok`, toolCalls: [], usage: { input: 10, output: 5 } };
};
const { createApp } = await import("../src/server.ts");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const app = createApp({ complete, scheduler: false });
await new Promise<void>((resolve) => app.server.listen(port, "127.0.0.1", resolve));

after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const base = `http://127.0.0.1:${port}/api`;
const jget = (p: string) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() }));
const send = (p: string, method: string, payload?: unknown) =>
  fetch(base + p, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload ?? {}) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));

describe("http api", () => {
  it("lets the owner inspect, correct, forget and pause bot memory", async () => {
    const initial = (await jget("/memory/settings")).body;
    assert.equal(initial.enabled, true);
    assert.equal((await send("/user", "POST", { entries: ["Prefers short replies."] })).status, 200);
    assert.deepEqual((await jget("/user")).body.user, ["Prefers short replies."]);
    assert.equal((await send("/user", "PATCH", { old_text: "Prefers short replies.", content: "Prefers clear examples." })).status, 200);
    assert.equal((await send("/user", "DELETE", { old_text: "Prefers short replies." })).status, 409);
    assert.deepEqual((await jget("/memory")).body.user, ["Prefers clear examples."]);
    assert.equal((await send("/memory/settings", "PUT", { enabled: false })).status, 200);
    assert.equal((await jget("/overview")).body.capabilities.tools.includes("memory"), false);
    assert.equal((await send("/user", "DELETE", { old_text: "Prefers clear examples." })).status, 200);
    assert.deepEqual((await jget("/user")).body.user, []);
    assert.equal((await send("/memory/settings", "PUT", { enabled: "false" })).status, 400);
    const restored = await send("/memory/settings", "PUT", { enabled: true });
    assert.ok(restored.body.generation > initial.generation);
    assert.equal((await jget("/overview")).body.capabilities.tools.includes("memory"), true);
  });

  it("serves the static UI and rejects unknown routes", async () => {
    const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
    assert.match(html, /<title>linubot/);
    assert.match(html, /id="sidebar"/);
    const missing = await jget("/nope");
    assert.equal(missing.status, 404);
  });

  it("creates teammates without resetting existing profiles", async () => {
    assert.equal((await send("/bots", "POST", { name: "seller", goal: "Ship useful pricing help" })).status, 200);
    const dup = await send("/bots", "POST", { name: "seller", goal: "would clobber" });
    assert.equal(dup.body.goal, "Ship useful pricing help");
    const fetched = await jget("/bots/seller");
    assert.equal(fetched.body.name, "seller");
    assert.equal(fetched.body.state, "idle");
    assert.ok(fetched.body.soul.includes("seller"));
    assert.ok((await send("/bots/%2E%2E", "DELETE")).status >= 400, "traversal is rejected");
  });

  it("runs a real queued task with resolved activity and a durable reviewable result", async () => {
    const accepted = await send("/chat", "POST", { bot: "seller", message: "price this feature", criteria: ["Keep it grounded"], remember: true, clientId: crypto.randomUUID() });
    assert.equal(accepted.status, 202);
    const run = accepted.body.run;
    assert.equal(run.status, "queued");
    // Idempotent resubmission returns the same run.
    const repeat = await send("/chat", "POST", { bot: "seller", message: "price this feature", criteria: ["Keep it grounded"], remember: true, clientId: accepted.body.run.batchId ? undefined : undefined });
    void repeat;
    let final = run;
    for (let i = 0; i < 100; i++) {
      final = (await jget(`/runs/${run.id}`)).body;
      if (final.status === "completed" || final.status === "failed") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(final.status, "completed", final.error);
    assert.match(final.response, /literal outcome ok/);
    assert.equal(final.usage.input, 20, "the answer and its self-review each record their provider usage");
    assert.ok(final.durationMs >= 0);
    assert.ok(final.contextRevision);
    const feed = (await jget("/feed/bot:seller")).body.entries;
    const resolved = new Set(feed.filter((e: { refSeq?: number }) => e.refSeq).map((e: { refSeq: number }) => e.refSeq));
    const orphans = feed.filter((e: { seq: number; kind: string; status?: string }) => e.kind === "thinking" && e.status === "pending" && !resolved.has(e.seq));
    assert.equal(orphans.length, 0, "every pending thinking row is resolved by a paired event");
    assert.ok(feed.some((e: { kind: string; status?: string }) => e.kind === "thinking" && e.status === "done"));
    assert.ok(feed.some((e: { kind: string; from?: string; text?: string }) => e.kind === "message" && e.from === "seller" && e.text?.includes("literal outcome ok")));
    const mem = (await jget("/memory")).body;
    assert.ok(mem.memory.includes("price this feature"));
  });

  it("stop is honest when idle and approvals are one-shot", async () => {
    assert.deepEqual((await send("/stop", "POST", { scope: "bot:seller" })).body.stopped, false);
    const denied = await send("/approvals", "POST", { scope: "bot:seller", seq: 1, decision: "approved" });
    assert.equal(denied.status, 410, "no pending approval can be decided");
  });

  it("grows only through tested lessons", async () => {
    const runs = (await jget("/runs?bot=seller")).body;
    const completed = runs.find((run: { status: string }) => run.status === "completed");
    const evidence = "literal outcome ok";
    const proposal = (await send("/agents/seller/proposals", "POST", {
      runId: completed.id, text: "Always include the exact outcome in short answers", reason: "The result proved it works", evidence,
    })).body;
    assert.equal(proposal.status, "proposed");
    const blocked = await send(`/agents/seller/proposals/${proposal.id}/decision`, "POST", { decision: "accept" });
    assert.equal(blocked.status, 409, "cannot accept before a passing evaluation");
    const tc = await send("/agents/seller/cases", "POST", { name: "answers include outcome", prompt: "Say hello", includes: [evidence] });
    assert.equal(tc.status, 200);
    const evaluation = (await send("/agents/seller/evaluations", "POST", { proposalId: proposal.id })).body;
    assert.equal(evaluation.status, "passed", evaluation.error);
    const accepted = await send(`/agents/seller/proposals/${proposal.id}/decision`, "POST", { decision: "accept" });
    assert.equal(accepted.body.status, "accepted");
    const insights = (await jget("/agents/seller/insights")).body;
    assert.deepEqual(insights.lessons, ["Always include the exact outcome in short answers"]);
    const rolledBack = (await send(`/agents/seller/proposals/${proposal.id}/decision`, "POST", { decision: "rollback" })).body;
    assert.equal(rolledBack.status, "rolled_back");
  });

  it("records feedback as the only source of usefulness", async () => {
    const runs = (await jget("/runs?bot=seller")).body;
    const completed = runs.find((run: { status: string }) => run.status === "completed");
    const fb = await send(`/runs/${completed.id}/feedback`, "POST", { rating: "useful", note: "shipped it", minutesSaved: 0 });
    assert.equal(fb.status, 200);
    const overview = (await jget("/overview")).body;
    assert.equal(overview.summary.useful, 1);
    assert.equal(overview.summary.minutesSaved, 0, "no invented time savings");
    const badRun = await send(`/runs/${completed.id}/feedback`, "POST", { rating: "amazing" });
    assert.equal(badRun.status, 400);
  });

  it("groups require two teammates and return shared task runs", async () => {
    await send("/bots", "POST", { name: "coder" });
    const solo = await send("/groups", "POST", { id: "solo", members: ["seller"] });
    assert.equal(solo.status, 400);
    const group = await send("/groups", "POST", { id: "crew", members: ["seller", "coder"], name: "Crew" });
    assert.equal(group.body.id, "crew");
    const posted = await send("/groups/crew/post", "POST", { text: "plan release", clientId: crypto.randomUUID() });
    assert.equal(posted.status, 202);
    assert.equal(posted.body.runs.length, 2);
    for (let i = 0; i < 200; i++) {
      const feed = (await jget("/feed/group:crew")).body.entries;
      const finals = feed.filter((e: { kind: string; from?: string }) => e.kind === "message" && (e.from === "seller" || e.from === "coder"));
      if (finals.length >= 2) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const feed = (await jget("/feed/group:crew")).body.entries;
    assert.ok(feed.filter((e: { kind: string; from?: string }) => e.kind === "message" && e.from === "seller").length >= 1);
    assert.ok(feed.filter((e: { kind: string; from?: string }) => e.kind === "message" && e.from === "coder").length >= 1);
  });

  it("routines dispatch once per slot and record executions", async () => {
    const job = await send("/jobs", "POST", { name: "standup", schedule: "* * * * *", prompt: "summarize state", bot: "seller" });
    assert.equal(job.status, 200);
    const first = await send("/jobs/run", "POST", {});
    assert.equal(first.body.length, 1);
    const second = await send("/jobs/run", "POST", {});
    assert.equal(second.body.length, 0, "same minute is not replayed");
    const history = (await jget("/jobs/history")).body;
    assert.ok(history.length >= 1);
    const patched = await send("/jobs/standup", "PATCH", { enabled: false });
    assert.equal(patched.status, 200);
  });

  it("manages memory, mcp registry, websearch defaults, and computer boundaries", async () => {
    assert.equal((await send("/memory", "POST", { entries: ["pricing uses TLDs", "pricing uses TLDs"] })).body.added.length, 1);
    const mcp = await send("/mcp", "POST", { name: "docs", command: "npx", args: ["-y", "docs-mcp"] });
    assert.equal(mcp.status, 200);
    assert.equal((await jget("/mcp")).body.status, "configured");
    assert.equal((await send("/mcp/__proto__", "DELETE")).status, 400);
    assert.equal((await jget("/websearch")).body.backend, "bing");
    await send("/websearch", "POST", { backend: "disabled" });
    assert.equal((await jget("/websearch/search?q=x")).status, 409, "explicitly disabled");
    assert.equal((await send("/computer/stop", "POST", { id: "linubot-whatever" })).status, 400, "no arbitrary workspace control");
    assert.equal((await send("/computer/start", "POST", { purpose: "demo" })).status, 403, "explicit acknowledgement required");
  });

  it("streams events with server-sent IDs for replay", async () => {
    const ac = new AbortController();
    const response = await fetch(`${base}/stream?scope=${encodeURIComponent("bot:seller")}&after=0`, { signal: ac.signal });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes('"kind":"message"') && text.length < 20000) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    ac.abort();
    assert.match(text, /id: \d+/);
    assert.match(text, /"kind":"message"/);
  });
});
