import { it } from "node:test";
import assert from "node:assert/strict";
import { createUpdates, managedUpdateInstaller, newerVersion, parseRelease } from "../src/updates.ts";
import { createApp } from "../src/server.ts";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readlinkSync } from "node:fs";
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


it("managed updates stage, freeze and hand off activation before quitting", async () => {
  const events: string[] = [];
  const install = managedUpdateInstaller({
    hasActiveWork: () => false,
    stage: async (update) => { events.push(`stage:${update.version}`); },
    freeze: () => { events.push("freeze"); return () => events.push("resume"); },
    activateAfterExit: async (update) => { events.push(`activate:${update.version}`); },
    quit: () => { events.push("quit"); },
  });
  const updates = createUpdates({ version: "2.6.0", check: async () => release(), install });
  await updates.check();
  assert.equal(updates.status().canInstall, true);
  await updates.install();
  assert.deepEqual(events, ["stage:2.7.0", "freeze", "activate:2.7.0", "quit"]);
});

it("managed updates retain the staged release if work starts during download", async () => {
  let active = false, staged = 0;
  const install = managedUpdateInstaller({
    hasActiveWork: () => active,
    stage: async () => { staged++; active = true; },
    freeze: () => assert.fail("Must not freeze active work"),
    activateAfterExit: async () => assert.fail("Must not activate"),
    quit: () => assert.fail("Must not quit"),
  });
  const update = parseRelease(release(), "2.6.0", "x64")!;
  await assert.rejects(install(update), /update is downloaded/);
  await assert.rejects(install(update), /Finish active tasks before/);
  assert.equal(staged, 1);
});

it("managed updates thaw admission if the activation helper cannot start", async () => {
  let resumed = false;
  const install = managedUpdateInstaller({
    hasActiveWork: () => false,
    stage: async () => {},
    freeze: () => () => { resumed = true; },
    activateAfterExit: async () => { throw new Error("systemd-run failed"); },
    quit: () => assert.fail("Must not quit on failed handoff"),
  });
  await assert.rejects(install(parseRelease(release(), "2.6.0", "x64")!), /could not be activated/);
  assert.equal(resumed, true);
});

