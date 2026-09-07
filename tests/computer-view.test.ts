import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createComputer } from "../src/computer/workspace.ts";
import type { Runner } from "../src/computer/workspace.ts";
import { createWorkspaceView } from "../src/computer/view.ts";
import { createApp } from "../src/server.ts";
import { createAgentRuntime } from "../src/agents/runtime.ts";
import { createBot } from "../src/bots/manager.ts";
import { setProvider } from "../src/auth/store.ts";
import { bus } from "../src/events/log.ts";
import type { FeedEvent } from "../src/events/log.ts";
import type { ChatResponse } from "../src/auth/providers.ts";

const ID = "linubot-10000000-0000-4000-8000-000000000001";
const OTHER = "linubot-10000000-0000-4000-8000-000000000002";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq1sAAAAASUVORK5CYII=", "base64");
const previousData = process.env.LINUBOT_DATA;
let directory: string;
const cleanup: (() => unknown | Promise<unknown>)[] = [];
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "linubot-computer-view-")); process.env.LINUBOT_DATA = directory; });
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  if (previousData === undefined) delete process.env.LINUBOT_DATA; else process.env.LINUBOT_DATA = previousData;
  rmSync(directory, { recursive: true, force: true });
});
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
function signal() { const ctrl = new AbortController(); cleanup.push(() => ctrl.abort(new Error("Test cleanup"))); return ctrl; }
const hasStatus = (status: number) => (error: unknown) => Boolean(error && typeof error === "object" && "status" in error && error.status === status);
async function fixture(intercept?: (args: string[], options: Parameters<Runner>[1]) => Promise<string | undefined> | string | undefined) {
  const calls: { args: string[]; options: Parameters<Runner>[1] }[] = [];
  const computer = createComputer(async (args, options) => {
    calls.push({ args: [...args], options });
    const overridden = await intercept?.(args, options); if (overridden !== undefined) return overridden;
    const id = args[args.indexOf("--id") + 1];
    if (args[1] === "start" && args.includes("--dry-run")) return JSON.stringify({ ok: true, start_preview: { id, already_running: false, ok_to_start: true, would_start: true } });
    if (args[1] === "cleanup") return JSON.stringify({ dry_run: false, removed: [{ id }], skipped: [] });
    if (args[1] === "screenshot") writeFileSync(args[args.indexOf("--output") + 1], PNG);
    return JSON.stringify({ ok: true, status: { id, ready: args[1] !== "stop", session_id: `fixture-${id}` } });
  });
  await computer.start({ id: ID, acknowledge: true, purpose: "Fixture owned desktop", scope: "bot:Viewer" });
  calls.length = 0;
  const view = createWorkspaceView(computer); cleanup.push(() => view.close());
  return { computer, view, calls };
}

