import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createImportSources, importName, sourceId } from "./sources.ts";
import type { ImportRoots, ImportedMessage, SourceBundle } from "./sources.ts";
import { dataDir, readJson, writeJson } from "../store.ts";
import { createBot, getBot, listBots, validName, writeSoul, writeBotContext } from "../bots/manager.ts";
import { getProvider } from "../auth/store.ts";
import { saveLearnedSkill, validateLearnedSkill } from "../marketplace/search.ts";
import { addJob } from "../crons/scheduler.ts";
import { appendEvent } from "../events/log.ts";
import { listGroups } from "../chat/session.ts";
import { InputError } from "../errors.ts";

interface ImportOptions { sourceId: string; name?: string; providerId?: string; model?: string; memory?: boolean; skills?: boolean; history?: boolean; routines?: boolean }
interface ImportResult { id: string; scope: string; bots: string[]; skills: string[]; routines: string[]; messages: number; warnings: string[] }
interface Prepared { bundle: SourceBundle; options: ImportOptions; targets: { name: string; source: string; existing: boolean }[]; expires: number; providerId?: string; model: string; sourceKey: string; groupId?: string }
const uuid = /^[0-9a-f-]{36}$/;
function metadata(name: string) { return readJson<{ source?: string }>(join(dataDir(), "profiles", name, "import.json"), {}); }
function ensureDirectory(path: string) { const stat = lstatSync(path, { throwIfNoEntry: false }); if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new InputError("Unsafe import destination"); mkdirSync(path, { recursive: true, mode: 0o700 }); }
const skillName = (bot: string, name: string, key: string) => `${importName(`${bot}-${name}`).toLowerCase().replaceAll("_", "-").slice(0, 31)}-${sourceId(`${bot}:${key}:${name}`).slice(0, 8)}`;

