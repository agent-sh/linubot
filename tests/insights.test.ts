import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputError } from "../src/errors.ts";
import { readJson, writeJson } from "../src/store.ts";
import {
  activeLessons, addEvalCase, createProposal, createRun, decideProposal, deleteEvalCase, feedbackRun,
  getProposal, getRun, listEvalCases, listEvaluations, listProposals, listRuns, recoverRuns, runEvaluation,
  summarizeRuns, updateRun,
} from "../src/agents/insights.ts";
import type { EvaluationReport, Proposal, RunRecord, RunStatus } from "../src/agents/insights.ts";

const previousData = process.env.LINUBOT_DATA;
const root = mkdtempSync(join(tmpdir(), "linubot-insights-"));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(root, "case-"));
  process.env.LINUBOT_DATA = dir;
});
after(() => {
  if (previousData === undefined) delete process.env.LINUBOT_DATA;
  else process.env.LINUBOT_DATA = previousData;
  rmSync(root, { recursive: true, force: true });
});

const bot = "writer";
const revision = "soul-provider-model-skills-lessons-v1";
const options = { revision, model: "local-test-stub", respond: async () => "OK" };
const hasStatus = (status: number) => (error: unknown) => error instanceof InputError && error.status === status;

function run(status: RunStatus = "completed", patch: Partial<RunRecord> = {}): RunRecord {
  const record = createRun({ bot, scope: `bot:${bot}`, prompt: "Please preserve explicit evidence." });
  return updateRun(record.id, { status, ...patch });
}

function propose(text = "Use explicit evidence.", name = bot, status: RunStatus = "completed"): Proposal {
  const source = createRun({ bot: name, scope: `bot:${name}`, prompt: "Please preserve explicit evidence." });
  updateRun(source.id, { status });
  return createProposal({ bot: name, runId: source.id, text, reason: "The user asked for evidence.", evidence: "explicit evidence" });
}

function guard(name = "guard", owner = bot) {
  return addEvalCase({ bot: owner, name, prompt: name, includes: ["OK"], excludes: ["unsafe"] });
}

