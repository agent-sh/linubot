import { assertBrowserIdle, forgetBrowserProfiles } from "../computer/profiles.ts";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir, readJson, writeJson } from "../store.ts";
import { lastSeq, tailEvents } from "../events/log.ts";
import { InputError, requiredText, textList } from "../errors.ts";
import { readInstalledSkill, validSkillName } from "../marketplace/search.ts";

export interface BotProfile {
  name: string;
  model: string;
  providerId?: string;
  skills: string[];
  topic: string | null;
  goal?: string;
  mascotSeed?: string;
  color: string;
  pinned: boolean;
  createdAt: string;
}

export interface Section {
  name: string;
  bots: string[];
}

const COLORS = ["#0f766e", "#1d4ed8", "#b45309", "#be123c", "#4d7c0f", "#0e7490", "#7c3aed", "#374151"];
const MAX_SOUL_BYTES = 128 * 1024;
const MAX_IMPORTED_CONTEXT_BYTES = 256 * 1024;

function directory(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new InputError("unsafe bot directory");
  return true;
}

function storedFile(path: string, maxBytes = 1024 * 1024): string {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)) throw new InputError("unsafe or oversized bot data file");
  return path;
}

function profilesDir(): string {
  const path = join(realpathSync(dataDir()), "profiles");
  directory(path);
  return path;
}

function botDir(name: string): string {
  if (!validName(name)) throw new InputError("invalid bot name");
  const path = join(profilesDir(), name);
  directory(path);
  return path;
}

export function validName(name: unknown): name is string {
  return typeof name === "string" && name === name.trim() && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(name) &&
    !["__proto__", "constructor", "prototype"].includes(name.toLowerCase());
}

function optionalText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new InputError(`${label} must be text of at most ${max} characters`);
  return value.trim();
}

export function colorFor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export function defaultSoul(name: string): string {
  return `You are ${name}, a friendly linubot helper. Speak naturally, warmly and simply. Be direct and useful. Admit uncertainty. Prefer finished work over long explanations. Use only the tools and approved skills actually available in this turn. Do not claim research or actions you have not performed.\n`;
}

export function draftSoul(name: string, topic: string): string {
  return (
    defaultSoul(name).trimEnd() + ` Your focus is ${topic}. Ground advice in the user's context and verified evidence, not assumed expertise.\n`
  );
}

export function inferSpecialty(name: string): string | null {
  const n = name.toLowerCase();
  const table: Array<[RegExp, string]> = [
    [/sell|seller|sales|growth|marketing/, "sales and marketing"],
    [/code|coder|dev|debug|engineer|program/, "software engineering"],
    [/research|scout|intel|analyst/, "deep research"],
    [/writ|copy|editor|blog|docs/, "writing and editing"],
    [/trade|trader|crypto|market|invest/, "markets and trading"],
    [/data|ml|ai|model|train/, "data and machine learning"],
    [/design|ui|ux|style|brand/, "product design"],
    [/ops|deploy|infra|sysadmin|server/, "operations and infrastructure"],
    [/support|help|care|service/, "customer support"],
    [/legal|contract|policy|compliance/, "legal and policy review"],
    [/financ|account|budget|tax|invoice/, "finance and accounting"],
    [/chef|cook|recipe|food/, "cooking"],
    [/fit|gym|health|coach/, "health and fitness coaching"],
    [/travel|trip|flight|hotel/, "travel planning"],
    [/music|dj|song|audio/, "music"],
  ];
  for (const [re, topic] of table) {
    if (re.test(n)) return topic;
  }
  return null;
}

export type ResearchFn = (topic: string) => Promise<string[]>;

export interface BotOptions {
  model?: string;
  providerId?: string | null;
  topic?: string | null;
  goal?: string;
  mascotSeed?: string;
}

function mascotSeed(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value)) throw new InputError("Invalid mascot seed");
  return value;
}

