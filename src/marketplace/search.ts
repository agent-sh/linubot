import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { dataDir } from "../store.ts";
import { InputError, requiredText } from "../errors.ts";

export type SkillSource = "local" | "learned" | "hermes" | "codex" | "muse";
export type SkillStatus = "draft" | "approved";

export interface Skill {
  name: string;
  description: string;
  body: string;
  status?: SkillStatus;
}

export interface InstalledSkill extends Skill {
  status: SkillStatus;
}

export interface SkillHit {
  name: string;
  source: SkillSource;
  path: string;
  description: string;
  status: SkillStatus;
}

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_BODY_LENGTH = 128 * 1024;
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
const discovered = new Map<string, { root: string; data: string }>();

export function readSkillFile(name: string, path: string): string {
  if (!readInstalledSkill(name)) throw new InputError("Skill must be approved before reading its supporting files", 409);
  if (!path || path.length > 500 || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) throw new InputError("Invalid skill file path");
  const root = realpathSync(join(skillsDir(), name));
  const target = join(root, path);
  if (!inside(root, target) || realpathSync(target) !== target) throw new InputError("Unsafe skill file path");
  return readBoundedFile(target, 128 * 1024).toString("utf8");
}

export function validSkillName(name: unknown): name is string {
  return typeof name === "string" && name === name.trim() && /^[a-z0-9][a-z0-9-]{0,39}$/.test(name) &&
    !["constructor", "prototype", "__proto__"].includes(name);
}

function checkName(name: unknown): asserts name is string {
  if (!validSkillName(name)) throw new InputError("invalid skill name");
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

function directory(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new InputError("unsafe skill directory");
  return true;
}

function skillsDir(): string {
  const path = join(realpathSync(dataDir()), "skills");
  directory(path);
  return path;
}

function readBoundedFile(path: string, limit: number): Buffer {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new InputError("unsafe skill file symlink");
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new InputError("unsafe or oversized skill file");
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > stat.size) throw new InputError("skill file changed while reading");
    return buffer.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

// Support flat string frontmatter and block descriptions, not YAML tags, aliases or objects.
function scalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch { /* invalid quoted scalar */ }
    throw new InputError("invalid skill frontmatter");
  }
  if (/^'(?:[^']|'')*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
  if (!value || /^[\[\]{}&*!|>'"%@`#?,:-]/.test(value) || /:\s|\s#|[\x00-\x1f]/.test(value) ||
      /^(?:null|true|false|~|[-+]?\d+(?:[.eE:_xob-][\w.+:-]*)?)$/i.test(value)) {
    throw new InputError("invalid skill frontmatter");
  }
  return value;
}

function parseSkill(raw: string, expectedName: string): { skill: InstalledSkill; fields: Map<string, string> } | null {
  const match = raw.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match || match[1].length > 8192) return null;
  try {
    const fields = new Map<string, string>();
    // The original demo writer left the colon in this generated description unquoted.
    const legacyDemo = match[1].match(/^name: ([a-z0-9][a-z0-9-]{0,39})\ndescription: (Demonstrated for [A-Za-z0-9][A-Za-z0-9_-]{0,39}: [^\n]+)$/);
    const header = legacyDemo && /\(demonstrated for [A-Za-z0-9][A-Za-z0-9_-]{0,39}\)/.test(match[2]) && /Review the screenshots, then rewrite this draft/.test(match[2])
      ? `name: ${JSON.stringify(legacyDemo[1])}\ndescription: ${JSON.stringify(legacyDemo[2])}\nstatus: "draft"`
      : match[1];
    const lines = header.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim() || lines[i].startsWith("#")) continue;
      const field = lines[i].match(/^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/);
      if (!field || fields.has(field[1])) return null;
      let value: string;
      if (field[1] === "description" && /^[>|][-+]?$/.test(field[2])) {
        const block: string[] = [];
        while (i + 1 < lines.length && /^(?: +.*|)$/.test(lines[i + 1])) block.push(lines[++i]);
        const indentation = Math.min(...block.filter((line) => line.trim()).map((line) => line.match(/^ */)![0].length));
        value = block.map((line) => line.slice(indentation)).join(field[2][0] === ">" ? " " : "\n").trim();
      } else {
        value = scalar(field[2]);
      }
      fields.set(field[1], value);
    }
    const name = fields.get("name");
    if (!validSkillName(name) || name !== expectedName) return null;
    const description = requiredText(fields.get("description"), "skill description", 2000);
    const body = requiredText(match[2], "skill body", MAX_BODY_LENGTH);
    const declared = fields.get("status");
    if (declared !== undefined && declared !== "draft" && declared !== "approved") return null;
    // Older demonstrations carried their draft label in the body rather than metadata.
    const status = declared ?? (/^#.*\bdraft\b|\brewrite this draft\b/im.test(body) ? "draft" : "approved");
    return { skill: { name, description, body, status }, fields };
  } catch (error) {
    if (error instanceof InputError) return null;
    throw error;
  }
}

