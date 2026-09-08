import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { retentionSettings, retentionStatus, runRetention, setRetentionSettings } from "../src/retention.ts";
import { createComputer } from "../src/computer/workspace.ts";
const DAY = 86400000, now = Date.now();
let directory: string;
const prior = process.env.LINUBOT_DATA;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "linubot-retention-")); process.env.LINUBOT_DATA = directory; });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); if (prior === undefined) delete process.env.LINUBOT_DATA; else process.env.LINUBOT_DATA = prior; });
function file(name: string, age = 0, content = "cache") {
  const path = join(directory, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); utimesSync(path, new Date(now - age), new Date(now - age)); return path;
}
function json(name: string, value: unknown) { return file(name, 0, JSON.stringify(value)); }
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("disk retention", () => {
  it("prunes only listed cache directories of idle standard and automated profiles", async () => {
    json("computer-workspaces.json", [{ scope: "bot:busy", state: "running" }, { scope: "bot:idle", state: "stopped" }]);
    const removed: string[] = [], kept: string[] = [];
    for (const owner of ["bot_idle", "bot_busy", "group_live"]) for (const mode of ["standard", "automated"]) {
      for (const prefix of ["", "Default/"]) for (const cache of ["Cache", "Code Cache", "GPUCache", "GrShaderCache", "ShaderCache", "DawnCache", "Service Worker/CacheStorage"]) {
        const path = file(`computer-profiles/${owner}/${mode}/${prefix}${cache}/nested/data`); (owner === "bot_idle" ? removed : kept).push(path);
      }
      for (const name of ["Cookies", "Login Data", "Local Storage/data", "IndexedDB/data", "Preferences", "Network/Cookies", "Service Worker/Database/data", "other"]) kept.push(file(`computer-profiles/${owner}/${mode}/Default/${name}`));
    }
    const result = await runRetention({ directory, runningScopes: () => ["group:live"] });
    assert.equal(result.files, removed.length); assert.equal(result.bytes, removed.length * 5);
    for (const path of removed) assert.equal(existsSync(path), false);
    for (const path of kept) assert.equal(readFileSync(path, "utf8"), "cache");
  });
  it("protects screenshots referenced recently or by every non-terminal run status", async () => {
    const old = 20 * DAY;
    for (let n = 1; n <= 8; n++) file(`screenshots/${id(n)}.png`, n === 8 ? DAY : old);
    ["queued", "running", "awaiting_approval"].forEach((status, n) => json(`runs/${id(n + 4)}.json`, { id: id(n + 4), status }));
    json(`runs/${id(3)}.json`, { id: id(3), status: "completed" });
    file("feed-bot_test.jsonl", 0, [
      { at: new Date(now - DAY).toISOString(), path: `/api/screenshots/${id(2)}` },
      ...[3, 4, 5, 6].map(n => ({ at: new Date(now - old).toISOString(), runId: id(n), path: `/api/screenshots/${id(n)}` })),
      { at: new Date(now).toISOString(), text: `See /api/screenshots/${id(7)}` },
    ].map(event => JSON.stringify(event)).join("\n"));
    const expired = file("live-frames/old.png", 3600001), fresh = file("live-frames/new.png", 3599999);
    const other = file("screenshots/notes.txt", old);
    const result = await runRetention({ directory, now }); assert.equal(result.files, 3);
    for (const n of [1, 3]) assert.equal(existsSync(join(directory, `screenshots/${id(n)}.png`)), false);
    for (const n of [2, 4, 5, 6, 7, 8]) assert.equal(existsSync(join(directory, `screenshots/${id(n)}.png`)), true);
    assert.equal(existsSync(expired), false); assert.equal(existsSync(fresh), true); assert.equal(existsSync(other), true);
  });
  it("persists a validated age and dry runs leave all files untouched", async () => {
    assert.equal(retentionSettings(directory).screenshotDays, 14);
    setRetentionSettings({ screenshotDays: 2 }, directory);
    assert.equal(retentionSettings(directory).screenshotDays, 2);
    assert.throws(() => setRetentionSettings({ screenshotDays: 0 }, directory));
    const path = file(`screenshots/${id(1)}.png`, 3 * DAY);
    assert.equal(retentionStatus(directory).sizes.screenshots.bytes, 5);
    assert.deepEqual(await runRetention({ directory, now, dryRun: true }), { files: 1, bytes: 5, dryRun: true });
    assert.equal(readFileSync(path, "utf8"), "cache");
    assert.equal((await runRetention({ directory, now })).files, 1);
  });
  it("coalesces overlapping runs", async () => {
    file(`screenshots/${id(1)}.png`, 20 * DAY);
    const first = runRetention({ directory, now }), second = runRetention({ directory, now });
    assert.equal(first, second); assert.equal((await first).files, 1); assert.equal((await second).bytes, 5);
    assert.equal((await runRetention({ directory, now })).files, 0);
  });
  it("serializes cleanup requested during a dry run without sharing the wrong result", async () => {
    const path = file(`screenshots/${id(1)}.png`, 20 * DAY);
    const inspection = runRetention({ directory, now, dryRun: true });
    const cleanup = runRetention({ directory, now });
    const results = await Promise.all([inspection, cleanup]);
    assert.deepEqual(results, [{ files: 1, bytes: 5, dryRun: true }, { files: 1, bytes: 5, dryRun: false }]);
    assert.equal(existsSync(path), false);
  });
  it("does not follow cache, parent or screenshot symlinks", async () => {
    const outside = file("outside/data"), base = "computer-profiles/bot_idle/standard";
    mkdirSync(join(directory, base, "Default"), { recursive: true });
    symlinkSync(join(directory, "outside"), join(directory, base, "Cache"));
    symlinkSync(join(directory, "outside"), join(directory, base, "Default/Service Worker"));
    mkdirSync(join(directory, "screenshots")); symlinkSync(outside, join(directory, "screenshots", `${id(1)}.png`));
    assert.equal((await runRetention({ directory, now })).files, 0); assert.equal(readFileSync(outside, "utf8"), "cache");
  });
  it("fails closed on malformed events before pruning caches", async () => {
    const path = file("computer-profiles/bot_idle/standard/Cache/data"); file("feed-bot_test.jsonl", 0, '{"at":');
    await assert.rejects(runRetention({ directory })); assert.equal(existsSync(path), true);
  });
  it("fails closed on a symlinked run record", async () => {
    const path = file(`screenshots/${id(1)}.png`, 20 * DAY);
    const run = json("external.json", { id: id(2), status: "running" });
    mkdirSync(join(directory, "runs")); symlinkSync(run, join(directory, "runs", `${id(2)}.json`));
    await assert.rejects(runRetention({ directory }), /Unsafe retention run record/);
    assert.equal(existsSync(path), true);
  });
  it("protects a profile while workspace startup has not reached the persisted registry", async () => {
    const path = file("computer-profiles/bot_starting/standard/Cache/data");
    let release!: (value: string) => void;
    const computer = createComputer(() => new Promise(resolve => { release = resolve; }));
    const start = computer.start({ id: `linubot-${id(1)}`, scope: "bot:starting", purpose: "test", acknowledge: true, dryRun: true });
    try { assert.equal((await runRetention({ directory })).files, 0); assert.equal(existsSync(path), true); }
    finally { release(JSON.stringify({ ok: true, start_preview: { id: `linubot-${id(1)}`, already_running: false } })); await start; }
    assert.equal((await runRetention({ directory })).files, 1);
  });
});