describe("embedded owned computer control", () => {
  it("rejects unowned frame, takeover, input and agent requests before reaching the runner", async () => {
    const { view, calls } = await fixture(), ctrl = signal();
    for (const id of [OTHER, "host-desktop", "../outside"]) {
      await assert.rejects(() => view.frame(id), hasStatus(404));
      await assert.rejects(() => view.take(id, ctrl.signal), hasStatus(404));
      await assert.rejects(() => view.input(id, "foreign-token", { action: "click", x: 1, y: 2 }), hasStatus(404));
      await assert.rejects(() => view.agent(id, 0, ctrl.signal, async () => { assert.fail("Unowned agent work must not run"); }), hasStatus(404));
    }
    assert.deepEqual(calls, []);
  });

  it("takeover waits for an in-flight agent action and holds queued agents until the owner releases", { timeout: 2000 }, async () => {
    const { view } = await fixture(), ctrl = signal(), gate = deferred(), entered = deferred();
    cleanup.push(() => gate.resolve()); const events: string[] = [];
    const first = view.agent(ID, 0, ctrl.signal, async () => { events.push("agent-start"); entered.resolve(); await gate.promise; events.push("agent-end"); });
    await entered.promise;
    let granted = false; const taking = view.take(ID, ctrl.signal).then((value) => { granted = true; return value; });
    let queued = false; const next = view.agent(ID, undefined, ctrl.signal, async () => { queued = true; events.push("next-agent"); });
    await tick(); assert.equal(granted, false); assert.equal(queued, false); assert.equal(view.blocked(ID), true);
    gate.resolve(); await first; const { token } = await taking; await tick(); assert.equal(queued, false);
    assert.equal(view.status(ID).manual, true); assert.doesNotMatch(JSON.stringify(view.status(ID)), new RegExp(token));
    await view.release(ID, token); await next;
    assert.deepEqual(events, ["agent-start", "agent-end", "next-agent"]); assert.equal(view.blocked(ID), false);
  });

  it("serializes agent actions and rejects actions chosen from a revision preceding human input", async () => {
    const { view } = await fixture(), ctrl = signal(), gate = deferred(), started = deferred(); cleanup.push(() => gate.resolve());
    let executing = 0, maxExecuting = 0;
    const first = view.agent(ID, 0, ctrl.signal, async () => { executing++; maxExecuting = Math.max(maxExecuting, executing); started.resolve(); await gate.promise; executing--; });
    await started.promise;
    const second = view.agent(ID, 0, ctrl.signal, async () => { executing++; maxExecuting = Math.max(maxExecuting, executing); executing--; });
    gate.resolve(); await Promise.all([first, second]); assert.equal(maxExecuting, 1);
    const before = view.revision(ID), { token } = await view.take(ID, ctrl.signal);
    await view.input(ID, token, { action: "click", x: 3, y: 4 }); await view.release(ID, token);
    assert.ok(view.revision(ID) > before);
    await assert.rejects(() => view.agent(ID, before, ctrl.signal, async () => { assert.fail("Stale computer action ran"); }), hasStatus(409));
    assert.equal(await view.agent(ID, view.revision(ID), ctrl.signal, async () => "fresh-observation"), "fresh-observation");
  });

  it("cancels takeover while an agent is working without leaving manual control locked", { timeout: 2000 }, async () => {
    const { view } = await fixture(), ctrl = signal(), owner = signal(), gate = deferred(), started = deferred(); cleanup.push(() => gate.resolve());
    const agent = view.agent(ID, 0, ctrl.signal, async () => { started.resolve(); await gate.promise; }); await started.promise;
    const taking = view.take(ID, owner.signal), rejected = assert.rejects(taking, /owner cancelled/);
    owner.abort(new Error("owner cancelled")); await rejected; assert.equal(view.status(ID).manual, false);
    gate.resolve(); await agent; assert.equal(await view.agent(ID, undefined, ctrl.signal, async () => "continued"), "continued");
  });

  it("user-help requests wait for takeover and release, and reject concurrent requests", async () => {
    const { view } = await fixture(), ctrl = signal(); let completed = false;
    const request = view.request(ID, "Please sign in inside this desktop", ctrl.signal).then(() => { completed = true; });
    assert.equal(view.status(ID).requested, "Please sign in inside this desktop");
    await assert.rejects(() => view.request(ID, "Another login", ctrl.signal), hasStatus(409));
    await tick(); assert.equal(completed, false);
    const { token } = await view.take(ID, ctrl.signal); await view.input(ID, token, { action: "type", text: "fixture-private-login" });
    await tick(); assert.equal(completed, false); await view.release(ID, token); await request;
    assert.equal(view.blocked(ID), false); assert.equal(view.status(ID).requested, undefined);
  });

  it("cancelling a help request clears its prompt while preserving any active human control", async () => {
    for (const manual of [false, true]) {
      const { view } = await fixture(), ctrl = signal(), requestCtrl = signal();
      const request = view.request(ID, "Owner login", requestCtrl.signal), rejected = assert.rejects(request, /task cancelled/);
      const token = manual ? (await view.take(ID, ctrl.signal)).token : undefined;
      requestCtrl.abort(new Error("task cancelled")); await rejected;
      assert.equal(view.status(ID).requested, undefined); assert.equal(view.status(ID).manual, manual);
      if (token) await view.release(ID, token);
      assert.equal(await view.agent(ID, undefined, ctrl.signal, async () => "resumed"), "resumed");
      // Each variant gets its own ownership registry, like a separate app profile.
      view.close(); rmSync(join(directory, "computer-workspaces.json"));
    }
  });

  it("release waits for every queued owner input before allowing an agent to continue", { timeout: 2000 }, async () => {
    const firstGate = deferred(), secondGate = deferred(), firstStarted = deferred(), secondStarted = deferred();
    cleanup.push(() => { firstGate.resolve(); secondGate.resolve(); });
    const events: string[] = [];
    const { view } = await fixture(async (args) => {
      if (args[1] === "type") { const value = args.at(-1)!; events.push(`${value}-start`); if (value === "first") { firstStarted.resolve(); await firstGate.promise; } else { secondStarted.resolve(); await secondGate.promise; } events.push(`${value}-end`); }
      return undefined;
    });
    const ctrl = signal(), { token } = await view.take(ID, ctrl.signal);
    const first = view.input(ID, token, { action: "type", text: "first" }); await firstStarted.promise;
    const second = view.input(ID, token, { action: "type", text: "second" });
    let released = false, agentStarted = false;
    const release = view.release(ID, token).then(() => { released = true; });
    const agent = view.agent(ID, undefined, ctrl.signal, async () => { agentStarted = true; events.push("agent"); });
    await tick(); assert.equal(released, false); assert.equal(agentStarted, false);
    firstGate.resolve(); await secondStarted.promise; assert.equal(released, false); assert.equal(agentStarted, false);
    secondGate.resolve(); await Promise.all([first, second, release, agent]);
    assert.deepEqual(events, ["first-start", "first-end", "second-start", "second-end", "agent"]);
  });

  it("rejects stale tokens after another takeover and after release without performing their inputs", async () => {
    const { view, calls } = await fixture(), ctrl = signal();
    const first = await view.take(ID, ctrl.signal), second = await view.take(ID, ctrl.signal); assert.notEqual(first.token, second.token);
    calls.length = 0;
    await assert.rejects(() => view.input(ID, first.token, { action: "key", keys: "Return" }), hasStatus(403));
    await assert.rejects(() => view.release(ID, first.token), hasStatus(409));
    assert.equal(view.status(ID).manual, true); assert.deepEqual(calls, []);
    await view.release(ID, second.token);
    await assert.rejects(() => view.input(ID, second.token, { action: "type", text: "stale" }), hasStatus(403));
    assert.deepEqual(calls, []);
  });

  it("bounds queued input and recovers queue capacity after an input fails", { timeout: 2000 }, async () => {
    const gate = deferred(), started = deferred(); cleanup.push(() => gate.resolve()); let types = 0;
    const { view } = await fixture(async (args) => { if (args[1] === "type") { types++; if (types === 1) { started.resolve(); await gate.promise; throw new Error("fixture backend failure with private text"); } } return undefined; });
    const { token } = await view.take(ID, signal().signal);
    const first = view.input(ID, token, { action: "type", text: "first" }), failed = assert.rejects(first, (error: unknown) => hasStatus(502)(error) && !String(error).includes("private text"));
    await started.promise;
    const queued = Array.from({ length: 63 }, () => view.input(ID, token, { action: "key", keys: "Return" }));
    await assert.rejects(() => view.input(ID, token, { action: "key", keys: "Return" }), hasStatus(429));
    gate.resolve(); await Promise.all([failed, ...queued]);
    await view.input(ID, token, { action: "type", text: "recovered" }); assert.equal(types, 2);
  });

  it("serves one bounded PNG capture to concurrent readers and removes the temporary frame", async () => {
    const gate = deferred(), started = deferred(); cleanup.push(() => gate.resolve());
    const { view, calls } = await fixture(async (args, options) => {
      if (args[1] === "screenshot") { assert.equal(options?.timeoutMs, 5000); assert.ok(options?.signal); started.resolve(); await gate.promise; }
      return undefined;
    });
    const first = view.frame(ID); await started.promise; const second = view.frame(ID); gate.resolve();
    const frames = await Promise.all([first, second]); assert.deepEqual(frames, [PNG, PNG]);
    assert.equal(calls.filter((call) => call.args[1] === "screenshot").length, 1);
    assert.deepEqual(readdirSync(join(directory, "live-frames")), []);
    assert.doesNotMatch(readFileSync(join(directory, "computer-workspaces.json"), "utf8"), /base64|PNG/);
  });

  it("rejects corrupt, oversized and symlinked frames while cleaning only its temporary output", async () => {
    const victim = join(directory, "unrelated.txt"); writeFileSync(victim, "keep this fixture");
    let variant = "corrupt";
    const { view } = await fixture((args) => {
      if (args[1] !== "screenshot") return undefined;
      const path = args[args.indexOf("--output") + 1];
      if (variant === "corrupt") writeFileSync(path, "not-a-png");
      else if (variant === "large") writeFileSync(path, Buffer.alloc(8 * 1024 * 1024 + 1));
      else symlinkSync(victim, path);
      return JSON.stringify({ ok: true });
    });
    for (variant of ["corrupt", "large", "symlink"]) {
      await assert.rejects(() => view.frame(ID), /Invalid frame/);
      assert.deepEqual(readdirSync(join(directory, "live-frames")), []); assert.equal(readFileSync(victim, "utf8"), "keep this fixture");
    }
  });

  it("shutdown aborts a pending frame capture, removes its output and rejects new requests", { timeout: 2000 }, async () => {
    const started = deferred(); let captureSignal: AbortSignal | undefined;
    const { view } = await fixture(async (args, options) => {
      if (args[1] !== "screenshot") return undefined;
      writeFileSync(args[args.indexOf("--output") + 1], PNG); captureSignal = options?.signal; started.resolve();
      await new Promise((_, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }));
      return undefined;
    });
    const frame = view.frame(ID), rejected = assert.rejects(frame, /closed/i); await started.promise; view.close(); await rejected;
    assert.equal(captureSignal?.aborted, true); assert.deepEqual(readdirSync(join(directory, "live-frames")), []);
    await assert.rejects(() => view.frame(ID), hasStatus(404)); await assert.rejects(() => view.take(ID, signal().signal), hasStatus(404));
  });

  it("shutdown wakes a blocked agent and user-help waiter without executing further work", async () => {
    const { view } = await fixture(), ctrl = signal();
    const request = view.request(ID, "Please sign in", ctrl.signal), rejectedRequest = assert.rejects(request, /closed/i);
    const agent = view.agent(ID, undefined, ctrl.signal, async () => { assert.fail("Agent ran after shutdown"); }), rejectedAgent = assert.rejects(agent, /closed/i);
    await tick(); view.close(); await Promise.all([rejectedRequest, rejectedAgent]);
  });

  it("shutdown rejects queued work and takeover while an agent action or readiness lookup is still pending", { timeout: 2000 }, async () => {
    for (const phase of ["agent", "status", "queued-agent"]) {
      const gate = deferred(), started = deferred();
      const { view } = await fixture(async (args) => { if (phase === "status" && args[1] === "status") { started.resolve(); await gate.promise; } return undefined; });
      const ctrl = signal(); let outcome: unknown;
      const agent = phase !== "status" ? view.agent(ID, 0, ctrl.signal, async () => { started.resolve(); await gate.promise; }) : Promise.resolve();
      if (phase !== "status") await started.promise;
      const operation = phase === "queued-agent" ? view.agent(ID, 0, ctrl.signal, async () => { assert.fail("Queued agent executed after shutdown"); }) : view.take(ID, ctrl.signal);
      const taking = operation.then(() => { outcome = "granted"; }, (error) => { outcome = error; });
      if (phase === "status") await started.promise;
      try {
        view.close(); await tick();
        assert.match(String(outcome), /closed|available|changed/i, `Computer operation remained pending during ${phase} after shutdown`);
      } finally {
        gate.resolve(); await Promise.all([taking, agent]); rmSync(join(directory, "computer-workspaces.json"));
      }
    }
  });

  it("pauses the task budget as soon as the owner takes over during a pending model request", { timeout: 3000 }, async (t) => {
    const { computer, view } = await fixture();
    setProvider({ kind: "openai-compat", baseUrl: "https://fixture.example/v1", apiKey: "fixture-key", model: "fixture-model" }); createBot("ClockBot");
    const modelStarted = deferred(), reply = deferred<ChatResponse>(); let calls = 0, modelSignal: AbortSignal | undefined;
    const runtime = createAgentRuntime({ computer, workspaceView: view, timeoutMs: 100, review: false,
      complete: async (_provider, _messages, _tools, signal) => {
        calls++;
        if (calls === 1) return { text: "", toolCalls: [{ id: "start-clock-desktop", name: "start_workspace", arguments: '{"purpose":"Fixture login"}' }] };
        if (calls === 2) { modelSignal = signal; modelStarted.resolve(); return reply.promise; }
        return { text: "Continued from the updated computer", toolCalls: [] };
      } });
    const approve = (scope: string, event: FeedEvent) => { if (scope === "bot:ClockBot" && event.kind === "approval" && event.status === "pending") setImmediate(() => runtime.decide(scope, event.seq, "approved")); };
    bus.on("event", approve);
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    try {
      const [run] = runtime.enqueue({ scope: "bot:ClockBot", message: "Use the desktop and let me sign in" }); await modelStarted.promise;
      const workspace = computer.owned().find((entry) => entry.scope === "bot:ClockBot")!.id;
      const { token } = await view.take(workspace, signal().signal);
      t.mock.timers.tick(5000);
      assert.equal(modelSignal?.aborted, false, "Human control must pause the budget while the provider request remains pending");
      await view.release(workspace, token); reply.resolve({ text: "Stale model response", toolCalls: [] });
      const final = await runtime.wait(run.id);
      assert.equal(final.status, "completed", final.error ?? ""); assert.equal(final.response, "Continued from the updated computer"); assert.equal(calls, 3);
    } finally { reply.resolve({ text: "Fixture cleanup", toolCalls: [] }); bus.off("event", approve); await runtime.close(); t.mock.timers.reset(); }
  });
});