function readDocument(dir: string, name: string): { raw: string; skill: InstalledSkill; fields: Map<string, string> } | null {
  if (!directory(dir)) return null;
  const path = join(dir, "SKILL.md");
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_BYTES) throw new InputError("unsafe or oversized skill file");
  const raw = readBoundedFile(path, MAX_SKILL_BYTES).toString("utf8");
  const parsed = parseSkill(raw, name);
  return parsed ? { ...parsed, raw } : null;
}

function bundleFiles(dir: string): Array<{ path: string; relative: string; mode: number; size: number }> {
  const files: Array<{ path: string; relative: string; mode: number; size: number }> = [];
  let bytes = 0;
  let count = 0;
  function visit(path: string, depth: number): void {
    if (depth > 8 || ++count > 256) throw new InputError("skill bundle has too many resources");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !inside(dir, realpathSync(path))) throw new InputError("skill bundle cannot contain symlinks");
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name), depth + 1);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > MAX_BUNDLE_BYTES) throw new InputError("skill bundle exceeds 10 MiB");
      files.push({ path, relative: relative(dir, path), mode: stat.mode & 0o111 ? 0o700 : 0o600, size: stat.size });
    } else {
      throw new InputError("skill bundle contains a non-regular file");
    }
  }
  visit(dir, 0);
  return files;
}

function formatSkill(skill: InstalledSkill, fields = new Map<string, string>()): string {
  const header = new Map(fields);
  header.set("name", skill.name);
  header.set("description", skill.description);
  header.set("status", skill.status);
  const frontmatter = [...header].map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  if (frontmatter.length > 8192) throw new InputError("skill frontmatter is too large");
  const raw = `---\n${frontmatter}\n---\n\n${skill.body}\n`;
  if (Buffer.byteLength(raw) > MAX_SKILL_BYTES) throw new InputError("oversized skill file");
  return raw;
}

export function validateLearnedSkill(value: Skill): InstalledSkill {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("skill must be an object");
  checkName(value.name);
  if (value.status !== undefined && value.status !== "draft") throw new InputError("save learned skills as draft; use approveSkill after review");
  const skill: InstalledSkill = {
    name: value.name,
    description: requiredText(value.description, "skill description", 2000),
    body: requiredText(value.body, "skill body", MAX_BODY_LENGTH),
    status: "draft",
  };
  formatSkill(skill);
  return skill;
}

