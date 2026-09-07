import { browserProfile, standardBrowserSaved, saveStandardBrowser } from "./profiles.ts";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, readJson, writeJson } from "../store.ts";
import { InputError, requiredText } from "../errors.ts";

interface CommandOptions { signal?: AbortSignal; timeoutMs?: number }
export type Runner = (args: string[], options?: CommandOptions) => Promise<string>;

function defaultRunner(args: string[], options: CommandOptions = {}): Promise<string> {
  const bin = process.env.LINUBOT_WORKSPACE_BIN ?? "agent-workspace-linux";
  // The viewer is a long-lived GUI, not an RPC. It exits when cleanup removes its workspace.
  if (args[0] === "viewer") {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { detached: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve(JSON.stringify({ ok: true, pid: child.pid, message: "viewer process spawned" }));
      });
    });
  }
  return new Promise((resolve, reject) => {
    execFile(bin, args, { signal: options.signal, timeout: options.timeoutMs ?? 90_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim() || err.message));
      else resolve(stdout);
    });
  });
}

export interface StartOptions {
  purpose: string;
  scope?: string;
  profile?: string;
  id?: string;
  width?: number;
  height?: number;
  dryRun?: boolean;
  acknowledge?: boolean;
}

export interface WorkspaceHandle {
  id: string;
  purpose: string;
  sessionId?: string;
  scope?: string;
}

interface OwnedWorkspace extends WorkspaceHandle {
  state: "running" | "stopped";
}

function ownedPath(): string {
  return join(dataDir(), "computer-workspaces.json");
}