describe("run evidence ledger", () => {
  it("creates private UUID records and rejects unsafe paths and immutable identity changes", () => {
    const record = createRun({ bot, scope: `bot:${bot}`, prompt: "Do the work" });
    assert.match(record.id, /^[0-9a-f-]{36}$/);
    assert.equal(record.status, "queued");
    assert.equal(record.source, "chat");
    assert.equal(record.toolCalls, 0);
    assert.deepEqual(record.criteria, []);
    assert.equal(record.durationMs, undefined);
    assert.equal(record.feedback, undefined);
    assert.deepEqual(getRun(record.id), record);
    const detached = getRun(record.id);
    detached.criteria.push("mutated outside storage");
    assert.deepEqual(getRun(record.id).criteria, []);
    assert.equal(statSync(join(dir, "runs")).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "runs", `${record.id}.json`)).mode & 0o777, 0o600);
    for (const id of ["../escape", "/tmp/file", "", "not-a-uuid", `${randomUUID()}/../other`]) {
      assert.throws(() => getRun(id), hasStatus(400));
      assert.throws(() => getProposal(id), hasStatus(400));
    }
    assert.throws(() => getRun(randomUUID()), hasStatus(404));
    assert.throws(() => getProposal(randomUUID()), hasStatus(404));
    for (const name of ["../escape", "bad/name", "", "a".repeat(41)]) {
      assert.throws(() => createRun({ bot: name, scope: "scope", prompt: "work" }), hasStatus(400));
      assert.throws(() => listEvalCases(name), hasStatus(400));
      assert.throws(() => activeLessons(name), hasStatus(400));
    }
    for (const patch of [{ id: randomUUID() }, { scope: "group:other" }, { bot: "other" }]) {
      assert.throws(() => updateRun(record.id, patch), /immutable/);
    }
    assert.equal(updateRun(record.id, { id: record.id, scope: record.scope, bot: record.bot }).status, "queued");
  });

  it("preserves measured fields, nullable checks, and explicitly model-sourced assessments", () => {
    const record = run("completed", {
      criteria: ["Cite the result", "State uncertainty"], source: "handoff", batchId: "batch-1", messageSeq: 12,
      startedAt: "2026-09-06T10:00:00.000Z", finishedAt: "2026-09-06T10:00:02.000Z", durationMs: 2000,
      model: "stub", response: "  Exact response text.\n", toolCalls: 2, usage: { input: 20, output: 10 },
      checks: [{ label: "Citation", passed: null, detail: "Not independently checked" }],
      assessment: {
        source: "model", summary: "The result may meet the criterion.",
        checks: [{ criterion: "Cite the result", verdict: "uncertain", evidence: "Exact response text." }],
        limitations: ["No independent verification"],
      },
    });
    assert.deepEqual(getRun(record.id), record);
    assert.equal(record.response, "  Exact response text.\n");
    assert.deepEqual(summarizeRuns(bot), {
      total: 1, completed: 1, failed: 0, cancelled: 0, unreviewed: 1, reviewed: 0, useful: 0, needsWork: 0,
      successRate: 1, usefulnessRate: null, minutesSaved: 0, medianDurationMs: 2000,
    });
    for (const patch of [
      { status: "imaginary" }, { source: "imaginary" }, { durationMs: -1 }, { toolCalls: 0.5 },
      { usage: { input: Infinity, output: 1 } }, { messageSeq: NaN }, { startedAt: "not a date" },
      { response: "x".repeat(200_001) }, { checks: [{ label: "check", passed: "yes", detail: "" }] },
      { assessment: { source: "user", summary: "x", checks: [], limitations: [] } },
    ]) assert.throws(() => updateRun(record.id, patch as Partial<RunRecord>), hasStatus(400));
    assert.deepEqual(getRun(record.id), record, "invalid patches must not change the stored evidence");
  });

  it("bounds run listings but summarizes and recovers the complete ledger", () => {
    const ids: string[] = [];
    for (let index = 0; index < 205; index++) {
      const owner = index % 2 ? bot : "other";
      const record = createRun({ bot: owner, scope: index % 2 ? "group:shared" : "bot:other", prompt: `Task ${index}` });
      updateRun(record.id, { createdAt: new Date(1_700_000_000_000 + index).toISOString() });
      ids.push(record.id);
    }
    assert.equal(listRuns().length, 100);
    assert.equal(listRuns({ limit: 1_000_000 }).length, 200);
    assert.deepEqual(listRuns({ limit: 2 }).map((record) => record.id), ids.slice(-2).reverse());
    assert.equal(listRuns({ bot, scope: "group:shared", limit: 200 }).length, 102);
    assert.deepEqual(listRuns({ bot, scope: "bot:other" }), []);
    assert.deepEqual(listRuns({ limit: 0 }), []);
    for (const limit of [-1, 0.5, NaN, Infinity]) assert.throws(() => listRuns({ limit }), hasStatus(400));
    assert.equal(summarizeRuns().total, 205);
    assert.equal(summarizeRuns(bot).total, 102);
    assert.equal(recoverRuns().length, 205, "recovery must not use the capped listing");
    assert.deepEqual(recoverRuns(), []);
    assert.equal(getRun(ids[0]).status, "interrupted");
  });

  it("records restart interruption from disk in a new process without inventing elapsed work", () => {
    const queued = run("queued");
    const running = run("running", { startedAt: "2020-01-01T00:00:00.000Z", response: "Partial output", toolCalls: 3 });
    const awaiting = run("awaiting_approval");
    const terminal = ["completed", "failed", "cancelled", "interrupted"].map((status) => run(status as RunStatus));
    const moduleUrl = new URL("../src/agents/insights.ts", import.meta.url).href;
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
      `import { recoverRuns } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(recoverRuns()));`,
    ], { encoding: "utf8", env: { LINUBOT_DATA: dir }, timeout: 10_000 });
    const recovered = JSON.parse(output) as RunRecord[];
    assert.deepEqual(new Set(recovered.map((record) => record.id)), new Set([queued.id, running.id, awaiting.id]));
    for (const record of recovered) {
      assert.equal(record.status, "interrupted");
      assert.ok(record.finishedAt);
      assert.match(record.error!, /restart/);
      assert.equal(record.durationMs, undefined);
    }
    assert.equal(getRun(running.id).response, "Partial output");
    assert.equal(getRun(running.id).toolCalls, 3);
    for (const record of terminal) assert.deepEqual(getRun(record.id), record);
    assert.deepEqual(recoverRuns(), []);
  });

  it("does not disguise corrupt storage as an empty history or a missing record", () => {
    const record = run();
    const path = join(dir, "runs", `${record.id}.json`);
    writeFileSync(path, "{broken json");
    assert.throws(() => getRun(record.id), /Cannot read stored JSON/);
    assert.throws(() => summarizeRuns(), /Cannot read stored JSON/);
    writeJson(path, null);
    assert.throws(() => listRuns(), /Invalid stored/);
    writeJson(path, { ...record, id: randomUUID() });
    assert.throws(() => getRun(record.id), /Invalid stored/);
  });
});