export function saveLearnedSkill(value: Skill): boolean {
  const skill = validateLearnedSkill(value);
  const root = skillsDir();
  const dest = join(root, skill.name);
  if (directory(dest)) {
    if (readDocument(dest, skill.name)) return false;
    throw new InputError(`skill directory already exists: ${skill.name}`, 409);
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(dest, { mode: 0o700 });
  writeFileSync(join(dest, "SKILL.md"), formatSkill(skill), { flag: "wx", mode: 0o600 });
  return true;
}

export function searchSkills(localDir: string, query: string): SkillHit[] {
  const local = requiredText(localDir, "local skills directory", 4096);
  if (local.includes("\0")) throw new InputError("invalid local skills directory");
  if (typeof query !== "string" || query.length > 2000) throw new InputError("skill query must be at most 2000 characters");
  const home = homedir();
  const data = realpathSync(dataDir());
  const hits: SkillHit[] = [];
  discovered.clear();
  const roots: Array<[string, SkillSource]> = [
    [local, "local"],
    [skillsDir(), "learned"],
    [join(home, ".hermes", "skills"), "hermes"],
    [join(home, ".codex", "skills"), "codex"],
    [join(home, ".local", "share", "muse", "skills"), "muse"],
  ];
  for (const [path, source] of roots) {
    let root: string;
    try { root = realpathSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!directory(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validSkillName(entry.name)) continue;
      const dir = join(root, entry.name);
      try {
        const document = readDocument(dir, entry.name);
        if (!document) continue;
        bundleFiles(dir);
        const file = realpathSync(join(dir, "SKILL.md"));
        if (!inside(root, file)) continue;
        hits.push({ name: entry.name, source, path: file, description: document.skill.description, status: document.skill.status });
        discovered.set(file, { root, data });
      } catch (error) {
        if (error instanceof InputError || (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
  }
  const deduped = [...new Map(hits.map((hit) => [`${hit.source}:${hit.name}`, hit])).values()];
  const q = query.toLowerCase().trim();
  return deduped.filter((hit) => !q || hit.name.includes(q) || hit.description.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function installSkill(name: string, fromPath: string): string {
  checkName(name);
  const source = requiredText(fromPath, "skill source", 4096);
  if (source.includes("\0")) throw new InputError("invalid skill source");
  const path = resolve(source);
  const approved = discovered.get(path);
  if (!approved || approved.data !== realpathSync(dataDir()) || basename(path) !== "SKILL.md" || basename(dirname(path)) !== name) {
    throw new InputError("skill source must be an approved discovery result");
  }
  try {
    if (!directory(approved.root) || realpathSync(approved.root) !== approved.root || !inside(approved.root, realpathSync(path))) {
      throw new InputError("skill source escaped its discovery root");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new InputError("skill source is no longer available", 404);
    throw error;
  }
  const document = readDocument(dirname(path), name);
  if (!document) throw new InputError("invalid skill frontmatter or name mismatch");
  const files = bundleFiles(dirname(path));
  const root = skillsDir();
  const dest = join(root, name);
  if (directory(dest)) throw new InputError(`already installed: ${name}`, 409);
  const raw = formatSkill(document.skill, document.fields);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temporary = join(root, `.${name}.${randomUUID()}.tmp`);
  mkdirSync(temporary, { mode: 0o700 });
  try {
    let bytes = 0;
    for (const file of files) {
      const target = join(temporary, file.relative);
      const content = file.relative === "SKILL.md" ? Buffer.from(raw) : readBoundedFile(file.path, file.size);
      bytes += content.byteLength;
      if (bytes > MAX_BUNDLE_BYTES) throw new InputError("skill bundle exceeds 10 MiB");
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, content, { flag: "wx", mode: file.relative === "SKILL.md" ? 0o600 : file.mode });
    }
    renameSync(temporary, dest);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return join(dest, "SKILL.md");
}

/** Drafts are visible only to explicit review callers, never to the default runtime loader. */
export function validateSkillDirectory(dir: string, name: string): InstalledSkill {
  checkName(name);
  const document = readDocument(dir, name);
  if (!document) throw new InputError("Invalid or empty skill instructions");
  bundleFiles(dir);
  return document.skill;
}

export function readInstalledSkill(name: string, includeDraft = false): InstalledSkill | null {
  checkName(name);
  if (typeof includeDraft !== "boolean") throw new InputError("includeDraft must be a boolean");
  const dir = join(skillsDir(), name);
  const document = readDocument(dir, name);
  if (!document || (!includeDraft && document.skill.status !== "approved")) return null;
  bundleFiles(dir);
  return document.skill;
}

export function listInstalledSkills(includeDraft = false): InstalledSkill[] {
  if (typeof includeDraft !== "boolean") throw new InputError("includeDraft must be a boolean");
  const root = skillsDir();
  if (!directory(root)) return [];
  const skills: InstalledSkill[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !validSkillName(entry.name)) continue;
    try {
      const skill = readInstalledSkill(entry.name, includeDraft);
      if (skill) skills.push(skill);
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkillBody(name: string): string {
  checkName(name);
  const dir = join(skillsDir(), name);
  const document = readDocument(dir, name);
  if (!document) throw new InputError(`not installed or invalid: ${name}`, 404);
  bundleFiles(dir);
  return document.raw;
}

export function approveSkill(name: string): InstalledSkill {
  checkName(name);
  const dir = join(skillsDir(), name);
  const document = readDocument(dir, name);
  if (!document) throw new InputError(`not installed or invalid: ${name}`, 404);
  bundleFiles(dir);
  const skill: InstalledSkill = { ...document.skill, status: "approved" };
  const temporary = join(dir, `.SKILL.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, formatSkill(skill, document.fields), { flag: "wx", mode: 0o600 });
    renameSync(temporary, join(dir, "SKILL.md"));
  } finally {
    rmSync(temporary, { force: true });
  }
  return skill;
}
