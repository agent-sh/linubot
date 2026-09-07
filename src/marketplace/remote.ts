import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchPublic, fetchPublicJson } from "../network/http.ts";
import { InputError, requiredText } from "../errors.ts";
import { dataDir, writeJson } from "../store.ts";
import { validSkillName, validateSkillDirectory } from "./search.ts";

interface TreeEntry { path: string; type: string; mode: string; size?: number }
export interface RemoteSkillHit { name: string; repository: string; path?: string; installs?: number; description?: string }
interface Preview {
  id: string; name: string; repository: string; commit: string; path: string; body: string;
  files: { path: string; content: Buffer }[]; sha256: string; expires: number; data: string;
}
const previews = new Map<string, Preview>();
type RemoteSource = { json: typeof fetchPublicJson; read: typeof fetchPublic };
const remoteSource: RemoteSource = { json: fetchPublicJson, read: fetchPublic };

export function repositoryName(value: string): string {
  const repository = value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository) || repository.split("/").some((part) => part === "." || part === "..")) throw new InputError("Use a GitHub owner/repository or repository URL");
  return repository;
}

export function safeBundlePath(value: string): boolean {
  return Boolean(value && value.length < 500 && !value.includes("\\") && !/[\x00-\x1f]/.test(value) && value.split("/").every((part) => part && part !== "." && part !== ".." && part !== ".git"));
}

async function repositoryTree(repository: string, signal?: AbortSignal, source = remoteSource) {
  const info = await source.json<{ default_branch: string }>(`https://api.github.com/repos/${repository}`, signal);
  const commit = await source.json<{ sha: string }>(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(info.default_branch)}`, signal);
  if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error("GitHub did not return a pinned commit");
  const tree = await source.json<{ tree: TreeEntry[]; truncated?: boolean }>(`https://api.github.com/repos/${repository}/git/trees/${commit.sha}?recursive=1`, signal);
  if (!Array.isArray(tree.tree) || tree.truncated) throw new Error("Repository tree is incomplete; use a smaller skill repository");
  return { commit: commit.sha, entries: tree.tree };
}

export async function browseSkillRepository(value: string, signal?: AbortSignal) {
  const repository = repositoryName(value);
  const tree = await repositoryTree(repository, signal);
  return tree.entries.filter((file) => /(^|\/)SKILL\.md$/.test(file.path) && file.mode === "100644").slice(0, 200).map((file) => ({
    repository, path: file.path, name: file.path.split("/").at(-2) ?? repository.split("/")[1],
  }));
}

export async function searchRemoteSkills(query: string, signal?: AbortSignal): Promise<RemoteSkillHit[]> {
  const q = requiredText(query, "Skill query", 200);
  // The public CLI catalog is available without a Vercel account. v1 is authenticated.
  const response = await fetchPublicJson<{ skills: { name: string; skillId?: string; source: string; installs?: number }[] }>(`https://skills.sh/api/search?q=${encodeURIComponent(q)}&limit=25`, signal);
  if (!Array.isArray(response.skills)) throw new Error("The skill catalog returned an invalid response");
  return response.skills.flatMap((skill) => {
    try { return [{ name: requiredText(skill.skillId ?? skill.name, "Skill name", 100), repository: repositoryName(skill.source), installs: skill.installs }]; } catch { return []; }
  }).slice(0, 25);
}