describe("explicit feedback, not synthetic benefit", () => {
  it("accepts feedback only for completed runs and validates every feedback field", () => {
    for (const status of ["queued", "running", "awaiting_approval", "failed", "cancelled", "interrupted"] as RunStatus[]) {
      const record = run(status);
      assert.throws(() => feedbackRun(record.id, { rating: "useful" }), hasStatus(409));
      assert.throws(() => updateRun(record.id, { feedback: { rating: "useful", note: "", minutesSaved: null, at: new Date().toISOString() } }), hasStatus(409));
      assert.equal(getRun(record.id).feedback, undefined);
    }
    const record = run();
    for (const rating of ["", "good", "USEFUL", null, 1]) assert.throws(() => feedbackRun(record.id, { rating: rating as string }), hasStatus(400));
    for (const minutesSaved of [-1, NaN, Infinity, Number.MAX_VALUE, "5", true]) {
      assert.throws(() => feedbackRun(record.id, { rating: "useful", minutesSaved: minutesSaved as number }), hasStatus(400));
    }
    for (const note of [null, 42, "x".repeat(4001)]) assert.throws(() => feedbackRun(record.id, { rating: "useful", note: note as string }), hasStatus(400));
    assert.equal(getRun(record.id).feedback, undefined);
    const first = feedbackRun(record.id, { rating: "useful", note: "  Verified myself  ", minutesSaved: 2.5 });
    assert.equal(first.feedback?.note, "Verified myself");
    assert.equal(first.feedback?.minutesSaved, 2.5);
    assert.ok(Number.isFinite(Date.parse(first.feedback!.at)));
    assert.deepEqual(getRun(record.id), first);
    const replacement = feedbackRun(record.id, { rating: "needs_work" });
    assert.equal(replacement.feedback?.minutesSaved, null);
    assert.equal(replacement.feedback?.note, "");
    assert.equal(summarizeRuns(bot).reviewed, 1);
    assert.equal(summarizeRuns(bot).minutesSaved, 0, "replacement feedback is not accumulated");
    assert.equal(feedbackRun(record.id, { rating: "useful", minutesSaved: 0 }).feedback?.minutesSaved, 0);
    assert.equal(feedbackRun(record.id, { rating: "useful", minutesSaved: null }).feedback?.minutesSaved, null);
  });

  it("returns null for unknown rates and durations instead of fabricated scores", () => {
    assert.deepEqual(summarizeRuns(), {
      total: 0, completed: 0, failed: 0, cancelled: 0, unreviewed: 0, reviewed: 0, useful: 0, needsWork: 0,
      successRate: null, usefulnessRate: null, minutesSaved: 0, medianDurationMs: null,
    });
    run("queued");
    run("running", { toolCalls: 100 });
    run("cancelled");
    assert.equal(summarizeRuns().successRate, null);
    assert.equal(summarizeRuns().unreviewed, 0);
    assert.equal(summarizeRuns().minutesSaved, 0);
    run("completed");
    assert.equal(summarizeRuns().medianDurationMs, null, "missing duration stays unknown");
    assert.equal(summarizeRuns().usefulnessRate, null);
  });

  it("keeps completion, literal/model checks, and reported usefulness separate", () => {
    const useful = run("completed", { durationMs: 1000, checks: [{ label: "literal", passed: false, detail: "No match" }] });
    const needsWork = run("completed", { durationMs: 5000 });
    run("completed", {
      durationMs: 3000, toolCalls: 50,
      assessment: { source: "model", summary: "I think it was useful", checks: [{ criterion: "Save time", verdict: "met", evidence: "I did" }], limitations: [] },
    });
    run("failed", { durationMs: 999_999 });
    run("cancelled", { durationMs: 999_999 });
    run("interrupted");
    run("queued");
    run("running");
    run("awaiting_approval");
    feedbackRun(useful.id, { rating: "useful", minutesSaved: 7.5 });
    feedbackRun(needsWork.id, { rating: "needs_work", minutesSaved: 2.5 });
    assert.deepEqual(summarizeRuns(bot), {
      total: 9, completed: 3, failed: 1, cancelled: 1, unreviewed: 1, reviewed: 2, useful: 1, needsWork: 1,
      successRate: 3 / 5, usefulnessRate: 1 / 2, minutesSaved: 10, medianDurationMs: 3000,
    });
    run("completed", { durationMs: 7000 });
    assert.equal(summarizeRuns(bot).medianDurationMs, 4000);
    assert.equal(summarizeRuns("other").total, 0);
  });
});

