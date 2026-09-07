import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../store.ts";
import { InputError } from "../errors.ts";
import { abortable } from "../network/abort.ts";
import type { createComputer } from "./workspace.ts";

interface Control {
  revision: number;
  token?: string;
  requested?: string;
  changed: Promise<void>;
  notify: () => void;
  agent: Promise<void>;
  input: Promise<void>;
  pendingInput: number;
  frame?: Promise<Buffer>;
  closed?: boolean;
  abort: AbortController;
  listeners: Set<(blocked: boolean) => void>;
}
function control(): Control {
  let notify!: () => void;
  const changed = new Promise<void>((resolve) => { notify = resolve; });
  return { revision: 0, changed, notify, agent: Promise.resolve(), input: Promise.resolve(), pendingInput: 0, abort: new AbortController(), listeners: new Set() };
}

/** Owner input and live frames are separate from model tools and conversation logs. */
export function createWorkspaceView(computer: ReturnType<typeof createComputer>) {
  const controls = new Map<string, Control>();
  let closed = false;
  function state(id: string) {
    if (closed || !computer.owns(id)) throw new InputError("This computer is no longer available", 404);
    let entry = controls.get(id);
    if (!entry) { entry = control(); controls.set(id, entry); }
    return entry;
  }
  function changed(entry: Control) {
    entry.notify();
    for (const listener of entry.listeners) listener(Boolean(entry.token || entry.requested));
    entry.changed = new Promise<void>((resolve) => { entry.notify = resolve; });
  }
  async function wait(id: string, signal: AbortSignal) {
    const entry = state(id);
    while (entry.token || entry.requested) {
      await abortable(entry.changed, signal);
      if (entry.closed || closed) throw new InputError("This computer was closed", 410);
    }
    signal.throwIfAborted();
  }
  function forget(id: string) {
    const entry = controls.get(id);
    if (entry) { entry.abort.abort(new Error("Computer closed")); entry.closed = true; entry.token = undefined; entry.requested = undefined; changed(entry); controls.delete(id); }
  }
  return {
    subscribe(id: string, listener: (blocked: boolean) => void) { const entry = state(id); entry.listeners.add(listener); listener(Boolean(entry.token || entry.requested)); return () => entry.listeners.delete(listener); },
    status(id: string) { const entry = state(id); return { manual: Boolean(entry.token), requested: entry.requested, revision: entry.revision }; },
    revision: (id: string) => state(id).revision,
    blocked: (id: string) => { const entry = state(id); return Boolean(entry.token || entry.requested); },
    wait,
    async agent<T>(id: string, revision: number | undefined, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
      const entry = state(id);
      signal = AbortSignal.any([signal, entry.abort.signal]);
      for (;;) {
        await wait(id, signal);
        const previous = entry.agent;
        await abortable(previous, signal);
        if (entry.closed || closed) throw new InputError("This computer was closed", 410);
        if (entry.agent === previous && !entry.token && !entry.requested) break;
      }
      if (revision !== undefined && entry.revision !== revision) throw new InputError("The owner changed this computer. Observe it again before choosing another action.", 409);
      let done!: () => void;
      entry.agent = new Promise<void>((resolve) => { done = resolve; });
      try { return await work(); } finally { done(); }
    },
    async take(id: string, signal: AbortSignal) {
      const entry = state(id);
      signal = AbortSignal.any([signal, entry.abort.signal]);
      const token = randomUUID(); entry.token = token; entry.revision++; changed(entry);
      try {
        await abortable(entry.agent, signal);
        await abortable(entry.input, signal);
        if (entry.frame) await abortable(entry.frame.catch(() => {}), signal);
        const status = JSON.parse(await abortable(computer.status(id, { signal, timeoutMs: 5000 }), signal));
        signal.throwIfAborted();
        if (entry.closed || entry.token !== token || status.status?.ready !== true) throw new InputError("This computer or control session changed", 409);
        return { token };
      } catch (error) { if (entry.token === token) { entry.token = undefined; changed(entry); } throw error; }
    },
    async release(id: string, token: string) {
      const entry = state(id);
      if (!entry.token || entry.token !== token) throw new InputError("This control session is no longer active", 409);
      await entry.input;
      if (entry.token !== token) throw new InputError("This control session changed", 409);
      entry.token = undefined; entry.requested = undefined; entry.revision++; changed(entry);
    },
    async request(id: string, reason: string, signal: AbortSignal) {
      const entry = state(id);
      if (entry.requested) throw new InputError("The computer already needs user help", 409);
      entry.requested = reason; changed(entry);
      try { await wait(id, signal); }
      finally { if (entry.requested === reason) { entry.requested = undefined; changed(entry); } }
    },
    async input(id: string, token: string, action: Record<string, unknown>) {
      const entry = state(id);
      if (!entry.token || entry.token !== token) throw new InputError("Take control before using this computer", 403);
      if (entry.pendingInput >= 64) throw new InputError("Computer input is catching up. Wait a moment.", 429);
      entry.pendingInput++;
      const work = entry.input.then(async () => {
        if (entry.closed || entry.token !== token) throw new InputError("This control session ended", 409);
        try {
          switch (action.action) {
            case "click": await computer.click(action.x as number, action.y as number, id, { button: action.button as number | undefined, signal: entry.abort.signal, timeoutMs: 5000 }); break;
            case "drag": await computer.drag(action.fromX as number, action.fromY as number, action.toX as number, action.toY as number, id, { signal: entry.abort.signal, timeoutMs: 5000 }); break;
            case "type":
              if (typeof action.text !== "string" || action.text.length > 16000) throw new InputError("Input text is too long");
              await computer.type(action.text, id); break;
            case "key":
              if (typeof action.keys !== "string" || action.keys.length > 100 || !/^[A-Za-z0-9_+]+$/.test(action.keys)) throw new InputError("Unsupported key");
              await computer.key(action.keys, id); break;
            case "scroll": await computer.scroll(action.x as number, action.y as number, action.direction as "up" | "down" | "left" | "right", id, action.amount as number | undefined); break;
            default: throw new InputError("Unsupported computer input");
          }
        } catch { throw new InputError("Computer input failed. Check that the workspace is still running.", 502); }
      });
      entry.input = work.catch(() => {}).finally(() => { entry.pendingInput--; });
      await work;
    },
    async frame(id: string): Promise<Buffer> {
      const entry = state(id);
      if (!entry.frame) {
        entry.frame = (async () => {
          const directory = join(dataDir(), "live-frames"); mkdirSync(directory, { recursive: true, mode: 0o700 });
          const path = join(directory, `${id}.png`);
          try {
            await computer.screenshot(path, id, { signal: entry.abort.signal, timeoutMs: 5000 });
            const stat = lstatSync(path);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error("Invalid frame");
            const bytes = readFileSync(path);
            if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Invalid frame");
            return bytes;
          } finally { rmSync(path, { force: true }); }
        })();
        void entry.frame.finally(() => { entry.frame = undefined; }).catch(() => {});
      }
      return entry.frame;
    },
    forget,
    close() { closed = true; for (const id of controls.keys()) forget(id); },
  };
}
export type WorkspaceView = ReturnType<typeof createWorkspaceView>;
