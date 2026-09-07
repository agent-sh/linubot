import { it } from "node:test";
import assert from "node:assert/strict";
import { createUpdates, newerVersion, parseRelease } from "../src/updates.ts";
import { createApp } from "../src/server.ts";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const release = (version = "2.7.0") => ({ tag_name: `v${version}`, html_url: `https://github.com/agent-sh/linubot/releases/tag/v${version}`, assets: [`linubot-${version}-x64.tar.gz`, "SHA256SUMS"].map((name) => ({ name, browser_download_url: `https://github.com/agent-sh/linubot/releases/download/v${version}/${name}` })) });
it("offers only newer stable releases with matching repository assets and checksums", () => {
  assert.equal(newerVersion("2.10.0", "2.9.9"), true);
  for (const version of ["2.6.0", "2.5.9", "2.7.0-beta", "2.7", "Infinity.0.0"]) assert.equal(newerVersion(version, "2.6.0"), false);
  assert.equal(parseRelease(release(), "2.6.0", "x64")?.version, "2.7.0");
  for (const value of [null, { ...release(), prerelease: true }, { ...release(), draft: true }, { ...release(), html_url: "https://example.com/release" }, { ...release(), assets: release().assets.slice(0, 1) }, { ...release(), assets: [{ ...release().assets[0], browser_download_url: "https://example.com/app.tar.gz" }, release().assets[1]] }]) assert.equal(parseRelease(value, "2.6.0", "x64"), undefined);
});

it("coalesces update checks and prevents concurrent installs", async () => {
  let checks = 0, installs = 0, finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const updates = createUpdates({ version: "2.6.0", check: async () => { checks++; return release(); }, install: async () => { installs++; await pending; } });
  await Promise.all([updates.check(), updates.check(), updates.check(true)]);
  assert.equal(checks, 1);
  const installation = updates.install();
  await assert.rejects(updates.install(), /already being installed/);
  assert.equal(updates.status().installing, true);
  finish(); await installation;
  assert.equal(installs, 1); assert.equal(updates.status().installing, false);
});

it("refreshes on foreground checks and retries failed checks without a six-hour delay", async (t) => {
  let now = Date.now(), calls = 0, fail = false;
  t.mock.method(Date, "now", () => now);
  const updates = createUpdates({ version: "2.6.0", check: async () => { calls++; if (fail) throw new Error("offline"); return calls === 1 ? release("2.6.0") : release(); } });
  assert.equal((await updates.check()).latest, undefined);
  now += 61000;
  assert.equal((await updates.check()).latest, undefined); assert.equal(calls, 1);
  assert.equal((await updates.check(true)).latest?.version, "2.7.0"); assert.equal(calls, 2);
  now += 15 * 60000; fail = true;
  assert.match((await updates.check()).error!, /Could not check/);
  now += 61000; fail = false;
  assert.equal((await updates.check()).error, undefined); assert.equal(calls, 4);
  const disabled = createUpdates({ enabled: false, check: async () => { assert.fail("Disabled checks must not contact GitHub"); } });
  assert.equal((await disabled.check(true)).enabled, false);
});

it("freezes late HTTP writes and runtime admission during update activation, and can resume on failure", async () => {
  const data = mkdtempSync(join(tmpdir(), "linubot-update-gate-")); process.env.LINUBOT_DATA = data;
  const app = createApp({ scheduler: false });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  try {
    const thaw = app.freezeForUpdate();
    assert.throws(() => app.runtime.enqueue({ scope: "bot:Future", message: "Start" }), /stopping/);
    const address = app.server.address(); assert(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/bots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "AfterUpdate", topic: "Test" }) });
    assert.equal(response.status, 503); await response.body?.cancel();
    thaw();
    const retry = await fetch(`http://127.0.0.1:${address.port}/api/bots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "AfterUpdate", topic: "Test" }) });
    assert.equal(retry.status, 200); await retry.body?.cancel();
  } finally { await app.close(); rmSync(data, { recursive: true, force: true }); }
});

it("installer stages verified release bytes and rejects tampering before touching the installed app", { skip: process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() === 0 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "linubot-install-test-"));
  try {
    const fixture = join(dir, "fixture"), bin = join(dir, "bin"), root = join(dir, "opt"), asset = "linubot-2.7.0-x64.tar.gz";
    mkdirSync(join(fixture, "resources"), { recursive: true }); mkdirSync(bin);
    writeFileSync(join(fixture, "linubot"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(fixture, "resources", "app.asar"), "fixture");
    execFileSync("tar", ["-czf", join(dir, asset), "-C", fixture, "."]);
    const digest = createHash("sha256").update(readFileSync(join(dir, asset))).digest("hex");
    writeFileSync(join(dir, "SHA256SUMS"), `${digest}  ${asset}\n`);
    writeFileSync(join(bin, "curl"), '#!/usr/bin/env bash\nset -eu\nurl=""; output=""\nwhile [ "$#" -gt 0 ]; do case "$1" in https://*) url="$1"; shift;; -o) output="$2"; shift 2;; *) shift;; esac; done\ncp "$LINUBOT_FIXTURE/${url##*/}" "$output"\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LINUBOT_FIXTURE: dir, LINUBOT_INSTALL_ROOT: root };
    const args = [resolve("install.sh"), "--version", "2.7.0", "--stage-only"];
    const good = spawnSync("bash", args, { env, encoding: "utf8" });
    assert.equal(good.status, 0, good.stderr);
    assert.equal(readFileSync(join(root, "linubot-2.7.0", ".linubot-managed"), "utf8").trim(), "2.7.0");
    assert.equal(existsSync(join(root, "linubot")), false);
    writeFileSync(join(dir, asset), "tampered");
    const badRoot = join(dir, "bad-opt");
    const bad = spawnSync("bash", args, { env: { ...env, LINUBOT_INSTALL_ROOT: badRoot }, encoding: "utf8" });
    assert.notEqual(bad.status, 0);
    assert.equal(existsSync(join(badRoot, "linubot-2.7.0")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
