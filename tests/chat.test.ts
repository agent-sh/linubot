import { after, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputError } from "../src/errors.ts";
import { writeJson } from "../src/store.ts";

const previousData = process.env.LINUBOT_DATA;
const root = mkdtempSync(join(tmpdir(), "linubot-chat-"));
process.env.LINUBOT_DATA = root;
const { routeGroup } = await import("../src/chat/router.ts");
const { createGroup, deleteGroup, getGroup, listGroups, postToGroup, readFeed, sendDm } =
  await import("../src/chat/session.ts");
const { getBot } = await import("../src/bots/manager.ts");

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { mode: 0o700 });
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-07T08:00:00Z") });
  for (const name of ["alice", "bob", "cara"]) {
    writeJson(join(root, "profiles", name, "profile.json"), { name, model: "fake", createdAt: "2026-09-07T08:00:00Z" });
  }
});

after(() => {
  mock.timers.reset();
  rmSync(root, { recursive: true, force: true });
  if (previousData === undefined) delete process.env.LINUBOT_DATA;
  else process.env.LINUBOT_DATA = previousData;
});

describe("local chat and groups", () => {
  it("routes tagged bots first", () => {
    assert.deepEqual(routeGroup("hey @bob x", ["alice", "bob", "cara"]), ["bob", "alice", "cara"]);
    assert.deepEqual(routeGroup("hi", ["alice", "bob"]), ["alice", "bob"]);
  });

  it("dms land as handoff plus message events", async () => {
    await sendDm("alice", "bob", "take over");
    const feed = readFeed("bot:bob");
    assert.deepEqual(feed.entries.map((e) => e.kind), ["handoff", "message"]);
    assert.equal(feed.entries[1].text, "take over");
    assert.equal(feed.entries[0].from, "alice");
    assert.equal(feed.entries[0].to, "bob");
    assert.equal(feed.entries[1].from, "alice");
    await assert.rejects(() => sendDm("alice", "bob", "  "), /message is required/);
    await assert.rejects(() => sendDm("../alice", "bob", "hello"), InputError);
    await assert.rejects(() => sendDm("newbot", "../bob", "hello"), InputError);
    assert.equal(getBot("newbot"), null);
    assert.equal(readFeed("bot:bob").entries.length, 2);
  });

  it("validates all membership before creating bots and treats duplicate creation as conflict", async () => {
    await assert.rejects(() => createGroup("solo", ["alice"]), /at least two/);
    await assert.rejects(() => createGroup("solo", ["alice", "alice"]), /at least two/);
    await assert.rejects(() => createGroup("../team", ["alice", "bob"]), /invalid group/);
    await assert.rejects(() => createGroup("team", ["newbot", "../bad"]), /invalid bot/);
    assert.equal(getBot("newbot"), null);
    await assert.rejects(() => createGroup("team", ["alice", null] as unknown as string[]), InputError);
    await assert.rejects(() => createGroup("team", null as unknown as string[]), InputError);
    await assert.rejects(() => createGroup("team", ["alice", "bob"], " "), InputError);
    await createGroup("team", ["alice", " bob ", "alice", "cara"], "Dream team");
    assert.equal(getGroup("team")?.name, "Dream team");
    assert.deepEqual(getGroup("team")?.members, ["alice", "bob", "cara"]);
    assert.deepEqual(listGroups().map((g) => g.id), ["team"]);
    await assert.rejects(createGroup("team", ["alice", "newbot"], "Do not reset"), (error) => error instanceof InputError && error.status === 409);
    assert.equal(getBot("newbot"), null);
    assert.equal(getGroup("team")?.name, "Dream team");
    assert.equal(readFeed("group:team").entries.length, 1);
  });

  it("preserves programmatic local bot creation without any research or provider", async () => {
    await createGroup("new-team", ["new-a", "new-b"]);
    assert.ok(getBot("new-a"));
    assert.ok(getBot("new-b"));
  });

  it("allows only one concurrent creation of a group", async () => {
    const results = await Promise.allSettled([
      createGroup("team", ["alice", "bob"], "first"),
      createGroup("team", ["alice", "cara"], "second"),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.equal(failed.reason.status, 409);
    assert.equal(listGroups().length, 1);
    assert.equal(readFeed("group:team").entries.length, 1);
  });

  it("persists each final bot reply exactly once in the group, with no bot-feed mirror", async () => {
    await createGroup("team", ["alice", "bob", "cara"], "Dream team");
    const said: string[] = [];
    const turns = await postToGroup("team", "user", "ship it @cara", async (bot, text) => {
      said.push(bot);
      return `${bot}:${text}`;
    });
    assert.deepEqual(said, ["cara", "alice", "bob"]);
    assert.equal(turns.length, 3);
    const entries = readFeed("group:team").entries;
    assert.deepEqual(entries.filter((entry) => entry.kind === "message").map((entry) => entry.from), ["user", "cara", "alice", "bob"]);
    assert.deepEqual(entries.filter((entry) => entry.kind === "handoff").map((entry) => [entry.from, entry.to]), [["user", "cara"], ["user", "alice"], ["user", "bob"]]);
    for (const bot of ["alice", "bob", "cara"]) assert.deepEqual(readFeed(`bot:${bot}`).entries, []);
    const memberPost = await postToGroup("team", "alice", "from a member", async (bot) => bot);
    assert.equal(memberPost.length, 3);
    assert.equal(readFeed("group:team").entries.filter((entry) => entry.kind === "handoff").at(-1)?.from, "alice");
  });

  it("supports cancellation and never invents a final reply when speak rejects", async () => {
    await createGroup("team", ["alice", "bob", "cara"]);
    let calls = 0;
    const cut = await postToGroup("team", "user", "stop now", async (b) => { calls++; return b; }, () => calls >= 1);
    assert.equal(cut.length, 1);
    assert.match(readFeed("group:team").entries.at(-1)?.text ?? "", /Stopped by user/);
    await assert.rejects(postToGroup("team", "user", "fake failure", async () => { throw new Error("speak failed"); }), /speak failed/);
    const replies = readFeed("group:team").entries.filter((entry) => entry.kind === "message" && entry.from !== "user");
    assert.deepEqual(replies.map((entry) => entry.from), ["alice"]);
    await assert.rejects(() => postToGroup("nope", "user", "hi", async () => "x"), /unknown group/);
  });

  it("rejects nonmember authors and missing persisted members before writing a transcript", async () => {
    await createGroup("team", ["alice", "bob"]);
    await assert.rejects(postToGroup("team", "cara", "hello", async () => assert.fail("nonmember")), /not a group member/);
    await assert.rejects(postToGroup("team", "user", " ", async () => assert.fail("empty")), InputError);
    rmSync(join(root, "profiles", "bob"), { recursive: true });
    await assert.rejects(postToGroup("team", "user", "hello", async () => assert.fail("missing member")), /missing or invalid members/);
    assert.equal(readFeed("group:team").entries.length, 1);
  });

  it("protects group delivery references, including disabled jobs, and keeps deleted groups' history", async () => {
    await createGroup("team", ["alice", "bob"]);
    writeJson(join(root, "jobs.json"), [{ name: "brief", deliver: "group:team", enabled: false }]);
    assert.throws(() => deleteGroup("team"), (error) => error instanceof InputError && error.status === 409 && /brief/.test(error.message));
    assert.ok(getGroup("team"));
    writeJson(join(root, "jobs.json"), []);
    assert.equal(deleteGroup("team"), true);
    assert.equal(deleteGroup("team"), false);
    assert.equal(getGroup("team"), null);
    assert.equal(readFeed("group:team").entries.length, 1);
    assert.throws(() => deleteGroup("../team"), InputError);
  });
});
