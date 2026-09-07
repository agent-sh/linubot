import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousData = process.env.LINUBOT_DATA;
const previousHome = process.env.HOME;
let root: string;
let local: string;
let data: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "linubot-market-"));
  local = join(root, "local");
  data = join(root, "data");
  process.env.LINUBOT_DATA = data;
  process.env.HOME = join(root, "home");
  mkdirSync(local);
  mkdirSync(process.env.HOME);
});
afterEach(() => {
  if (previousData === undefined) delete process.env.LINUBOT_DATA;
  else process.env.LINUBOT_DATA = previousData;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});
const { approveSkill, installSkill, listInstalledSkills, readInstalledSkill, readSkillBody, searchSkills, validSkillName } =
  await import("../src/marketplace/search.ts");
const { saveSkill } = await import("../src/memory/updater.ts");

function skill(dir: string, name: string, desc = "Useful skill", body = "Body."): string {
  mkdirSync(join(dir, name), { recursive: true });
  const path = join(dir, name, "SKILL.md");
  writeFileSync(path, `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(desc)}\n---\n\n${body}\n`);
  return path;
}

describe("marketplace", () => {
  it("finds local skills, rejects spoofs", () => {
    skill(local, "nightly-brief", "Builds a nightly briefing");
    assert.deepEqual(searchSkills(local, "nightly").map((h) => h.name), ["nightly-brief"]);
    mkdirSync(join(local, "evil"), { recursive: true });
    writeFileSync(join(local, "evil", "SKILL.md"), "---\nname: innocent\ndescription: x\n---\n");
    const names = searchSkills(local, "").map((h) => h.name);
    assert.ok(names.includes("nightly-brief"));
    assert.ok(!names.includes("evil") && !names.includes("innocent"));
  });

  it("installs once and reads back", () => {
    skill(local, "nightly-brief", "Builds a nightly briefing");
    searchSkills(local, "nightly");
    const dest = installSkill("nightly-brief", join(local, "nightly-brief", "SKILL.md"));
    assert.ok(dest.endsWith("nightly-brief/SKILL.md"));
    assert.ok(readSkillBody("nightly-brief").includes("Builds a nightly briefing"));
    assert.deepEqual(readInstalledSkill("nightly-brief"), { name: "nightly-brief", description: "Builds a nightly briefing", body: "Body.", status: "approved" });
    assert.deepEqual(listInstalledSkills().map((item) => item.name), ["nightly-brief"]);
    assert.throws(() => installSkill("nightly-brief", join(local, "nightly-brief", "SKILL.md")), { name: "InputError", status: 409 });
    assert.throws(() => installSkill("Bad!", join(local, "nightly-brief", "SKILL.md")), /invalid skill name/);
  });

  it("uses the same strict frontmatter validation for discovery and installed loading", () => {
    const malformed = [
      (name: string) => `name: ${name}\nname: other\ndescription: x`,
      (name: string) => `name: ${name}\ndescription: x\ndescription: y`,
      (name: string) => `name: ${name}\ndescription: "unterminated`,
      (name: string) => `name: ${name}\ndescription: unquoted: mapping`,
      (name: string) => `name: ${name}\ndescription: [not, text]`,
      (name: string) => `name: ${name}\ndescription: !tag text`,
      (name: string) => `name: ${name}\ndescription: *alias`,
      (name: string) => `name: ${name}\ndescription: x\nstatus: unknown`,
      () => "name: ../escape\ndescription: x",
      () => "name: other\ndescription: x",
      () => "name: constructor\ndescription: x",
      (name: string) => `name: ${name}\n  description: x`,
      (name: string) => `name: ${name}`,
    ];
    for (const [index, header] of malformed.entries()) {
      const name = `invalid-${index}`;
      const raw = `---\n${header(name)}\n---\nBody.\n`;
      const path = skill(local, name);
      writeFileSync(path, raw);
      const installed = skill(join(data, "skills"), name);
      writeFileSync(installed, raw);
      assert.equal(readInstalledSkill(name, true), null);
      assert.throws(() => approveSkill(name), { name: "InputError", status: 404 });
    }
    assert.deepEqual(searchSkills(local, ""), []);
    assert.deepEqual(listInstalledSkills(true), []);
  });

  it("supports string quoting and block descriptions without dropping scalar metadata", () => {
    const path = skill(local, "quoted");
    writeFileSync(path, "---\r\nname: 'quoted'\r\ndescription: >-\r\n  First line\r\n  second line\r\nallowed-tools: 'Read, Test'\r\n---\r\n\r\nDo the work.\r\n");
    const [hit] = searchSkills(local, "quoted");
    assert.equal(hit.description, "First line second line");
    installSkill("quoted", path);
    assert.equal(readInstalledSkill("quoted")?.body, "Do the work.");
    assert.match(readSkillBody("quoted"), /description: "First line second line"/);
    assert.match(readSkillBody("quoted"), /allowed-tools: "Read, Test"/);
  });

  it("cannot install arbitrary host files or paths outside discovered roots", () => {
    const path = skill(local, "brief");
    const outside = skill(join(root, "outside"), "secret");
    assert.throws(() => installSkill("brief", path), /approved discovery result/);
    searchSkills(local, "");
    assert.throws(() => installSkill("secret", outside), /approved discovery result/);
    assert.throws(() => installSkill("brief", outside), /approved discovery result/);
    assert.throws(() => installSkill("secret", join(local, "..", "outside", "secret", "SKILL.md")), /approved discovery result/);
    assert.equal(existsSync(join(data, "skills", "secret")), false);
    assert.ok(readFileSync(outside, "utf8").includes("Body."));
  });

  it("revalidates discovered content at install time", () => {
    const path = skill(local, "brief");
    searchSkills(local, "");
    writeFileSync(path, "---\nname: other\ndescription: x\n---\nBody.\n");
    assert.throws(() => installSkill("brief", path), /frontmatter or name mismatch/);
    assert.equal(existsSync(join(data, "skills", "brief")), false);
  });

  it("reports a disappeared discovery result as not found", () => {
    const path = skill(local, "brief");
    searchSkills(local, "");
    rmSync(path);
    assert.throws(() => installSkill("brief", path), { name: "InputError", status: 404 });
    assert.equal(existsSync(join(data, "skills", "brief")), false);
  });

  it("rejects source symlink escapes during discovery and after discovery", () => {
    const outside = skill(join(root, "outside"), "brief");
    symlinkSync(join(root, "outside", "brief"), join(local, "brief"));
    assert.deepEqual(searchSkills(local, ""), []);
    assert.throws(() => installSkill("brief", join(local, "brief", "SKILL.md")), /approved discovery result/);
    rmSync(join(local, "brief"));
    const path = skill(local, "brief");
    rmSync(path);
    symlinkSync(outside, path);
    assert.deepEqual(searchSkills(local, ""), []);
    rmSync(path);
    skill(local, "brief");
    searchSkills(local, "");
    renameSync(join(local, "brief"), join(root, "original"));
    symlinkSync(join(root, "outside", "brief"), join(local, "brief"));
    assert.throws(() => installSkill("brief", path), /escaped|unsafe/);
    assert.equal(existsSync(join(data, "skills", "brief")), false);
  });

  it("preserves regular resource bundles with private modes and executable scripts", () => {
    const path = skill(local, "bundle", "Uses bundled resources", "Read references/facts.txt and run scripts/check.sh.");
    const dir = join(local, "bundle");
    mkdirSync(join(dir, "references"));
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "references", "facts.txt"), "Verified facts\n");
    writeFileSync(join(dir, "scripts", "check.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(dir, "assets", "raw.bin"), Buffer.from([0, 1, 255]));
    searchSkills(local, "bundle");
    installSkill("bundle", path);
    const dest = join(data, "skills", "bundle");
    assert.equal(readFileSync(join(dest, "references", "facts.txt"), "utf8"), "Verified facts\n");
    assert.deepEqual(readFileSync(join(dest, "assets", "raw.bin")), Buffer.from([0, 1, 255]));
    assert.equal(statSync(dest).mode & 0o777, 0o700);
    assert.equal(statSync(join(dest, "references")).mode & 0o777, 0o700);
    assert.equal(statSync(join(dest, "references", "facts.txt")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dest, "scripts", "check.sh")).mode & 0o777, 0o700);
    assert.equal(statSync(join(dest, "SKILL.md")).mode & 0o777, 0o600);
    assert.equal(readdirSync(join(data, "skills")).some((name) => name.endsWith(".tmp")), false);
  });

  it("rejects resource symlinks, including internal links, instead of copying escapes", () => {
    const path = skill(local, "bundle");
    const secret = join(root, "secret");
    writeFileSync(secret, "keep");
    const link = join(local, "bundle", "resource");
    for (const target of [secret, join(local, "bundle", "SKILL.md"), root]) {
      searchSkills(local, "bundle");
      symlinkSync(target, link);
      assert.throws(() => installSkill("bundle", path), /symlinks/);
      assert.equal(existsSync(join(data, "skills", "bundle")), false);
      assert.deepEqual(searchSkills(local, "bundle"), []);
      rmSync(link);
    }
    assert.equal(readFileSync(secret, "utf8"), "keep");
  });

  it("rejects symlinked installed directories, files, and resources", () => {
    const outside = skill(join(root, "outside"), "linked");
    mkdirSync(join(data, "skills"), { recursive: true });
    symlinkSync(join(root, "outside", "linked"), join(data, "skills", "linked"));
    assert.throws(() => readInstalledSkill("linked"), /unsafe/);
    assert.throws(() => approveSkill("linked"), /unsafe/);
    assert.throws(() => saveSkill({ name: "linked", description: "x", body: "x" }), /unsafe/);
    assert.deepEqual(listInstalledSkills(true), []);
    const path = skill(join(data, "skills"), "leaf");
    rmSync(path);
    symlinkSync(outside, path);
    assert.throws(() => readSkillBody("leaf"), /unsafe/);
    const bundled = skill(join(data, "skills"), "bundled");
    symlinkSync(outside, join(data, "skills", "bundled", "resource"));
    assert.throws(() => readInstalledSkill("bundled"), /symlinks/);
    assert.deepEqual(listInstalledSkills(true), []);
    assert.ok(readFileSync(bundled, "utf8").includes("Body."));
  });

  it("rejects a symlinked installation root", () => {
    mkdirSync(data);
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(data, "skills"));
    assert.throws(() => readInstalledSkill("brief"), /unsafe/);
    assert.throws(() => saveSkill({ name: "brief", description: "x", body: "x" }), /unsafe/);
    assert.deepEqual(readdirSync(join(root, "outside")), []);
  });

  it("loads valid old manual installs but keeps old demonstrations as drafts", () => {
    const manual = skill(join(data, "skills"), "manual");
    writeFileSync(manual, "---\nname: manual\ndescription: A manual skill\n---\nBody.\n");
    const legacy = skill(join(data, "skills"), "demo", "Demonstrated for seller: a task", "# Demonstration\nReview the screenshots, then rewrite this draft into exact steps and test it on a real task.");
    assert.equal(readInstalledSkill("manual")?.status, "approved");
    assert.equal(readInstalledSkill("demo"), null);
    assert.equal(readInstalledSkill("demo", true)?.status, "draft");
    assert.ok(readSkillBody("demo").includes("rewrite this draft"));
    assert.deepEqual(listInstalledSkills().map((item) => item.name), ["manual"]);
    approveSkill("demo");
    assert.equal(readInstalledSkill("demo")?.status, "approved");
    assert.match(readFileSync(legacy, "utf8"), /status: "approved"/);
    assert.equal(approveSkill("demo").status, "approved");
  });

  it("keeps the original demo writer's unquoted-description format reviewable as draft", () => {
    const body = "# Recorded Task (demonstrated for seller)\n\nPurpose: A task\n\nReview the screenshots, then rewrite this draft into exact steps and test it on a real task before scheduling it as a routine.";
    const path = skill(join(data, "skills"), "old-demo");
    writeFileSync(path, `---\nname: old-demo\ndescription: Demonstrated for seller: A task\n---\n\n${body}\n`);
    assert.equal(readInstalledSkill("old-demo"), null);
    assert.deepEqual(readInstalledSkill("old-demo", true), { name: "old-demo", description: "Demonstrated for seller: A task", body, status: "draft" });
    assert.equal(searchSkills(local, "old-demo")[0].status, "draft");
    assert.equal(approveSkill("old-demo").status, "approved");
    assert.match(readFileSync(path, "utf8"), /description: "Demonstrated for seller: A task"/);
    assert.equal(readInstalledSkill("old-demo")?.body, body);
  });

  it("does not promote a declared draft during manual installation", () => {
    const path = skill(local, "draft");
    writeFileSync(path, '---\nname: "draft"\ndescription: "A draft"\nstatus: "draft"\n---\nNeeds review.\n');
    assert.equal(searchSkills(local, "draft")[0].status, "draft");
    installSkill("draft", path);
    assert.equal(readInstalledSkill("draft"), null);
    assert.equal(readInstalledSkill("draft", true)?.status, "draft");
  });

  it("bounds names, input types, files and resource bundles", () => {
    for (const name of ["..", "../escape", "Bad", "brief\n", "brief\r", "brief\u2028", "__proto__", "constructor", "prototype", "x".repeat(41), null, {}]) {
      assert.equal(validSkillName(name), false);
      for (const action of [() => installSkill(name as string, "/not-approved"), () => readInstalledSkill(name as string), () => readSkillBody(name as string), () => approveSkill(name as string)]) {
        assert.throws(action, { name: "InputError", status: 400 });
      }
    }
    assert.throws(() => searchSkills(local, null as never), { name: "InputError", status: 400 });
    assert.throws(() => searchSkills(local, "x".repeat(2001)), { name: "InputError", status: 400 });
    assert.throws(() => readInstalledSkill("brief", "yes" as never), { name: "InputError", status: 400 });
    const oversized = skill(local, "oversized");
    writeFileSync(oversized, Buffer.alloc(256 * 1024 + 1, "x"));
    const path = skill(local, "bundle");
    searchSkills(local, "");
    writeFileSync(join(local, "bundle", "huge"), Buffer.alloc(10 * 1024 * 1024, "x"));
    assert.throws(() => installSkill("bundle", path), /exceeds 10 MiB/);
    assert.deepEqual(searchSkills(local, ""), []);
    assert.equal(existsSync(join(data, "skills", "bundle")), false);
  });
});
