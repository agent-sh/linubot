import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createComputer } from "../src/computer/workspace.ts";
import type { StartOptions } from "../src/computer/workspace.ts";
import { InputError } from "../src/errors.ts";

const previousData = process.env.LINUBOT_DATA;
const root = mkdtempSync(join(tmpdir(), "linubot-computer-"));
process.env.LINUBOT_DATA = root;
const ID = "linubot-00000000-0000-4000-8000-000000000001";
const OTHER = "linubot-00000000-0000-4000-8000-000000000002";
const startOptions = { purpose: "verify fake clicks", acknowledge: true, id: ID };

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { mode: 0o700 });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
  if (previousData === undefined) delete process.env.LINUBOT_DATA;
  else process.env.LINUBOT_DATA = previousData;
});

function fake(seen: string[][], intercept?: (args: string[]) => string | undefined | Promise<string | undefined>) {
  return createComputer(async (args: string[]) => {
    seen.push([...args]);
    const overridden = await intercept?.(args);
    if (overridden !== undefined) return overridden;
    const id = args[args.indexOf("--id") + 1];
    if (args[1] === "start" && args.includes("--dry-run")) {
      return JSON.stringify({ ok: true, start_preview: { id, already_running: false, ok_to_start: true, would_start: true } });
    }
    if (args[1] === "cleanup") return JSON.stringify({ dry_run: false, removed: [{ id }], skipped: [] });
    return JSON.stringify({ ok: true, status: { id, ready: args[1] !== "stop", session_id: `session-${id}` } });
  });
}

