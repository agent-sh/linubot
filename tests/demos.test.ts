import { after, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createComputer } from "../src/computer/workspace.ts";
import { InputError } from "../src/errors.ts";
import { writeJson } from "../src/store.ts";
import { readInstalledSkill } from "../src/marketplace/search.ts";
import { saveSkill } from "../src/memory/updater.ts";
import { appendDemoLog, cancelDemo, captureDemo, finishDemo, listDemos, readDemoLog, startDemo, writeDemoLog } from "../src/teach/demos.ts";

const previousData = process.env.LINUBOT_DATA;
const root = mkdtempSync(join(tmpdir(), "linubot-demos-"));
process.env.LINUBOT_DATA = root;
const CLOCK = "2026-09-07T08:00:00.000Z";
const approval = { acknowledge: true };

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { mode: 0o700 });
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: Date.parse(CLOCK) });
  writeJson(join(root, "profiles", "seller", "profile.json"), { name: "seller", model: "fake", createdAt: CLOCK });
});

after(() => {
  mock.timers.reset();
  rmSync(root, { recursive: true, force: true });
  if (previousData === undefined) delete process.env.LINUBOT_DATA;
  else process.env.LINUBOT_DATA = previousData;
});

function fake(seen: string[][] = [], intercept?: (args: string[]) => string | undefined | Promise<string | undefined>) {
  return createComputer(async (args) => {
    seen.push([...args]);
    const overridden = await intercept?.(args);
    if (overridden !== undefined) return overridden;
    const id = args[args.indexOf("--id") + 1];
    if (args[1] === "start" && args.includes("--dry-run")) {
      return JSON.stringify({ ok: true, start_preview: { id, already_running: false, ok_to_start: true, would_start: true } });
    }
    if (args[1] === "screenshot") writeFileSync(args[args.indexOf("--output") + 1], "fake screenshot", { mode: 0o600 });
    if (args[1] === "cleanup") return JSON.stringify({ dry_run: false, removed: [{ id }], skipped: [] });
    return JSON.stringify({ ok: true, status: { id, ready: args[1] !== "stop", session_id: `fake-${id}` } });
  });
}