export function createBot(name: string, opts?: BotOptions): BotProfile {
  if (!validName(name)) throw new InputError("invalid bot name");
  if (opts !== undefined && (!opts || typeof opts !== "object" || Array.isArray(opts))) throw new InputError("bot options must be an object");
  const model = requiredText(opts?.model === undefined ? "default" : opts.model, "model", 200);
  const topic = opts?.topic === undefined ? inferSpecialty(name) : opts.topic === null ? null : optionalText(opts.topic, "topic", 2000) || null;
  const goal = opts?.goal === undefined ? undefined : optionalText(opts.goal, "goal", 4000) || undefined;
  const appearance = opts?.mascotSeed === undefined ? randomUUID() : mascotSeed(opts.mascotSeed);
  const existing = getBot(name);
  if (existing) return existing;
  const dir = botDir(name);
  if (directory(dir)) throw new InputError(`bot directory already exists: ${name}`, 409);
  mkdirSync(profilesDir(), { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 });
  const profile: BotProfile = {
    name,
    model,
    ...(opts?.providerId ? { providerId: requiredText(opts.providerId, "Provider connection", 80) } : {}),
    skills: [],
    topic,
    ...(goal ? { goal } : {}),
    color: colorFor(name),
    mascotSeed: appearance,
    pinned: false,
    createdAt: new Date().toISOString(),
  };
  writeJson(join(dir, "profile.json"), profile);
  writeSoul(name, topic ? draftSoul(name, topic) : defaultSoul(name));
  return profile;
}

/** Get or create a bot. Only an explicit research callback can supply research notes. */
export async function ensureBot(name: string, research?: ResearchFn, opts?: BotOptions): Promise<BotProfile> {
  if (!validName(name)) throw new InputError("invalid bot name");
  if (research !== undefined && typeof research !== "function") throw new InputError("research must be a function");
  const existing = getBot(name);
  if (existing) return existing;
  const profile = createBot(name, opts);
  if (profile.topic && research) appendSoul(name, await research(profile.topic));
  return profile;
}

