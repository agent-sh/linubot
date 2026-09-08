import type { ServerResponse } from "node:http";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { Computer } from "../computer/workspace.ts";
import type { WorkspaceView } from "../computer/view.ts";
import { InputError, requiredText } from "../errors.ts";
import { dataDir } from "../store.ts";
import { cancelDemo, captureDemo, finishDemo, getDemo, listDemos, startDemo } from "../teach/demos.ts";
import { number, optionalBoolean } from "./request-fields.ts";

// Called only after createApp applies API authentication and lifecycle guards.
export function createComputerRoutes(computer: Computer, workspaceView: WorkspaceView) {
  return async (r: string[], method: string | undefined, b: Record<string, unknown>, url: URL, res: ServerResponse, ok: (value: unknown) => void): Promise<void> => {
    if (r[0] === "computer") {
      if (r[1] === "views" && method === "GET") {
        const scope = url.searchParams.get("scope");
        ok({ workspaces: computer.owned().filter((entry) => entry.state === "running" && (!scope || !entry.scope || entry.scope === scope)).map((entry) => ({ ...entry, ...workspaceView.status(entry.id) })) }); return;
      }
      if (r[1] === "frame" && method === "GET") {
        const bytes = await workspaceView.frame(requiredText(url.searchParams.get("id"), "Workspace", 80));
        res.writeHead(200, { "content-type": "image/png", "content-length": bytes.length }); res.end(bytes); return;
      }
      if (r[1] === "control" && method === "POST") {
        const id = requiredText(b.id, "Workspace", 80);
        if (b.action === "take") {
          const ctrl = new AbortController(), disconnected = () => { if (!res.writableEnded) ctrl.abort(new Error("Panel closed")); };
          res.once("close", disconnected);
          try { ok(await workspaceView.take(id, ctrl.signal)); } finally { res.off("close", disconnected); }
          return;
        }
        if (b.action === "release") { await workspaceView.release(id, requiredText(b.token, "Control session", 80)); ok({ released: true }); return; }
        throw new InputError("Unknown control action");
      }
      if (r[1] === "input" && method === "POST") {
        await workspaceView.input(requiredText(b.id, "Workspace", 80), requiredText(b.token, "Control session", 80), b);
        ok({ accepted: true }); return;
      }
      if (r[1] === "doctor" && method === "GET") { ok({ report: await computer.doctor() }); return; }
      if (r[1] === "list" && method === "GET") { ok({ report: await computer.list() }); return; }
      if (r[1] === "start" && method === "POST") { ok(await computer.start({ purpose: requiredText(b.purpose, "Workspace purpose", 2000), acknowledge: b.acknowledge === true })); return; }
      if (r[1] === "stop" && method === "POST") { const id = requiredText(b.id, "Owned workspace ID", 80); workspaceView.forget(id); ok({ report: await computer.stop(id) }); return; }
      if (r[1] === "cleanup" && method === "POST") { ok({ report: await computer.cleanup(requiredText(b.id, "Owned workspace ID", 80)) }); return; }
      if (r[1] === "viewer" && method === "POST") { ok({ report: await computer.openViewer(requiredText(b.id, "Owned workspace ID", 80), { inputForwarding: optionalBoolean(b.inputForwarding) }) }); return; }
    }
    if (r[0] === "demos") {
      if (r.length === 1 && method === "GET") { ok(listDemos()); return; }
      if (r.length === 1 && method === "POST") { ok(await startDemo(computer, requiredText(b.bot, "Teammate", 40), requiredText(b.purpose, "Demonstration purpose", 2000), { acknowledge: b.acknowledge === true })); return; }
      if (r[2] === "capture" && method === "POST") { ok(await captureDemo(computer, r[1])); return; }
      if (r[2] === "finish" && method === "POST") { ok(await finishDemo(computer, r[1], requiredText(b.skill, "Skill name", 40), requiredText(b.notes, "Demonstrated steps", 20000))); return; }
      if (r[2] === "cancel" && method === "POST") { ok(await cancelDemo(computer, r[1])); return; }
      if (r[2] === "shots" && method === "GET") {
        const demo = getDemo(r[1]);
        const shot = demo.shots[number(r[3], 0, 0, 1000)];
        if (!shot || !existsSync(shot)) throw new InputError("Screenshot not found", 404);
        const parent = realpathSync(join(dataDir(), "demos", demo.id)) + sep;
        if (!realpathSync(shot).startsWith(parent) || lstatSync(shot).isSymbolicLink()) throw new InputError("Unsafe screenshot path", 403);
        res.writeHead(200, { "content-type": "image/png" }); res.end(readFileSync(shot)); return;
      }
    }
    throw new InputError("Not found", 404);
  };
}
