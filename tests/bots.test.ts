import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousData = process.env.LINUBOT_DATA;
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "linubot-bots-"));
  process.env.LINUBOT_DATA = root;
});
afterEach(() => {
  if (previousData === undefined) delete process.env.LINUBOT_DATA;
  else process.env.LINUBOT_DATA = previousData;
  rmSync(root, { recursive: true, force: true });
});
const { appendSoul, createBot, deleteBot, ensureBot, getBot, inferSpecialty, listBots, markRead, readSoul, saveSections, listSections, unreadCount, updateBot, validName, writeSoul } =
  await import("../src/bots/manager.ts");
const { appendEvent } = await import("../src/events/log.ts");
const { saveSkill, approveSkill } = await import("../src/memory/updater.ts");

describe("bots", () => {
  it("rejects unsafe names at every filesystem boundary without deleting data", async () => {
    assert.equal(validName("bob-1_x"), true);
    createBot("keeper");
    writeFileSync(join(root, "keep.txt"), "keep");
    for (const name of ["..", ".", "../evil", "a/b", "a\\b", "zed\n", "zed\r", "zed\u2028", "__proto__", "constructor", "prototype", "", null, 12, {}]) {
      assert.equal(validName(name), false);
      const n = name as string;
      for (const action of [() => createBot(n), () => getBot(n), () => deleteBot(n), () => readSoul(n), () => writeSoul(n, "x"), () => appendSoul(n, []), () => updateBot(n, {})]) {
        assert.throws(action, { name: "InputError", status: 400 });
      }
      await assert.rejects(() => ensureBot(n), { name: "InputError", status: 400 });
    }
    assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "keep");
    assert.equal(getBot("keeper")?.name, "keeper");
  });

  it("uses explicit research only, without stock claims", async () => {
    const p = await ensureBot("seller", async (t) => [`Knows ${t}.`]);
    assert.equal(p.topic, "sales and marketing");
    assert.match(p.color, /^#[0-9a-f]{6}$/);
    assert.ok(readSoul("seller").includes("Knows sales and marketing."));
    const again = await ensureBot("seller", async () => { throw new Error("no second research"); });
    assert.equal(again.createdAt, p.createdAt);
    await ensureBot("debug-dan");
    assert.match(readSoul("debug-dan"), /focus is software engineering/);
    assert.match(readSoul("debug-dan"), /approved skills actually available/);
    assert.doesNotMatch(readSoul("debug-dan"), /Specialty:|Refine this soul|researched specialist/);
  });

  it("does not reset an existing profile or its soul", () => {
    createBot("keeper", { model: "initial", goal: "Ship the fix", topic: "Testing" });
    const expected = updateBot("keeper", { model: "chosen", pinned: true });
    writeSoul("keeper", "Custom instructions");
    assert.deepEqual(createBot("keeper", { model: "other", topic: "Other", goal: "Other" }), expected);
    assert.deepEqual(getBot("keeper"), expected);
    assert.equal(readSoul("keeper"), "Custom instructions\n");
  });

  it("preserves malformed profiles and unowned directories instead of recreating them", () => {
    createBot("broken");
    const path = join(root, "profiles", "broken", "profile.json");
    writeFileSync(path, "{bad json");
    assert.throws(() => getBot("broken"), /Cannot read stored JSON/);
    assert.throws(() => createBot("broken"), /Cannot read stored JSON/);
    assert.throws(() => deleteBot("broken"), /Cannot read stored JSON/);
    assert.equal(readFileSync(path, "utf8"), "{bad json");
    writeFileSync(path, "null");
    assert.throws(() => getBot("broken"), /invalid stored bot profile/);
    assert.throws(() => createBot("broken"), /invalid stored bot profile/);
    assert.equal(readFileSync(path, "utf8"), "null");
    mkdirSync(join(root, "profiles", "notes"));
    writeFileSync(join(root, "profiles", "notes", "keep.txt"), "keep");
    assert.throws(() => createBot("notes"), { name: "InputError", status: 409 });
    assert.equal(deleteBot("notes"), false);
    assert.equal(readFileSync(join(root, "profiles", "notes", "keep.txt"), "utf8"), "keep");
  });

  it("infers specialties", () => {
    assert.equal(inferSpecialty("debug-dan"), "software engineering");
    assert.equal(inferSpecialty("bob"), null);
  });

  it("requires installed, approved skill bodies, and persists goal/topic edits", () => {
    createBot("zed");
    createBot("amy");
    saveSkill({ name: "web", description: "Web notes", body: "Use verified sources." });
    assert.throws(() => updateBot("zed", { skills: ["missing"] }), /not installed and approved/);
    assert.throws(() => updateBot("zed", { skills: ["web"] }), /not installed and approved/);
    approveSkill("web");
    updateBot("zed", { pinned: true, skills: ["web", "web"] });
    assert.deepEqual(listBots().map((b) => b.name), ["zed", "amy"]);
    assert.deepEqual(getBot("zed")?.skills, ["web"]);
    updateBot("zed", { goal: " Ship tests ", topic: " QA " });
    assert.equal(getBot("zed")?.goal, "Ship tests");
    assert.equal(getBot("zed")?.topic, "QA");
    const stored = JSON.parse(readFileSync(join(root, "profiles", "zed", "profile.json"), "utf8"));
    assert.equal(stored.goal, "Ship tests");
    updateBot("zed", { goal: "", topic: null });
    assert.equal(Object.hasOwn(getBot("zed")!, "goal"), false);
    assert.equal(getBot("zed")?.topic, null);
  });

  it("validates profile input before persisting any part of a patch", () => {
    const before = createBot("zed");
    for (const patch of [null, [], { model: 1 }, { model: "x".repeat(201) }, { skills: "web" }, { skills: ["../x"] }, { skills: [null] }, { pinned: "yes" }, { topic: [] }, { topic: "x".repeat(2001) }, { goal: {} }, { goal: "x".repeat(4001) }]) {
      assert.throws(() => updateBot("zed", patch as never), { name: "InputError", status: 400 });
      assert.deepEqual(getBot("zed"), before);
    }
    assert.throws(() => updateBot("missing", {}), { name: "InputError", status: 404 });
    assert.throws(() => createBot("new", { model: 1 } as never), { name: "InputError", status: 400 });
    assert.equal(getBot("new"), null);
  });

  it("tracks unread per scope", () => {
    createBot("zed");
    assert.equal(unreadCount("bot:zed"), 0);
    appendEvent("bot:zed", { kind: "message", from: "user", text: "hey" });
    assert.equal(unreadCount("bot:zed"), 0, "your own message is not unread");
    appendEvent("bot:zed", { kind: "message", from: "zed", text: "yo" });
    appendEvent("bot:zed", { kind: "state", status: "working", from: "zed" });
    assert.equal(unreadCount("bot:zed"), 1, "state events are not unread");
    markRead("bot:zed");
    assert.equal(unreadCount("bot:zed"), 0);
    assert.throws(() => markRead("__proto__"), { name: "InputError", status: 400 });
    assert.throws(() => markRead("bot:zed", -1), { name: "InputError", status: 400 });
    assert.throws(() => markRead("bot:zed", Number.NaN), { name: "InputError", status: 400 });
  });

  it("blocks referenced deletions and only removes the deleted bot from sections", () => {
    createBot("seller");
    createBot("zed");
    saveSections([{ name: "Work", bots: ["seller", "zed"] }, { name: "Only Seller", bots: ["seller"] }]);
    const groups = join(root, "groups.json");
    const jobs = join(root, "jobs.json");
    const group = [{ id: "team", members: ["seller", "zed"] }];
    writeFileSync(groups, JSON.stringify(group));
    assert.throws(() => deleteBot("seller"), { name: "InputError", status: 409 });
    assert.deepEqual(JSON.parse(readFileSync(groups, "utf8")), group);
    writeFileSync(groups, "[]");
    for (const job of [{ name: "sales", bot: "seller" }, { name: "send", bot: "zed", deliver: "bot:seller" }, { name: "paused", bot: "zed", deliver: " bot:seller ", enabled: false }]) {
      writeFileSync(jobs, JSON.stringify([job]));
      assert.throws(() => deleteBot("seller"), { name: "InputError", status: 409 });
      assert.equal(getBot("seller")?.name, "seller");
      assert.deepEqual(JSON.parse(readFileSync(jobs, "utf8")), [job]);
    }
    writeFileSync(jobs, "[]");
    assert.equal(deleteBot("seller"), true);
    assert.equal(deleteBot("seller"), false);
    assert.deepEqual(listSections(), [{ name: "Work", bots: ["zed"] }, { name: "Only Seller", bots: [] }]);
    assert.equal(getBot("zed")?.name, "zed");
  });

  it("fails closed on corrupt stored references", () => {
    createBot("seller");
    for (const file of ["groups.json", "jobs.json", "sections.json"]) {
      const path = join(root, file);
      for (const raw of ["{bad", "{}", "[{}]", "[null]"]) {
        writeFileSync(path, raw);
        assert.throws(() => deleteBot("seller"));
        assert.equal(getBot("seller")?.name, "seller");
      }
      rmSync(path);
    }
  });

  it("validates sections without mutating the caller", () => {
    const sections = [{ name: " Work ", bots: ["zed", "zed"] }];
    assert.deepEqual(saveSections(sections), [{ name: "Work", bots: ["zed"] }]);
    assert.equal(sections[0].name, " Work ");
    assert.equal(sections[0].bots.length, 2);
    for (const value of [null, {}, [{ name: "", bots: [] }], [{ name: "Work", bots: "zed" }], [{ name: "Work", bots: ["../x"] }]]) {
      assert.throws(() => saveSections(value as never), { name: "InputError", status: 400 });
    }
    assert.throws(() => saveSections([{ name: "Work", bots: [] }, { name: "work", bots: [] }]), { name: "InputError", status: 409 });
  });

  it("dedupes soul lines within a batch and bounds input", () => {
    createBot("zed");
    assert.deepEqual(appendSoul("zed", ["Prefers terse replies", " PREFERS TERSE REPLIES ", "Another", "another"]), ["Prefers terse replies", "Another"]);
    assert.deepEqual(appendSoul("zed", ["PREFERS TERSE REPLIES"]), []);
    const before = readSoul("zed");
    for (const input of [null, {}, [1], ["x".repeat(4001)], Array(51).fill("x"), ["a\n§\nb"]]) {
      assert.throws(() => appendSoul("zed", input as never), { name: "InputError", status: 400 });
    }
    assert.throws(() => writeSoul("zed", {} as never), { name: "InputError", status: 400 });
    assert.throws(() => writeSoul("zed", "x".repeat(128 * 1024 + 1)), { name: "InputError", status: 400 });
    assert.equal(readSoul("zed"), before);
  });

  it("writes private profile and soul files, including replacements", () => {
    createBot("zed");
    const dir = join(root, "profiles", "zed");
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "profile.json")).mode & 0o777, 0o600);
    const soul = join(dir, "SOUL.md");
    assert.equal(statSync(soul).mode & 0o777, 0o600);
    chmodSync(soul, 0o644);
    writeSoul("zed", "private");
    assert.equal(statSync(soul).mode & 0o777, 0o600);
  });

  it("rejects symlinked bot directories and leaf files", () => {
    createBot("zed");
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret"), "keep");
    symlinkSync(outside, join(root, "profiles", "linked"));
    for (const action of [() => getBot("linked"), () => deleteBot("linked"), () => readSoul("linked"), () => createBot("linked")]) {
      assert.throws(action, { name: "InputError", status: 400 });
    }
    const soul = join(root, "profiles", "zed", "SOUL.md");
    rmSync(soul);
    symlinkSync(join(outside, "secret"), soul);
    assert.throws(() => readSoul("zed"), { name: "InputError", status: 400 });
    assert.throws(() => writeSoul("zed", "overwrite"), { name: "InputError", status: 400 });
    assert.equal(readFileSync(join(outside, "secret"), "utf8"), "keep");
    const profile = join(root, "profiles", "zed", "profile.json");
    rmSync(profile);
    symlinkSync(join(outside, "secret"), profile);
    assert.throws(() => getBot("zed"), { name: "InputError", status: 400 });
    assert.throws(() => listBots(), { name: "InputError", status: 400 });
  });

  it("rejects a symlinked profiles root", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "profiles"));
    assert.throws(() => createBot("zed"), { name: "InputError", status: 400 });
    assert.throws(() => deleteBot("zed"), { name: "InputError", status: 400 });
    assert.equal(existsSync(join(outside, "zed")), false);
  });
});


describe("bot mascots", () => {
  it("persists each bot's appearance without changing its agent context", async () => {
    const { agentContext } = await import("../src/agents/runtime.ts");
    const first = createBot("Milo", { goal: "Help with writing" });
    const second = createBot("Fern");
    assert.ok(first.mascotSeed);
    assert.notEqual(first.mascotSeed, second.mascotSeed);
    assert.equal(getBot("Milo")?.mascotSeed, first.mascotSeed);
    const revision = agentContext("Milo").revision;
    updateBot("Milo", { mascotSeed: "new-look" });
    assert.equal(getBot("Milo")?.mascotSeed, "new-look");
    assert.equal(getBot("Milo")?.goal, "Help with writing");
    assert.equal(agentContext("Milo").revision, revision);
    assert.throws(() => updateBot("Milo", { mascotSeed: '<script>' }), /mascot seed/);
    assert.equal(getBot("Milo")?.mascotSeed, "new-look");
  });
});