export function getBot(name: string): BotProfile | null {
  const path = storedFile(join(botDir(name), "profile.json"), 64 * 1024);
  const p = readJson<Partial<BotProfile> | undefined>(path, undefined);
  if (p === undefined) return null;
  if (!p || typeof p !== "object" || Array.isArray(p) || p.name !== name) throw new Error(`invalid stored bot profile: ${name}`);
  const skills = textList(p.skills === undefined ? [] : p.skills, "skills", 256, 40);
  if (skills.some((skill) => !validSkillName(skill))) throw new InputError("invalid skill name in bot profile");
  if (p.pinned !== undefined && typeof p.pinned !== "boolean") throw new InputError("pinned must be a boolean");
  if (p.color !== undefined && (typeof p.color !== "string" || !/^#[0-9a-f]{6}$/i.test(p.color))) throw new Error(`invalid stored bot color: ${name}`);
  if (p.createdAt !== undefined && (typeof p.createdAt !== "string" || p.createdAt.length > 40 || !Number.isFinite(Date.parse(p.createdAt)))) throw new Error(`invalid stored bot date: ${name}`);
  const goal = p.goal === undefined ? undefined : optionalText(p.goal, "goal", 4000) || undefined;
  return {
    name,
    model: requiredText(p.model === undefined ? "default" : p.model, "model", 200),
    skills,
    topic: p.topic === undefined || p.topic === null ? null : optionalText(p.topic, "topic", 2000) || null,
    ...(goal ? { goal } : {}),
    color: p.color ?? colorFor(name),
    ...(p.mascotSeed === undefined ? {} : { mascotSeed: mascotSeed(p.mascotSeed) }),
    ...(p.providerId ? { providerId: requiredText(p.providerId, "Provider connection", 80) } : {}),
    pinned: p.pinned ?? false,
    createdAt: p.createdAt ?? lstatSync(path).mtime.toISOString(),
  };
}

export interface RosterEntry extends BotProfile {
  preview: string;
  unread: number;
  state: "idle" | "working";
}

export function listBots(running?: Set<string>): BotProfile[] {
  const root = profilesDir();
  if (!directory(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && validName(d.name))
    .map((d) => getBot(d.name))
    .filter((p): p is BotProfile => p !== null)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
}

export function updateBot(name: string, patch: BotOptions & { skills?: string[]; pinned?: boolean }): BotProfile {
  const profile = getBot(name);
  if (!profile) throw new InputError(`unknown bot: ${name}`, 404);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new InputError("bot patch must be an object");
  if (patch.model !== undefined) profile.model = requiredText(patch.model, "model", 200);
  if (patch.providerId === null) delete profile.providerId;
  else if (patch.providerId !== undefined) profile.providerId = requiredText(patch.providerId, "Provider connection", 80);
  if (patch.mascotSeed !== undefined) profile.mascotSeed = mascotSeed(patch.mascotSeed);
  if (patch.skills !== undefined) {
    const skills = textList(patch.skills, "skills", 256, 40);
    for (const skill of skills) {
      if (!validSkillName(skill)) throw new InputError("invalid skill name");
      if (!readInstalledSkill(skill)) throw new InputError(`skill is not installed and approved: ${skill}`);
    }
    profile.skills = skills;
  }
  if (patch.pinned !== undefined) {
    if (typeof patch.pinned !== "boolean") throw new InputError("pinned must be a boolean");
    profile.pinned = patch.pinned;
  }
  if (patch.topic !== undefined) profile.topic = patch.topic === null ? null : optionalText(patch.topic, "topic", 2000) || null;
  if (patch.goal !== undefined) {
    const goal = optionalText(patch.goal, "goal", 4000);
    if (goal) profile.goal = goal;
    else delete profile.goal;
  }
  writeJson(join(botDir(name), "profile.json"), profile);
  return profile;
}

function deletionReferences(name: string) {
  const groups = readJson<Array<{ id: string; name?: string; members: string[] }>>(storedFile(join(dataDir(), "groups.json")), []);
  const jobs = readJson<Array<{ name: string; bot: string; deliver?: string }>>(storedFile(join(dataDir(), "jobs.json")), []);
  if (!Array.isArray(groups) || !groups.every((group) => group && typeof group.id === "string" && Array.isArray(group.members) && group.members.every(validName))) throw new Error("cannot delete bot: invalid stored groups");
  if (!Array.isArray(jobs) || !jobs.every((job) => job && typeof job.name === "string" && validName(job.bot) && (job.deliver === undefined || typeof job.deliver === "string"))) throw new Error("cannot delete bot: invalid stored jobs");
  const emptyGroups = groups.filter((group) => group.members.includes(name) && group.members.every((member) => member === name)).map((group) => group.id);
  const affected = (job: typeof jobs[number]) => job.bot === name || job.deliver?.trim() === `bot:${name}` || emptyGroups.some((id) => job.deliver?.trim() === `group:${id}`);
  return { groups, jobs, emptyGroups, affected };
}
export function botDeletionPreview(name: string) {
  if (!getBot(name)) throw new InputError("Bot not found", 404);
  const { groups, jobs, emptyGroups, affected } = deletionReferences(name);
  return { groups: groups.filter((group) => group.members.includes(name)).map((group) => ({ id: group.id, name: group.name || group.id })), routines: jobs.filter(affected).map((job) => ({ name: job.name })), emptyGroups };
}
export function deleteBot(name: string, options: { detachReferences?: boolean } = {}): boolean {
  const dir = botDir(name);
  if (!getBot(name)) return false;
  const { groups, jobs, affected } = deletionReferences(name);
  const references = groups.some((group) => group.members.includes(name)) || jobs.some(affected);
  if (references && !options.detachReferences) throw new InputError(`bot is referenced by a group or job: ${name}`, 409);
  assertBrowserIdle(`bot:${name}`);
  for (const group of groups) if (group.members.length === 1 && group.members[0] === name) assertBrowserIdle(`group:${group.id}`);
  const sections = listSections();
  const updated = sections.map((section) => ({ ...section, bots: section.bots.filter((bot) => bot !== name) }));
  if (references) {
    writeJson(join(dataDir(), "groups.json"), groups.map((group) => ({ ...group, members: group.members.filter((member) => member !== name) })).filter((group) => group.members.length));
    writeJson(join(dataDir(), "jobs.json"), jobs.filter((job) => !affected(job)));
  }
  if (sections.some((section, i) => section.bots.length !== updated[i].bots.length)) writeJson(join(dataDir(), "sections.json"), updated);
  forgetBrowserProfiles(`bot:${name}`);
  for (const group of groups) if (group.members.length === 1 && group.members[0] === name) forgetBrowserProfiles(`group:${group.id}`);
  rmSync(dir, { recursive: true });
  return true;
}

export function readSoul(name: string): string {
  const path = storedFile(join(botDir(name), "SOUL.md"), MAX_SOUL_BYTES);
  try {
    const soul = readFileSync(path, "utf8");
    if (Buffer.byteLength(soul) > MAX_SOUL_BYTES) throw new InputError("soul is too large");
    return soul;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export function readBotContext(name: string): string {
  const path = storedFile(join(botDir(name), "imported-context.md"), MAX_IMPORTED_CONTEXT_BYTES);
  try { return readFileSync(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}
export function writeBotContext(name: string, value: string): void {
  if (!getBot(name)) throw new InputError("Unknown bot", 404);
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_IMPORTED_CONTEXT_BYTES) throw new InputError("Imported context must be at most 256 KiB");
  const path = storedFile(join(botDir(name), "imported-context.md"), MAX_IMPORTED_CONTEXT_BYTES), temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, value, { flag: "wx", mode: 0o600 }); renameSync(temporary, path); } finally { rmSync(temporary, { force: true }); }
}

export function writeSoul(name: string, soul: string): void {
  if (!getBot(name)) throw new InputError(`unknown bot: ${name}`, 404);
  if (typeof soul !== "string" || soul.length > MAX_SOUL_BYTES) throw new InputError("soul must be text of at most 128 KiB");
  const text = soul.endsWith("\n") ? soul : soul + "\n";
  if (Buffer.byteLength(text) > MAX_SOUL_BYTES) throw new InputError("soul must be text of at most 128 KiB");
  const path = storedFile(join(botDir(name), "SOUL.md"), MAX_SOUL_BYTES);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const SEP = "\n§\n";

export function appendSoul(name: string, lines: string[]): string[] {
  if (!getBot(name)) throw new InputError(`unknown bot: ${name}`, 404);
  const values = textList(lines, "soul lines", 50, 4000);
  if (values.some((line) => line.includes(SEP))) throw new InputError("soul lines cannot contain the entry separator");
  const current = readSoul(name).split(SEP).map((s) => s.trim()).filter(Boolean);
  const known = new Set(current.map((s) => s.toLowerCase()));
  const fresh = values.filter((line) => {
    const key = line.toLowerCase();
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
  if (fresh.length === 0) return [];
  writeSoul(name, [...current, ...fresh].join(SEP) + "\n");
  return fresh;
}

// Sections: named roster groups, everything else lands in Unassigned.
export function listSections(): Section[] {
  return validateSections(readJson<Section[]>(storedFile(join(dataDir(), "sections.json")), []));
}

function validateSections(sections: Section[]): Section[] {
  if (!Array.isArray(sections) || sections.length > 100) throw new InputError("sections must be a list of at most 100 items");
  const names = new Set<string>();
  return sections.map((section) => {
    if (!section || typeof section !== "object") throw new InputError("section must be an object");
    const name = requiredText(section.name, "section name", 40);
    if (names.has(name.toLowerCase())) throw new InputError(`duplicate section: ${name}`, 409);
    names.add(name.toLowerCase());
    const bots = textList(section.bots, "section bots", 200, 40);
    if (bots.some((bot) => !validName(bot))) throw new InputError("invalid bot name in section");
    return { name, bots };
  });
}

export function saveSections(sections: Section[]): Section[] {
  const validated = validateSections(sections);
  writeJson(join(dataDir(), "sections.json"), validated);
  return validated;
}

// Unread: per-scope last-read sequence.
function checkScope(scope: string): void {
  if (typeof scope !== "string" || !/^(bot|group):/.test(scope) || !validName(scope.slice(scope.indexOf(":") + 1))) throw new InputError("invalid scope");
}

export function lastRead(scope: string): number {
  checkScope(scope);
  const all = readJson<Record<string, number>>(storedFile(join(dataDir(), "unread.json")), {});
  if (!all || typeof all !== "object" || Array.isArray(all)) throw new Error("invalid stored unread state");
  const seq = Object.hasOwn(all, scope) ? all[scope] : 0;
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("invalid stored unread sequence");
  return seq;
}

export function markRead(scope: string, seq?: number): void {
  checkScope(scope);
  if (seq !== undefined && (!Number.isSafeInteger(seq) || seq < 0)) throw new InputError("read sequence must be a nonnegative integer");
  const all = readJson<Record<string, number>>(storedFile(join(dataDir(), "unread.json")), {});
  if (!all || typeof all !== "object" || Array.isArray(all)) throw new Error("invalid stored unread state");
  all[scope] = seq ?? lastSeq(scope);
  writeJson(join(dataDir(), "unread.json"), all);
}

const UNREAD_KINDS = new Set(["message", "handoff", "file", "approval"]);

/** Unread means something arrived for you to read, not bookkeeping events you caused. */
export function unreadCount(scope: string): number {
  checkScope(scope);
  const pending = lastSeq(scope) - lastRead(scope);
  if (pending <= 0) return 0;
  return tailEvents(scope, pending).entries
    .filter((e) => UNREAD_KINDS.has(e.kind) && e.from !== "user")
    .length;
}
