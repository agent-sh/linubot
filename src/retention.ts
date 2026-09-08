import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, unlinkSync, rmdirSync } from "node:fs";
import type { Stats } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, writeJson } from "./store.ts";
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
const defaultDirectory = () => resolve(process.env.LINUBOT_DATA ?? "data");
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

// Linux procfs resolves this prefix to the open directory itself, even after a
// rename. Only ONE untrusted basename may follow it. O_NOFOLLOW then covers
// that entire lookup; never append a multi-component relative path here.
// See open(2), "Rationale for openat()", and proc_pid_fd(5).
function at(fd: number, name?: string): string {
  if (name !== undefined && (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0"))) throw new Error("Invalid retention basename");
  return `/proc/self/fd/${fd}${name === undefined ? "" : `/${name}`}`;
}
function openRoot(directory: string): number | undefined {
  if (process.platform !== "linux") throw new Error("Retention requires Linux directory handles");
  let fd = openSync("/", directoryFlags);
  try {
    // Pin every component, including ancestors of LINUBOT_DATA. Do not follow
    // configured symlink aliases or fall back to ordinary pathname traversal.
    for (const name of resolve(directory).split("/").filter(Boolean)) {
      const child = openSync(at(fd, name), directoryFlags);
      closeSync(fd); fd = child;
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    if (code(error) === "ENOENT") return undefined;
    throw error;
  }
}
function inDirectory(parent: number, names: string[], visit: (fd: number) => void): void {
  if (!names.length) { visit(parent); return; }
  let fd: number;
  try { fd = openSync(at(parent, names[0]), directoryFlags); }
  catch (error) { if (["ENOENT", "ENOTDIR", "ELOOP"].includes(code(error) ?? "")) return; throw error; }
  try { inDirectory(fd, names.slice(1), visit); } finally { closeSync(fd); }
}
function readStored<T>(fd: number, name: string, fallback: T): T {
  let file: number;
  try { file = openSync(at(fd, name), fileFlags); }
  catch (error) { if (code(error) === "ENOENT") return fallback; throw error; }
  try {
    if (!fstatSync(file).isFile()) throw new Error("Unsafe retention metadata file");
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } finally { closeSync(file); }
}
function settings(value: Settings): Settings {
  if (!value || !Number.isSafeInteger(value.screenshotDays) || value.screenshotDays < 1 || value.screenshotDays > 3650) throw new InputError("Screenshot retention must be between 1 and 3650 days");
  return { screenshotDays: value.screenshotDays };
}
const storedSettings = (fd: number) => settings(readStored(fd, "retention-settings.json", { screenshotDays: 14 }));
export function retentionSettings(directory = defaultDirectory()): Settings {
  const fd = openRoot(directory);
  if (fd === undefined) return { screenshotDays: 14 };
  try { return storedSettings(fd); } finally { closeSync(fd); }
}
export function setRetentionSettings(value: Settings, directory = dataDir()): Settings {
  const next = settings(value); writeJson(join(directory, "retention-settings.json"), next); return next;
}

// File information comes from a no-follow handle. Unlink uses its pinned parent
// and one basename: even a last-instant file symlink swap only unlinks the link.
function inspectFile(parent: number, name: string, visit: (stat: Stats) => void): void {
  let fd: number;
  try { fd = openSync(at(parent, name), fileFlags); }
  catch (error) { if (["ENOENT", "ENOTDIR", "ELOOP"].includes(code(error) ?? "")) return; throw error; }
  try { const stat = fstatSync(fd); if (stat.isFile()) visit(stat); }
  finally { closeSync(fd); }
}
function removeEmpty(parent: number, name: string): void {
  // rmdir never follows a final symlink; raced links and nonempty directories stay.
  try { rmdirSync(at(parent, name)); }
  catch (error) { if (!["ENOENT", "ENOTDIR", "ENOTEMPTY", "EEXIST"].includes(code(error) ?? "")) throw error; }
}
function walk(fd: number, visit: (parent: number, name: string, stat: Stats) => void, removeDirectories = false): void {
  for (const entry of readdirSync(at(fd), { withFileTypes: true })) {
    if (entry.isDirectory()) inDirectory(fd, [entry.name], child => {
      walk(child, visit, removeDirectories);
      if (removeDirectories) removeEmpty(fd, entry.name);
    });
    else if (entry.isFile()) inspectFile(fd, entry.name, stat => visit(fd, entry.name, stat));
  }
}
export function retentionStatus(directory = defaultDirectory()) {
  const sizes = Object.fromEntries(categories.map(category => [category, { files: 0, bytes: 0 }]));
  const fd = openRoot(directory);
  if (fd === undefined) return { settings: { screenshotDays: 14 }, sizes };
  try {
    for (const category of categories) inDirectory(fd, [category], child => walk(child, (_parent, _name, stat) => { sizes[category].files++; sizes[category].bytes += stat.size; }));
    return { settings: storedSettings(fd), sizes };
  } finally { closeSync(fd); }
}

function prune(options: Options, directory: string) {
  const result = { files: 0, bytes: 0, dryRun: options.dryRun === true };
  const root = openRoot(directory);
  if (root === undefined) return result;
  try {
    const cutoff = (options.now ?? Date.now()) - storedSettings(root).screenshotDays * DAY;
    const protectedIds = new Set<string>(), activeRuns = new Set<string>();
    const entries = readdirSync(at(root), { withFileTypes: true });
    const runs = entries.find(entry => entry.name === "runs");
    if (runs) {
      if (!runs.isDirectory()) throw new Error("Unsafe retention run directory");
      // Metadata must fail closed if a directory disappears or becomes a link.
      const fd = openSync(at(root, "runs"), directoryFlags);
      try {
        for (const entry of readdirSync(at(fd), { withFileTypes: true })) {
          if (!entry.name.endsWith(".json")) continue;
          if (!entry.isFile()) throw new Error("Unsafe retention run record");
          const run = readStored<{ id: string; status: string } | null>(fd, entry.name, null);
          if (!run || typeof run.id !== "string" || typeof run.status !== "string") throw new Error("Invalid retention run record");
          if (!terminal.has(run.status)) activeRuns.add(run.id);
        }
      } finally { closeSync(fd); }
    }
    for (const entry of entries) {
      if (!entry.name.startsWith("feed-") || !entry.name.endsWith(".jsonl")) continue;
      if (!entry.isFile()) throw new Error("Unsafe retention event file");
      const fd = openSync(at(root, entry.name), fileFlags);
      try {
        if (!fstatSync(fd).isFile()) throw new Error("Unsafe retention event file");
        for (const line of readFileSync(fd, "utf8").split("\n").filter(Boolean)) {
          const event = JSON.parse(line);
          if (!event || !Number.isFinite(Date.parse(event.at))) throw new Error("Invalid retention event record");
          if (Date.parse(event.at) >= cutoff || activeRuns.has(event.runId)) {
            for (const match of line.matchAll(/\/api\/screenshots\/([a-f0-9-]{36})/g)) protectedIds.add(match[1]);
          }
        }
      } finally { closeSync(fd); }
    }
    const owned = readStored<{ scope?: string; state: string }[]>(root, "computer-workspaces.json", []);
    if (!Array.isArray(owned) || owned.some(entry => !entry || !["running", "stopped"].includes(entry.state))) throw new Error("Invalid retention workspace registry");
    const busy = new Set([...owned.filter(entry => entry.state === "running").map(entry => entry.scope), ...(options.runningScopes?.() ?? [])]);
    const remove = (parent: number, name: string, stat: Stats) => {
      if (!options.dryRun) {
        try { unlinkSync(at(parent, name)); }
        catch (error) { if (["ENOENT", "EISDIR"].includes(code(error) ?? "")) return; throw error; }
      }
      result.files++; result.bytes += stat.size;
    };
    inDirectory(root, ["computer-profiles"], profiles => {
      for (const owner of readdirSync(at(profiles), { withFileTypes: true })) {
        if (!owner.isDirectory() || !/^(bot|group)_[A-Za-z0-9_-]{1,60}$/.test(owner.name)) continue;
        const scope = owner.name.replace("_", ":");
        if (busy.has(scope) || workspaceStarting(scope, directory)) continue;
        for (const mode of ["standard", "automated"]) inDirectory(profiles, [owner.name, mode], profile => {
          const paths = caches.flatMap(cache => [cache, `Default/${cache}`]);
          // Chromium's component updater stores cached CRX packages at the
          // user-data root. Installed components/models are separate and kept.
          paths.push("component_crx_cache");
          for (const path of paths) {
            const parts = path.split("/"), name = parts.pop()!;
            inDirectory(profile, parts, parent => inDirectory(parent, [name], cache => {
              walk(cache, remove, !options.dryRun);
              if (!options.dryRun) removeEmpty(parent, name);
            }));
          }
        });
      }
    });
    for (const category of ["screenshots", "live-frames"] as const) inDirectory(root, [category], fd => {
      for (const entry of readdirSync(at(fd), { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".png")) continue;
        inspectFile(fd, entry.name, stat => {
          const expires = category === "screenshots" ? cutoff : (options.now ?? Date.now()) - 3600000;
          if (stat.mtimeMs >= expires || (category === "screenshots" && protectedIds.has(entry.name.slice(0, -4)))) return;
          remove(fd, entry.name, stat);
        });
      }
    });
    return result;
  } finally { closeSync(root); }
}

/** Synchronous work keeps this process's workspace starts and event writes out
 * of the pass. Directory handles, not synchrony, prevent filesystem link races. */
export function runRetention(options: Options = {}): Promise<Usage & { dryRun: boolean }> {
  const directory = resolve(options.directory ?? defaultDirectory());
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
  const directory = defaultDirectory();
  console.log(JSON.stringify({ ...retentionStatus(directory), result: await runRetention({ directory, dryRun: true }) }, null, 2));
}