it("installer stage-only leaves integration alone, and activation uses supervision with legacy stop first", { skip: process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() === 0 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "linubot-service-test-"));
  try {
    const home = join(dir, "home"), bin = join(dir, "bin"), root = join(home, ".local/opt"), target = join(root, "linubot-2.11.0"), calls = join(dir, "calls");
    mkdirSync(join(target, "resources"), { recursive: true }); mkdirSync(bin);
    writeFileSync(join(target, ".linubot-managed"), "2.11.0\n");
    writeFileSync(join(target, "linubot"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(target, "resources/app.asar"), "fixture");
    writeFileSync(join(target, "linubot.png"), "fixture");
    writeFileSync(join(bin, "systemctl"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LINUBOT_TEST_CALLS"\nexit 0\n', { mode: 0o755 });
    for (const name of ["gtk-update-icon-cache", "update-desktop-database"]) writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = { ...process.env, HOME: home, LINUBOT_INSTALL_ROOT: root, PATH: `${bin}:${process.env.PATH}`, LINUBOT_TEST_CALLS: calls };
    const args = [resolve("install.sh"), "--version", "2.11.0"];
    execFileSync("bash", [...args, "--stage-only"], { env });
    assert.equal(existsSync(calls), false);
    assert.equal(existsSync(join(root, "linubot")), false);
    assert.equal(existsSync(join(home, ".config/systemd")), false);
    execFileSync("bash", [...args, "--activate-only"], { env });
    const unit = readFileSync(join(home, ".config/systemd/user/linubot.service"), "utf8");
    for (const setting of ["Description=Linubot", "ExecStart=%h/.local/bin/linubot", "Restart=on-failure", "RestartSec=5", "StartLimitIntervalSec=300", "StartLimitBurst=3", "KillMode=process", "UnsetEnvironment=ELECTRON_RUN_AS_NODE", "PartOf=graphical-session.target", "WantedBy=graphical-session.target"]) assert(unit.includes(setting), setting);
    const commands = readFileSync(calls, "utf8").trim().split("\n");
    assert(commands.includes("--user daemon-reload"));
    assert(commands.includes("--user enable linubot.service"));
    assert(commands.indexOf("--user stop linubot-desktop") < commands.indexOf("--user restart linubot"));
    assert(commands.includes("--user stop linubot-desktop"));
    assert.match(readFileSync(join(home, ".local/share/applications/linubot.desktop"), "utf8"), /Exec=".*linubot-start"/);
    execFileSync(join(home, ".local/bin/linubot-start"), [], { env });
    assert(readFileSync(calls, "utf8").endsWith("--user start linubot\n"));
    // An unavailable user manager takes the plain-launcher path, with no unit writes.
    writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(join(target, "linubot"), '#!/bin/sh\ntest -z "${ELECTRON_RUN_AS_NODE+x}"\n', { mode: 0o755 });
    execFileSync(join(home, ".local/bin/linubot-start"), [], { env: { ...env, ELECTRON_RUN_AS_NODE: "1" } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


for (const failure of ["enable", "restart"]) it(`activation restores the old version and integration after systemd ${failure} fails`, { skip: process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() === 0 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "linubot-rollback-test-"));
  try {
    const home = join(dir, "home"), bin = join(dir, "bin"), root = join(home, ".local/opt"), old = join(root, "linubot-2.10.0"), target = join(root, "linubot-2.11.0"), calls = join(dir, "calls");
    mkdirSync(bin);
    for (const path of [old, target]) {
      mkdirSync(join(path, "resources"), { recursive: true });
      writeFileSync(join(path, ".linubot-managed"), "fixture");
      writeFileSync(join(path, "linubot"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(path, "resources/app.asar"), "fixture");
      writeFileSync(join(path, "linubot.png"), "fixture");
    }
    symlinkSync(old, join(root, "linubot"));
    const integration = [".local/bin/linubot", ".local/bin/linubot-start", ".local/share/applications/linubot.desktop", ".local/share/icons/hicolor/512x512/apps/linubot.png", ".config/systemd/user/linubot.service"];
    for (const path of integration) { mkdirSync(join(home, path, ".."), { recursive: true }); writeFileSync(join(home, path), `original:${path}`); }
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$LINUBOT_TEST_CALLS"
if [ "$2" = "$LINUBOT_TEST_FAIL" ] && [ ! -f "$LINUBOT_TEST_CALLS.failed" ]; then touch "$LINUBOT_TEST_CALLS.failed"; exit 1; fi
if [ "$2" = restart ]; then readlink "$LINUBOT_INSTALL_ROOT/linubot" >> "$LINUBOT_TEST_CALLS"; fi
exit 0
`, { mode: 0o755 });
    for (const name of ["gtk-update-icon-cache", "update-desktop-database"]) writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = { ...process.env, HOME: home, LINUBOT_INSTALL_ROOT: root, PATH: `${bin}:${process.env.PATH}`, LINUBOT_TEST_CALLS: calls, LINUBOT_TEST_FAIL: failure };
    const result = spawnSync("bash", [resolve("install.sh"), "--version", "2.11.0", "--activate-only"], { env, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restoring the previous installation/);
    assert.equal(readlinkSync(join(root, "linubot")), old);
    for (const path of integration) assert.equal(readFileSync(join(home, path), "utf8"), `original:${path}`);
    assert(readFileSync(calls, "utf8").endsWith(`${old}\n`), "Recovery restart must resolve the old payload");
    assert(existsSync(join(target, ".linubot-managed")), "Keep the downloaded candidate staged for retry");
    // Rollback releases the lock, so an explicit retry can proceed.
    const retry = spawnSync("bash", [resolve("install.sh"), "--version", "2.11.0", "--activate-only"], { env, encoding: "utf8" });
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(readlinkSync(join(root, "linubot")), target);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