describe("evidence-backed proposals and literal suites", () => {
  it("requires a real, same-bot source quote and allows proposals during a running turn", () => {
    const source = run("running");
    const input = { bot, runId: source.id, text: "Keep evidence", reason: "User preference", evidence: "explicit evidence" };
    assert.equal(createProposal(input).status, "proposed");
    assert.throws(() => createProposal({ ...input, bot: "other" }), /another bot/);
    assert.throws(() => createProposal({ ...input, runId: randomUUID() }), hasStatus(404));
    for (const evidence of ["not in the source", "EXPLICIT EVIDENCE", ""]) {
      assert.throws(() => createProposal({ ...input, evidence }), hasStatus(400));
    }
    assert.throws(() => createProposal({ ...input, text: "x".repeat(2001) }), hasStatus(400));
    assert.throws(() => createProposal({ ...input, reason: "x".repeat(4001) }), hasStatus(400));
    assert.throws(() => createProposal({ ...input, evidence: "x".repeat(4001) }), hasStatus(400));
    for (const status of ["queued", "awaiting_approval", "failed", "cancelled", "interrupted"] as RunStatus[]) {
      updateRun(source.id, { status });
      assert.throws(() => createProposal(input), hasStatus(409));
    }
    updateRun(source.id, { status: "completed", response: "A concrete observed result." });
    assert.equal(createProposal({ ...input, text: "Remember the result", evidence: "observed result" }).evidence, "observed result");
    assert.equal(listProposals().length, 2);
    assert.equal(listProposals("other").length, 0);
  });

  it("deduplicates active lesson text without rewriting its evidence or reactivating rejected proposals", () => {
    const proposal = propose("Prefer explicit evidence.");
    const duplicate = propose("PREFER   explicit evidence.");
    assert.equal(duplicate.id, proposal.id);
    assert.equal(duplicate.runId, proposal.runId);
    assert.equal(listProposals(bot).length, 1);
    assert.deepEqual(activeLessons(bot), []);
    const rejected = decideProposal(proposal.id, "reject", "");
    assert.equal(rejected.status, "rejected");
    assert.deepEqual(decideProposal(proposal.id, "reject", ""), rejected);
    assert.throws(() => decideProposal(proposal.id, "accept", revision), hasStatus(409));
    assert.throws(() => decideProposal(proposal.id, "rollback", ""), hasStatus(409));
    const fresh = propose(proposal.text);
    assert.notEqual(fresh.id, proposal.id);
    assert.equal(fresh.status, "proposed");
    assert.throws(() => decideProposal(fresh.id, "rollback", ""), hasStatus(409));
  });

  it("requires bounded, nonempty literal assertions and limits suites to eight cases per bot", () => {
    for (const assertions of [{}, { includes: [] }, { includes: [""] }, { excludes: [" "] }, { includes: Array(21).fill("x") }, { excludes: ["x".repeat(2001)] }]) {
      assert.throws(() => addEvalCase({ bot, name: "bad", prompt: "prompt", ...assertions }), hasStatus(400));
    }
    assert.throws(() => addEvalCase({ bot, name: "", prompt: "prompt", includes: ["x"] }), hasStatus(400));
    assert.throws(() => addEvalCase({ bot, name: "long", prompt: "x".repeat(20_001), includes: ["x"] }), hasStatus(400));
    const first = addEvalCase({ bot, name: "negative only", prompt: "Do not say it", excludes: ["unsafe"] });
    for (let index = 1; index < 8; index++) guard(`guard ${index}`);
    assert.equal(listEvalCases(bot).length, 8);
    assert.throws(() => guard("ninth"), hasStatus(409));
    guard("other bot", "other");
    assert.throws(() => deleteEvalCase("other", first.id), hasStatus(404));
    assert.throws(() => deleteEvalCase(bot, "../escape"), hasStatus(400));
    deleteEvalCase(bot, first.id);
    assert.equal(listEvalCases(bot).length, 7);
    guard("replacement");
    assert.equal(listEvalCases(bot).length, 8);
    assert.equal(statSync(join(dir, "evaluations", "suites", `${bot}.json`)).mode & 0o777, 0o600);
  });

  it("runs baseline cases once, uses case-insensitive literals rather than regex or semantic truth", async () => {
    addEvalCase({ bot, name: "literal", prompt: "first", includes: ["READY", ".+"], excludes: ["unsafe"] });
    addEvalCase({ bot, name: "exclusion", prompt: "second", excludes: ["secret"] });
    const calls: string[] = [];
    const report = await runEvaluation(bot, undefined, { ...options, respond: async (prompt, lessons, signal) => {
      calls.push(prompt);
      assert.deepEqual(lessons, []);
      assert.ok(signal instanceof AbortSignal);
      return prompt === "first" ? "ready .+" : "ordinary output";
    } });
    assert.deepEqual(calls, ["first", "second"]);
    assert.equal(report.status, "passed");
    assert.equal(report.baselinePassed, 2);
    assert.equal(report.candidatePassed, 2);
    assert.equal(report.regressions, 0);
    assert.equal(report.improvements, 0);
    assert.equal(report.total, 2);
    assert.equal(report.proposalId, undefined);
    assert.equal(Object.hasOwn(report, "provenance"), false);
    for (const result of report.cases) {
      assert.equal(result.baseline, result.candidate);
      assert.ok(result.checks.every((check) => check.baseline && check.candidate && check.label.includes("literal (case-insensitive)")));
    }
    const failed = await runEvaluation(bot, undefined, { ...options, respond: async () => "I am prepared, definitely unsafe" });
    assert.equal(failed.status, "failed");
    assert.equal(failed.cases[0].checks[0].candidate, false, "prepared is not the literal READY");
    assert.equal(failed.cases[0].checks[1].candidate, false, ".+ must not be interpreted as a regular expression");
    assert.equal(failed.cases[0].checks[2].candidate, false);
    assert.equal(summarizeRuns().total, 0, "suite output must not create production runs or user benefits");
    assert.equal(summarizeRuns().usefulnessRate, null);
    assert.equal(listEvaluations(bot).length, 2);
    assert.deepEqual(listEvaluations("other"), []);
    assert.ok(listEvaluations().every((item, index, all) => index === 0 || all[index - 1].createdAt >= item.createdAt));
  });
});

