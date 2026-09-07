import { join } from "node:path";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dataDir, readJson, readText, writeJson } from "../store.ts";
import { InputError, requiredText } from "../errors.ts";
import { getBot, validName } from "../bots/manager.ts";
import { getGroup, validGroupId } from "../chat/session.ts";

export interface CronJob {
  name: string;
  schedule: string;
  prompt: string;
  bot: string;
  deliver?: string;
  enabled?: boolean;
}

export interface Execution {
  job: string;
  at: string;
  slot?: string;
  bot: string;
  deliver?: string;
  ok: boolean;
  detail?: string;
}

const DAYS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

function num(v: string, min: number, max: number, what: string): number {
  const n = Number(v);
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n < min || n > max) throw new InputError(`bad ${what}: ${v}`);
  return n;
}

interface Field {
  values: Set<number>;
  wildcard: boolean;
}

function parseField(field: string, min: number, max: number, what: string): Field {
  const values = new Set<number>();
  for (const piece of field.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(piece);
    if (!match) throw new InputError(`bad ${what}: ${field}`);
    const step = match[2] === undefined ? 1 : num(match[2], 1, max - min + 1, `${what} step`);
    const range = match[1].split("-");
    const start = range[0] === "*" ? min : num(range[0], min, max, what);
    const end = range[0] === "*" || (range.length === 1 && match[2] !== undefined)
      ? max : range.length === 2 ? num(range[1], min, max, what) : start;
    if (start > end) throw new InputError(`bad ${what} range: ${piece}`);
    for (let value = start; value <= end; value += step) {
      values.add(what === "weekday" && value === 7 ? 0 : value);
    }
  }
  // Vixie cron's day wildcard rule also applies to a leading */step.
  return { values, wildcard: field.startsWith("*") };
}

function parseSchedule(schedule: string): { schedule: string; fields: Field[] } {
  let s = requiredText(schedule, "schedule", 200).toLowerCase();
  if (s === "hourly") s = "0 * * * *";
  let m = s.match(/^daily\s+(\d{1,2}):(\d{2})$/);
  if (m) s = `${num(m[2], 0, 59, "minute")} ${num(m[1], 0, 23, "hour")} * * *`;
  m = s.match(/^weekly\s+([a-z]+)\s+(\d{1,2}):(\d{2})$/);
  if (m && Object.hasOwn(DAYS, m[1])) s = `${num(m[3], 0, 59, "minute")} ${num(m[2], 0, 23, "hour")} * * ${DAYS[m[1]]}`;
  const parts = s.split(/\s+/);
  if (parts.length !== 5) throw new InputError(`bad schedule (want 5-field cron or hourly/daily/weekly): ${schedule}`);
  return {
    schedule: parts.join(" "),
    fields: [
      parseField(parts[0], 0, 59, "minute"), parseField(parts[1], 0, 23, "hour"),
      parseField(parts[2], 1, 31, "day"), parseField(parts[3], 1, 12, "month"),
      parseField(parts[4], 0, 7, "weekday"),
    ],
  };
}

export function normalizeSchedule(schedule: string): string {
  return parseSchedule(schedule).schedule;
}

function matchesDay(fields: Field[], at: Date): boolean {
  const [, , dom, mon, dow] = fields;
  const day = dom.values.has(at.getUTCDate());
  const weekday = dow.values.has(at.getUTCDay());
  return mon.values.has(at.getUTCMonth() + 1) &&
    (dom.wildcard || dow.wildcard ? day && weekday : day || weekday);
}

function validDate(at: Date): void {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new InputError("invalid cron date");
}

export function isDue(schedule: string, at: Date = new Date()): boolean {
  validDate(at);
  const fields = parseSchedule(schedule).fields;
  return fields[0].values.has(at.getUTCMinutes()) && fields[1].values.has(at.getUTCHours()) && matchesDay(fields, at);
}

/** First matching UTC minute strictly after from, or null within an eight-year search horizon. */
export function nextRun(schedule: string, from: Date = new Date()): string | null {
  validDate(from);
  const fields = parseSchedule(schedule).fields;
  const earliest = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  const day = new Date(earliest);
  day.setUTCHours(0, 0, 0, 0);
  const hours = [...fields[1].values].sort((a, b) => a - b);
  const minutes = [...fields[0].values].sort((a, b) => a - b);
  for (let days = 0; days < 8 * 366 && Number.isFinite(day.getTime()); days++, day.setUTCDate(day.getUTCDate() + 1)) {
    if (!matchesDay(fields, day)) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = day.getTime() + (hour * 60 + minute) * 60_000;
        if (candidate >= earliest && Number.isFinite(new Date(candidate).getTime())) return new Date(candidate).toISOString();
      }
    }
  }
  return null;
}

function jobsPath(): string {
  return join(dataDir(), "jobs.json");
}

export function listJobs(): CronJob[] {
  const jobs = readJson<CronJob[]>(jobsPath(), []);
  if (!Array.isArray(jobs)) throw new Error("stored jobs must be a list");
  return jobs;
}

