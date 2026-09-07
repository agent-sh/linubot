import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createAgentImports } from "../src/imports/manager.ts";
import { createBot, getBot, listBots, readSoul, readBotContext } from "../src/bots/manager.ts";
import { getProvider, setProvider, providerConnections } from "../src/auth/store.ts";
import { listGroups } from "../src/chat/session.ts";
import { listJobs } from "../src/crons/scheduler.ts";
import { readInstalledSkill } from "../src/marketplace/search.ts";
import { eventsAfter } from "../src/events/log.ts";
import { readMemory, readUserEntries } from "../src/memory/store.ts";
import { agentContext, createAgentRuntime } from "../src/agents/runtime.ts";

let root: string, hermes: string, grok: string;
const prior = process.env.LINUBOT_DATA;
function file(path: string, value: string) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, value); }
function encoded(value: string) { let bits = 0, buffer = 0, output = ""; for (const byte of Buffer.from(value)) { buffer = (buffer << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; output += "abcdefghijklmnopqrstuvwxyz234567"[(buffer >> bits) & 31]; } } if (bits) output += "abcdefghijklmnopqrstuvwxyz234567"[(buffer << (5 - bits)) & 31]; return output; }
function blob(key: string, value: unknown, schemaVersion = 1) { file(join(grok, `${encoded(key)}.blob`), JSON.stringify({ schemaVersion, value })); }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "linubot-imports-")); hermes = join(root, "hermes"); grok = join(root, "grok"); process.env.LINUBOT_DATA = join(root, "target");
  setProvider({ kind: "openai-compat", baseUrl: "http://127.0.0.1:9/v1", model: "fixture", auth: "none" });
  file(join(hermes, "SOUL.md"), "You are a friendly architecture helper.\n");
  file(join(hermes, "config.yaml"), 'model:\n  provider: source-provider\n  default: source-model\n  api_key: NEVER_IMPORT_CONFIG_KEY\ntimezone: UTC\nmcp_servers:\n  calendar:\n    command: calendar-server\n    env:\n      TOKEN: NEVER_IMPORT_MCP_KEY\n');
  file(join(hermes, ".env"), "SECRET=NEVER_IMPORT_ENV_KEY");
  file(join(hermes, "auth.json"), '{"token":"NEVER_IMPORT_AUTH_KEY"}');
  file(join(hermes, "memories/MEMORY.md"), "PRIVATE_IMPORT_MARKER: release codename LEMON-7391.\n");
  file(join(hermes, "memories/USER.md"), "The owner likes short answers.\n");
  file(join(hermes, "skills/research/SKILL.md"), '---\nname: research\ndescription: Read the source carefully\n---\nUse references/guide.md to verify the evidence.');
  file(join(hermes, "skills/research/references/guide.md"), "RESEARCH_GUIDE");
  file(join(hermes, "skills/research/credentials.json"), '{"key":"NEVER_IMPORT_SKILL_KEY"}');
  file(join(hermes, "cron/jobs.json"), JSON.stringify({ jobs: [{ name: "Morning check", prompt: "Check the daily brief", schedule: { kind: "cron", expr: "0 8 * * *" } }] }));
  const db = new DatabaseSync(join(hermes, "state.db"));
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, model TEXT, started_at REAL); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER)");
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run("s1", "A prior conversation", "source-model", 1000);
  const insert = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)");
  insert.run(1, "s1", "user", "Historical request", 1001, 1); insert.run(2, "s1", "assistant", "Historical answer", 1002, 1);
  insert.run(3, "s1", "tool", "NOT_A_LINUBOT_APPROVAL", 1003, 1); insert.run(4, "s1", "assistant", "REWOUND_MESSAGE", 1004, 0); db.close();
  const account = "sand.client.slice.account.fixture";
  blob(`${account}.roster.last-roster`, { rows: [{ id: "a", name: "Pip", description: "Research helper", isGroup: false }, { id: "b", name: "Fern", description: "Writing helper", isGroup: false }, { id: "g", name: "Study group", isGroup: true, memberIds: ["a", "b"] }] }, 3);
  for (const id of ["a", "b", "g"]) blob(`${account}.transcript.replicas.${id}`, { entries: [{ kind: "message", id: "1", role: "user", content: "An earlier question", timestampMs: 1700000000000 }, { kind: "send-message", id: "2", message: { type: "text", content: "A cached answer" }, author: { id: id === "g" ? "b" : id }, timestampMs: 1700000001000 }] });
});
afterEach(() => { if (prior === undefined) delete process.env.LINUBOT_DATA; else process.env.LINUBOT_DATA = prior; rmSync(root, { recursive: true, force: true }); });