describe("regression-gated lesson decisions", () => {
  it("accepts only evaluated lessons and supports explicit idempotent rollback without editing SOUL", async () => {
    const soulPath = join(dir, "profiles", bot, "SOUL.md");
    mkdirSync(join(dir, "profiles", bot), { recursive: true });
    writeFileSync(soulPath, "User-owned soul stays unchanged.\n");
    const proposal = propose();
    assert.throws(() => decideProposal(proposal.id, "accept", revision), /evaluation/);
    await assert.rejects(() => runEvaluation(bot, proposal.id, options), /at least one evaluation case/);
    guard();
    const report = await runEvaluation(bot, proposal.id, { ...options, respond: async (_prompt, lessons) => lessons.length ? "OK" : "missing" });
    assert.equal(report.status, "passed");
    assert.equal(report.baselinePassed, 0);
    assert.equal(report.candidatePassed, 1);
    assert.equal(report.improvements, 1);
    assert.deepEqual(activeLessons(bot), []);
    assert.equal(getProposal(proposal.id).evaluationId, report.id);
    const accepted = decideProposal(proposal.id, "accept", revision);
    assert.equal(accepted.status, "accepted");
    assert.ok(accepted.decidedAt);
    assert.equal(Object.hasOwn(accepted, "lessonOrder"), false);
    assert.deepEqual(activeLessons(bot), [proposal.text]);
    assert.deepEqual(decideProposal(proposal.id, "accept", revision), accepted);
    assert.equal(propose(proposal.text).id, proposal.id, "accepted text also deduplicates");
    assert.throws(() => decideProposal(proposal.id, "reject", ""), hasStatus(409));
    const rolledBack = decideProposal(proposal.id, "rollback", "");
    assert.equal(rolledBack.status, "rolled_back");
    assert.deepEqual(activeLessons(bot), []);
    assert.deepEqual(decideProposal(proposal.id, "rollback", ""), rolledBack);
    assert.throws(() => decideProposal(proposal.id, "accept", revision), hasStatus(409));
    assert.throws(() => decideProposal(proposal.id, "reject", ""), hasStatus(409));
    assert.equal(readFileSync(soulPath, "utf8"), "User-owned soul stays unchanged.\n");
    assert.equal(summarizeRuns(bot).useful, 0);
    assert.equal(summarizeRuns(bot).minutesSaved, 0);
    for (const path of ["runs", "proposals", "evaluations", "evaluations/suites"]) assert.equal(statSync(join(dir, path)).mode & 0o777, 0o700);
    for (const path of [`proposals/${proposal.id}.json`, `evaluations/${report.id}.json`]) assert.equal(statSync(join(dir, path)).mode & 0o777, 0o600);
  });

  it("blocks regressions even when improvements leave the overall pass count unchanged", async () => {
    const proposal = propose();
    guard("keep");
    guard("improve");
    const report = await runEvaluation(bot, proposal.id, { ...options, respond: async (prompt, lessons) => {
      const candidate = lessons.length > 0;
      return (prompt === "keep" ? !candidate : candidate) ? "OK" : "missing";
    } });
    assert.equal(report.baselinePassed, 1);
    assert.equal(report.candidatePassed, 1);
    assert.equal(report.regressions, 1);
    assert.equal(report.improvements, 1);
    assert.equal(report.status, "failed");
    assert.throws(() => decideProposal(proposal.id, "accept", revision), /regressions/);
    assert.deepEqual(activeLessons(bot), []);
    const stillFailing = await runEvaluation(bot, proposal.id, { ...options, respond: async () => "missing" });
    assert.equal(stillFailing.regressions, 0);
    assert.equal(stillFailing.status, "failed", "zero regressions alone is not a passing evaluation");
    assert.throws(() => decideProposal(proposal.id, "accept", revision), hasStatus(409));
  });

  it("rejects changed soul/provider/model/skills revisions and a changed source outcome or quote", async () => {
    const proposal = propose();
    guard();
    await runEvaluation(bot, proposal.id, options);
    for (const context of ["new-soul", "new-provider", "new-model", "new-skills"]) {
      assert.throws(() => decideProposal(proposal.id, "accept", context), /context is stale/);
    }
    updateRun(proposal.runId, { status: "running" });
    assert.throws(() => decideProposal(proposal.id, "accept", revision), /completed before acceptance/);
    updateRun(proposal.runId, { status: "failed" });
    assert.throws(() => decideProposal(proposal.id, "accept", revision), hasStatus(409));
    updateRun(proposal.runId, { status: "completed", prompt: "Evidence has changed" });
    assert.throws(() => decideProposal(proposal.id, "accept", revision), /literal quote/);
    assert.deepEqual(activeLessons(bot), []);
  });

  it("rejects changed assertions even when case IDs and counts match, and rejects a missing suite", async () => {
    const proposal = propose();
    const test = guard();
    await runEvaluation(bot, proposal.id, options);
    writeJson(join(dir, "evaluations", "suites", `${bot}.json`), [{ ...test, includes: ["different literal"] }]);
    assert.throws(() => decideProposal(proposal.id, "accept", revision), /suite is missing or stale/);
    deleteEvalCase(bot, test.id);
    assert.throws(() => decideProposal(proposal.id, "accept", revision), /suite is missing or stale/);
    guard();
    assert.throws(() => decideProposal(proposal.id, "accept", revision), /suite is missing or stale/, "recreated cases have new identities");
    await runEvaluation(bot, proposal.id, options);
    assert.equal(decideProposal(proposal.id, "accept", revision).status, "accepted");
  });

  it("rejects an added case, incomplete report rows, and fabricated literal-check flags", async () => {
    const proposal = propose();
    guard("first");
    await runEvaluation(bot, proposal.id, options);
    guard("second");
    assert.throws(() => decideProposal(proposal.id, "accept", revision), /suite is missing or stale/);
    const report = await runEvaluation(bot, proposal.id, options);
    const path = join(dir, "evaluations", `${report.id}.json`);
    const stored = readJson<EvaluationReport & { provenance: unknown }>(path, undefined!);
    writeJson(path, { ...stored, cases: stored.cases.slice(1) });
    assert.throws(() => decideProposal(proposal.id, "accept", revision), /incomplete/);
    const fabricated = structuredClone(stored);
    fabricated.cases[0].candidate = "unsafe and missing";
    writeJson(path, fabricated);
    assert.throws(() => decideProposal(proposal.id, "accept", revision), /incomplete/);
    writeJson(path, stored);
    assert.equal(decideProposal(proposal.id, "accept", revision).status, "accepted");
  });

  it("fingerprints active lessons independently of caller revision and preserves candidate append order", async (context) => {
    context.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    const older = propose("Older proposal, accepted second.");
    const newer = propose("Newer proposal, accepted first.");
    const third = propose("Evaluate with both lessons.");
    guard();
    await runEvaluation(bot, older.id, options);
    await runEvaluation(bot, newer.id, options);
    decideProposal(newer.id, "accept", revision);
    assert.throws(() => decideProposal(older.id, "accept", revision), /Active lessons changed/);
    const seen: string[][] = [];
    await runEvaluation(bot, older.id, { ...options, respond: async (_prompt, lessons) => {
      seen.push([...lessons]);
      lessons.push("adapter mutation must not change snapshots");
      return "OK";
    } });
    assert.deepEqual(seen, [[newer.text], [newer.text, older.text]]);
    decideProposal(older.id, "accept", revision);
    assert.deepEqual(activeLessons(bot), [newer.text, older.text]);
    await runEvaluation(bot, third.id, options);
    decideProposal(newer.id, "rollback", "");
    assert.throws(() => decideProposal(third.id, "accept", revision), /Active lessons changed/);
    assert.deepEqual(activeLessons(bot), [older.text]);
  });

  it("can evaluate a running source but cannot accept it until the recorded run completes", async () => {
    const proposal = propose("Keep the user's quote.", bot, "running");
    guard();
    await runEvaluation(bot, proposal.id, options);
    assert.throws(() => decideProposal(proposal.id, "accept", revision), /completed before acceptance/);
    updateRun(proposal.runId, { status: "completed" });
    assert.equal(decideProposal(proposal.id, "accept", revision).status, "accepted");
  });
});

