import { join } from "node:path";
import { chmodSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dataDir, readJson, writeJson } from "../store.ts";
import { InputError, requiredText, textList } from "../errors.ts";

const SEP = "\n§\n";
const MAX_BYTES = 1024 * 1024;
export type MemoryTarget = "memory" | "user";
export const MEMORY_LIMITS = { memory: 4000, user: 3000 } as const;

export function memorySettings(): { enabled: boolean; generation: number } {
  const path = join(dataDir(), "memory-settings.json");
  checkFile(path);
  const value = readJson(path, { enabled: true, generation: 0 });
  if (!value || typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.generation) || value.generation < 0) throw new Error("Invalid memory settings");
  return value;
}

export function setMemoryEnabled(enabled: boolean): ReturnType<typeof memorySettings> {
  if (typeof enabled !== "boolean") throw new InputError("Memory enabled must be a boolean");
  const previous = memorySettings();
  const next = { enabled, generation: previous.generation + 1 };
  writeJson(join(dataDir(), "memory-settings.json"), next);
  return next;
}

// Owner edits invalidate decisions made from an older snapshot, including in-flight model calls.
export function invalidateMemoryWriters(): void { setMemoryEnabled(memorySettings().enabled); }

function split(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw.split(SEP).map((s) => s.trim()).filter(Boolean);
}

function memPath(): string {
  return join(dataDir(), "MEMORY.md");
}

function userPath(): string {
  return join(dataDir(), "USER.md");
}

export function ensureMemoryFiles(): void {
  for (const path of [memPath(), userPath()]) {
    const stat = checkFile(path);
    if (stat) chmodSync(path, 0o600);
    else writeFileSync(path, "", { flag: "wx", mode: 0o600 });
  }
}

function checkFile(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new InputError("unsafe memory file");
  if (stat.size > MAX_BYTES) throw new InputError("memory file exceeds 1 MiB");
  return true;
}

function readEntries(path: string): string[] {
  if (!checkFile(path)) return [];
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new InputError("memory file exceeds 1 MiB");
  return split(raw);
}

function writeEntries(path: string, entries: string[]): void {
  const raw = entries.length ? entries.join(SEP) + "\n" : "";
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new InputError("memory file exceeds 1 MiB");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, raw, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export function readMemory(): string[] {
  return readEntries(memPath());
}

export function readUserEntries(): string[] {
  return readEntries(userPath());
}

function addUnique(path: string, existing: string[], entries: string[]): string[] {
  const values = textList(entries, "memory entries", 100, 4000);
  if (values.some((entry) => entry.includes(SEP))) throw new InputError("memory entries cannot contain the entry separator");
  const known = new Set(existing.map((e) => e.toLowerCase()));
  const fresh = values.filter((entry) => {
    const key = entry.toLowerCase();
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
  if (fresh.length > 0) writeEntries(path, [...existing, ...fresh]);
  return fresh;
}

export function appendMemory(entries: string[]): string[] {
  return addUnique(memPath(), readMemory(), entries);
}

export function updateUser(entries: string[]): string[] {
  return addUnique(userPath(), readUserEntries(), entries);
}

export function searchMemory(query: string): string[] {
  const q = requiredText(query, "memory query", 2000).toLowerCase();
  return readMemory().filter((e) => e.toLowerCase().includes(q));
}

export function memoryUsage() {
  const memory = readMemory(); const user = readUserEntries();
  const settings = memorySettings();
  return { ...settings, revision: createHash("sha256").update(JSON.stringify({ memory, user, settings })).digest("hex"), counts: { memory: memory.length, user: user.length },
    chars: { memory: memory.join("\n").length, user: user.join("\n").length }, limits: MEMORY_LIMITS };
}

export function manageMemory(input: { action: string; target: string; content?: string; old_text?: string }, options: { owner?: boolean; generation?: number } = {}) {
  if (!["add", "replace", "remove"].includes(input.action)) throw new InputError("Memory action must be add, replace or remove");
  if (input.target !== "memory" && input.target !== "user") throw new InputError("Memory target must be memory or user");
  const target = input.target;
  const settings = memorySettings();
  if (!options.owner && (!settings.enabled || options.generation !== settings.generation)) throw new InputError("Memory updates are disabled or the owner changed memory while this task was running. Do not retry a write in this task.", 409);
  const path = target === "memory" ? memPath() : userPath();
  const entries = readEntries(path);
  const content = input.action === "remove" ? "" : requiredText(input.content, "Memory content", 2000);
  if (content.includes(SEP)) throw new InputError("Memory content cannot contain the entry separator");
  if (!options.owner && /-----BEGIN [\w ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat|xox[baprs])[-_][\w-]{16,}|\beyJ[\w-]{15,}\.[\w-]{10,}\.[\w-]+|\b(?:password|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret)\s*[:=]\s*\S+/i.test(content)) throw new InputError("Do not store credentials in memory");
  let next = [...entries];
  if (input.action === "add") {
    if (!next.some((entry) => entry.toLowerCase() === content.toLowerCase())) next.push(content);
  } else {
    const old = requiredText(input.old_text, "Exact old memory entry", 4000);
    const matches = entries.flatMap((entry, index) => entry === old ? [index] : []);
    if (matches.length !== 1) throw new InputError("The old entry changed or is not unique. Read current memory and use its complete exact text.", 409);
    if (input.action === "remove") next.splice(matches[0], 1);
    else next[matches[0]] = content;
    next = next.filter((entry, index) => next.findIndex((other) => other.toLowerCase() === entry.toLowerCase()) === index);
  }
  const chars = next.join("\n").length;
  if (input.action !== "remove" && chars > MEMORY_LIMITS[target] && chars >= entries.join("\n").length) throw new InputError(`Memory is full (${chars}/${MEMORY_LIMITS[target]} characters). Consolidate with replace or remove outdated entries before adding more. Nothing was discarded.`, 409);
  const changed = JSON.stringify(entries) !== JSON.stringify(next);
  if (changed) {
    if (options.owner) invalidateMemoryWriters();
    writeEntries(path, next);
  }
  return { changed, target, action: input.action, entries: next, chars, limit: MEMORY_LIMITS[target] };
}
