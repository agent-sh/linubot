import { after, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeJson } from "../src/store.ts";
import { InputError } from "../src/errors.ts";
import type { CronJob, Execution } from "../src/crons/scheduler.ts";

const previousData = process.env.LINUBOT_DATA;
const root = mkdtempSync(join(tmpdir(), "linubot-crons-"));
process.env.LINUBOT_DATA = root;
const { addJob, isDue, listExecutions, listJobs, logExecution, nextRun, normalizeSchedule, removeJob, runDue } =
  await import("../src/crons/scheduler.ts");

const MON_0800 = new Date("2026-09-07T08:00:00Z");
const job: CronJob = { name: "brief", schedule: "daily 8:00", prompt: "Brief me", bot: "seller" };

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { mode: 0o700 });
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: MON_0800.getTime() });
  for (const name of ["seller", "other", "ghost"]) {
    writeJson(join(root, "profiles", name, "profile.json"), { name, model: "fake", createdAt: MON_0800.toISOString() });
  }
  writeJson(join(root, "groups.json"), [{ id: "team", members: ["seller", "other"] }]);
});

after(() => {
  mock.timers.reset();
  rmSync(root, { recursive: true, force: true });
  if (previousData === undefined) delete process.env.LINUBOT_DATA;
  else process.env.LINUBOT_DATA = previousData;
});

function inputError(error: unknown): boolean {
  return error instanceof InputError && error.status === 400;
}