describe("owned computer workspaces", () => {
  it("requires explicit approval and a purpose, and rejects arbitrary IDs and host profiles before any call", async () => {
    const seen: string[][] = [];
    const c = fake(seen);
    for (const patch of [
      { purpose: "" }, { purpose: null }, { purpose: "x".repeat(2001) },
      { acknowledge: undefined }, { acknowledge: false }, { acknowledge: "true" },
      { id: "default" }, { id: "host-owned" }, { id: "linubot-arbitrary" }, { id: "../other" }, { id: "" },
      { profile: "host-profile" }, { profile: "linubot-profile" }, { profile: "" },
      { width: 0 }, { width: 8193 }, { height: -1 }, { height: NaN }, { dryRun: "true" },
    ]) await assert.rejects(c.start({ ...startOptions, ...patch } as StartOptions), InputError, JSON.stringify(patch));
    assert.deepEqual(seen, []);
    assert.equal(c.owns(ID), false);
    assert.equal("run" in c, false);
  });

  it("generates unique namespaced UUIDs and stores only successful starts", async () => {
    const seen: string[][] = [];
    const c = fake(seen);
    const a = await c.start({ purpose: "fake A", acknowledge: true });
    const b = await c.start({ purpose: "fake B", acknowledge: true });
    assert.match(a.id, /^linubot-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(a.id, b.id);
    assert.equal(a.dryRun, false);
    assert.equal(c.owns(a.id), true);
    assert.equal(c.owns(b.id), true);
    assert.equal(JSON.parse(readFileSync(join(root, "computer-workspaces.json"), "utf8")).length, 2);
    assert.equal(statSync(join(root, "computer-workspaces.json")).mode & 0o777, 0o600);
    assert.equal(seen.filter((args) => args.includes("--dry-run")).length, 2);
  });

  it("previews without adopting the preview ID and refuses an existing backend workspace", async () => {
    const seen: string[][] = [];
    const c = fake(seen);
    const preview = await c.start({ ...startOptions, dryRun: true, width: 1200, height: 800 });
    assert.equal(preview.id, ID);
    assert.equal(preview.dryRun, true);
    assert.equal(c.owns(ID), false);
    assert.deepEqual(seen, [["workspace", "start", "--ack-hidden-workspace", "--purpose", "verify fake clicks", "--id", ID, "--width", "1200", "--height", "800", "--dry-run"]]);
    await assert.rejects(c.stop(ID), /unknown linubot-owned/);
    assert.deepEqual(JSON.parse(await c.list()), { workspaces: [] });
    for (const record of [
      { id: OTHER, already_running: false, ok_to_start: true, would_start: true },
      { id: ID, already_running: true, ok_to_start: true, would_start: false },
      { id: ID, already_running: false, ok_to_start: false, would_start: false, message: "runtime unavailable" },
    ]) {
      const blockedSeen: string[][] = [];
      const blocked = fake(blockedSeen, () => JSON.stringify({ ok: true, start_preview: record }));
      await assert.rejects(blocked.start(startOptions), /wrong ID|already-running|runtime unavailable/);
      assert.equal(blockedSeen.length, 1);
      assert.equal(blocked.owns(ID), false);
    }
  });

  it("never treats arbitrary stdout, missing readiness, or the wrong returned ID as ownership", async () => {
    for (const reply of [
      "ws-1\n", "null", "{}", JSON.stringify({ ok: false, message: "denied" }),
      JSON.stringify({ ok: true, status: { id: OTHER, ready: true } }),
      JSON.stringify({ ok: true, status: { id: ID, ready: false } }),
      JSON.stringify({ ok: true, status: { id: ID } }),
      JSON.stringify({ ok: true, status: { id: ID, ready: true }, message: "workspace is already running" }),
    ]) {
      const seen: string[][] = [];
      const c = fake(seen, (args) => args[1] === "start" && !args.includes("--dry-run") ? reply : undefined);
      await assert.rejects(c.start(startOptions), /JSON|invalid|wrong ID|unready|failed|already-running/);
      assert.equal(c.owns(ID), false);
      assert.equal(c.owns(OTHER), false);
      const before = seen.length;
      await assert.rejects(c.stop(ID), /unknown linubot-owned/);
      assert.equal(seen.length, before);
    }
    const failed = fake([], () => { throw new Error("backend unavailable"); });
    await assert.rejects(failed.start(startOptions), /backend unavailable/);
    assert.equal(failed.owns(ID), false);
  });

  it("does not expose a handle while start is pending or allow concurrent adoption of it", async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const starting = new Promise<void>((resolve) => { entered = resolve; });
    t.after(() => release());
    const seen: string[][] = [];
    const c = fake(seen, async (args) => {
      if (args[1] === "start" && !args.includes("--dry-run")) { entered(); await gate; }
      return undefined;
    });
    const operation = c.start(startOptions);
    await starting;
    assert.equal(c.owns(ID), false);
    await assert.rejects(c.status(ID), /unknown linubot-owned/);
    await assert.rejects(fake([]).start(startOptions), /already owned or starting/);
    release();
    await operation;
    assert.equal(c.owns(ID), true);
    await assert.rejects(c.start(startOptions), /already owned or starting/);
  });

  it("rejects missing, arbitrary and unowned IDs for every scoped action without contacting the backend", async () => {
    const seen: string[][] = [];
    const c = fake(seen);
    const operations = [
      (id: string) => c.status(id), (id: string) => c.stop(id), (id: string) => c.cleanup(id),
      (id: string) => c.launch("fake", [], { id }), (id: string) => c.exec("fake", [], { id }),
      (id: string) => c.observe({ id }), (id: string) => c.screenshot(join(root, "fake.png"), id),
      (id: string) => c.windows(id), (id: string) => c.activeWindow(id), (id: string) => c.focusWindow("Fake", id),
      (id: string) => c.click(1, 2, id), (id: string) => c.type("fake", id), (id: string) => c.key("Return", id),
      (id: string) => c.scroll(1, 2, "down", id), (id: string) => c.openViewer(id),
      (id: string) => c.openBrowser(id), (id: string) => c.browserTargets(id),
      (id: string) => c.browserNavigate("https://example.com", id), (id: string) => c.browserSnapshot(id),
      (id: string) => c.killApp("fake", id), (id: string) => c.appLogs("fake", id),
    ];
    for (const id of [undefined, "", "default", "host-workspace", "linubot-arbitrary", OTHER]) {
      for (const operation of operations) await assert.rejects(operation(id as string), /explicit linubot-owned|unknown linubot-owned/);
    }
    await assert.rejects(c.observe(), /explicit linubot-owned/);
    await assert.rejects(c.exec("fake"), /explicit linubot-owned/);
    await assert.rejects(c.launch("fake"), /explicit linubot-owned/);
    assert.deepEqual(seen, []);
  });

  it("persists handles for a new adapter and lists only those scoped statuses, including errors", async () => {
    const seen: string[][] = [];
    const c = fake(seen);
    await c.start(startOptions);
    await c.start({ ...startOptions, id: OTHER });
    seen.length = 0;
    const restarted = fake(seen, (args) => {
      if (args[1] === "status" && args.includes(OTHER)) throw new Error("offline");
      return undefined;
    });
    assert.equal(restarted.owns(ID), true);
    const list = JSON.parse(await restarted.list());
    assert.deepEqual(list.workspaces.map((entry: { id: string }) => entry.id), [ID, OTHER]);
    assert.equal(list.workspaces[0].status.id, ID);
    assert.match(list.workspaces[1].error, /offline/);
    assert.deepEqual(seen, [["workspace", "status", "--id", ID], ["workspace", "status", "--id", OTHER]]);
  });

  it("passes exact scoped argv for input, observation, browsers, and viewers", async () => {
    const seen: string[][] = [];
    const c = fake(seen);
    await c.start(startOptions);
    seen.length = 0;
    const output = join(root, "fake.png");
    await c.screenshot(output, ID);
    await c.observe({ id: ID, screenshot: true, output, allWindows: true });
    await c.windows(ID);
    await c.activeWindow(ID);
    await c.focusWindow("Fake app", ID);
    await c.click(100, 200, ID);
    await c.type("hello world", ID);
    await c.key("ctrl+s", ID);
    await c.scroll(100, 200, "down", ID, 4);
    await c.openBrowser(ID);
    await c.browserTargets(ID);
    await c.browserNavigate("https://example.com", ID);
    await c.browserSnapshot(ID);
    await c.killApp("fake-app", ID);
    await c.appLogs("fake-app", ID);
    const expected = [
      ["screenshot", "--output", output], ["observe", "--screenshot", "--output", output, "--all-windows"],
      ["windows"], ["active-window"], ["focus-window", "--title", "Fake app"], ["click", "100", "200"],
      ["type", "hello world"], ["key", "ctrl+s"], ["scroll", "--amount", "4", "100", "200", "down"],
      ["open-browser", "--browser", fileURLToPath(new URL("../desktop/linubot-chrome.sh", import.meta.url))], ["browser-targets"], ["browser-navigate", "https://example.com"], ["browser-snapshot"],
      ["kill-app", "fake-app"], ["logs", "fake-app"],
    ];
    assert.deepEqual(seen, expected.map(([command, ...args]) => ["workspace", command, "--id", ID, ...(["key", "type"].includes(command) ? ["--"] : []), ...args]));
    await c.openViewer(ID);
    await c.openViewer(ID, { inputForwarding: true });
    assert.deepEqual(seen.slice(-2), [
      ["viewer", "--id", ID, "--exit-when-workspace-gone"],
      ["viewer", "--id", ID, "--exit-when-workspace-gone", "--input-forwarding"],
    ]);
  });

  it("separates app arguments from scoped flags and applies bounded kill-on-timeout execution", async () => {
    const seen: string[][] = [];
    const c = fake(seen);
    await c.start(startOptions);
    seen.length = 0;
    await c.exec("fake-command", ["--id", "not-the-workspace"], { id: ID, name: "fake", timeoutMs: 5000 });
    await c.exec("fake-command", [], { id: ID });
    await c.launch("fake-command", ["a b"], { id: ID, name: "fake", cwd: "/fake cwd" });
    assert.deepEqual(seen, [
      ["workspace", "run", "--id", ID, "--timeout-ms", "5000", "--kill-on-timeout", "--name", "fake", "--", "fake-command", "--id", "not-the-workspace"],
      ["workspace", "run", "--id", ID, "--timeout-ms", "30000", "--kill-on-timeout", "--", "fake-command"],
      ["workspace", "launch", "--id", ID, "--name", "fake", "--cwd", "/fake cwd", "--", "fake-command", "a b"],
    ]);
    for (const timeoutMs of [0, -1, 60001, NaN, 2.5]) await assert.rejects(c.exec("fake", [], { id: ID, timeoutMs }), InputError);
    await assert.rejects(c.click(NaN, 0, ID), InputError);
    await assert.rejects(c.scroll(1, 2, "diagonal" as "up", ID), InputError);
    assert.equal(seen.length, 3);
  });

  it("surfaces backend status and session mismatches instead of trusting them", async () => {
    const c = fake([]);
    await c.start(startOptions);
    for (const reply of [
      "not-json", JSON.stringify({ ok: false, message: "gone" }),
      JSON.stringify({ ok: true, status: { id: OTHER } }),
      JSON.stringify({ ok: true, status: { id: ID, session_id: "unrelated-session" } }),
    ]) await assert.rejects(fake([], () => reply).status(ID), /JSON|failed|wrong ID|different session/);
    await assert.rejects(fake([], () => { throw new Error("gone"); }).status(ID), /gone/);
  });

  it("does not record a stopped handle for a partial response, live status, or dry-run", async () => {
    const c = fake([]);
    await c.start(startOptions);
    for (const reply of [
      { ok: true },
      { ok: true, status: { id: ID } },
      { ok: true, status: { id: ID, ready: true } },
      { ok: true, status: { id: ID, ready: false }, dry_run: true },
    ]) {
      await assert.rejects(fake([], () => JSON.stringify(reply)).stop(ID), /did not confirm shutdown/);
      assert.equal(JSON.parse(readFileSync(join(root, "computer-workspaces.json"), "utf8"))[0].state, "running");
      await assert.rejects(c.cleanup(ID), /stop the owned workspace/);
    }
    await c.stop(ID);
    for (const reply of [
      { removed: [], skipped: [] },
      { dry_run: true, removed: [], skipped: [] },
      { dry_run: false },
    ]) {
      await assert.rejects(fake([], () => JSON.stringify(reply)).cleanup(ID), /invalid scoped cleanup/);
      assert.equal(c.owns(ID), true);
    }
    await c.cleanup(ID);
  });

  it("retains ownership on stop/cleanup failure and forgets only confirmed scoped cleanup", async () => {
    const seen: string[][] = [];
    let failStop = true;
    let skipCleanup = true;
    const c = fake(seen, (args) => {
      if (args[1] === "stop" && failStop) return JSON.stringify({ ok: false, message: "stop failed" });
      if (args[1] === "cleanup" && skipCleanup) return JSON.stringify({ dry_run: false, removed: [], skipped: [{ id: ID, reason: "busy" }] });
      return undefined;
    });
    await c.start(startOptions);
    await assert.rejects(c.cleanup(ID), /stop the owned workspace/);
    await assert.rejects(c.stop(ID), /stop failed/);
    assert.equal(c.owns(ID), true);
    failStop = false;
    await c.stop(ID);
    const stops = seen.filter((args) => args[1] === "stop").length;
    await c.stop(ID);
    assert.equal(seen.filter((args) => args[1] === "stop").length, stops);
    assert.deepEqual(seen.find((args) => args[1] === "stop"), ["workspace", "stop", "--id", ID, "--timeout-ms", "30000"]);
    await assert.rejects(c.cleanup(ID), /cleanup skipped: busy/);
    assert.equal(c.owns(ID), true);
    await assert.rejects(fake([], () => JSON.stringify({ removed: [{ id: OTHER }], skipped: [] })).cleanup(ID), /invalid scoped cleanup/);
    skipCleanup = false;
    await c.cleanup(ID);
    assert.equal(c.owns(ID), false);
    const count = seen.length;
    await assert.rejects(c.stop(ID), /unknown linubot-owned/);
    await assert.rejects(c.cleanup(ID), /unknown linubot-owned/);
    assert.equal(seen.length, count);
    assert.deepEqual(JSON.parse(await c.list()), { workspaces: [] });
  });
});