describe("agent import conversion", () => {
  it("previews and converts a Hermes profile into a native bot without source mutation or shared-memory changes", async () => {
    const importer = createAgentImports({ hermes, grok }); const sources = importer.discover();
    assert.equal(sources.candidates.length, 4);
    const original = createHash("sha256").update(readFileSync(join(hermes, "state.db"))).digest("hex");
    const preview = importer.preview({ sourceId: sources.candidates.find((s) => s.source === "hermes")!.id, providerId: getProvider().id, routines: true });
    assert.equal(listBots().length, 0); assert.equal(preview.bots[0].messages, 3); assert.equal(preview.bots[0].skills.length, 1);
    assert.ok(preview.warnings.some((w) => w.includes("calendar")));
    assert.doesNotMatch(JSON.stringify(preview), /NEVER_IMPORT/);
    file(join(hermes, "SOUL.md"), "The source was edited after the preview.");
    const result = importer.commit(preview.id); const bot = result.bots[0];
    assert.equal(getBot(bot)?.providerId, getProvider().id); assert.match(readSoul(bot), /architecture helper/); assert.match(readBotContext(bot), /LEMON-7391/);
    assert.equal(readFileSync(join(hermes, "SOUL.md"), "utf8"), "The source was edited after the preview.");
    assert.deepEqual(readMemory(), []); assert.deepEqual(readUserEntries(), []);
    assert.equal(listJobs()[0].enabled, false);
    assert.equal(readInstalledSkill(result.skills[0]), null); assert.equal(readInstalledSkill(result.skills[0], true)?.status, "draft");
    assert.equal(readFileSync(join(process.env.LINUBOT_DATA!, "skills", result.skills[0], "references/guide.md"), "utf8"), "RESEARCH_GUIDE");
    assert.deepEqual(readdirSync(join(process.env.LINUBOT_DATA!, "skills", result.skills[0])).sort(), ["SKILL.md", "references"]);
    assert.equal(createHash("sha256").update(readFileSync(join(hermes, "state.db"))).digest("hex"), original);
    assert.deepEqual(createAgentImports({ hermes, grok }).commit(preview.id), result);
    assert.equal(eventsAfter(`bot:${bot}`, 0).filter((event) => event.kind === "message").length, 3);
    assert.doesNotMatch(JSON.stringify(eventsAfter(`bot:${bot}`, 0)), /REWOUND_MESSAGE|NOT_A_LINUBOT_APPROVAL/);
    createBot("Unrelated"); assert.doesNotMatch(agentContext("Unrelated").system, /PRIVATE_IMPORT_MARKER/);
    assert.match(agentContext(bot).system, /PRIVATE_IMPORT_MARKER/);
    let calls = 0;
    const runtime = createAgentRuntime({ review: false, complete: async (_provider, messages) => {
      assert.ok(messages.some((m) => m.content.includes("Imported historical message")));
      assert.ok(messages.filter((m) => m.role === "user").every((m) => m.content !== "Historical request"));
      return ++calls === 1 ? { text: "", toolCalls: [{ id: "remember-import", name: "read_memory", arguments: '{"query":"LEMON-7391"}' }] } : { text: messages.some((m) => m.role === "tool" && m.content.includes("LEMON-7391")) ? "IMPORT_RECALLED" : "FAILED", toolCalls: [] };
    } });
    try { const [run] = runtime.enqueue({ scope: `bot:${bot}`, message: "Recall the imported project codename." }); const done = await runtime.wait(run.id); assert.equal(done.status, "completed", done.error ?? ""); assert.equal(done.response, "IMPORT_RECALLED"); } finally { await runtime.close(); }
  });

  it("converts a Grok group with its members and speaker attribution, without duplicating already imported bots", () => {
    const importer = createAgentImports({ hermes, grok }); const sources = importer.discover();
    const pip = sources.candidates.find((s) => s.name === "Pip")!;
    const first = importer.commit(importer.preview({ sourceId: pip.id }).id);
    const group = sources.candidates.find((s) => s.kind === "group")!;
    const preview = importer.preview({ sourceId: group.id }); assert.ok(preview.targets.some((t) => t.existing && t.name === "Pip"));
    const result = importer.commit(preview.id);
    assert.equal(listBots().length, 2); assert.deepEqual(listGroups()[0].members.sort(), ["Fern", "Pip"]);
    assert.equal(eventsAfter(result.scope, 0).find((e) => e.text === "A cached answer")?.from, "Fern");
    assert.equal(eventsAfter(first.scope, 0).filter((e) => e.kind === "message").length, 2);
    assert.match(getBot("Pip")?.goal || "", /Research helper/);
    assert.ok(result.warnings.some((w) => w.includes("Cloud-only")));
  });

  it("keeps an existing teammate intact and rejects stale names or unsafe source files", () => {
    createBot("Hermes", { goal: "Keep this original bot" });
    const importer = createAgentImports({ hermes, grok }); const id = importer.discover().candidates.find((s) => s.source === "hermes")!.id;
    const preview = importer.preview({ sourceId: id }); assert.equal(preview.targets[0].name, "Hermes-1");
    createBot("Hermes-1"); assert.throws(() => importer.commit(preview.id), /became unavailable/);
    assert.equal(getBot("Hermes")?.goal, "Keep this original bot");
    rmSync(join(hermes, "SOUL.md")); symlinkSync(join(hermes, "auth.json"), join(hermes, "SOUL.md"));
    assert.throws(() => importer.preview({ sourceId: id }), /Unsupported/);
    assert.equal(listBots().length, 2);
  });

  it("refuses a group preview if an existing imported member was removed before commit", () => {
    const importer = createAgentImports({ hermes, grok }), sources = importer.discover();
    const pip = sources.candidates.find((s) => s.name === "Pip")!, group = sources.candidates.find((s) => s.kind === "group")!;
    importer.commit(importer.preview({ sourceId: pip.id }).id);
    const preview = importer.preview({ sourceId: group.id });
    rmSync(join(process.env.LINUBOT_DATA!, "profiles/Pip"), { recursive: true });
    assert.throws(() => importer.commit(preview.id), /existing import target changed/);
    assert.deepEqual(listGroups(), []); assert.equal(getBot("Fern"), null);
  });

  it("honors opt-outs without reading invalid optional source files", () => {
    file(join(hermes, "memories/MEMORY.md"), "MEMORY_NOT_SELECTED");
    file(join(hermes, "skills/research/SKILL.md"), "---\nname: [invalid\n---\nbody");
    const importer = createAgentImports({ hermes, grok }); const id = importer.discover().candidates.find((s) => s.source === "hermes")!.id;
    const preview = importer.preview({ sourceId: id, history: false, skills: false, memory: false, routines: false });
    assert.equal(preview.bots[0].context, ""); assert.equal(preview.bots[0].messages, 0);
    const result = importer.commit(preview.id); assert.deepEqual(result.skills, []); assert.deepEqual(result.routines, []); assert.equal(readBotContext(result.bots[0]), "");
    assert.equal(providerConnections().connections.length, 1);
  });

  it("rolls back new bot data if a retained skill conflicts, preserving the existing Library item", () => {
    const importer = createAgentImports({ hermes, grok }); const id = importer.discover().candidates.find((s) => s.source === "hermes")!.id;
    const first = importer.commit(importer.preview({ sourceId: id }).id);
    const skill = join(process.env.LINUBOT_DATA!, "skills", first.skills[0], "SKILL.md"), original = readFileSync(skill);
    // Simulate an owner removing the imported bot/archive while keeping its Library skill.
    rmSync(join(process.env.LINUBOT_DATA!, "profiles", first.bots[0]), { recursive: true });
    rmSync(join(process.env.LINUBOT_DATA!, `feed-bot_${first.bots[0]}.jsonl`));
    const preview = importer.preview({ sourceId: id });
    assert.throws(() => importer.commit(preview.id), /skill name is already in use/);
    assert.equal(listBots().length, 0);
    assert.deepEqual(readFileSync(skill), original);
    assert.deepEqual(listGroups(), []); assert.deepEqual(listJobs(), []);
    assert.throws(() => readFileSync(join(process.env.LINUBOT_DATA!, `feed-bot_${first.bots[0]}.jsonl`)), /ENOENT/);
  });
});
