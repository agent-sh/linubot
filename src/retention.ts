import { lstatSync, readdirSync, readFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, readJson, writeJson } from "./store.ts";
import { workspaceStarting } from "./computer/workspace.ts";
import { InputError } from "./errors.ts";

const DAY = 86400000;
const categories = ["computer-profiles", "screenshots", "contexts", "artifacts", "live-frames"] as const;
const caches = ["Cache", "Code Cache", "GPUCache", "GrShaderCache", "ShaderCache", "DawnCache", "Service Worker/CacheStorage"];
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
interface Usage { files: number; bytes: number }
interface Settings { screenshotDays: number }
interface Options { directory?: string; dryRun?: boolean; now?: number; runningScopes?: () => Iterable<string> }
const pending = new Map<string, { dryRun: boolean; work: Promise<Usage & { dryRun: boolean }> }>();

function settings(value: Settings): Settings {
  if (!value || !Number.isSafeInteger(value.screenshotDays) || value.screenshotDays < 1 || value.screenshotDays > 3650) throw new InputError("Screenshot retention must be between 1 and 3650 days");
  return { screenshotDays: value.screenshotDays };
}
export function retentionSettings(directory = dataDir()): Settings {
  return settings(readJson(join(directory, "retention-settings.json"), { screenshotDays: 14 }));
}
export function setRetentionSettings(value: Settings, directory = dataDir()): Settings {
  const next = settings(value); writeJson(join(directory, "retention-settings.json"), next); return next;
}

// Walk only real directories, including every intermediate cache path component.
// Symlinks and special files never become retention targets or size inputs.
function safeDirectory(root: string, relative = ""): boolean {
  let path = root;
  for (const part of ["", ...relative.split(sep).filter(Boolean)]) {
    path = join(path, part);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  }
  return true;
}
function files(path: string): string[] {
  if (!safeDirectory(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : entry.isFile() ? [join(path, entry.name)] : []);
}
function usage(paths: string[]): Usage {
  return paths.reduce((sum, path) => { const stat = lstatSync(path); return { files: sum.files + 1, bytes: sum.bytes + stat.size }; }, { files: 0, bytes: 0 });
}
export function retentionStatus(directory = dataDir()) {
  return { settings: retentionSettings(directory), sizes: Object.fromEntries(categories.map(category => [category, usage(safeDirectory(directory, category) ? files(join(directory, category)) : [])])) };
}

function prune(options: Options, directory: string) {
  const cutoff = (options.now ?? Date.now()) - retentionSettings(directory).screenshotDays * DAY;
  const protectedIds = new Set<string>(), activeRuns = new Set<string>();
  if (!safeDirectory(directory)) throw new Error("Unsafe retention data directory");
  const runsStat = lstatSync(join(directory, "runs"), { throwIfNoEntry: false });
  if (runsStat && !safeDirectory(directory, "runs")) throw new Error("Unsafe retention run directory");
  if (safeDirectory(directory, "runs")) for (const entry of readdirSync(join(directory, "runs"), { withFileTypes: true })) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile()) throw new Error("Unsafe retention run record");
    const path = join(directory, "runs", entry.name);
    const run = readJson<{ id: string; status: string } | null>(path, null);
    if (!run || typeof run.id !== "string" || typeof run.status !== "string") throw new Error("Invalid retention run record");
    if (!terminal.has(run.status)) activeRuns.add(run.id);
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.name.startsWith("feed-") || !entry.name.endsWith(".jsonl")) continue;
    if (!entry.isFile()) throw new Error("Unsafe retention event file");
    for (const line of readFileSync(join(directory, entry.name), "utf8").split("\n").filter(Boolean)) {
      const event = JSON.parse(line);
      if (!event || !Number.isFinite(Date.parse(event.at))) throw new Error("Invalid retention event record");
      if (Date.parse(event.at) >= cutoff || activeRuns.has(event.runId)) {
        for (const match of line.matchAll(/\/api\/screenshots\/([a-f0-9-]{36})/g)) protectedIds.add(match[1]);
      }
    }
  }
  const owned = readJson<{ scope?: string; state: string }[]>(join(directory, "computer-workspaces.json"), []);
  if (!Array.isArray(owned) || owned.some(entry => !entry || !["running", "stopped"].includes(entry.state))) throw new Error("Invalid retention workspace registry");
  const busy = new Set([...owned.filter(entry => entry.state === "running").map(entry => entry.scope), ...(options.runningScopes?.() ?? [])]);
  const targets = new Set<string>(), directories: string[] = [];
  const profiles = join(directory, "computer-profiles");
  if (safeDirectory(directory, "computer-profiles")) for (const owner of readdirSync(profiles, { withFileTypes: true })) {
    if (!owner.isDirectory() || !/^(bot|group)_[A-Za-z0-9_-]{1,60}$/.test(owner.name)) continue;
    const scope = owner.name.replace("_", ":");
    if (busy.has(scope) || workspaceStarting(scope, directory)) continue;
    for (const mode of ["standard", "automated"]) for (const prefix of ["", "Default"]) for (const cache of caches) {
      const relative = join("computer-profiles", owner.name, mode, prefix, cache);
      if (!safeDirectory(directory, relative)) continue;
      const path = join(directory, relative); directories.push(path);
      for (const file of files(path)) targets.add(file);
    }
  }
  for (const category of ["screenshots", "live-frames"] as const) {
    if (!safeDirectory(directory, category)) continue;
    for (const entry of readdirSync(join(directory, category), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".png")) continue;
      const path = join(directory, category, entry.name);
      const expires = category === "screenshots" ? cutoff : (options.now ?? Date.now()) - 3600000;
      if (lstatSync(path).mtimeMs >= expires || (category === "screenshots" && protectedIds.has(entry.name.slice(0, -4)))) continue;
      targets.add(path);
    }
  }
  const result = { ...usage([...targets]), dryRun: options.dryRun === true };
  if (!options.dryRun) {
    for (const path of targets) unlinkSync(path);
    const removeEmpty = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) removeEmpty(join(path, entry.name));
      if (!readdirSync(path).length) rmdirSync(path);
    };
    for (const path of directories) removeEmpty(path);
  }
  return result;
}

/** A synchronous pass cannot race this process's workspace starts or event writes.
 * Defer it one microtask so simultaneous callers share the same completion. */
export function runRetention(options: Options = {}): Promise<Usage & { dryRun: boolean }> {
  const directory = resolve(options.directory ?? dataDir());
  const existing = pending.get(directory);
  if (existing) return existing.dryRun === (options.dryRun === true) ? existing.work : existing.work.then(() => runRetention(options));
  const work = Promise.resolve().then(() => {
    const result = prune(options, directory);
    if (!result.dryRun) console.log(`Retention: ${result.files} files, ${result.bytes} bytes freed`);
    return result;
  }).finally(() => pending.delete(directory));
  pending.set(directory, { dryRun: options.dryRun === true, work }); return work;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--dry-run")) throw new Error("CLI inspection requires --dry-run; use the desktop to free space");
  // Do not call dataDir(): inspection must never create a directory.
  const directory = resolve(process.env.LINUBOT_DATA ?? "data");
  console.log(JSON.stringify({ ...retentionStatus(directory), result: await runRetention({ directory, dryRun: true }) }, null, 2));
}
