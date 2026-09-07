import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { InputError, requiredText, textList } from "../errors.ts";
import { dataDir, readJson, writeJson } from "../store.ts";

export type RunStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "interrupted";

export interface RunRecord {
  id: string;
  scope: string;
  bot: string;
  prompt: string;
  criteria: string[];
  source: "chat" | "group" | "cron" | "handoff";
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  model?: string;
  providerId?: string;
  contextRevision?: string;
  response?: string;
  error?: string;
  resumedFrom?: string;
  userAuthored?: boolean;
  continuationBatchId?: string;
  toolCalls: number;
  usage?: { input: number; output: number };
  messageSeq?: number;
  batchId?: string;
  checks?: { label: string; passed: boolean | null; detail: string }[];
  assessment?: {
    source: "model";
    summary: string;
    checks: { criterion: string; verdict: "met" | "unmet" | "uncertain"; evidence: string }[];
    limitations: string[];
  };
  feedback?: { rating: "useful" | "needs_work"; note: string; minutesSaved: number | null; at: string };
}

export interface Proposal {
  id: string;
  bot: string;
  runId: string;
  text: string;
  reason: string;
  evidence: string;
  createdAt: string;
  status: "proposed" | "accepted" | "rejected" | "rolled_back";
  evaluationId?: string;
  decidedAt?: string;
}

export interface EvalCase {
  id: string;
  bot: string;
  name: string;
  prompt: string;
  includes: string[];
  excludes: string[];
  createdAt: string;
}

export interface EvaluationReport {
  id: string;
  bot: string;
  proposalId?: string;
  createdAt: string;
  revision: string;
  model: string;
  status: "passed" | "failed";
  baselinePassed: number;
  candidatePassed: number;
  regressions: number;
  improvements: number;
  total: number;
  cases: {
    id: string;
    name: string;
    prompt: string;
    baseline: string;
    candidate: string;
    baselinePassed: boolean;
    candidatePassed: boolean;
    checks: { label: string; baseline: boolean; candidate: boolean }[];
  }[];
  error?: string;
}

type Collection = "runs" | "proposals" | "evaluations";
type StoredProposal = Proposal & { lessonOrder?: number };
type StoredEvaluation = EvaluationReport & {
  provenance: { suite: EvalCase[]; lessonsFingerprint: string; proposalText?: string };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_STATUSES: RunStatus[] = ["queued", "running", "awaiting_approval", "completed", "failed", "cancelled", "interrupted"];
const MAX_RESPONSE = 200_000;
const evaluationLocks = new Set<string>();

function safeId(value: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new InputError("Invalid record id");
  return value;
}

function botName(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(value)) throw new InputError("Invalid bot name");
  return value;
}

function recordPath(collection: Collection, id: string): string {
  return join(dataDir(), collection, `${safeId(id)}.json`);
}

function load<T extends { id: string; createdAt: string }>(collection: Collection, id: string): T {
  const record = readJson<T | undefined>(recordPath(collection, id), undefined);
  if (record === undefined) throw new InputError(`${collection} record not found`, 404);
  if (!record || record.id !== id || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new Error(`Invalid stored ${collection} record: ${id}`);
  }
  return record;
}