describe("manual demonstration lifecycle", () => {
  it("requires a known bot, purpose and explicit approval without creating any workspace on invalid input", async () => {
    const seen: string[][] = [];
    const c = fake(seen);
    await assert.rejects(startDemo(c, "seller", " ", approval), InputError);
    await assert.rejects(startDemo(c, "../seller", "test", approval), InputError);
    await assert.rejects(startDemo(c, "missing", "test", approval), InputError);
    await assert.rejects(startDemo(c, "seller", "test"), (error) => error instanceof InputError && error.status === 403);
    await assert.rejects(startDemo(c, "seller", "test", { acknowledge: false }), InputError);
    assert.deepEqual(seen, []);
    assert.deepEqual(listDemos(), []);
  });

  it("uses UUIDs even with a frozen clock and persists ownership before the initial screenshot", async () => {
    const seen: string[][] = [];
    const c = fake(seen, (args) => {
      if (args[1] === "screenshot") {
        const workspaceId = args[args.indexOf("--id") + 1];
        const demo = listDemos().find((entry) => entry.workspaceId === workspaceId)!;
        assert.equal(demo.state, "starting");
        assert.equal(demo.workspaceStarted, true);
        assert.equal(c.owns(workspaceId), true);
        const output = args[args.indexOf("--output") + 1];
        assert.equal(statSync(dirname(output)).mode & 0o777, 0o700);
        assert.equal(statSync(output).mode & 0o777, 0o600);
      }
      return undefined;
    });
    const demos = await Promise.all([
      startDemo(c, "seller", "open the report", approval),
      startDemo(c, "seller", "save the report", approval),
    ]);
    assert.notEqual(demos[0].id, demos[1].id);
    assert.equal(listDemos().length, 2);
    for (const demo of demos) {
      assert.match(demo.id, /^demo-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(demo.workspaceId, demo.id.replace("demo-", "linubot-"));
      assert.equal(demo.startedAt, CLOCK);
      assert.equal(demo.state, "recording");
      assert.equal(demo.finished, false);
      assert.equal(demo.shots.length, 1);
      assert.equal(statSync(demo.shots[0]).mode & 0o777, 0o600);
    }
    assert.equal(statSync(join(root, "demos")).mode & 0o777, 0o700);
    assert.equal(statSync(join(root, "demos.json")).mode & 0o777, 0o600);
    assert.equal(seen.some((args) => args[0] === "viewer"), false);
    await Promise.all(demos.map((demo) => cancelDemo(c, demo.id)));
  });

  it("records start errors without stopping an unowned or wrong backend workspace", async () => {
    const seen: string[][] = [];
    const c = fake(seen, (args) => {
      if (args[1] === "start" && !args.includes("--dry-run")) {
        return JSON.stringify({ ok: true, status: { id: "host-owned", ready: true } });
      }
      return undefined;
    });
    await assert.rejects(startDemo(c, "seller", "fake", approval), /wrong ID/);
    const demo = listDemos()[0];
    assert.equal(demo.state, "failed");
    assert.equal(demo.workspaceStarted, false);
    assert.match(demo.errors.join("\n"), /wrong ID/);
    assert.equal(seen.some((args) => ["stop", "cleanup"].includes(args[1])), false);
    const cancelled = await cancelDemo(c, demo.id);
    assert.equal(cancelled.cancelled, true);
    assert.equal(seen.some((args) => ["stop", "cleanup"].includes(args[1])), false);
  });

  it("compensates an initial screenshot failure and records the failed attempt", async () => {
    const seen: string[][] = [];
    const c = fake(seen, (args) => {
      if (args[1] === "screenshot") throw new Error("screenshot failed");
      return undefined;
    });
    await assert.rejects(startDemo(c, "seller", "fake", approval), /screenshot failed/);
    const demo = listDemos()[0];
    assert.equal(demo.state, "failed");
    assert.equal(demo.workspaceStarted, true);
    assert.equal(demo.workspaceStopped, true);
    assert.equal(demo.workspaceCleaned, true);
    assert.equal(c.owns(demo.workspaceId), false);
    assert.deepEqual(demo.shots, []);
    assert.match(demo.errors.join("\n"), /screenshot failed/);
    assert.equal(existsSync(join(root, "demos", demo.id, "start.png")), false);
    assert.deepEqual(seen.filter((args) => ["stop", "cleanup"].includes(args[1])).map((args) => args[1]), ["stop", "cleanup"]);
    await assert.rejects(finishDemo(c, demo.id, "empty-draft", "Nothing demonstrated"), /not started recording|not recording/);
  });

  it("does not accept a successful screenshot response with no artifact", async () => {
    const c = fake([], (args) => args[1] === "screenshot" ? JSON.stringify({ ok: true }) : undefined);
    await assert.rejects(startDemo(c, "seller", "fake", approval), /did not produce an artifact/);
    assert.equal(listDemos()[0].workspaceCleaned, true);
  });

  it("surfaces compensation stop failures alongside screenshot errors and retries safely on cancel", async () => {
    const seen: string[][] = [];
    let stopFails = true;
    const c = fake(seen, (args) => {
      if (args[1] === "screenshot") throw new Error("capture broke");
      if (args[1] === "stop" && stopFails) throw new Error("cannot stop");
      return undefined;
    });
    await assert.rejects(startDemo(c, "seller", "fake", approval), /capture broke.*stop failed.*cannot stop/);
    let demo = listDemos()[0];
    assert.equal(demo.state, "failed");
    assert.equal(demo.workspaceStopped, false);
    assert.equal(c.owns(demo.workspaceId), true);
    assert.match(demo.errors.join("\n"), /capture broke.*cannot stop/);
    assert.equal(seen.some((args) => args[1] === "cleanup"), false);
    stopFails = false;
    demo = await cancelDemo(c, demo.id);
    assert.equal(demo.cancelled, true);
    assert.equal(demo.workspaceCleaned, true);
    assert.equal(c.owns(demo.workspaceId), false);
  });

  it("retains cleanup failures and retries cleanup after an adapter restart without repeating stop", async () => {
    const seen: string[][] = [];
    const c = fake(seen, (args) => {
      if (args[1] === "screenshot") throw new Error("capture broke");
      if (args[1] === "cleanup") throw new Error("cannot clean");
      return undefined;
    });
    await assert.rejects(startDemo(c, "seller", "fake", approval), /capture broke.*cleanup failed.*cannot clean/);
    const demo = listDemos()[0];
    assert.equal(demo.workspaceStopped, true);
    assert.equal(demo.workspaceCleaned, false);
    assert.equal(c.owns(demo.workspaceId), true);
    const restartedSeen: string[][] = [];
    const restarted = fake(restartedSeen);
    const cancelled = await cancelDemo(restarted, demo.id);
    assert.equal(cancelled.workspaceCleaned, true);
    assert.deepEqual(restartedSeen.map((args) => args[1]), ["cleanup"]);
    assert.match(cancelled.errors.join("\n"), /cannot clean/);
  });

  it("recovers the ownership-to-recording interruption window using only the adapter's saved handle", async () => {
    const c = fake();
    const demo = await startDemo(c, "seller", "fake", approval);
    writeJson(join(root, "demos.json"), [{ ...demo, state: "starting", workspaceStarted: false, shots: [] }]);
    const restartedSeen: string[][] = [];
    const cancelled = await cancelDemo(fake(restartedSeen), demo.id);
    assert.equal(cancelled.workspaceStarted, true);
    assert.equal(cancelled.workspaceCleaned, true);
    assert.deepEqual(restartedSeen.map((args) => args[1]), ["stop", "cleanup"]);
  });

  it("serializes capture and finish, keeps all screenshots, and writes a reviewable draft from recorded steps", async (t) => {
    const seen: string[][] = [];
    let captureGate: Promise<void> | undefined;
    let entered!: () => void;
    const captureEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const c = fake(seen, async (args) => {
      if (args[1] === "screenshot" && captureGate) { entered(); await captureGate; }
      if (args[1] === "stop") {
        const demo = listDemos()[0];
        assert.equal(demo.state, "finishing");
        assert.throws(() => appendDemoLog(demo.id, "late note"), /cannot change/);
      }
      return undefined;
    });
    const demo = await startDemo(c, "seller", "export the report", approval);
    appendDemoLog(demo.id, "1. Open Reports and choose the current month.");
    appendDemoLog(demo.id, "2. Select Export and choose CSV.");
    assert.equal(statSync(join(root, "demos", demo.id, "notes.md")).mode & 0o777, 0o600);
    captureGate = new Promise<void>((resolve) => { release = resolve; });
    t.after(() => release());
    seen.length = 0;
    const first = captureDemo(c, demo.id);
    const second = captureDemo(c, demo.id);
    const finish = finishDemo(c, demo.id, "export-report", "3. Verify the CSV contains this month's rows.");
    await captureEntered;
    assert.deepEqual(seen.map((args) => args[1]), ["screenshot"]);
    release();
    const [one, two, result] = await Promise.all([first, second, finish]);
    assert.equal(one.shots.length, 2);
    assert.equal(two.shots.length, 3);
    assert.deepEqual(result.demo.shots.map((shot) => basename(shot)), ["start.png", "shot-1.png", "shot-2.png"]);
    assert.equal(result.demo.state, "finished");
    assert.equal(result.created, true);
    assert.equal(result.demo.skill, "export-report");
    assert.equal(result.demo.finishedAt, CLOCK);
    assert.deepEqual(seen.map((args) => args[1]), ["screenshot", "screenshot", "stop", "cleanup"]);
    const draft = readInstalledSkill("export-report", true)!;
    assert.equal(draft.status, "draft");
    assert.equal(readInstalledSkill("export-report"), null);
    assert.match(draft.body, /Open Reports/);
    assert.match(draft.body, /Select Export/);
    assert.match(draft.body, /Verify the CSV/);
    assert.match(draft.body, /manual demonstration/);
    assert.match(draft.body, /Not automatically learned, tested, or verified/);
    assert.equal(statSync(join(root, "skills", "export-report", "SKILL.md")).mode & 0o777, 0o600);
    assert.match(readDemoLog(demo.id), /Select Export/);
    const count = seen.length;
    const repeated = await finishDemo(c, demo.id, "export-report", "ignored on retry");
    assert.equal(repeated.created, false);
    assert.equal(seen.length, count);
    assert.equal((await cancelDemo(c, demo.id)).skill, "export-report");
    assert.equal(seen.length, count);
    await assert.rejects(finishDemo(c, demo.id, "different-name", "notes"), /different outcome/);
    await assert.rejects(captureDemo(c, demo.id), /not recording/);
    assert.throws(() => writeDemoLog(demo.id, "changed"), /cannot change/);
  });

  it("validates exact skill names, recorded steps, and overwrite conflicts before stopping", async () => {
    const seen: string[][] = [];
    const c = fake(seen);
    const demo = await startDemo(c, "seller", "fake", approval);
    const calls = seen.length;
    for (const name of ["", "Bad Name", "../escape", " leading", "trailing ", "a".repeat(41)]) {
      await assert.rejects(finishDemo(c, demo.id, name, "one recorded step"), /invalid skill name/);
    }
    await assert.rejects(finishDemo(c, demo.id, "missing-steps", " "), /steps or notes/);
    saveSkill({ name: "existing", description: "existing", body: "keep this", status: "draft" });
    await assert.rejects(finishDemo(c, demo.id, "existing", "do not overwrite"), (error) => error instanceof InputError && error.status === 409);
    mkdirSync(join(root, "skills", "reserved"), { mode: 0o700 });
    await assert.rejects(finishDemo(c, demo.id, "reserved", "do not overwrite"), (error) => error instanceof InputError && error.status === 409);
    assert.equal(readInstalledSkill("existing", true)?.body, "keep this");
    assert.equal(seen.length, calls);
    assert.equal(listDemos()[0].state, "recording");
    await cancelDemo(c, demo.id);
  });

  it("reports a save collision between demos without overwriting or claiming success", async () => {
    const c = fake();
    const a = await startDemo(c, "seller", "A", approval);
    const b = await startDemo(c, "seller", "B", approval);
    const results = await Promise.allSettled([
      finishDemo(c, a.id, "same-name", "A: open the report"),
      finishDemo(c, b.id, "same-name", "B: close the report"),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const collision = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.equal(collision.reason.status, 409);
    const failed = listDemos().find((entry) => entry.state === "failed")!;
    assert.ok(failed);
    assert.equal(failed.finished, false);
    assert.equal(failed.workspaceCleaned, true);
    assert.match(failed.errors.join("\n"), /nothing was overwritten/);
    assert.equal(listDemos().filter((entry) => entry.state === "finished").length, 1);
    await cancelDemo(c, failed.id);
  });

  it("records capture failure and permits explicit cancellation without creating a skill", async () => {
    let failCapture = false;
    const c = fake([], (args) => {
      if (args[1] === "screenshot" && failCapture) throw new Error("capture failed");
      return undefined;
    });
    const demo = await startDemo(c, "seller", "fake", approval);
    failCapture = true;
    await assert.rejects(captureDemo(c, demo.id), /capture failed/);
    assert.equal(listDemos()[0].state, "failed");
    assert.equal(listDemos()[0].shots.length, 1);
    assert.equal(c.owns(demo.workspaceId), true);
    assert.equal(existsSync(join(root, "demos", demo.id, "shot-1.png")), false);
    const cancelled = await cancelDemo(c, demo.id);
    assert.equal(cancelled.state, "finished");
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.skill, undefined);
    assert.equal(c.owns(demo.workspaceId), false);
    await assert.rejects(finishDemo(c, demo.id, "should-not-exist", "notes"), /different outcome/);
  });

  it("surfaces finish stop and cleanup failures, saves no premature skill, and retries only unfinished work", async () => {
    for (const failedAction of ["stop", "cleanup"]) {
      const seen: string[][] = [];
      let failing = true;
      const c = fake(seen, (args) => {
        if (args[1] === failedAction && failing) throw new Error(`fake ${failedAction} error`);
        return undefined;
      });
      const demo = await startDemo(c, "seller", failedAction, approval);
      const name = `retry-${failedAction}`;
      await assert.rejects(finishDemo(c, demo.id, name, "1. Follow the recorded control."), new RegExp(`${failedAction} failed`));
      let saved = listDemos().find((entry) => entry.id === demo.id)!;
      assert.equal(saved.state, "failed");
      assert.equal(saved.finished, false);
      assert.equal(readInstalledSkill(name, true), null);
      assert.match(saved.errors.join("\n"), new RegExp(`fake ${failedAction} error`));
      assert.equal(c.owns(demo.workspaceId), true);
      failing = false;
      saved = (await finishDemo(c, demo.id, name, "1. Follow the recorded control.")).demo;
      assert.equal(saved.state, "finished");
      assert.equal(saved.workspaceCleaned, true);
      assert.equal(readInstalledSkill(name, true)?.status, "draft");
      assert.equal(seen.filter((args) => args[1] === "stop").length, failedAction === "stop" ? 2 : 1);
    }
  });

  it("validates log IDs and refuses tampered workspace associations before any action", async () => {
    const seen: string[][] = [];
    const c = fake(seen);
    const demo = await startDemo(c, "seller", "fake", approval);
    assert.equal(readDemoLog(demo.id), "");
    for (const id of ["../outside", "../../notes", "demo-../../outside", "", "demo-00000000-0000-4000-8000-000000000000"]) {
      assert.throws(() => appendDemoLog(id, "notes"), InputError);
      assert.throws(() => readDemoLog(id), InputError);
      assert.throws(() => writeDemoLog(id, "notes"), InputError);
      await assert.rejects(cancelDemo(c, id), InputError);
    }
    writeDemoLog(demo.id, "first step");
    appendDemoLog(demo.id, "second step");
    assert.equal(readDemoLog(demo.id), "first step\nsecond step\n");
    const unrelated = await c.start({ purpose: "unrelated fake workspace", acknowledge: true });
    writeJson(join(root, "demos.json"), [{ ...demo, workspaceId: unrelated.id }]);
    const calls = seen.length;
    await assert.rejects(cancelDemo(c, demo.id), /ownership mismatch/);
    await assert.rejects(finishDemo(c, demo.id, "draft", "notes"), /ownership mismatch/);
    await assert.rejects(captureDemo(c, demo.id), /ownership mismatch/);
    assert.equal(seen.length, calls);
    assert.equal(c.owns(unrelated.id), true);
    assert.equal(c.owns(demo.workspaceId), true);
  });

  it("rejects linked notes and artifact directories rather than reading or writing outside the demo", async () => {
    const seen: string[][] = [];
    const c = fake(seen);
    const demo = await startDemo(c, "seller", "fake", approval);
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "leave unchanged", { mode: 0o600 });
    const dir = join(root, "demos", demo.id);
    const notes = join(dir, "notes.md");
    symlinkSync(outside, notes);
    assert.throws(() => readDemoLog(demo.id), /unsafe/);
    assert.throws(() => writeDemoLog(demo.id, "changed"), /unsafe/);
    assert.throws(() => appendDemoLog(demo.id, "changed"), /unsafe/);
    assert.equal(readFileSync(outside, "utf8"), "leave unchanged");
    rmSync(notes);
    const moved = join(root, "moved-artifacts");
    renameSync(dir, moved);
    symlinkSync(moved, dir, "dir");
    const calls = seen.length;
    assert.throws(() => readDemoLog(demo.id), /unsafe/);
    await assert.rejects(captureDemo(c, demo.id), /unsafe/);
    assert.equal(seen.length, calls);
    await cancelDemo(c, demo.id);
    assert.equal(readFileSync(outside, "utf8"), "leave unchanged");
  });

  it("rejects a symlinked artifact root before starting or changing its permissions", async () => {
    const outside = join(root, "outside-directory");
    mkdirSync(outside, { mode: 0o755 });
    const mode = statSync(outside).mode & 0o777;
    symlinkSync(outside, join(root, "demos"), "dir");
    const seen: string[][] = [];
    await assert.rejects(startDemo(fake(seen), "seller", "fake", approval), /unsafe demo artifact directory/);
    assert.deepEqual(seen, []);
    assert.deepEqual(listDemos(), []);
    assert.equal(statSync(outside).mode & 0o777, mode);
  });

  it("makes repeated finish and cancel calls harmless to unrelated owned workspaces", async () => {
    const seen: string[][] = [];
    const c = fake(seen);
    const demo = await startDemo(c, "seller", "fake", approval);
    const unrelated = await c.start({ purpose: "unrelated fake workspace", acknowledge: true });
    const results = await Promise.all([
      finishDemo(c, demo.id, "finished-demo", "1. Review the fake state."),
      finishDemo(c, demo.id, "finished-demo", "1. Review the fake state."),
    ]);
    assert.deepEqual(results.map((result) => result.created), [true, false]);
    const count = seen.length;
    await cancelDemo(c, demo.id);
    await finishDemo(c, demo.id, "finished-demo", "");
    assert.equal(seen.length, count);
    assert.equal(c.owns(unrelated.id), true);
    const teardown = seen.filter((args) => ["stop", "cleanup"].includes(args[1]));
    assert.equal(teardown.length, 2);
    assert.ok(teardown.every((args) => args[args.indexOf("--id") + 1] === demo.workspaceId));
    const stored = JSON.parse(readFileSync(join(root, "demos.json"), "utf8"));
    assert.equal(stored[0].state, "finished");
  });
});
