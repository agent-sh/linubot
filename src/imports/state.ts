import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { dataDir, readJson } from "../store.ts";
import { InputError } from "../errors.ts";
import { importName, sourceId, type ImportedMessage, type ImportedSkill, type SourceBot } from "./sources.ts";
import { readBotContext, readSoul } from "../bots/manager.ts";
export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const importedSkillName = (bot: string, name: string, key: string) => `${importName(`${bot}-${name}`).toLowerCase().replaceAll("_", "-").slice(0, 31)}-${sourceId(`${bot}:${key}:${name}`).slice(0, 8)}`;
export interface Baseline { memory: string; soul: string; skills: Record<string, { source: string; local: string }> }
export interface ImportMetadata { source: string; skills?: string[]; baseline?: Baseline; syncedAt?: string; [key: string]: unknown }
export function importMetadata(name: string): ImportMetadata | undefined { return readJson<ImportMetadata | undefined>(join(dataDir(), "profiles", name, "import.json"), undefined); }
export function skillFiles(name: string): Map<string, Buffer> {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) throw new InputError("Invalid imported skill name");
  const parent = lstatSync(join(dataDir(), "skills"), { throwIfNoEntry: false });
  if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) throw new InputError("Unsafe skill library directory");
  const root = join(dataDir(), "skills", name), files = new Map<string, Buffer>(); let total = 0;
  function walk(path: string, depth: number) {
    const stat = lstatSync(path, { throwIfNoEntry: false }); if (!stat) return;
    if (stat.isSymbolicLink() || depth > 9) throw new InputError("Unsafe imported skill destination");
    if (stat.isDirectory()) for (const entry of readdirSync(path)) walk(join(path, entry), depth + 1);
    else if (stat.isFile()) { total += stat.size; if (stat.size > 2 * 1024 * 1024 || total > 24 * 1024 * 1024 || files.size > 256) throw new InputError("Imported skill destination is too large"); files.set(relative(root, path), readFileSync(path)); }
    else throw new InputError("Unsupported imported skill destination");
  }
  walk(root, 0); return files;
}
export function treeHash(files: Map<string, Buffer>): string { return digest(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, digest(bytes)]))); }
export function skillSourceHash(skill: ImportedSkill): string { return digest(JSON.stringify({ body: skill.body, description: skill.description, files: [...skill.files].sort((a,b)=>a.path.localeCompare(b.path)).map(file=>[file.path,digest(file.bytes)]) })); }
export function captureBaseline(bot: string, source: SourceBot): Baseline {
  return { memory: digest(readBotContext(bot)), soul: digest(readSoul(bot)), skills: Object.fromEntries(source.skills.map(skill => { const name = importedSkillName(bot, skill.name, skill.key); return [name, { source: skillSourceHash(skill), local: treeHash(skillFiles(name)) }]; })) };
}
export function messageKey(source: string, message: ImportedMessage): string { return digest(JSON.stringify([source, message.key ?? "", message.role, message.text, message.at ?? "", message.author ?? ""])); }