function validId(id: unknown): id is string {
  return typeof id === "string" && /^linubot-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function ownedWorkspaces(): OwnedWorkspace[] {
  const owned = readJson<OwnedWorkspace[]>(ownedPath(), []);
  if (!Array.isArray(owned) || owned.some((entry) => !entry || !validId(entry.id) ||
    typeof entry.purpose !== "string" || !["running", "stopped"].includes(entry.state))) {
    throw new Error("invalid linubot workspace ownership registry");
  }
  return owned;
}

function requireOwned(id: unknown): OwnedWorkspace {
  if (!validId(id)) throw new InputError("an explicit linubot-owned workspace ID is required");
  const owned = ownedWorkspaces().find((entry) => entry.id === id);
  if (!owned) throw new InputError(`unknown linubot-owned workspace: ${id}`, 404);
  return owned;
}

function integer(value: number, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new InputError(`${label} must be an integer between ${min} and ${max}`);
  return value;
}

interface BackendResponse {
  id?: string;
  session_id?: string;
  ready?: boolean;
  ok?: boolean;
  message?: string;
  status?: { id?: string; session_id?: string; ready?: boolean };
  start_preview?: Record<string, unknown>;
  dry_run?: boolean;
  removed?: Array<{ id: string }>;
  skipped?: Array<{ id: string; reason?: string }>;
}

function response(output: string): BackendResponse {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw new Error("workspace backend returned invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid workspace backend response");
  const result = parsed as BackendResponse;
  if (result.ok === false) throw new Error(`workspace backend failed: ${result.message ?? "unknown error"}`);
  return result;
}

const starting = new Set<string>();

/** Only handles created and persisted by this adapter can be used. No host inventory or raw runner escape hatch. */
export function createComputer(run: Runner = defaultRunner) {
  const scoped = async (args: string[], id: unknown, options?: CommandOptions): Promise<string> => {
    const owned = requireOwned(id);
    const [command, ...rest] = args;
    // The CLI stops parsing scope options at the first positional argument.
    // Text/key payloads also need '--' so literal text cannot become a flag.
    const output = await run(["workspace", command, "--id", owned.id, ...(["key", "type", "clipboard-set"].includes(command) ? ["--"] : []), ...rest], options);
    const parsed = response(output);
    if (parsed.status?.id !== undefined && parsed.status.id !== owned.id) throw new Error("workspace backend returned the wrong ID");
    if (owned.sessionId && parsed.status?.session_id && parsed.status.session_id !== owned.sessionId) {
      throw new Error("workspace backend returned a different session");
    }
    return output;
  };
  const status = async (id: string, options?: CommandOptions): Promise<string> => {
    const output = await scoped(["status"], id, options);
    const parsed = response(output);
    // The public CLI returns a bare status object; MCP responses wrap it in `status`.
    const current = parsed.status ?? (typeof parsed.ready === "boolean" ? parsed : undefined);
    if (current?.id !== id) throw new Error("workspace status did not identify the owned workspace");
    const owned = requireOwned(id);
    if (owned.sessionId && current.session_id !== owned.sessionId) throw new Error("workspace backend returned a different session");
    return parsed.status ? output : JSON.stringify({ ok: true, status: current });
  };
  return {
    owned: () => ownedWorkspaces(),
    standardBrowser(id: string): boolean { const owned = requireOwned(id); return Boolean(owned.scope && standardBrowserSaved(owned.scope)); },
    owns: (id: string): boolean => validId(id) && ownedWorkspaces().some((entry) => entry.id === id),
    doctor: (): Promise<string> => run(["doctor"]),
    async list(): Promise<string> {
      const workspaces = await Promise.all(ownedWorkspaces().map(async (owned) => {
        try {
          return { ...owned, status: response(await status(owned.id)).status };
        } catch (error) {
          return { ...owned, error: String(error) };
        }
      }));
      return JSON.stringify({ workspaces });
    },
    async start(opts: StartOptions): Promise<WorkspaceHandle & { dryRun: boolean; preview?: Record<string, unknown> }> {
      const purpose = requiredText(opts?.purpose, "workspace purpose", 2000);
      if (opts.scope !== undefined && !/^(bot|group):[a-zA-Z0-9_-]{1,60}$/.test(opts.scope)) throw new InputError("Invalid workspace conversation");
      if (opts.acknowledge !== true) throw new InputError("workspace start requires explicit acknowledgement", 403);
      if (opts.profile !== undefined) throw new InputError("host workspace profiles cannot be adopted by linubot");
      if (opts.dryRun !== undefined && typeof opts.dryRun !== "boolean") throw new InputError("dryRun must be a boolean");
      const id = opts.id === undefined ? `linubot-${randomUUID()}` : opts.id;
      if (!validId(id)) throw new InputError("workspace ID must be linubot-<UUID v4>");
      if (opts.scope && ownedWorkspaces().some(entry => entry.scope === opts.scope && entry.state === "running")) throw new InputError("This bot or group already has an open computer. Close it before starting another.", 409);
      const key = `${ownedPath()}:${id}`, scopeKey = opts.scope ? `${ownedPath()}:${opts.scope}` : key;
      if (opts.scope && starting.has(scopeKey)) throw new InputError("This bot or group already has a computer starting", 409);
      if (starting.has(key) || ownedWorkspaces().some((entry) => entry.id === id)) throw new InputError(`workspace already owned or starting: ${id}`, 409);
      const args = ["workspace", "start", "--ack-hidden-workspace", "--purpose", purpose, "--id", id];
      if (opts.width !== undefined) args.push("--width", String(integer(opts.width, "width", 1, 8192)));
      if (opts.height !== undefined) args.push("--height", String(integer(opts.height, "height", 1, 8192)));
      starting.add(key); starting.add(scopeKey);
      try {
        // A start can silently attach to an existing backend workspace. Refuse that adoption.
        const preview = response(await run([...args, "--dry-run"]));
        if (preview.ok !== true || preview.start_preview?.id !== id) throw new Error("workspace preview returned the wrong ID or shape");
        if (preview.start_preview.already_running !== false) throw new InputError("cannot adopt an already-running workspace", 409);
        if (opts.dryRun) return { id, purpose, dryRun: true, preview: preview.start_preview };
        if (preview.start_preview.ok_to_start !== true || preview.start_preview.would_start !== true) {
          throw new Error(`workspace start blocked: ${preview.start_preview.message ?? "preflight failed"}`);
        }
        const parsed = response(await run(args));
        if (parsed.ok !== true || parsed.status?.id !== id || parsed.status.ready !== true) {
          throw new Error("workspace start returned the wrong ID or an unready workspace");
        }
        if (typeof parsed.message === "string" && /already running/i.test(parsed.message)) throw new Error("cannot adopt an already-running workspace");
        const handle: WorkspaceHandle = { id, purpose, ...(opts.scope ? { scope: opts.scope } : {}) };
        if (typeof parsed.status.session_id === "string" && parsed.status.session_id) handle.sessionId = parsed.status.session_id;
        writeJson(ownedPath(), [...ownedWorkspaces(), { ...handle, state: "running" }]);
        return { ...handle, dryRun: false };
      } finally {
        starting.delete(key); starting.delete(scopeKey);
      }
    },
    status,
    async stop(id: string): Promise<string> {
      const owned = requireOwned(id);
      if (owned.state === "stopped") return JSON.stringify({ ok: true, status: { id, ready: false }, message: "already stopped" });
      // Close saved-profile browsers before the display is terminated so Chrome
      // can flush cookies and session state to disk.
      let browserWarning: string | undefined;
      try { if (owned.scope) {
        const current = JSON.parse(await status(id));
        const profiles = [browserProfile(owned.scope, "standard"), browserProfile(owned.scope, "automated")];
        const browsers = (current.status?.apps ?? []).filter((app: { running?: boolean; command?: string[] }) => app.running && app.command?.some(arg => profiles.some(profile => arg === `--user-data-dir=${profile}` || arg === profile)));
        if (browsers.length) {
          const windows = JSON.parse(await scoped(["windows"], id)).windows ?? [];
          for (const app of browsers) {
            const window = windows.find((window: { app_id?: string; pid?: number }) => app.id === window.app_id || app.pid === window.pid);
            if (window) await scoped(["key-window", requiredText(window.id, "Browser window", 80), "ctrl+shift+q"], id, { timeoutMs: 5000 });
          }
          for (const app of browsers) await scoped(["wait-app", "--timeout-ms", "10000", requiredText(app.id, "Browser app", 80)], id, { timeoutMs: 11000 });
        }
      }
      } catch { browserWarning = "The browser did not close normally. Its most recent session changes may not have been saved."; }
      const output = await scoped(["stop", "--timeout-ms", "30000"], id);
      const parsed = response(output);
      if (parsed.ok !== true || parsed.status?.id !== id || parsed.status.ready !== false || parsed.dry_run === true) {
        throw new Error("workspace stop did not confirm shutdown");
      }
      writeJson(ownedPath(), ownedWorkspaces().map((entry) => entry.id === id ? { ...entry, state: "stopped" } : entry));
      return browserWarning ? JSON.stringify({ ...JSON.parse(output), warning: browserWarning }) : output;
    },
    async cleanup(id: string): Promise<string> {
      if (requireOwned(id).state !== "stopped") throw new InputError("stop the owned workspace before cleanup", 409);
      const output = await scoped(["cleanup"], id);
      const parsed = response(output);
      if (parsed.dry_run !== false || !Array.isArray(parsed.removed) || !Array.isArray(parsed.skipped) ||
        [...parsed.removed, ...parsed.skipped].some((entry) => entry?.id !== id)) throw new Error("invalid scoped cleanup response");
      if (parsed.skipped.length) throw new Error(`workspace cleanup skipped: ${parsed.skipped[0].reason ?? id}`);
      rmSync(join(resolve(dataDir()), "computer-browsers", id), { recursive: true, force: true });
      writeJson(ownedPath(), ownedWorkspaces().filter((entry) => entry.id !== id));
      return output;
    },
    async launch(command: string, args: string[] = [], opts: { name?: string; cwd?: string; id?: string } = {}): Promise<string> {
      const owned = requireOwned(opts.id);
      const a = ["workspace", "launch", "--id", owned.id];
      if (opts.name) a.push("--name", requiredText(opts.name, "app name", 200));
      if (opts.cwd) a.push("--cwd", requiredText(opts.cwd, "app cwd", 4096));
      const output = await run([...a, "--", requiredText(command, "command", 4096), ...args]);
      response(output);
      return output;
    },
    async exec(command: string, args: string[] = [], opts: { name?: string; timeoutMs?: number; id?: string } = {}): Promise<string> {
      const owned = requireOwned(opts.id);
      const timeout = integer(opts.timeoutMs === undefined ? 30_000 : opts.timeoutMs, "app timeout", 1, 60_000);
      const a = ["workspace", "run", "--id", owned.id, "--timeout-ms", String(timeout), "--kill-on-timeout"];
      if (opts.name) a.push("--name", requiredText(opts.name, "app name", 200));
      const output = await run([...a, "--", requiredText(command, "command", 4096), ...args]);
      response(output);
      return output;
    },
    observe: async (opts: { screenshot?: boolean; output?: string; allWindows?: boolean; id?: string } = {}): Promise<string> => {
      const a = ["observe"];
      if (opts.screenshot) a.push("--screenshot");
      if (opts.output) a.push("--output", requiredText(opts.output, "screenshot output", 4096));
      if (opts.allWindows) a.push("--all-windows");
      return scoped(a, opts.id);
    },
    screenshot: async (output: string, id: string, options?: CommandOptions): Promise<string> => scoped(["screenshot", "--output", requiredText(output, "screenshot output", 4096)], id, options),
    windows: (id: string): Promise<string> => scoped(["windows"], id),
    activeWindow: (id: string): Promise<string> => scoped(["active-window"], id),
    focusWindow: async (title: string, id: string): Promise<string> => scoped(["focus-window", "--title", requiredText(title, "window title", 2000)], id),
    click: async (x: number, y: number, id: string, options: CommandOptions & { button?: number } = {}): Promise<string> => scoped(["click", ...(options.button === undefined ? [] : ["--button", String(integer(options.button, "button", 1, 3))]), String(integer(x, "x", 0, 65535)), String(integer(y, "y", 0, 65535))], id, options),
    drag: async (fromX: number, fromY: number, toX: number, toY: number, id: string, options?: CommandOptions): Promise<string> => scoped(["drag", ...[fromX, fromY, toX, toY].map((value) => String(integer(value, "coordinate", 0, 65535)))], id, options),
    type: async (text: string, id: string, options?: CommandOptions): Promise<string> => {
      if (typeof text !== "string" || text.length > 65536 || text.includes("\0")) throw new InputError("input text must be a string of at most 65536 characters without NUL");
      if (text.startsWith("-")) {
        // This backend's xdotool type path treats a leading dash as an option.
        // The owned clipboard transports literal text without that second parser.
        await scoped(["clipboard-set", text], id, options);
        return scoped(["key", "ctrl+v"], id, options);
      }
      return scoped(["type", text], id, options);
    },
    paste: async (text: string, id: string, options?: CommandOptions): Promise<string> => {
      if (typeof text !== "string" || text.length > 16000 || text.includes("\0")) throw new InputError("Invalid pasted text");
      await scoped(["clipboard-set", text], id, options);
      return scoped(["key", "ctrl+v"], id, options);
    },
    // The public backend rejects zero-length clipboard values; a blank removes the transferred secret.
    clearClipboard: async (id: string, options?: CommandOptions): Promise<string> => scoped(["clipboard-set", " "], id, options),
    key: async (keys: string, id: string, options?: CommandOptions): Promise<string> => {
      const value = requiredText(keys, "keys", 2000);
      if (value.startsWith("-")) throw new InputError("Use a key name or combination, not command flags");
      return scoped(["key", value], id, options);
    },
    scroll: async (x: number, y: number, direction: "up" | "down" | "left" | "right", id: string, amount = 3, options?: CommandOptions): Promise<string> => {
      if (!["up", "down", "left", "right"].includes(direction)) throw new InputError("invalid scroll direction");
      return scoped(["scroll", "--amount", String(integer(amount, "scroll amount", 1, 255)), String(integer(x, "x", 0, 65535)), String(integer(y, "y", 0, 65535)), direction], id, options);
    },
    async openViewer(id: string, opts: { inputForwarding?: boolean } = {}): Promise<string> {
      requireOwned(id);
      const args = ["viewer", "--id", id, "--exit-when-workspace-gone"];
      if (opts.inputForwarding === true) args.push("--input-forwarding");
      const output = await run(args);
      response(output);
      return output;
    },
    async openSignInBrowser(value: string, id: string, options?: CommandOptions): Promise<string> {
      const owned = requireOwned(id);
      if (owned.state !== "running") throw new InputError("This computer has stopped", 409);
      const url = new URL(requiredText(value, "Website URL", 2000));
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new InputError("Use a website URL without embedded credentials");
      const profile = owned.scope ? browserProfile(owned.scope, "standard") : join(resolve(dataDir()), "computer-browsers", id);
      mkdirSync(profile, { recursive: true, mode: 0o700 });
      // Launch an ordinary browser through the owned desktop, without a DevTools
      // endpoint. Keep this separate from both host and automated browser profiles.
      const output = await scoped(["launch", "--name", "Sign-in browser", "--", process.env.LINUBOT_BROWSER_WRAPPER ?? fileURLToPath(new URL("../../desktop/linubot-chrome.sh", import.meta.url)),
        `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--ozone-platform=x11", "--new-window", url.href], id, options);
      if (owned.scope) saveStandardBrowser(owned.scope);
      return output;
    },
    openBrowser: async (id: string): Promise<string> => {
      const owned = requireOwned(id);
      return scoped(["open-browser", "--browser", process.env.LINUBOT_BROWSER_WRAPPER ?? fileURLToPath(new URL("../../desktop/linubot-chrome.sh", import.meta.url)), ...(owned.scope ? ["--user-data-dir", browserProfile(owned.scope, "automated")] : [])], id);
    },
    browserTargets: (id: string): Promise<string> => scoped(["browser-targets"], id),
    browserNavigate: async (url: string, id: string): Promise<string> => scoped(["browser-navigate", requiredText(url, "browser URL", 20000)], id),
    browserSnapshot: (id: string): Promise<string> => scoped(["browser-snapshot"], id),
    killApp: async (app: string, id: string): Promise<string> => scoped(["kill-app", requiredText(app, "app", 200)], id),
    appLogs: async (app: string, id: string): Promise<string> => scoped(["logs", requiredText(app, "app", 200)], id),
  };
}

export type Computer = ReturnType<typeof createComputer>;