function records<T extends { id: string; createdAt: string }>(collection: Collection): T[] {
  let entries;
  try {
    entries = readdirSync(join(dataDir(), collection), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json") && UUID.test(entry.name.slice(0, -5)))
    .map((entry) => load<T>(collection, entry.name.slice(0, -5)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new InputError(`${label} must be text of at most ${max} characters`);
  return value;
}

function nonnegative(value: unknown, label: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(value))) {
    throw new InputError(`${label} must be a finite nonnegative ${integer ? "safe integer" : "number"}`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = requiredText(value, label, 40);
  if (!Number.isFinite(Date.parse(text))) throw new InputError(`${label} must be a valid timestamp`);
  return new Date(text).toISOString();
}

function validateRun(input: RunRecord): RunRecord {
  if (!RUN_STATUSES.includes(input.status)) throw new InputError("Invalid run status");
  if (!["chat", "group", "cron", "handoff"].includes(input.source)) throw new InputError("Invalid run source");
  const run: RunRecord = {
    id: safeId(input.id), scope: requiredText(input.scope, "Scope", 200), bot: botName(input.bot),
    prompt: requiredText(input.prompt, "Prompt"), criteria: textList(input.criteria, "Criteria"),
    source: input.source, status: input.status, createdAt: timestamp(input.createdAt, "Created at"),
    toolCalls: nonnegative(input.toolCalls, "Tool calls", true),
  };
  if (input.startedAt !== undefined) run.startedAt = timestamp(input.startedAt, "Started at");
  if (input.finishedAt !== undefined) run.finishedAt = timestamp(input.finishedAt, "Finished at");
  if (input.durationMs !== undefined) run.durationMs = nonnegative(input.durationMs, "Duration");
  if (input.model !== undefined) run.model = requiredText(input.model, "Model", 200);
  if (input.providerId !== undefined) run.providerId = requiredText(input.providerId, "Provider connection", 80);
  if (input.contextRevision !== undefined) run.contextRevision = requiredText(input.contextRevision, "Context revision", 512);
  if (input.response !== undefined) run.response = boundedText(input.response, "Response", MAX_RESPONSE);
  if (input.error !== undefined) run.error = boundedText(input.error, "Error", 20_000);
  if (input.messageSeq !== undefined) run.messageSeq = nonnegative(input.messageSeq, "Message sequence", true);
  if (input.userAuthored !== undefined) { if (typeof input.userAuthored !== "boolean") throw new InputError("Invalid task authorship"); run.userAuthored = input.userAuthored; }
  if (input.resumedFrom !== undefined) run.resumedFrom = safeId(input.resumedFrom);
  if (input.continuationBatchId !== undefined) run.continuationBatchId = safeId(input.continuationBatchId);
  if (input.batchId !== undefined) run.batchId = requiredText(input.batchId, "Batch id", 200);
  if (input.usage !== undefined) {
    if (!input.usage) throw new InputError("Invalid usage");
    run.usage = { input: nonnegative(input.usage.input, "Input tokens", true), output: nonnegative(input.usage.output, "Output tokens", true) };
  }
  if (input.checks !== undefined) {
    if (!Array.isArray(input.checks) || input.checks.length > 20) throw new InputError("At most 20 run checks are allowed");
    run.checks = input.checks.map((check) => {
      if (!check || (check.passed !== null && typeof check.passed !== "boolean")) throw new InputError("Invalid check result");
      return { label: requiredText(check.label, "Check label", 2000), passed: check.passed, detail: boundedText(check.detail, "Check detail", 4000) };
    });
  }
  if (input.assessment !== undefined) {
    const assessment = input.assessment;
    if (!assessment || assessment.source !== "model" || !Array.isArray(assessment.checks) || assessment.checks.length > 20) {
      throw new InputError("Invalid model assessment");
    }
    run.assessment = {
      source: "model", summary: requiredText(assessment.summary, "Assessment summary", 4000),
      checks: assessment.checks.map((check) => {
        if (!check || !["met", "unmet", "uncertain"].includes(check.verdict)) throw new InputError("Invalid assessment verdict");
        return { criterion: requiredText(check.criterion, "Criterion", 2000), verdict: check.verdict, evidence: boundedText(check.evidence, "Assessment evidence", 4000) };
      }),
      limitations: textList(assessment.limitations, "Limitations"),
    };
  }
  if (input.feedback !== undefined) {
    if (run.status !== "completed") throw new InputError("Only completed runs can receive feedback", 409);
    const feedback = input.feedback;
    if (!feedback || !["useful", "needs_work"].includes(feedback.rating)) throw new InputError("Rating must be useful or needs_work");
    run.feedback = {
      rating: feedback.rating, note: boundedText(feedback.note, "Feedback note", 4000).trim(),
      minutesSaved: feedback.minutesSaved === null ? null : nonnegative(feedback.minutesSaved, "Minutes saved"),
      at: timestamp(feedback.at, "Feedback time"),
    };
  }
  return run;
}

export function createRun(input: { scope: string; bot: string; prompt: string; criteria?: string[]; source?: RunRecord["source"]; batchId?: string }): RunRecord {
  const run = validateRun({
    id: randomUUID(), scope: input.scope, bot: input.bot, prompt: input.prompt,
    criteria: input.criteria === undefined ? [] : input.criteria, source: input.source === undefined ? "chat" : input.source,
    batchId: input.batchId, status: "queued", createdAt: new Date().toISOString(), toolCalls: 0,
  });
  writeJson(recordPath("runs", run.id), run);
  return run;
}

export function getRun(id: string): RunRecord {
  return validateRun(load<RunRecord>("runs", id));
}

export function updateRun(id: string, patch: Partial<RunRecord>): RunRecord {
  const current = getRun(id);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new InputError("Invalid run patch");
  for (const key of ["id", "scope", "bot"] as const) {
    if (Object.hasOwn(patch, key) && patch[key] !== current[key]) throw new InputError(`Run ${key} is immutable`);
  }
  const run = validateRun({ ...current, ...patch });
  writeJson(recordPath("runs", id), run);
  return run;
}

export function listRuns(filters: { bot?: string; scope?: string; limit?: number } = {}): RunRecord[] {
  const bot = filters.bot === undefined ? undefined : botName(filters.bot);
  const scope = filters.scope === undefined ? undefined : requiredText(filters.scope, "Scope", 200);
  const limit = filters.limit === undefined ? 100 : nonnegative(filters.limit, "Limit", true);
  return records<RunRecord>("runs").map(validateRun)
    .filter((run) => (bot === undefined || run.bot === bot) && (scope === undefined || run.scope === scope))
    .slice(0, Math.min(limit, 200));
}

export function recoverRuns(): RunRecord[] {
  return records<RunRecord>("runs").filter((run) => ["queued", "running", "awaiting_approval"].includes(run.status))
    .map((run) => updateRun(run.id, {
      status: "interrupted", finishedAt: new Date().toISOString(),
      error: run.error ?? "Interrupted by restart; no final outcome was recorded.",
      // Downtime is not measured execution time, so do not invent a duration.
    }));
}

export function feedbackRun(id: string, input: { rating: string; note?: string; minutesSaved?: number | null }): RunRecord {
  if (getRun(id).status !== "completed") throw new InputError("Only completed runs can receive feedback", 409);
  if (input.rating !== "useful" && input.rating !== "needs_work") throw new InputError("Rating must be useful or needs_work");
  return updateRun(id, { feedback: {
    rating: input.rating, note: input.note === undefined ? "" : input.note,
    minutesSaved: input.minutesSaved === undefined ? null : input.minutesSaved, at: new Date().toISOString(),
  } });
}

export function summarizeRuns(bot?: string) {
  if (bot !== undefined) botName(bot);
  const runs = records<RunRecord>("runs").map(validateRun).filter((run) => bot === undefined || run.bot === bot);
  const completed = runs.filter((run) => run.status === "completed");
  const failed = runs.filter((run) => run.status === "failed").length;
  const cancelled = runs.filter((run) => run.status === "cancelled").length;
  const interrupted = runs.filter((run) => run.status === "interrupted").length;
  const reviewed = completed.filter((run) => run.feedback !== undefined);
  const useful = reviewed.filter((run) => run.feedback!.rating === "useful").length;
  const durations = completed.flatMap((run) => run.durationMs === undefined ? [] : [run.durationMs]).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  // Rates are fractions. Completion is not correctness; only feedback measures reported benefit.
  const attempts = completed.length + failed + interrupted;
  return {
    total: runs.length, completed: completed.length, failed, cancelled,
    unreviewed: completed.length - reviewed.length, reviewed: reviewed.length, useful, needsWork: reviewed.length - useful,
    successRate: attempts ? completed.length / attempts : null,
    usefulnessRate: reviewed.length ? useful / reviewed.length : null,
    minutesSaved: reviewed.reduce((sum, run) => sum + (run.feedback!.minutesSaved ?? 0), 0),
    medianDurationMs: durations.length ? (durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2) : null,
  };
}

function publicProposal({ lessonOrder: _order, ...proposal }: StoredProposal): Proposal {
  return proposal;
}

export function getProposal(id: string): Proposal {
  return publicProposal(load<StoredProposal>("proposals", id));
}

export function listProposals(bot?: string): Proposal[] {
  if (bot !== undefined) botName(bot);
  return records<StoredProposal>("proposals").filter((proposal) => bot === undefined || proposal.bot === bot).map(publicProposal);
}

function acceptedLessons(bot: string): StoredProposal[] {
  botName(bot);
  const lessons = records<StoredProposal>("proposals").filter((proposal) => proposal.bot === bot && proposal.status === "accepted");
  if (lessons.some((lesson) => !Number.isSafeInteger(lesson.lessonOrder) || lesson.lessonOrder! < 1)) throw new Error("Invalid stored lesson order");
  return lessons.sort((a, b) => a.lessonOrder! - b.lessonOrder!);
}

export function activeLessons(bot: string): string[] {
  return acceptedLessons(bot).map((proposal) => proposal.text);
}

function sourceEvidence(proposal: Pick<Proposal, "runId" | "bot" | "evidence">): RunRecord {
  const run = getRun(proposal.runId);
  if (run.bot !== proposal.bot) throw new InputError("Source run belongs to another bot");
  if (run.status !== "completed" && run.status !== "running") throw new InputError("Source run must be completed or running", 409);
  if (!run.prompt.includes(proposal.evidence) && !run.response?.includes(proposal.evidence)) {
    throw new InputError("Evidence must be a literal quote from the source prompt or response");
  }
  return run;
}

export function createProposal(input: { bot: string; runId: string; text: string; reason: string; evidence: string }): Proposal {
  const proposal: Proposal = {
    id: randomUUID(), bot: botName(input.bot), runId: safeId(input.runId), text: requiredText(input.text, "Lesson", 2000),
    reason: requiredText(input.reason, "Reason", 4000), evidence: requiredText(input.evidence, "Evidence", 4000),
    createdAt: new Date().toISOString(), status: "proposed",
  };
  sourceEvidence(proposal);
  const normalized = (text: string) => text.replace(/\s+/g, " ").toLowerCase();
  const existing = listProposals(proposal.bot).find((item) => ["proposed", "accepted"].includes(item.status) && normalized(item.text) === normalized(proposal.text));
  if (existing) return existing;
  writeJson(recordPath("proposals", proposal.id), proposal);
  return proposal;
}

function suitePath(bot: string): string {
  return join(dataDir(), "evaluations", "suites", `${botName(bot)}.json`);
}

function validateCase(input: EvalCase): EvalCase {
  if (!input) throw new InputError("Invalid evaluation case");
  const test: EvalCase = {
    id: safeId(input.id), bot: botName(input.bot), name: requiredText(input.name, "Case name", 200),
    prompt: requiredText(input.prompt, "Case prompt"), includes: textList(input.includes, "Includes"), excludes: textList(input.excludes, "Excludes"),
    createdAt: timestamp(input.createdAt, "Case created at"),
  };
  if (test.includes.length + test.excludes.length === 0) throw new InputError("A case needs at least one nonempty literal assertion");
  return test;
}

export function listEvalCases(bot: string): EvalCase[] {
  const suite = readJson<EvalCase[]>(suitePath(bot), []);
  if (!Array.isArray(suite) || suite.length > 8) throw new Error("Invalid stored evaluation suite");
  const cases = suite.map(validateCase);
  if (cases.some((test) => test.bot !== bot) || new Set(cases.map((test) => test.id)).size !== cases.length) throw new Error("Invalid stored evaluation cases");
  return cases;
}

export function addEvalCase(input: { bot: string; name: string; prompt: string; includes?: string[]; excludes?: string[] }): EvalCase {
  const test = validateCase({
    id: randomUUID(), bot: input.bot, name: input.name, prompt: input.prompt,
    includes: input.includes === undefined ? [] : input.includes, excludes: input.excludes === undefined ? [] : input.excludes,
    createdAt: new Date().toISOString(),
  });
  const cases = listEvalCases(test.bot);
  if (cases.length >= 8) throw new InputError("At most 8 evaluation cases per bot are allowed", 409);
  writeJson(suitePath(test.bot), [...cases, test]);
  return test;
}

export function deleteEvalCase(bot: string, id: string): void {
  safeId(id);
  const cases = listEvalCases(bot);
  if (!cases.some((test) => test.id === id)) throw new InputError("Evaluation case not found for this bot", 404);
  writeJson(suitePath(bot), cases.filter((test) => test.id !== id));
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function literalChecks(test: EvalCase, baseline: string, candidate: string): EvaluationReport["cases"][number]["checks"] {
  const base = baseline.toLowerCase();
  const next = candidate.toLowerCase();
  return [
    ...test.includes.map((text) => ({ label: `Includes literal (case-insensitive): ${text}`, baseline: base.includes(text.toLowerCase()), candidate: next.includes(text.toLowerCase()) })),
    ...test.excludes.map((text) => ({ label: `Excludes literal (case-insensitive): ${text}`, baseline: !base.includes(text.toLowerCase()), candidate: !next.includes(text.toLowerCase()) })),
  ];
}

export function decideProposal(id: string, decision: "accept" | "reject" | "rollback", revision: string): Proposal {
  const proposal = load<StoredProposal>("proposals", id);
  if (!["accept", "reject", "rollback"].includes(decision)) throw new InputError("Invalid proposal decision");
  const status = { accept: "accepted", reject: "rejected", rollback: "rolled_back" }[decision] as Proposal["status"];
  if (proposal.status === status) return publicProposal(proposal);
  if (proposal.status !== (decision === "rollback" ? "accepted" : "proposed")) throw new InputError(`Cannot ${decision} a ${proposal.status} proposal`, 409);
  if (decision === "accept") {
    revision = requiredText(revision, "Context revision", 512);
    if (evaluationLocks.has(proposal.bot)) throw new InputError("An evaluation is still running for this bot", 409);
    if (sourceEvidence(proposal).status !== "completed") throw new InputError("Source run must be completed before acceptance", 409);
    if (!proposal.evaluationId) throw new InputError("A passing proposal evaluation is required", 409);
    const report = load<StoredEvaluation>("evaluations", proposal.evaluationId);
    const suite = listEvalCases(proposal.bot);
    const lessons = acceptedLessons(proposal.bot);
    if (report.bot !== proposal.bot || report.proposalId !== proposal.id || report.status !== "passed" || report.error || report.regressions !== 0) {
      throw new InputError("A passing proposal evaluation without regressions is required", 409);
    }
    if (report.revision !== revision || report.provenance?.proposalText !== proposal.text) throw new InputError("Evaluation context is stale; evaluate again", 409);
    if (!suite.length || fingerprint(report.provenance.suite) !== fingerprint(suite)) throw new InputError("Evaluation suite is missing or stale; evaluate again", 409);
    if (report.provenance.lessonsFingerprint !== fingerprint(lessons.map((lesson) => [lesson.id, lesson.text]))) {
      throw new InputError("Active lessons changed; evaluate again", 409);
    }
    if (report.total !== suite.length || report.candidatePassed !== suite.length || report.cases.length !== suite.length || !suite.every((test, index) => {
      const result = report.cases[index];
      return result.id === test.id && result.name === test.name && result.prompt === test.prompt && result.candidatePassed
        && fingerprint(result.checks) === fingerprint(literalChecks(test, result.baseline, result.candidate)) && result.checks.every((check) => check.candidate);
    })) throw new InputError("Evaluation is incomplete or failed; every current case must pass", 409);
    // Preserve append order, including decisions made in the same millisecond.
    proposal.lessonOrder = (lessons.at(-1)?.lessonOrder ?? 0) + 1;
  }
  proposal.status = status;
  proposal.decidedAt = new Date().toISOString();
  writeJson(recordPath("proposals", id), proposal);
  return publicProposal(proposal);
}

export function listEvaluations(bot?: string): EvaluationReport[] {
  if (bot !== undefined) botName(bot);
  return records<StoredEvaluation>("evaluations").filter((report) => bot === undefined || report.bot === bot)
    .map(({ provenance: _provenance, ...report }) => report);
}

export async function runEvaluation(
  bot: string,
  proposalId: string | undefined,
  options: {
    revision: string;
    model: string;
    respond: (prompt: string, lessons: string[], signal?: AbortSignal) => Promise<string>;
    signal?: AbortSignal;
  },
): Promise<EvaluationReport> {
  botName(bot);
  const revision = requiredText(options.revision, "Context revision", 512);
  const model = requiredText(options.model, "Model", 200);
  const respond = options.respond;
  if (typeof respond !== "function") throw new InputError("An evaluation responder is required");
  if (evaluationLocks.has(bot)) throw new InputError("An evaluation is already running for this bot", 409);
  const proposal = proposalId === undefined ? undefined : getProposal(proposalId);
  if (proposal && (proposal.bot !== bot || proposal.status !== "proposed")) throw new InputError("Evaluation requires a proposed lesson belonging to this bot", 409);
  const suite = listEvalCases(bot);
  if (suite.length === 0) throw new InputError("Add at least one evaluation case before evaluating", 409);
  const lessons = acceptedLessons(bot);
  const baselineLessons = lessons.map((lesson) => lesson.text);
  const candidateLessons = proposal ? [...baselineLessons, proposal.text] : baselineLessons;
  const report: EvaluationReport = {
    id: randomUUID(), bot, ...(proposal ? { proposalId: proposal.id } : {}), createdAt: new Date().toISOString(), revision, model,
    status: "failed", baselinePassed: 0, candidatePassed: 0, regressions: 0, improvements: 0, total: suite.length, cases: [],
  };
  const timeout = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  // A real provider answers slowly; budget derives from the work, not a fixed wall.
  const budgetMs = Math.max(120_000, suite.length * (proposal ? 2 : 1) * 45_000);
  const timer = setTimeout(() => timeout.abort(new Error(`Evaluation timed out after ${Math.round(budgetMs / 1000)} seconds`)), budgetMs);
  evaluationLocks.add(bot);
  let stage = "Starting evaluation";
  try {
    async function answer(prompt: string, active: string[]): Promise<string> {
      signal.throwIfAborted();
      let onAbort: () => void = () => {};
      const stopped = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        // An adapter may ignore cancellation; race it and never start subsequent calls after abort.
        const text = await Promise.race([stopped, Promise.resolve().then(() => {
          signal.throwIfAborted();
          return respond(prompt, [...active], signal);
        })]);
        signal.throwIfAborted();
        return boundedText(text, "Evaluation response", MAX_RESPONSE);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }

    try {
      for (const test of suite) {
        stage = `Baseline for ${test.name}`;
        const baseline = await answer(test.prompt, baselineLessons);
        stage = `Candidate for ${test.name}`;
        const candidate = proposal ? await answer(test.prompt, candidateLessons) : baseline;
        const checks = literalChecks(test, baseline, candidate);
        const baselinePassed = checks.every((check) => check.baseline);
        const candidatePassed = checks.every((check) => check.candidate);
        report.cases.push({ id: test.id, name: test.name, prompt: test.prompt, baseline, candidate, baselinePassed, candidatePassed, checks });
        report.baselinePassed += Number(baselinePassed);
        report.candidatePassed += Number(candidatePassed);
        report.regressions += Number(baselinePassed && !candidatePassed);
        report.improvements += Number(!baselinePassed && candidatePassed);
      }
      signal.throwIfAborted();
      if (report.candidatePassed === suite.length && report.regressions === 0) report.status = "passed";
    } catch (error) {
      if (error instanceof InputError && error.status === 409) throw error;
      report.error = `${stage}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000);
    }
    const stored: StoredEvaluation = { ...report, provenance: {
      suite, lessonsFingerprint: fingerprint(lessons.map((lesson) => [lesson.id, lesson.text])),
      ...(proposal ? { proposalText: proposal.text } : {}),
    } };
    writeJson(recordPath("evaluations", report.id), stored);
    if (proposal) {
      const current = load<StoredProposal>("proposals", proposal.id);
      if (current.status === "proposed") {
        current.evaluationId = report.id;
        writeJson(recordPath("proposals", current.id), current);
      }
    }
    return report;
  } finally {
    clearTimeout(timer);
    evaluationLocks.delete(bot);
  }
}