describe("cron schedules", () => {
  it("normalizes and validates", () => {
    assert.equal(normalizeSchedule("hourly"), "0 * * * *");
    assert.equal(normalizeSchedule("daily 8:05"), "5 8 * * *");
    assert.equal(normalizeSchedule(" WEEKLY Monday 9:30 "), "30 9 * * 1");
    assert.equal(normalizeSchedule("1,5-9/2   * * * 7"), "1,5-9/2 * * * 7");
    assert.throws(() => normalizeSchedule("daily 25:00"), /bad hour/);
    for (const schedule of ["", "sometimes", "weekly never 8:00", "weekly constructor 8:00", "daily 8:60", "* * * *", "* * * * * *"]) {
      assert.throws(() => normalizeSchedule(schedule), inputError, schedule);
    }
    for (const field of ["1-2-3", "9-2", "1,,2", "1,", ",1", "-1", "+1", "1e1", "0x10", "1.5", "*/0", "*/61", "*/-1", "*/1.5", "*/", "/2", "1/2/3", "1-*", "*-2"]) {
      assert.throws(() => normalizeSchedule(`${field} * * * *`), inputError, field);
    }
    for (const schedule of ["60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "* * * * 6-8"]) {
      assert.throws(() => normalizeSchedule(schedule), inputError, schedule);
    }
    assert.throws(() => normalizeSchedule(null as unknown as string), inputError);
  });

  it("matches UTC minutes", () => {
    assert.equal(isDue("0 8 * * *", MON_0800), true);
    assert.equal(isDue("0 8 * * *", new Date("2026-09-07T08:01:00Z")), false);
    assert.equal(isDue("*/15 * * * *", new Date("2026-09-07T08:30:00Z")), true);
    assert.equal(isDue("weekly tue 8:00", MON_0800), false);
    assert.equal(isDue("daily 8:00"), true);
  });

  it("applies Sunday 7 only to the weekday field, including ranges and steps", () => {
    const sunday = new Date("2026-09-06T00:00:00Z");
    assert.equal(isDue("7 * * * *", sunday), false);
    assert.equal(isDue("* 7 * * *", sunday), false);
    for (const weekday of ["0", "7", "6-7", "5-7/2", "1-7/2", "0,7", "7/2"]) {
      assert.equal(isDue(`0 0 * * ${weekday}`, sunday), true, weekday);
    }
    assert.equal(isDue("0 0 * * 5-7/2", new Date("2026-09-05T00:00:00Z")), false);
    assert.equal(isDue("0 0 * * 1-6", sunday), false);
  });

  it("anchors wildcard steps at each field's minimum and steps single values to its maximum", () => {
    assert.equal(isDue("0 0 */2 */2 *", new Date("2026-01-01T00:00:00Z")), true);
    assert.equal(isDue("0 0 */2 */2 *", new Date("2026-01-02T00:00:00Z")), false);
    assert.equal(isDue("0 0 */2 */2 *", new Date("2026-02-01T00:00:00Z")), false);
    for (const minute of [5, 20, 35, 50]) assert.equal(isDue("5/15 * * * *", new Date(`2026-09-07T08:${String(minute).padStart(2, "0")}:00Z`)), true);
    assert.equal(isDue("5/15 * * * *", MON_0800), false);
    assert.equal(isDue("0 8-12/2 * * *", new Date("2026-09-07T10:00:00Z")), true);
    assert.equal(isDue("0 8-12/2 * * *", new Date("2026-09-07T11:00:00Z")), false);
  });

  it("uses cron OR semantics for restricted DOM/DOW, but AND for wildcard fields", () => {
    assert.equal(isDue("0 8 13 * 1", MON_0800), true);
    assert.equal(isDue("0 8 13 * 1", new Date("2026-09-13T08:00:00Z")), true);
    assert.equal(isDue("0 8 13 * 1", new Date("2026-09-08T08:00:00Z")), false);
    assert.equal(isDue("0 8 13 * *", MON_0800), false);
    assert.equal(isDue("0 8 * * 1", new Date("2026-09-13T08:00:00Z")), false);
    assert.equal(isDue("0 8 */2 * 1", MON_0800), true);
    assert.equal(isDue("0 8 */2 * 1", new Date("2026-09-14T08:00:00Z")), false);
    assert.equal(isDue("0 8 13 10 1", MON_0800), false);
  });

  it("finds the next strictly later UTC minute without an unbounded search", () => {
    assert.equal(nextRun("hourly"), "2026-09-07T09:00:00.000Z");
    assert.equal(nextRun("daily 8:00", new Date("2026-09-07T07:59:59.999Z")), "2026-09-07T08:00:00.000Z");
    assert.equal(nextRun("daily 8:00", MON_0800), "2026-09-08T08:00:00.000Z");
    assert.equal(nextRun("0 8 13 * 1", MON_0800), "2026-09-13T08:00:00.000Z");
    assert.equal(nextRun("0 0 29 2 *", new Date("2025-03-01T00:00:00Z")), "2028-02-29T00:00:00.000Z");
    assert.equal(nextRun("0 0 29 2 *", new Date("2096-02-29T00:00:00Z")), "2104-02-29T00:00:00.000Z");
    assert.equal(nextRun("0 0 31 2 *", MON_0800), null);
    assert.throws(() => nextRun("broken"), inputError);
    assert.throws(() => nextRun("hourly", new Date(NaN)), inputError);
    assert.throws(() => isDue("hourly", new Date(NaN)), inputError);
  });
});

describe("durable cron jobs", () => {
  it("validates job fields and only accepts existing local delivery targets", () => {
    for (const patch of [
      { name: "" }, { name: "bad/name" }, { name: "a".repeat(41) }, { name: null },
      { bot: "" }, { bot: "../seller" }, { bot: "missing" }, { bot: null },
      { prompt: " " }, { prompt: 42 }, { prompt: "x".repeat(20001) },
      { enabled: "true" }, { enabled: null }, { deliver: 42 }, { deliver: null },
      { deliver: "telegram" }, { deliver: "https://example.com" }, { deliver: "email:user@example.com" },
      { deliver: "bot:missing" }, { deliver: "group:missing" }, { deliver: "bot:../seller" }, { deliver: "group:team:extra" },
    ]) assert.throws(() => addJob({ ...job, ...patch } as CronJob), inputError, JSON.stringify(patch));
    assert.deepEqual(listJobs(), []);
    addJob({ ...job, deliver: " " });
    assert.equal(listJobs()[0].deliver, undefined);
    assert.equal(listJobs()[0].enabled, true);
    addJob({ ...job, deliver: "bot:other", enabled: false });
    assert.equal(listJobs().length, 1);
    assert.equal(listJobs()[0].enabled, false);
    addJob({ ...job, deliver: "group:team" });
    assert.equal(listJobs()[0].deliver, "group:team");
    assert.throws(() => removeJob("../brief"), inputError);
    removeJob("brief");
    assert.deepEqual(listJobs(), []);
  });

  it("runs due jobs and records delivery failures as failures, not successful dispatches", async () => {
    addJob({ ...job, deliver: "group:team" });
    addJob({ ...job, name: "bad", bot: "ghost" });
    const seen: string[] = [];
    const ran = await runDue(MON_0800, async (job) => {
      if (job.name === "bad") throw new Error("delivery failed");
      seen.push(job.bot);
      return "fake dispatched and delivered";
    });
    assert.deepEqual(seen, ["seller"]);
    assert.equal(ran.find((e) => e.job === "brief")?.deliver, "group:team");
    assert.equal(ran.find((e) => e.job === "bad")?.ok, false);
    assert.match(ran.find((e) => e.job === "bad")!.detail!, /delivery failed/);
    assert.ok(ran.every((e) => e.slot === MON_0800.toISOString()));
    assert.deepEqual(await runDue(new Date("2026-09-07T08:00:45Z"), async () => assert.fail("same slot")), []);
    assert.equal(listExecutions().length, 2);
  });

  it("claims before awaiting the handler and never reclaims a slot after edits or delete/re-add", async (t) => {
    addJob({ ...job, schedule: "* * * * *" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    t.after(() => release());
    let calls = 0;
    const first = runDue(MON_0800, async () => { calls++; await gate; return "first"; });
    assert.equal(calls, 1);
    const duplicate = () => runDue(new Date("2026-09-07T08:00:30Z"), async () => assert.fail("duplicate handler"));
    assert.deepEqual(await duplicate(), []);
    addJob({ ...job, prompt: "edited", bot: "other", deliver: "group:team" });
    assert.deepEqual(await duplicate(), []);
    removeJob(job.name);
    addJob({ ...job, schedule: "* * * * *" });
    assert.deepEqual(await duplicate(), []);
    release();
    assert.equal((await first).length, 1);
    const next = await runDue(new Date("2026-09-07T08:01:00Z"), async () => { calls++; return "next minute"; });
    assert.equal(next.length, 1);
    assert.equal(calls, 2);
  });

  it("shares claims between concurrent processes and retains them after a restart", async () => {
    addJob(job);
    const module = new URL("../src/crons/scheduler.ts", import.meta.url).href;
    const child = async () => {
      const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
        `import { runDue } from ${JSON.stringify(module)}; const out = await runDue(new Date(${JSON.stringify(MON_0800.toISOString())}), async () => "fake child handler"); process.stdout.write(JSON.stringify(out));`,
      ], { env: { ...process.env, LINUBOT_DATA: root }, timeout: 10000 });
      return JSON.parse(stdout) as Execution[];
    };
    const concurrent = await Promise.all([child(), child()]);
    assert.equal(concurrent.flat().length, 1);
    assert.deepEqual(await child(), []);
    assert.deepEqual(await runDue(MON_0800, async () => assert.fail("persisted claim")), []);
    assert.equal(listExecutions().length, 1);
    const claims = join(root, "cron-claims");
    assert.equal(statSync(claims).mode & 0o777, 0o700);
    assert.equal(statSync(join(claims, readdirSync(claims)[0])).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, "executions.jsonl")).mode & 0o777, 0o600);
  });

  it("retains an interrupted handler's durable claim even without an execution record", async (t) => {
    addJob(job);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    t.after(() => release());
    const pending = runDue(MON_0800, async () => { await gate; return "completed later"; });
    assert.deepEqual(listExecutions(), []);
    const module = new URL("../src/crons/scheduler.ts", import.meta.url).href;
    const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
      `import { runDue } from ${JSON.stringify(module)}; process.stdout.write(JSON.stringify(await runDue(new Date(${JSON.stringify(MON_0800.toISOString())}), async () => { throw new Error("must not run"); })));`,
    ], { env: { ...process.env, LINUBOT_DATA: root }, timeout: 10000 });
    assert.equal(stdout, "[]");
    release();
    await pending;
  });

  it("skips disabled jobs without claiming and validates malformed persisted jobs independently", async () => {
    writeJson(join(root, "jobs.json"), [
      { ...job, name: "bad-schedule", schedule: "*/0 * * * *" },
      { ...job, name: "bad-bot", bot: "missing" },
      { ...job, name: "bad-delivery", deliver: "telegram" },
      { ...job, name: "bad-enabled", enabled: "yes" },
      null,
      { ...job, name: "disabled", schedule: "broken", enabled: false },
      job,
    ]);
    const seen: string[] = [];
    const out = await runDue(MON_0800, async (job) => { seen.push(job.name); return "fake"; });
    assert.deepEqual(seen, ["brief"]);
    assert.equal(out.filter((entry) => !entry.ok).length, 5);
    assert.match(out.find((entry) => entry.job === "bad-schedule")!.detail!, /bad minute/);
    assert.deepEqual(await runDue(MON_0800, async () => assert.fail("same slot")), []);
    writeJson(join(root, "jobs.json"), [{ ...job, name: "disabled", enabled: true }]);
    assert.equal((await runDue(MON_0800, async () => "now enabled")).length, 1);
    await assert.rejects(runDue(new Date(NaN), async () => assert.fail("invalid date")), inputError);
  });

  it("keeps malformed unnamed rows from claiming a valid job's name and permits repairing the job list", async () => {
    writeJson(join(root, "jobs.json"), [null]);
    addJob({ ...job, name: "invalid-job-0" });
    const seen: string[] = [];
    const out = await runDue(MON_0800, async (job) => { seen.push(job.name); return "fake"; });
    assert.deepEqual(seen, ["invalid-job-0"]);
    assert.equal(out.length, 2);
    assert.equal(out.filter((entry) => entry.ok).length, 1);
  });

  it("uses the same normalized job identity for execution, upsert and removal", async () => {
    writeJson(join(root, "jobs.json"), [{ ...job, name: " brief ", bot: " seller ", deliver: " bot:other " }]);
    const out = await runDue(MON_0800, async (job) => { assert.equal(job.bot, "seller"); return "fake"; });
    assert.equal(out[0].job, "brief");
    assert.equal(out[0].bot, "seller");
    assert.equal(out[0].deliver, "bot:other");
    addJob({ ...job, prompt: "edited" });
    assert.equal(listJobs().length, 1);
    assert.equal(listJobs()[0].prompt, "edited");
    assert.deepEqual(await runDue(MON_0800, async () => assert.fail("edited identity")), []);
    removeJob(" brief ");
    assert.deepEqual(listJobs(), []);
  });

  it("reports a disappeared delivery target without dispatching or creating it", async () => {
    addJob({ ...job, deliver: "bot:other" });
    rmSync(join(root, "profiles", "other"), { recursive: true });
    const out = await runDue(MON_0800, async () => assert.fail("missing delivery target"));
    assert.equal(out[0].ok, false);
    assert.match(out[0].detail!, /unknown delivery bot/);
  });

  it("returns bounded newest-first history and tolerates a torn JSONL record", () => {
    assert.deepEqual(listExecutions(), []);
    for (let i = 0; i < 55; i++) logExecution({ job: `job-${i}`, bot: "seller", at: MON_0800.toISOString(), ok: true });
    appendFileSync(join(root, "executions.jsonl"), "{unfinished\nnull\n");
    assert.equal(listExecutions().length, 50);
    assert.deepEqual(listExecutions(2).map((entry) => entry.job), ["job-54", "job-53"]);
    for (const limit of [0, -1, 501, 1.5, NaN]) assert.throws(() => listExecutions(limit), inputError);
  });
});