export async function previewRemoteSkill(input: RemoteSkillHit, signal?: AbortSignal, source = remoteSource) {
  const repository = repositoryName(input.repository);
  const tree = await repositoryTree(repository, signal, source);
  const candidates = tree.entries.filter((file) => /(^|\/)SKILL\.md$/.test(file.path) && (input.path ? file.path === input.path : file.path.split("/").at(-2) === input.name || (file.path === "SKILL.md" && tree.entries.filter((item) => /(^|\/)SKILL\.md$/.test(item.path)).length === 1)));
  if (candidates.length !== 1) throw new InputError("Select an exact skill folder from the GitHub repository", 409);
  const path = candidates[0].path;
  const prefix = path.slice(0, -"SKILL.md".length);
  const name = requiredText(input.name, "Installation name", 40);
  if (!validSkillName(name)) throw new InputError("Installation name needs lowercase letters, numbers or hyphens, up to 40 characters");
  const files = tree.entries.filter((file) => file.path.startsWith(prefix) && file.type !== "tree");
  if (files.length > 100 || files.some((file) => !["100644", "100755"].includes(file.mode) || !safeBundlePath(file.path.slice(prefix.length))) || files.reduce((sum, file) => sum + (file.size ?? 0), 0) > 5 * 1024 * 1024) throw new InputError("Skill bundle is too large or contains symlinks, submodules, or unsafe paths");
  const downloaded: Preview["files"] = [];
  // Small batches bound simultaneous requests and preserve the complete pinned bundle.
  for (let i = 0; i < files.length; i += 4) {
    const batch = await Promise.all(files.slice(i, i + 4).map(async (file) => {
      const result = await source.read(`https://raw.githubusercontent.com/${repository}/${tree.commit}/${file.path.split("/").map(encodeURIComponent).join("/")}`, { signal, maxBytes: 512 * 1024 });
      return { path: file.path.slice(prefix.length), content: result.bytes };
    }));
    downloaded.push(...batch);
  }
  if (downloaded.reduce((sum, file) => sum + file.content.length, 0) > 5 * 1024 * 1024) throw new InputError("Skill download exceeds the bundle budget");
  const body = downloaded.find((file) => file.path === "SKILL.md")?.content.toString("utf8");
  if (!body || body.length > 128 * 1024) throw new InputError("Missing or oversized SKILL.md");
  const hash = createHash("sha256");
  for (const file of downloaded) hash.update(file.path + "\0" + file.content.length + "\0").update(file.content);
  const preview: Preview = { id: randomUUID(), name, repository, commit: tree.commit, path, body, files: downloaded,
    sha256: hash.digest("hex"), expires: Date.now() + 20 * 60_000, data: dataDir() };
  for (const [id, prior] of previews) if (prior.expires < Date.now()) previews.delete(id);
  while (previews.size >= 15) previews.delete(previews.keys().next().value!);
  previews.set(preview.id, preview);
  return { ...preview, files: downloaded.map(({ path, content }) => ({ path, bytes: Buffer.byteLength(content) })), data: undefined };
}

export function installRemoteSkill(id: string) {
  const preview = previews.get(id);
  if (!preview || preview.expires < Date.now() || preview.data !== dataDir()) throw new InputError("Skill preview expired; preview it again before installing", 410);
  const root = join(dataDir(), "skills");
  const target = join(root, preview.name);
  if (existsSync(target)) throw new InputError("A skill with this name is already installed", 409);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temporary = join(root, `.install-${randomUUID()}`);
  mkdirSync(temporary, { mode: 0o700 });
  try {
    for (const file of preview.files) {
      const dest = join(temporary, file.path);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      // Imported instructions are wrapped in our own validated frontmatter; status cannot come from the publisher.
      const body = file.path === "SKILL.md" ? `---\nname: ${preview.name}\ndescription: ${JSON.stringify(`Imported from ${preview.repository} at ${preview.commit.slice(0, 12)}`)}\nstatus: draft\n---\n\n${preview.body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")}` : file.content;
      writeFileSync(dest, body, { flag: "wx", mode: 0o600 });
    }
    writeJson(join(temporary, ".linubot-source.json"), { repository: preview.repository, commit: preview.commit, path: preview.path, sha256: preview.sha256, installedAt: new Date().toISOString() });
    const skill = validateSkillDirectory(temporary, preview.name);
    renameSync(temporary, target);
    previews.delete(id);
    return skill;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
