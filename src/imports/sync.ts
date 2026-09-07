import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createImportSources, type ImportedMessage, type ImportRoots, type SourceBot } from "./sources.ts";
import { digest, importedSkillName, importMetadata, messageKey, skillFiles, skillSourceHash, treeHash, type Baseline, type ImportMetadata } from "./state.ts";
import { getBot, listBots, readBotContext, readSoul, updateBot, writeBotContext, writeSoul } from "../bots/manager.ts";
import { getGroup } from "../chat/session.ts";
import { appendImportedEvents, bus, eventsAfter, invalidateFeed, validateScope, type FeedEvent, type NewEvent } from "../events/log.ts";
import { approveSkill, readInstalledSkill, saveLearnedSkill, validateLearnedSkill } from "../marketplace/search.ts";
import { dataDir, readJson, writeJson } from "../store.ts";
import { InputError } from "../errors.ts";

type Status = "new" | "update" | "conflict" | "unchanged";
interface Change { bot: string; kind: "memory" | "instructions" | "skill"; name?: string; status: Status; sourceText: string; localText: string; files?: string[] }
interface BotPlan { name: string; source: SourceBot; metadata: ImportMetadata; baseline: Baseline; changes: Change[] }
interface Plan { id: string; scope: string; expires: number; bots: BotPlan[]; feeds: { scope: string; events: NewEvent[]; fingerprint: string }[]; expected: string; warnings: string[] }
function fileBytes(path: string): Buffer | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false }); if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new InputError("Unsafe or oversized sync destination");
  return readFileSync(path);
}
const fileHash = (path: string) => { const bytes = fileBytes(path); return bytes ? digest(bytes) : "missing"; };
const feedPath = (scope: string) => join(dataDir(), `feed-${scope.replace(":", "_")}.jsonl`);
function stateHash(bots: BotPlan[], scope: string): string {
  return digest(JSON.stringify({ group: scope.startsWith("group:") ? getGroup(scope.slice(6)) : null, bots: bots.map(bot => ({
    name: bot.name, profile: getBot(bot.name), metadata: importMetadata(bot.name), soul: readSoul(bot.name), memory: readBotContext(bot.name),
    skills: bot.source.skills.map(skill => { const name = importedSkillName(bot.name, skill.name, skill.key); return [name, treeHash(skillFiles(name))]; }),
  })) }));
}
function classify(current: string, next: string, baseline?: string): Status {
  if (current === next || (baseline !== undefined && digest(next) === baseline)) return "unchanged";
  if (!current && baseline === undefined) return "new";
  return baseline !== undefined && digest(current) === baseline ? "update" : "conflict";
}
function additions(scope: string, source: string, values: ImportedMessage[], names: Map<string,string>, fallback: string): NewEvent[] {
  const existing = eventsAfter(scope, 0), keys = new Set(existing.flatMap(event => event.importKey ? [event.importKey] : []));
  const legacy = existing.filter(event => event.kind === "message" && event.stage === "imported" && !event.importKey);
  const consumed = new Set<number>(), result: NewEvent[] = [];
  for (const message of values) {
    const key = messageKey(source, message); if (keys.has(key)) continue;
    const from = message.role === "user" ? "user" : names.get(message.author || "") || (message.author ? `Imported: ${message.authorName || "bot"}` : fallback);
    const old = legacy.find(event => !consumed.has(event.seq) && event.from === from && event.text === message.text && (!message.at || event.at === message.at));
    if (old) { consumed.add(old.seq); continue; }
    keys.add(key); result.push({ kind: "message", from, text: message.text, at: message.at, stage: "imported", importKey: key });
  }
  return result;
}
export function createImportSync(roots: ImportRoots = {}, busy: (bots: string[], scopes: string[]) => boolean = () => false) {
  const sources = createImportSources(roots), pending = new Map<string, Plan>();
  function available(scope: string): boolean {
    validateScope(scope);
    return scope.startsWith("bot:") ? Boolean(getBot(scope.slice(4)) && importMetadata(scope.slice(4))?.source) : /^group:grok-[a-f0-9]{20}$/.test(scope) && Boolean(getGroup(scope.slice(6)));
  }
  function preview(scope: string) {
    validateScope(scope); if (!available(scope)) throw new InputError("This conversation was not imported", 409);
    sources.discover();
    const sourceId = scope.startsWith("bot:") ? importMetadata(scope.slice(4))!.source : scope.slice(11);
    const bundle = sources.load(sourceId, { history: true, memory: true, skills: true, routines: false });
    const names = new Map(listBots().flatMap(bot => { const meta = importMetadata(bot.name); return meta?.source ? [[meta.source, bot.name] as const] : []; }));
    const members = scope.startsWith("group:") ? getGroup(scope.slice(6))!.members : [scope.slice(4)];
    const bots: BotPlan[] = [], warnings = [...bundle.warnings];
    for (const source of bundle.bots) {
      const name = names.get(source.candidate.id);
      if (!name || !members.includes(name)) { warnings.push(`${source.candidate.name} is not a current imported member here; import it separately if needed.`); continue; }
      const metadata = importMetadata(name)!;
      const baseline: Baseline = structuredClone(metadata.baseline ?? { memory: "", soul: "", skills: {} });
      const changes: Change[] = [];
      for (const [kind, next, current, prior] of [
        ["memory", source.context, readBotContext(name), metadata.baseline?.memory],
        ["instructions", source.soul.trim() ? source.soul.endsWith("\n") ? source.soul : source.soul + "\n" : "", readSoul(name), metadata.baseline?.soul],
      ] as const) {
        if (!next) continue;
        changes.push({ bot: name, kind, status: classify(current, next, prior), sourceText: next, localText: current });
      }
      for (const skill of source.skills) {
        const alias = importedSkillName(name, skill.name, skill.key), files = skillFiles(alias), current = readInstalledSkill(alias, true);
        validateLearnedSkill({ name: alias, description: skill.description, body: skill.body });
        const incoming = skillSourceHash(skill), prior = metadata.baseline?.skills[alias];
        const sameContent = current && skillSourceHash({ ...skill, body: current.body, description: current.description, files: [...files].filter(([path]) => path !== "SKILL.md").map(([path, bytes]) => ({ path, bytes })) }) === incoming;
        const status: Status = sameContent || (prior?.source === incoming) ? "unchanged" : !files.size && !prior ? "new" : prior && treeHash(files) === prior.local ? "update" : "conflict";
        changes.push({ bot: name, kind: "skill", name: alias, status, sourceText: skill.body, localText: current?.body ?? "", files: skill.files.map(file => file.path) });
      }
      const attached = new Set([...getBot(name)!.skills, ...changes.filter(change => change.kind === "skill" && change.status === "new").map(change => change.name!)]);
      if (attached.size > 256) throw new InputError("This sync would exceed 256 attached skills. Detach unused skills first.", 409);
      bots.push({ name, source, metadata, baseline, changes });
    }
    const feeds = bots.map(bot => ({ scope: `bot:${bot.name}`, fingerprint: fileHash(feedPath(`bot:${bot.name}`)), events: additions(`bot:${bot.name}`, bot.source.candidate.id, bot.source.messages, names, bot.name) }));
    if (scope.startsWith("group:")) feeds.push({ scope, fingerprint: fileHash(feedPath(scope)), events: additions(scope, sourceId, bundle.messages, names, "Imported bot") });
    if (!bots.length) throw new InputError("No current imported members match this source", 409);
    const plan: Plan = { id: randomUUID(), scope, expires: Date.now() + 600000, bots, feeds, expected: stateHash(bots, scope), warnings: [...new Set(warnings)] };
    for (const [id, value] of pending) if (value.expires < Date.now()) pending.delete(id);
    if (pending.size >= 3) pending.delete(pending.keys().next().value!);
    pending.set(plan.id, plan);
    return { id: plan.id, scope, expiresAt: plan.expires, messages: feeds.reduce((sum, feed) => sum + feed.events.length, 0), changes: structuredClone(bots.flatMap(bot => bot.changes).filter(change => change.status !== "unchanged")), warnings: [...plan.warnings] };
  }
  function commit(id: string, replaceConflicts = false) {
    if (!/^[a-f0-9-]{36}$/.test(id) || typeof replaceConflicts !== "boolean") throw new InputError("Invalid sync request");
    const storage = lstatSync(join(dataDir(), "import-sync"), { throwIfNoEntry: false });
    if (storage && (!storage.isDirectory() || storage.isSymbolicLink())) throw new InputError("Unsafe sync receipt directory");
    const receipt = join(dataDir(), "import-sync", `${id}.json`), prior = readJson<unknown>(receipt, null); if (prior) return prior;
    const plan = pending.get(id); if (!plan || plan.expires < Date.now()) throw new InputError("Sync preview expired. Check the source again.", 409);
    const skillNames = new Set(plan.bots.flatMap(bot => bot.changes.filter(change => change.kind === "skill" && change.status !== "unchanged").map(change => change.name!)));
    const affected = new Set([...plan.bots.map(bot => bot.name), ...listBots().filter(bot => bot.skills.some(name => skillNames.has(name))).map(bot => bot.name)]);
    if (busy([...affected], plan.feeds.map(feed => feed.scope))) throw new InputError("Finish active work for these bots before syncing their source", 409);
    if (stateHash(plan.bots, plan.scope) !== plan.expected || plan.feeds.some(feed => fileHash(feedPath(feed.scope)) !== feed.fingerprint)) throw new InputError("Linubot changed after this preview. Check the source again.", 409);
    const backups = new Map<string, Buffer | undefined>(), skillBackups = new Map<string, Map<string,Buffer>>();
    let backupBytes = 0;
    const remember = (path: string) => { if (backups.has(path)) return; const bytes = fileBytes(path); backupBytes += bytes?.length ?? 0; if (backupBytes > 64 * 1024 * 1024) throw new InputError("This sync's local backup exceeds 64 MiB"); backups.set(path, bytes); };
    for (const bot of plan.bots) {
      for (const file of ["profile.json", "import.json", "SOUL.md", "imported-context.md"]) remember(join(dataDir(), "profiles", bot.name, file));
      for (const change of bot.changes) if (change.kind === "skill" && change.status !== "unchanged" && (change.status !== "conflict" || replaceConflicts)) {
        const files = skillFiles(change.name!); backupBytes += [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0); if (backupBytes > 64 * 1024 * 1024) throw new InputError("This sync's local backup exceeds 64 MiB"); skillBackups.set(change.name!, files);
      }
    }
    for (const feed of plan.feeds) if (feed.events.length) remember(feedPath(feed.scope));
    const emitted: { scope: string; events: FeedEvent[] }[] = []; let updated = 0, conflicts = 0;
    let result: { id: string; scope: string; messages: number; updated: number; conflicts: number; warnings: string[] };
    try {
      for (const bot of plan.bots) {
        const profile = getBot(bot.name)!;
        for (const change of bot.changes) {
          if (change.status === "conflict" && !replaceConflicts) { conflicts++; continue; }
          if (change.kind === "memory" || change.kind === "instructions") {
            if (change.status !== "unchanged") { if (change.kind === "memory") writeBotContext(bot.name, change.sourceText); else writeSoul(bot.name, change.sourceText); updated++; }
            bot.baseline[change.kind === "memory" ? "memory" : "soul"] = digest(change.sourceText);
          } else {
            const name = change.name!, skill = bot.source.skills.find(skill => importedSkillName(bot.name, skill.name, skill.key) === name)!;
            if (change.status !== "unchanged") {
              const current = readInstalledSkill(name, true), approve = change.status === "new" || current?.status === "approved" || profile.skills.includes(name);
              rmSync(join(dataDir(), "skills", name), { recursive: true, force: true });
              if (!saveLearnedSkill({ name, description: skill.description, body: skill.body })) throw new InputError("Sync skill could not be written", 409);
              for (const file of skill.files) { const path = join(dataDir(), "skills", name, file.path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, file.bytes, { flag: "wx", mode: 0o600 }); }
              if (approve) approveSkill(name);
              if (change.status === "new") profile.skills.push(name);
              updated++;
            }
            // Keep an old baseline if only the Linubot copy was edited.
            const priorSkill = bot.metadata.baseline?.skills[name];
            if (change.status !== "unchanged" || !priorSkill || priorSkill.local === treeHash(skillFiles(name))) bot.baseline.skills[name] = { source: skillSourceHash(skill), local: treeHash(skillFiles(name)) };
          }
        }
        const attached = [...new Set(profile.skills)];
        if (JSON.stringify(attached) !== JSON.stringify(getBot(bot.name)!.skills)) updateBot(bot.name, { skills: attached });
        writeJson(join(dataDir(), "profiles", bot.name, "import.json"), { ...bot.metadata, baseline: bot.baseline, syncedAt: new Date().toISOString() });
      }
      for (const feed of plan.feeds) if (feed.events.length) emitted.push({ scope: feed.scope, events: appendImportedEvents(feed.scope, feed.events) });
      result = { id, scope: plan.scope, messages: plan.feeds.reduce((sum, feed) => sum + feed.events.length, 0), updated, conflicts, warnings: plan.warnings };
      writeJson(receipt, result);
    } catch (error) {
      for (const [name, files] of skillBackups) { const root = join(dataDir(), "skills", name); rmSync(root, { recursive: true, force: true }); for (const [file, bytes] of files) { const path = join(root, file); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, bytes, { mode: 0o600 }); } }
      for (const [path, bytes] of backups) { if (bytes) writeFileSync(path, bytes); else rmSync(path, { force: true }); }
      for (const feed of plan.feeds) invalidateFeed(feed.scope);
      throw error;
    }
    pending.delete(id);
    for (const batch of emitted) for (const event of batch.events) bus.emit("event", batch.scope, event);
    return result;
  }
  return { available, preview, commit };
}