function validateJob(job: CronJob): CronJob {
  if (!job || typeof job !== "object") throw new InputError("job is required");
  const name = requiredText(job.name, "job name", 40);
  if (!validName(name)) throw new InputError(`invalid job name: ${name}`);
  const prompt = requiredText(job.prompt, "job prompt");
  const bot = requiredText(job.bot, "job bot", 40);
  if (!validName(bot)) throw new InputError(`invalid bot name: ${bot}`);
  if (!getBot(bot)) throw new InputError(`unknown bot: ${bot}`);
  if (job.enabled !== undefined && typeof job.enabled !== "boolean") throw new InputError("job enabled must be a boolean");
  if (job.deliver !== undefined && typeof job.deliver !== "string") throw new InputError("job deliver must be a local bot:<name> or group:<id>");
  const deliver = job.deliver?.trim() || undefined;
  if (deliver) {
    const target = /^(bot|group):([^:]+)$/.exec(deliver);
    if (!target) throw new InputError("job deliver must be a local bot:<name> or group:<id>");
    if (target[1] === "bot") {
      if (!validName(target[2]) || !getBot(target[2])) throw new InputError(`unknown delivery bot: ${target[2]}`);
    } else if (!validGroupId(target[2]) || !getGroup(target[2])) {
      throw new InputError(`unknown delivery group: ${target[2]}`);
    }
  }
  const schedule = normalizeSchedule(job.schedule);
  return { name, schedule, prompt, bot, deliver, enabled: job.enabled ?? true };
}

/** Upsert by name. Editing or deleting a job never clears its minute claims. */
export function addJob(job: CronJob): CronJob[] {
  const validated = validateJob(job);
  const jobs = listJobs().filter((j) => typeof j?.name !== "string" || j.name.trim() !== validated.name);
  jobs.push(validated);
  jobs.sort((a, b) => (typeof a?.name === "string" ? a.name : "").localeCompare(typeof b?.name === "string" ? b.name : ""));
  writeJson(jobsPath(), jobs);
  return jobs;
}

export function removeJob(name: string): CronJob[] {
  name = requiredText(name, "job name", 40);
  if (!validName(name)) throw new InputError(`invalid job name: ${name}`);
  const jobs = listJobs().filter((j) => typeof j?.name !== "string" || j.name.trim() !== name);
  writeJson(jobsPath(), jobs);
  return jobs;
}

export function logExecution(e: Execution): void {
  appendFileSync(join(dataDir(), "executions.jsonl"), JSON.stringify(e) + "\n", { mode: 0o600, flush: true });
}

/** Newest first. Ignore incomplete JSONL records left by an interrupted append. */
export function listExecutions(limit = 50): Execution[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new InputError("execution limit must be between 1 and 500");
  const executions: Execution[] = [];
  for (const line of readText(join(dataDir(), "executions.jsonl")).split("\n").reverse()) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Execution;
      if (entry && typeof entry.job === "string" && typeof entry.ok === "boolean" && typeof entry.at === "string") executions.push(entry);
    } catch { /* A torn record must not hide the intact execution history. */ }
    if (executions.length === limit) break;
  }
  return executions;
}

function claim(job: string, slot: string): boolean {
  const dir = join(dataDir(), "cron-claims");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(JSON.stringify([job, slot])).digest("hex");
  try {
    writeFileSync(join(dir, `${key}.json`), JSON.stringify({ job, slot }) + "\n", { flag: "wx", mode: 0o600, flush: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** At-most-once dispatch per job name and UTC minute, including failures and process restarts.
 * Claims precede dispatch and are never retried: a crash can leave a claimed slot without a result.
 * handle owns actual dispatch/delivery and must reject when either fails.
 */
export async function runDue(at: Date, handle: (job: CronJob) => Promise<string>): Promise<Execution[]> {
  validDate(at);
  const timestamp = at.toISOString();
  const slot = new Date(Math.floor(at.getTime() / 60_000) * 60_000).toISOString();
  const out: Execution[] = [];
  for (const [index, stored] of listJobs().entries()) {
    if (stored?.enabled === false) continue;
    let job: CronJob | undefined;
    let invalid: unknown;
    try {
      job = validateJob(stored);
      if (!isDue(job.schedule, at)) continue;
    } catch (error) {
      invalid = error;
    }
    const name = typeof stored?.name === "string" && stored.name.trim() ? stored.name.trim() : `(invalid job #${index})`;
    if (!claim(name, slot)) continue;
    const e: Execution = {
      job: name, at: timestamp, slot, bot: job?.bot ?? (typeof stored?.bot === "string" ? stored.bot : ""),
      deliver: job ? job.deliver : typeof stored?.deliver === "string" ? stored.deliver : undefined, ok: false,
    };
    try {
      if (!job || invalid) throw invalid ?? new Error("invalid stored job");
      e.detail = await handle(job);
      e.ok = true;
    } catch (err) {
      e.detail = String(err);
    }
    logExecution(e);
    out.push(e);
  }
  return out;
}