describe("bounded evaluations and failures", () => {
  it("persists failed provider calls, retains honest partial counts, and replaces an older passing report", async () => {
    const proposal = propose();
    guard("first");
    guard("second");
    await runEvaluation(bot, proposal.id, options);
    let calls = 0;
    const failed = await runEvaluation(bot, proposal.id, { ...options, respond: async (prompt) => {
      calls++;
      if (prompt === "second") throw new Error("provider unavailable");
      return "OK";
    } });
    assert.equal(calls, 3, "do not call the candidate after a baseline provider failure");
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, /Baseline for second: provider unavailable/);
    assert.equal(failed.total, 2);
    assert.equal(failed.cases.length, 1, "unexecuted outputs must not be fabricated");
    assert.equal(failed.baselinePassed, 1);
    assert.equal(failed.candidatePassed, 1);
    assert.equal(getProposal(proposal.id).evaluationId, failed.id);
    assert.deepEqual(listEvaluations(bot).find((item) => item.id === failed.id), failed);
    assert.throws(() => decideProposal(proposal.id, "accept", revision), hasStatus(409));
    const retry = await runEvaluation(bot, proposal.id, options);
    assert.equal(retry.status, "passed", "provider failures must release the lock");
  });

  it("locks each bot, permits another bot, and blocks promotion while an evaluation is running", async () => {
    const proposal = propose();
    guard();
    guard("other", "other");
    await runEvaluation(bot, proposal.id, options);
    let release!: (text: string) => void;
    const deferred = new Promise<string>((resolve) => { release = resolve; });
    const pending = runEvaluation(bot, proposal.id, { ...options, respond: async () => deferred });
    try {
      await assert.rejects(() => runEvaluation(bot, undefined, options), hasStatus(409));
      assert.throws(() => decideProposal(proposal.id, "accept", revision), /still running/);
      assert.equal((await runEvaluation("other", undefined, options)).status, "passed");
    } finally {
      release("OK");
      await pending;
    }
    assert.equal((await runEvaluation(bot, undefined, options)).status, "passed");
  });

  it("does not reactivate a proposal rejected while its evaluation was awaiting a response", async () => {
    const proposal = propose();
    guard();
    let release!: (text: string) => void;
    const deferred = new Promise<string>((resolve) => { release = resolve; });
    const pending = runEvaluation(bot, proposal.id, { ...options, respond: async () => deferred });
    try {
      decideProposal(proposal.id, "reject", "");
    } finally {
      release("OK");
      await pending;
    }
    assert.equal(getProposal(proposal.id).status, "rejected");
    assert.equal(getProposal(proposal.id).evaluationId, undefined);
    assert.deepEqual(activeLessons(bot), []);
  });

  it("captures the suite before responding so in-flight suite changes invalidate promotion", async () => {
    const proposal = propose();
    guard();
    let changed = false;
    const report = await runEvaluation(bot, proposal.id, { ...options, respond: async () => {
      if (!changed) {
        changed = true;
        guard("added during evaluation");
      }
      return "OK";
    } });
    assert.equal(report.total, 1);
    assert.equal(report.cases.length, 1);
    assert.equal(report.status, "passed", "this report describes its original snapshot only");
    assert.throws(() => decideProposal(proposal.id, "accept", revision), /suite is missing or stale/);
  });

  it("stops immediately on an already-aborted signal and between baseline and candidate", async () => {
    const proposal = propose();
    guard("first");
    guard("second");
    const cancelled = new AbortController();
    cancelled.abort();
    let calls = 0;
    const preAborted = await runEvaluation(bot, proposal.id, { ...options, signal: cancelled.signal, respond: async () => { calls++; return "OK"; } });
    assert.equal(preAborted.status, "failed");
    assert.match(preAborted.error!, /abort/i);
    assert.equal(calls, 0);
    const controller = new AbortController();
    const during = await runEvaluation(bot, proposal.id, { ...options, signal: controller.signal, respond: async () => {
      calls++;
      controller.abort(new Error("User stopped evaluation"));
      return "OK";
    } });
    assert.equal(during.status, "failed");
    assert.match(during.error!, /User stopped/);
    assert.equal(calls, 1);
    assert.equal(during.cases.length, 0);
    assert.throws(() => decideProposal(proposal.id, "accept", revision), hasStatus(409));
  });

  it("aborts an uncooperative response promise and releases the evaluation lock", async () => {
    guard();
    const controller = new AbortController();
    let calls = 0;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let providerSignal: AbortSignal | undefined;
    const pending = runEvaluation(bot, undefined, { ...options, signal: controller.signal, respond: (_prompt, _lessons, signal) => {
      calls++;
      providerSignal = signal;
      started();
      return new Promise<string>(() => {});
    } });
    await entered;
    controller.abort(new Error("Stop now"));
    const report = await pending;
    assert.equal(report.status, "failed");
    assert.match(report.error!, /Stop now/);
    assert.equal(providerSignal?.aborted, true);
    assert.equal(calls, 1);
    assert.equal((await runEvaluation(bot, undefined, options)).status, "passed");
  });

  it("times out the whole evaluation without waiting on an uncooperative adapter", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    guard();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let providerSignal: AbortSignal | undefined;
    const pending = runEvaluation(bot, undefined, { ...options, respond: (_prompt, _lessons, signal) => {
      providerSignal = signal;
      started();
      return new Promise<string>(() => {});
    } });
    await entered;
    context.mock.timers.tick(120_000);
    const report = await pending;
    assert.equal(report.status, "failed");
    assert.match(report.error!, /timed out/);
    assert.equal(providerSignal?.aborted, true);
    assert.equal(report.total, 1);
    assert.equal(report.cases.length, 0);
  });

  it("fails oversized, non-text, and synchronously throwing responses without fabricating rows", async () => {
    guard();
    for (const respond of [
      async () => "x".repeat(200_001),
      async () => undefined as unknown as string,
      () => { throw new Error("synchronous provider failure"); },
    ]) {
      const report = await runEvaluation(bot, undefined, { ...options, respond });
      assert.equal(report.status, "failed");
      assert.ok(report.error);
      assert.equal(report.cases.length, 0);
      assert.equal(report.baselinePassed, 0);
      assert.equal(report.candidatePassed, 0);
    }
    assert.equal(listEvaluations(bot).length, 3);
    assert.equal(existsSync(join(dir, "profiles")), false);
  });

  it("rejects invalid evaluation context, cross-bot proposals, and terminal proposals before calling responders", async () => {
    const proposal = propose();
    guard();
    guard("other", "other");
    for (const input of [{ ...options, revision: "" }, { ...options, model: "" }]) {
      await assert.rejects(() => runEvaluation(bot, proposal.id, input), hasStatus(400));
    }
    await assert.rejects(() => runEvaluation("../escape", undefined, options), hasStatus(400));
    await assert.rejects(() => runEvaluation(bot, "../escape", options), hasStatus(400));
    await assert.rejects(() => runEvaluation("other", proposal.id, options), hasStatus(409));
    decideProposal(proposal.id, "reject", "");
    await assert.rejects(() => runEvaluation(bot, proposal.id, options), hasStatus(409));
    assert.deepEqual(listEvaluations(), []);
  });
});
