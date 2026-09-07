import { appendFileSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { dataDir } from "../store.ts";
import { InputError } from "../errors.ts";

/**
 * Event-sourced transcripts. Every scope (bot:<name> or group:<id>) owns one
 * append-only JSONL log. Messages, thinking, tool calls, files, approvals,
 * and handoffs share one chronological feed with sequence numbers, and every
 * append fans out to live SSE subscribers.
 */
export type EventKind = "message" | "thinking" | "tool" | "file" | "approval" | "handoff" | "notice" | "state";

export interface FeedEvent {
  seq: number;
  at: string;
  kind: EventKind;
  from?: string;
  text?: string;
  name?: string;
  preview?: string;
  detail?: string;
  status?: "pending" | "done" | "error" | "aborted" | "approved" | "denied" | "working" | "idle" | "queued" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "interrupted";
  path?: string;
  to?: string;
  runId?: string;
  batchId?: string;
  callId?: string;
  refSeq?: number;
  stage?: string;
  durationMs?: number;
}

export type NewEvent = Omit<FeedEvent, "seq" | "at"> & { at?: string };

export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function validateScope(scope: string): string {
  if (typeof scope !== "string" || !/^(bot|group):[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(scope)) {
    throw new InputError("Scope must be bot:<name> or group:<id>");
  }
  return scope;
}

function logPath(scope: string): string {
  validateScope(scope);
  return join(dataDir(), "feed-" + scope.replace(/[^A-Za-z0-9_-]/g, "_") + ".jsonl");
}

const cache = new Map<string, { size: number; mtime: number; entries: FeedEvent[] }>();

function readAll(scope: string): FeedEvent[] {
  const path = logPath(scope);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) { cache.delete(path); return []; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe feed file");
  const known = cache.get(path);
  if (known?.size === stat.size && known.mtime === stat.mtimeMs) return known.entries;
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const entries: FeedEvent[] = [];
  for (const [index, line] of lines.entries()) {
    let event: FeedEvent;
    try {
      event = JSON.parse(line) as FeedEvent;
    } catch (cause) {
      // A crash during append leaves at most a torn final line; drop that line only.
      if (index === lines.length - 1) {
        try {
          const rest = lines.slice(0, index);
          writeFileSync(path, rest.length ? rest.map(String).join("\n") + "\n" : "", { mode: 0o600 });
          cache.delete(path);
        } catch { /* keep reading what we have */ }
        break;
      }
      throw new Error(`Invalid feed record #${index + 1}`, { cause });
    }
    if (!event || event.seq !== index + 1 || typeof event.kind !== "string" || typeof event.at !== "string") {
      if (index === lines.length - 1) {
        try { writeFileSync(path, lines.slice(0, index).join("\n") + (index ? "\n" : ""), { mode: 0o600 }); cache.delete(path); } catch { /* keep */ }
        break;
      }
      throw new Error(`Invalid feed record #${index + 1}`);
    }
    entries.push(event);
  }
  cache.set(path, { size: stat.size, mtime: stat.mtimeMs, entries });
  return entries;
}

export function appendEvent(scope: string, e: NewEvent): FeedEvent {
  const existing = readAll(scope);
  const full: FeedEvent = { ...e, seq: existing.length + 1, at: e.at ?? new Date().toISOString() };
  const path = logPath(scope);
  appendFileSync(path, JSON.stringify(full) + "\n", { mode: 0o600 });
  existing.push(full);
  const stat = lstatSync(path);
  cache.set(path, { size: stat.size, mtime: stat.mtimeMs, entries: existing });
  bus.emit("event", scope, full);
  return full;
}

/** Tail page: last `limit` events at or before `beforeSeq` (1-based, newest last). */
export function tailEvents(scope: string, limit = 50, beforeSeq?: number): { entries: FeedEvent[]; nextBeforeSeq: number | null; lastSeq: number } {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new InputError("Limit must be a nonnegative integer");
  if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) throw new InputError("Before must be a positive sequence number");
  const all = readAll(scope);
  const upto = beforeSeq === undefined ? all.length : Math.min(beforeSeq - 1, all.length);
  const start = Math.max(0, upto - limit);
  const entries = all.slice(start, upto);
  return { entries, nextBeforeSeq: start > 0 ? start + 1 : null, lastSeq: all.length };
}

export function eventsAfter(scope: string, seq: number): FeedEvent[] {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new InputError("After must be a nonnegative sequence number");
  return readAll(scope).slice(seq);
}

export function eventBySeq(scope: string, seq: number): FeedEvent | undefined {
  return readAll(scope).find((event) => event.seq === seq);
}

export function previewOf(scope: string): string {
  const all = readAll(scope);
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].kind === "message" && all[i].text) return all[i].text as string;
  }
  return "";
}

export function lastSeq(scope: string): number {
  return readAll(scope).length;
}
