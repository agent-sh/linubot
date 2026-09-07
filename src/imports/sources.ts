import { dataDir, readJson, writeJson } from "../store.ts";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parseDocument } from "yaml";
import { InputError } from "../errors.ts";
import { normalizeSchedule } from "../crons/scheduler.ts";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown, max = 100000) => typeof value === "string" ? value.slice(0, max) : "";
export const sourceId = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 20);
export function importName(value: string, fallback = "Imported"): string { return value.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 32) || fallback; }
export interface ImportCandidate { id: string; source: "hermes" | "grok"; name: string; description: string; kind: "bot" | "group"; location: string; exported?: boolean }
interface SourceRef extends ImportCandidate { root: string; row?: RecordValue; account?: string; members?: string[] }
export interface ImportedMessage { role: "user" | "assistant"; text: string; at?: string; author?: string; authorName?: string }
export interface ImportedSkill { key: string; name: string; description: string; body: string; files: { path: string; bytes: Buffer }[] }
export interface ImportedRoutine { name: string; schedule: string; prompt: string }
export interface SourceBot { candidate: ImportCandidate; soul: string; context: string; model: string; provider: string; skills: ImportedSkill[]; routines: ImportedRoutine[]; messages: ImportedMessage[]; warnings: string[] }
export interface SourceBundle { bots: SourceBot[]; group?: ImportCandidate; messages: ImportedMessage[]; warnings: string[] }
export interface ImportRoots { hermes?: string; grok?: string }