describe("embedded computer HTTP control", () => {
  it("protects frame/input endpoints, isolates ownership and never exposes control tokens or typed input in status", async () => {
    const { computer, view, calls } = await fixture();
    await computer.start({ id: OTHER, acknowledge: true, purpose: "Another conversation", scope: "bot:Other" });
    const app = createApp({ computer, workspaceView: view, scheduler: false, accessToken: "fixture-desktop-access" });
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve)); cleanup.push(() => app.close());
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/computer`;
    const headers = { "x-linubot-token": "fixture-desktop-access", "content-type": "application/json" };
    const post = (path: string, data: unknown) => fetch(base + path, { method: "POST", headers, body: JSON.stringify(data) });
    assert.equal((await fetch(`${base}/frame?id=${ID}`)).status, 403);
    assert.equal((await fetch(`${base}/frame?id=host-desktop`, { headers })).status, 404);
    const views = await fetch(`${base}/views?scope=bot:Viewer`, { headers }).then((response) => response.json());
    assert.deepEqual(views.workspaces.map((entry: { id: string }) => entry.id), [ID]);
    assert.equal((await post("/input", { id: ID, token: "stale-token", action: "key", keys: "Return" })).status, 403);
    const taken = await post("/control", { id: ID, action: "take" }); assert.equal(taken.status, 200); const { token } = await taken.json();
    assert.equal((await post("/input", { id: OTHER, token, action: "key", keys: "Return" })).status, 403);
    calls.length = 0;
    assert.equal((await post("/input", { id: ID, token, action: "type", text: "private-login-fixture" })).status, 200);
    assert.deepEqual(calls[0].args, ["workspace", "type", "--id", ID, "--", "private-login-fixture"]);
    const status = await fetch(`${base}/views?scope=bot:Viewer`, { headers }).then((response) => response.text());
    assert.doesNotMatch(status, new RegExp(`${token}|private-login-fixture`));
    const frame = await fetch(`${base}/frame?id=${ID}`, { headers }); assert.equal(frame.status, 200); assert.equal(frame.headers.get("content-type"), "image/png"); assert.equal(frame.headers.get("cache-control"), "no-store"); assert.deepEqual(Buffer.from(await frame.arrayBuffer()), PNG);
    assert.equal((await post("/control", { id: ID, action: "release", token })).status, 200);
    assert.equal((await post("/input", { id: ID, token, action: "click", x: 0, y: 0 })).status, 403);
    assert.equal(existsSync(join(directory, "live-frames", `${ID}.png`)), false);
  });
});
