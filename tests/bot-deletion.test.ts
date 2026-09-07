import { it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBot, deleteBot, botDeletionPreview, getBot } from "../src/bots/manager.ts";
import { appendEvent } from "../src/events/log.ts";
import { setProvider } from "../src/auth/store.ts";
import { createGroup } from "../src/chat/session.ts";
import { createApp } from "../src/server.ts";

let directory: string;
const previous = process.env.LINUBOT_DATA;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "linubot-delete-test-")); process.env.LINUBOT_DATA = directory; });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); if (previous === undefined) delete process.env.LINUBOT_DATA; else process.env.LINUBOT_DATA = previous; });

it("previews and detaches references while preserving other bots and old messages", () => {
  createBot("Remove"); createBot("Keep");
  const event = appendEvent("bot:Remove", { kind: "message", from: "user", text: "Keep this historical message" });
  const groups = [{ id: "shared", members: ["Remove", "Keep"] }, { id: "last", members: ["Remove"] }, { id: "unrelated", members: ["Keep"] }];
  const jobs = [{ name: "owned", bot: "Remove" }, { name: "delivery", bot: "Keep", deliver: "bot:Remove" }, { name: "empty-group", bot: "Keep", deliver: "group:last" }, { name: "keep", bot: "Keep", deliver: "group:shared" }];
  writeFileSync(join(directory, "groups.json"), JSON.stringify(groups));
  writeFileSync(join(directory, "jobs.json"), JSON.stringify(jobs));
  const preview = botDeletionPreview("Remove");
  assert.deepEqual(preview.groups.map((group) => group.id), ["shared", "last"]);
  assert.deepEqual(preview.routines.map((job) => job.name), ["owned", "delivery", "empty-group"]);
  assert.deepEqual(preview.emptyGroups, ["last"]);
  assert.throws(() => deleteBot("Remove"), /referenced/);
  assert.equal(deleteBot("Remove", { detachReferences: true }), true);
  assert.equal(getBot("Remove"), null); assert.ok(getBot("Keep"));
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "groups.json"), "utf8")), [{ id: "shared", members: ["Keep"] }, { id: "unrelated", members: ["Keep"] }]);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "jobs.json"), "utf8")), [jobs[3]]);
  assert.match(readFileSync(join(directory, "feed-bot_Remove.jsonl"), "utf8"), new RegExp(event.text!));
});

it("rejects bot deletion while its group has queued or active work", async () => {
  setProvider({ kind: "openai-compat", baseUrl: "http://127.0.0.1:9999", model: "fixture", auth: "none" });
  createBot("First"); createBot("Second"); await createGroup("team", ["First", "Second"]);
  let finish!: () => void;
  const hold = new Promise<void>((resolve) => { finish = resolve; });
  const app = createApp({ scheduler: false, review: false, complete: async () => { await hold; return { text: "Done", toolCalls: [] }; } });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address(); assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const runs = app.runtime.enqueue({ scope: "group:team", message: "Both teammates reply" });
    const blocked = await fetch(`${base}/api/bots/Second`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ detachReferences: true }) });
    assert.equal(blocked.status, 409); await blocked.body?.cancel(); assert.ok(getBot("Second"));
    finish(); await Promise.all(runs.map((run) => app.runtime.wait(run.id)));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const removed = await fetch(`${base}/api/bots/Second`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ detachReferences: true }) });
    assert.equal(removed.status, 200); await removed.body?.cancel(); assert.equal(getBot("Second"), null);
  } finally { finish(); await app.close(); }
});

it("protects destinations of active routines even when another bot does the work", async () => {
  setProvider({ kind: "openai-compat", baseUrl: "http://127.0.0.1:9999", model: "fixture", auth: "none" });
  createBot("Worker"); createBot("Destination");
  writeFileSync(join(directory, "jobs.json"), JSON.stringify([{ name: "delivery", bot: "Worker", deliver: "bot:Destination", schedule: "* * * * *", prompt: "Deliver the fixture", enabled: true }]));
  let finish!: () => void, started!: () => void;
  const hold = new Promise<void>((resolve) => { finish = resolve; }), entered = new Promise<void>((resolve) => { started = resolve; });
  const app = createApp({ scheduler: false, review: false, complete: async () => { started(); await hold; return { text: "Delivered fixture", toolCalls: [] }; } });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address(); assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const running = fetch(`${base}/api/jobs/run`, { method: "POST" }); await entered;
    const blocked = await fetch(`${base}/api/bots/Destination`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ detachReferences: true }) });
    assert.equal(blocked.status, 409); await blocked.body?.cancel();
    finish(); const result = await running; assert.equal(result.status, 200); await result.body?.cancel();
    assert.match(readFileSync(join(directory, "feed-bot_Destination.jsonl"), "utf8"), /Delivered fixture/);
  } finally { finish(); await app.close(); }
});