function folder(path: string): boolean { const s = lstatSync(path, { throwIfNoEntry: false }); return Boolean(s?.isDirectory() && !s.isSymbolicLink()); }
function bytes(root: string, path: string, max = 1024 * 1024): Buffer | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false }); if (!stat) return;
  const rel = relative(realpathSync(root), realpathSync(dirname(path)));
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("/")) throw new InputError("Import source escaped its folder");
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new InputError(`Unsupported or oversized source file: ${basename(path)}`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const current = fstatSync(fd); if (!current.isFile() || current.size > max) throw new InputError("Import source changed while being read"); const value = readFileSync(fd); if (value.length > max) throw new InputError("Import source is too large"); return value; }
  finally { closeSync(fd); }
}
function json(root: string, path: string, max?: number): RecordValue { const value = bytes(root, path, max); if (!value) return {}; try { return object(JSON.parse(value.toString("utf8"))); } catch { throw new InputError(`Invalid JSON in ${basename(path)}`); } }
function yaml(value: string): RecordValue { const document = parseDocument(value, { schema: "core", uniqueKeys: true }); if (document.errors.length) throw new InputError("Invalid YAML in import source"); return object(document.toJS({ maxAliasCount: 30 })); }
function content(value: unknown): string {
  if (typeof value === "string") { if (/^\s*\[/.test(value)) { try { return content(JSON.parse(value)); } catch { /* Ordinary message text can start with a bracket. */ } } return value; }
  if (Array.isArray(value)) return value.filter((v) => ["text", "input_text", "output_text"].includes(String(object(v).type))).map((v) => text(object(v).text)).join("\n");
  return "";
}
function timestamp(value: unknown): string | undefined { const n = typeof value === "number" ? value < 1e12 ? value * 1000 : value : Date.parse(String(value)); return Number.isFinite(n) && n > 0 && n < 8640000000000000 ? new Date(n).toISOString() : undefined; }
function decodeKey(name: string): string {
  if (!/^[a-z2-7]+\.blob$/.test(name) || name.length > 1000) return "";
  let bits = 0, buffer = 0; const output: number[] = [];
  for (const c of name.slice(0, -5)) { buffer = (buffer << 5) | "abcdefghijklmnopqrstuvwxyz234567".indexOf(c); bits += 5; if (bits >= 8) { bits -= 8; output.push((buffer >> bits) & 255); } }
  return Buffer.from(output).toString("utf8");
}

export function createImportSources(roots: ImportRoots = {}) {
  const hermes = resolve(roots.hermes || process.env.HERMES_HOME || join(homedir(), ".hermes"));
  const grok = resolve(roots.grok || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Grok Bot", "sand-client-persistence"));
  const refs = new Map<string, SourceRef>(), blobs = new Map<string, string>();
  function discover() {
    refs.clear(); blobs.clear(); const warnings: string[] = [];
    if (folder(hermes)) {
      const profiles = [hermes]; const extra = join(hermes, "profiles");
      if (folder(extra)) for (const entry of readdirSync(extra, { withFileTypes: true }).slice(0, 100)) if (entry.isDirectory() && !entry.isSymbolicLink()) profiles.push(join(extra, entry.name));
      for (const root of profiles) if (lstatSync(join(root, "SOUL.md"), { throwIfNoEntry: false }) || lstatSync(join(root, "config.yaml"), { throwIfNoEntry: false })) {
        const name = root === hermes ? "Hermes" : basename(root), id = sourceId(`hermes:${root}`);
        refs.set(id, { id, source: "hermes", name, description: root === hermes ? "Default Hermes profile" : "Hermes profile", kind: "bot", root, location: root });
      }
    }
    if (folder(grok)) {
      const entries = readdirSync(grok); if (entries.length > 10000) warnings.push("Grok Bot cache discovery is limited to 10,000 files.");
      for (const entry of entries.slice(0, 10000)) { const key = decodeKey(entry); if (key) blobs.set(key, join(grok, entry)); }
      for (const [key, file] of blobs) if (key.endsWith(".roster.last-roster")) {
        try {
          const document = json(grok, file, 8 * 1024 * 1024); if (document.schemaVersion !== 3) { warnings.push("An unsupported Grok Bot roster cache was skipped."); continue; }
          const rows = object(document.value).rows; if (!Array.isArray(rows)) continue;
          const account = key.slice(0, -".roster.last-roster".length);
          for (const value of rows.slice(0, 500)) {
            const row = object(value), original = text(row.id, 100); if (!original || !text(row.name)) continue;
            const id = sourceId(`${account}:${original}`);
            refs.set(id, { id, source: "grok", name: text(row.name, 200), description: text(row.description, 2000), kind: row.isGroup === true ? "group" : "bot", location: grok, root: grok, row, account,
              members: Array.isArray(row.memberIds) ? row.memberIds.filter((m): m is string => typeof m === "string").map((m) => sourceId(`${account}:${m}`)) : [] });
          }
        } catch (error) { warnings.push(error instanceof Error ? error.message : "A Grok Bot cache could not be read."); }
      }
    }
    const savedFolders = readJson<{ path: string; source: "grok" | "hermes" }[]>(join(dataDir(), "import-folders.json"), []);
    for (const entry of savedFolders.slice(0, 100)) {
      if (!["grok", "hermes"].includes(entry.source) || !folder(entry.path)) continue;
      const root = resolve(entry.path), id = sourceId(`${entry.source}-folder:${root}`);
      refs.set(id, { id, source: entry.source, name: basename(root), kind: "bot", description: `Exported ${entry.source === "grok" ? "Grok" : "Hermes"} bot folder`, location: root, root, exported: true });
    }
    return { candidates: [...refs.values()].map(({ root: _root, row: _row, account: _account, members: _members, ...candidate }) => candidate), warnings, locations: { hermes, grok } };
  }
  function grokMessages(ref: SourceRef): ImportedMessage[] {
    const path = blobs.get(`${ref.account}.transcript.replicas.${ref.row?.id}`); if (!path) return [];
    const document = json(grok, path, 12 * 1024 * 1024); if (document.schemaVersion !== 1) throw new InputError("Unsupported Grok Bot transcript cache");
    const entries = object(document.value).entries; if (!Array.isArray(entries)) return [];
    const messages = new Map<string, ImportedMessage>();
    for (const value of entries.slice(-1000)) {
      const entry = object(value); if (entry.isStreaming === true) continue;
      const message = object(entry.message), author = object(entry.author);
      const role = entry.kind === "send-message" ? "assistant" : entry.kind === "message" && ["user", "assistant"].includes(String(entry.role)) ? entry.role as "user" | "assistant" : undefined;
      const body = role ? content(entry.kind === "send-message" && message.type === "text" ? message.content : entry.content) : "";
      if (role && body.trim()) messages.set(String(entry.id), { role, text: body.slice(0, 100000), at: timestamp(entry.timestampMs), ...(typeof author.id === "string" ? { author: sourceId(`${ref.account}:${author.id}`), authorName: text(author.name, 80) } : {}) });
    }
    return [...messages.values()];
  }
  function hermesBot(ref: SourceRef, options: { history: boolean; skills: boolean; memory: boolean; routines: boolean }): SourceBot {
    const root = ref.root, warnings: string[] = [], raw = bytes(root, join(root, "config.yaml"));
    const config = raw ? yaml(raw.toString("utf8")) : {}, model = object(config.model);
    const soul = bytes(root, join(root, "SOUL.md"), 100000)?.toString("utf8") || "";
    const notes: string[] = [];
    for (const path of options.memory ? ["memories/USER.md", "memories/MEMORY.md", "USER.md", "MEMORY.md"] : []) {
      if (!lstatSync(join(root, dirname(path)), { throwIfNoEntry: false })) continue;
      const data = bytes(root, join(root, path), 50000); if (data?.length) notes.push(`## ${path}\n${data.toString("utf8")}`);
    }
    const skills: ImportedSkill[] = [];
    if (options.skills && folder(join(root, "skills"))) {
      let visited = 0, total = 0;
      function visit(path: string, depth: number) {
        if (++visited > 2000 || depth > 6) { warnings.push("Some skill directories exceeded the import scan limit."); return; }
        const file = bytes(root, join(path, "SKILL.md"), 200000);
        if (file) {
          if (skills.length >= 256) { warnings.push("Only the first 256 skills are included."); return; }
          const raw = file.toString("utf8"), match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/), fields = match ? yaml(match[1]) : {};
          const body = match ? match[2].trim() : raw.trim(); if (!body) return;
          const files: ImportedSkill["files"] = [];
          function bundle(dir: string, level: number) {
            if (level > 8) throw new InputError("Skill bundle is too deeply nested");
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              if (entry.name.startsWith(".") || ["auth.json", "credentials.json", "secrets.json", "token.json", "node_modules"].includes(entry.name) || entry.isSymbolicLink()) continue;
              const target = join(dir, entry.name); if (entry.isDirectory()) bundle(target, level + 1);
              else if (entry.isFile() && target !== join(path, "SKILL.md")) { const value = bytes(root, target, 2 * 1024 * 1024)!; total += value.length; if (total > 16 * 1024 * 1024 || files.length >= 200) throw new InputError("Selected skill bundles exceed the import limit"); files.push({ path: relative(path, target), bytes: value }); }
            }
          }
          bundle(path, 0); skills.push({ key: relative(root, path), name: text(fields.name, 80) || basename(path), description: text(fields.description, 1500) || `Imported ${ref.source === "hermes" ? "Hermes" : "Grok"} skill ${basename(path)}`, body, files }); return;
        }
        for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".")) visit(join(path, entry.name), depth + 1);
      }
      visit(join(root, "skills"), 0);
    }
    if (options.memory && !notes.length) warnings.push(`No saved memory files were found for ${ref.name}.`);
    if (options.skills && !skills.length) warnings.push(`No supported skills were found for ${ref.name}.`);
    const routines: ImportedRoutine[] = [], cronFile = join(root, "cron/jobs.json");
    if (options.routines && folder(join(root, "cron"))) {
      const jobs = json(root, cronFile).jobs;
      if (Array.isArray(jobs)) for (const value of jobs.slice(0, 100)) {
        const job = object(value), schedule = object(job.schedule), zone = text(schedule.timezone || config.timezone) || "UTC";
        if (schedule.kind !== "cron" || job.script || job.no_agent || !["UTC", "Etc/UTC", "GMT"].includes(zone)) { warnings.push(`Routine ${text(job.name, 80) || "unnamed"} needs manual setup: its script, schedule or timezone is not supported.`); continue; }
        try { const prompt = text(job.prompt, 16000); if (prompt) routines.push({ name: text(job.name, 80) || "Routine", schedule: normalizeSchedule(text(schedule.expr, 200)), prompt }); } catch { warnings.push("A routine with an unsupported schedule was skipped."); }
      }
    }
    const servers = Object.keys(object(config.mcp_servers));
    if (servers.length) warnings.push(`Reconnect these Hermes tools in Connected tools: ${servers.join(", ")}. Credentials and prior permissions are not imported.`);
    const messages: ImportedMessage[] = [];
    if (options.history && lstatSync(join(root, "state.db"), { throwIfNoEntry: false })) {
      const path = join(root, "state.db"), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new InputError("Unsafe Hermes history database");
      const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
      try {
        db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN");
        const sessions = db.prepare("SELECT id, title, model FROM sessions ORDER BY started_at DESC LIMIT 3").all();
        const columns = db.prepare("PRAGMA table_info(messages)").all().map((row) => row.name);
        for (const session of sessions.reverse()) {
          const rows = db.prepare(`SELECT id, role, content, timestamp FROM messages WHERE session_id = ? AND role IN ('user','assistant') ${columns.includes("active") ? "AND active=1" : ""} AND length(content)<=200000 ORDER BY id DESC LIMIT 200`).all(String(session.id));
          messages.push({ role: "assistant", text: `[Imported Hermes conversation: ${text(session.title, 200) || session.id}. Historical record only; no past request or approval is reactivated.]` });
          for (const row of rows.reverse()) { const body = content(row.content); if (body.trim()) messages.push({ role: row.role as "user" | "assistant", text: body.slice(0, 100000), at: timestamp(row.timestamp) }); }
          if (rows.length === 200) warnings.push("A conversation was limited to its latest 200 visible messages.");
        }
        warnings.push("History includes up to three recent conversations. Other Hermes sessions stay in Hermes.");
      } catch { throw new InputError("This Hermes history database has an unsupported schema or is busy. Retry without history."); }
      finally { db.close(); }
    }
    return { candidate: ref, soul, context: notes.join("\n\n").slice(0, 100000), model: text(model.default || config.model, 200), provider: text(model.provider, 200), skills, routines, messages, warnings };
  }
  function load(id: string, options: { history: boolean; skills: boolean; memory: boolean; routines: boolean }): SourceBundle {
    const ref = refs.get(id); if (!ref) throw new InputError("Import source is unavailable. Refresh the source list.", 404);
    const memberRefs = ref.kind === "group" ? ref.members?.map((id) => refs.get(id)).filter((r): r is SourceRef => Boolean(r && r.kind === "bot")) || [] : [ref];
    if (ref.kind === "group" && (memberRefs.length < 2 || memberRefs.length !== ref.members?.length || memberRefs.length > 20 || new Set(memberRefs.map((r) => r.id)).size !== memberRefs.length)) throw new InputError("All group members must be available in the Grok Bot cache before importing this group.");
    let size = 0;
    const bots = memberRefs.map((ref): SourceBot => {
      const bot: SourceBot = (ref.source === "hermes" || ref.exported) ? hermesBot(ref, options) : { candidate: ref, soul: "", context: "", model: "", provider: "xai-oauth", skills: [], routines: [], messages: options.history ? grokMessages(ref) : [], warnings: ["Grok Bot's local cache contains its description and recent conversation. Cloud-only instructions, memories, files, skills and schedules are unavailable here."] };
      size += Buffer.byteLength(bot.soul + bot.context + bot.messages.map((m) => m.text).join("")) + bot.skills.reduce((n, s) => n + Buffer.byteLength(s.body) + s.files.reduce((n, f) => n + f.bytes.length, 0), 0);
      if (size > 24 * 1024 * 1024) throw new InputError("This import is too large. Try without history or skills.");
      return bot;
    });
    const groupMessages = ref.kind === "group" && options.history ? grokMessages(ref) : [];
    if (size + Buffer.byteLength(groupMessages.map((m) => m.text).join("")) > 24 * 1024 * 1024) throw new InputError("This import is too large. Try without history or skills.");
    return { bots, ...(ref.kind === "group" ? { group: ref } : {}), messages: groupMessages, warnings: [...new Set(bots.flatMap((b) => b.warnings))] };
  }
  function addFolder(path: string, source: string) {
    if (typeof path !== "string" || !path.trim() || !["hermes", "grok"].includes(source)) throw new InputError("Choose an exported bot folder and source");
    const root = resolve(path);
    if (!folder(root) || !["SOUL.md", "MEMORY.md", "USER.md", "memories", "skills", "config.yaml"].some(name => lstatSync(join(root, name), { throwIfNoEntry: false }))) throw new InputError("This folder does not contain supported bot instructions, memories or skills");
    const file = join(dataDir(), "import-folders.json"), folders = readJson<{ path: string; source: string }[]>(file, []);
    if (!folders.some(entry => entry.path === root && entry.source === source)) {
      if (folders.length >= 100) throw new InputError("At most 100 exported folders can be registered");
      writeJson(file, [...folders, { path: root, source }]);
    }
    return discover();
  }
  return { discover, load, addFolder };
}