export function createAgentImports(roots: ImportRoots = {}) {
  const sources = createImportSources(roots), pending = new Map<string, Prepared>();
  const directory = () => { const root = join(dataDir(), "imports"); ensureDirectory(root); return root; };
  function discover() {
    const result = sources.discover();
    const imported = new Map(listBots().map((bot) => [metadata(bot.name).source, bot.name]));
    return { ...result, candidates: result.candidates.map((candidate) => ({ ...candidate, importedAs: imported.get(candidate.id) })) };
  }
  function preview(options: ImportOptions) {
    if (!options || typeof options.sourceId !== "string") throw new InputError("Choose an import source");
    for (const key of ["memory", "skills", "history", "routines"] as const) if (options[key] !== undefined && typeof options[key] !== "boolean") throw new InputError(`Invalid import option: ${key}`);
    if (options.name !== undefined && !validName(options.name)) throw new InputError("Choose a name using up to 40 letters, digits, hyphens or underscores");
    const provider = getProvider(options.providerId);
    if (options.model !== undefined && typeof options.model !== "string") throw new InputError("Invalid import model");
    const model = options.model && options.model !== "default" ? options.model : provider.model;
    if (typeof model !== "string" || model.length > 200 || !model.trim() || model.trim() === "default") throw new InputError("Choose a provider and model for the imported bot");
    const bundle = sources.load(options.sourceId, { history: options.history !== false, skills: options.skills !== false, memory: options.memory !== false, routines: options.routines === true });
    const taken = new Set(listBots().map((bot) => bot.name));
    const targets = bundle.bots.map((bot) => {
      const existing = listBots().find((p) => metadata(p.name).source === bot.candidate.id);
      if (existing) return { name: existing.name, source: bot.candidate.id, existing: true };
      let name = !bundle.group && options.name ? options.name : importName(bot.candidate.name, bot.candidate.source === "hermes" ? "Hermes" : "Grok");
      if (!validName(name)) name = `Imported-${name}`.slice(0, 40);
      const base = name.slice(0, 33); let suffix = 1;
      while (taken.has(name) || existsSync(join(dataDir(), "profiles", name)) || existsSync(join(dataDir(), `feed-bot_${name}.jsonl`))) name = `${base}-${suffix++}`;
      taken.add(name); return { name, source: bot.candidate.id, existing: false };
    });
    for (const [index, bot] of bundle.bots.entries()) if (!targets[index].existing) for (const skill of bot.skills) validateLearnedSkill({ name: skillName(targets[index].name, skill.name, skill.key), description: skill.description, body: skill.body });
    for (const [id, entry] of pending) if (entry.expires < Date.now()) pending.delete(id);
    if (pending.size >= 3) pending.delete(pending.keys().next().value!);
    const id = randomUUID(), groupId = bundle.group ? `grok-${bundle.group.id}` : undefined;
    const existingGroup = groupId ? listGroups().find((group) => group.id === groupId) : undefined;
    if (existingGroup && [...existingGroup.members].sort().join("\n") !== targets.map((target) => target.name).sort().join("\n")) throw new InputError("This group was already imported with different members. Manage its membership in Linubot; importing does not replace an existing group.", 409);
    pending.set(id, { bundle, options: { ...options }, targets, expires: Date.now() + 10 * 60_000, providerId: options.providerId, model: options.model?.trim() || "default", sourceKey: options.sourceId, groupId });
    return { id, targets: targets.map((target) => ({ ...target })), group: bundle.group?.name, provider: { name: provider.name, id: provider.id, model, ready: Boolean(provider.apiKey) || provider.auth === "none" },
      bots: bundle.bots.map((bot, index) => ({ name: targets[index].name, originalName: bot.candidate.name, sourceModel: bot.model, sourceProvider: bot.provider, description: bot.candidate.description, soul: bot.soul,
        context: options.memory === false ? "" : bot.context, skills: bot.skills.map((skill) => ({ name: skill.name, description: skill.description, files: skill.files.length })), routines: options.routines ? bot.routines.map((routine) => ({ ...routine })) : [], messages: bot.messages.length })),
      groupMessages: bundle.messages.length, warnings: [...bundle.warnings], expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
  }
  function commit(id: string): ImportResult {
    if (!uuid.test(id)) throw new InputError("Invalid import preview");
    const prior = readJson<ImportResult | null>(join(directory(), `${id}.json`), null); if (prior) return prior;
    const entry = pending.get(id); if (!entry || entry.expires < Date.now()) throw new InputError("Import preview expired. Preview the source again.", 409);
    getProvider(entry.providerId);
    const { bundle, targets, options } = entry;
    const created: string[] = [], skills: string[] = [], routines: string[] = [], feeds: string[] = [];
    const sourceNames = new Map(targets.map((target) => [target.source, target.name]));
    for (const target of targets) if (target.existing && (!getBot(target.name) || metadata(target.name).source !== target.source)) throw new InputError("An existing import target changed. Preview the import again.", 409);
    for (const target of targets) if (!target.existing && (getBot(target.name) || existsSync(join(dataDir(), "profiles", target.name)) || existsSync(join(dataDir(), `feed-bot_${target.name}.jsonl`)))) throw new InputError("A target name became unavailable. Preview the import again.", 409);
    for (const path of [join(dataDir(), "profiles"), join(dataDir(), "skills")]) ensureDirectory(path);
    const backups = new Map<string, Buffer | undefined>();
    for (const name of ["groups.json", "jobs.json"]) { const path = join(dataDir(), name), stat = lstatSync(path, { throwIfNoEntry: false }); if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024)) throw new InputError("Unsafe import destination"); backups.set(path, stat ? readFileSync(path) : undefined); }
    let messages = 0;
    function importMessages(scope: string, values: ImportedMessage[], fallback: string) {
      const feed = join(dataDir(), `feed-${scope.replace(":", "_")}.jsonl`);
      if (existsSync(feed)) throw new InputError("An imported conversation already exists", 409);
      feeds.push(feed);
      appendEvent(scope, { kind: "notice", text: "Imported conversation history. Past tasks and approvals are historical records; no actions were restarted." });
      for (const message of values) {
        appendEvent(scope, { kind: "message", from: message.role === "user" ? "user" : sourceNames.get(message.author || "") || (message.author ? `Imported: ${message.authorName || "bot"}` : fallback), text: message.text, at: message.at, stage: "imported" }); messages++;
      }
    }
    try {
      for (const [index, source] of bundle.bots.entries()) {
        const target = targets[index]; if (target.existing) continue;
        createBot(target.name, { providerId: entry.providerId, model: entry.model, goal: source.candidate.description.slice(0, 4000) }); created.push(target.name);
        if (source.soul.trim()) writeSoul(target.name, source.soul);
        if (options.memory !== false && source.context) writeBotContext(target.name, source.context);
        importMessages(`bot:${target.name}`, source.messages, target.name);
        for (const skill of source.skills) {
          const name = skillName(target.name, skill.name, skill.key);
          if (existsSync(join(dataDir(), "skills", name))) throw new InputError("An imported skill name is already in use. Nothing was replaced.", 409);
          if (!saveLearnedSkill({ name, description: skill.description, body: skill.body })) throw new InputError("An imported skill already exists", 409);
          skills.push(name);
          for (const file of skill.files) { const path = join(dataDir(), "skills", name, file.path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, file.bytes, { flag: "wx", mode: 0o600 }); }
        }
        if (options.routines) for (const routine of source.routines) {
          const name = `${importName(`${target.name}-${routine.name}`).slice(0, 30)}-${sourceId(`${target.source}:${routine.name}`).slice(0, 8)}`;
          const jobs = readJson<{ name: string }[]>(join(dataDir(), "jobs.json"), []); if (jobs.some((job) => job.name === name)) throw new InputError("An imported routine name is already in use", 409);
          addJob({ name, bot: target.name, prompt: routine.prompt, schedule: routine.schedule, enabled: false }); routines.push(name);
        }
        writeJson(join(dataDir(), "profiles", target.name, "import.json"), { source: target.source, kind: source.candidate.source, originalName: source.candidate.name, sourceModel: source.model, sourceProvider: source.provider, importedAt: new Date().toISOString(), receipt: id, skills: source.skills.map((skill) => skillName(target.name, skill.name, skill.key)), warnings: source.warnings });
      }
      if (bundle.group && entry.groupId && !listGroups().some((group) => group.id === entry.groupId)) {
        if (existsSync(join(dataDir(), `feed-group_${entry.groupId}.jsonl`))) throw new InputError("An imported group conversation already exists", 409);
        writeJson(join(dataDir(), "groups.json"), [...listGroups(), { id: entry.groupId, name: bundle.group.name.slice(0, 80), members: targets.map((target) => target.name) }]);
        importMessages(`group:${entry.groupId}`, bundle.messages, targets[0].name);
      }
      const result: ImportResult = { id, scope: entry.groupId ? `group:${entry.groupId}` : `bot:${targets[0].name}`, bots: targets.map((target) => target.name), skills, routines, messages, warnings: bundle.warnings };
      writeJson(join(directory(), `${id}.json`), result); pending.delete(id); return result;
    } catch (error) {
      for (const [path, value] of backups) { if (value) writeFileSync(path, value); else rmSync(path, { force: true }); }
      for (const path of feeds) rmSync(path, { force: true });
      for (const name of skills) rmSync(join(dataDir(), "skills", name), { recursive: true, force: true });
      for (const name of created) rmSync(join(dataDir(), "profiles", name), { recursive: true, force: true });
      throw error;
    }
  }
  return { discover, preview, commit };
}
