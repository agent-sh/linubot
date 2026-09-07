import { join } from "node:path";
import { chmodSync, mkdirSync, lstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dataDir, readJson, readText, writeJson } from "../store.ts";
import { saveSkill, validSkillName } from "../memory/updater.ts";
import { getBot, validName } from "../bots/manager.ts";
import { InputError, requiredText } from "../errors.ts";
import type { Computer } from "../computer/workspace.ts";

export interface Demo {
  id: string;
  bot: string;
  purpose: string;
  startedAt: string;
  workspaceId: string;
  shots: string[];
  state: "starting" | "recording" | "finishing" | "finished" | "failed";
  workspaceStarted: boolean;
  workspaceStopped: boolean;
  workspaceCleaned: boolean;
  finished: boolean;
  finishedAt?: string;
  cancelled?: boolean;
  skill?: string;
  errors: string[];
}

function demosPath(): string {
  return join(dataDir(), "demos.json");
}

export function listDemos(): Demo[] {
  return readJson<Demo[]>(demosPath(), []);
}

function saveDemo(demo: Demo): void {
  const demos = listDemos();
  const index = demos.findIndex((entry) => entry.id === demo.id);
  if (index === -1) demos.push(demo);
  else demos[index] = demo;
  writeJson(demosPath(), demos);
}

export function getDemo(id: string): Demo {
  if (typeof id !== "string" || !/^demo-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new InputError("invalid demo ID");
  }
  const demo = listDemos().find((entry) => entry.id === id);
  if (!demo) throw new InputError(`unknown demo: ${id}`, 404);
  if (demo.workspaceId !== id.replace(/^demo-/, "linubot-")) throw new InputError("demo workspace ownership mismatch", 409);
  if (!["starting", "recording", "finishing", "finished", "failed"].includes(demo.state)) throw new InputError("invalid demo state", 409);
  return demo;
}

function artifactsDir(id: string): string {
  const root = join(dataDir(), "demos");
  const dir = join(root, id);
  for (const path of [root, dir]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new InputError("unsafe demo artifact directory");
  }
  return dir;
}

function notesPath(id: string): string {
  const path = join(artifactsDir(id), "notes.md");
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > 80_000)) throw new InputError("unsafe or oversized demo notes");
  return path;
}

const pending = new Map<string, Promise<unknown>>();

function serialize<T>(id: string, work: () => Promise<T>): Promise<T> {
  // Separate demos can progress together; each operation reloads its record after acquiring the queue.
  const key = `${demosPath()}:${id}`;
  const result = (pending.get(key) ?? Promise.resolve()).then(work, work);
  pending.set(key, result);
  const release = () => { if (pending.get(key) === result) pending.delete(key); };
  void result.then(release, release);
  return result;
}

function failed(demo: Demo, error: unknown): void {
  demo.state = "failed";
  demo.finished = false;
  demo.errors.push(String(error));
  saveDemo(demo);
}

async function releaseWorkspace(computer: Computer, demo: Demo): Promise<void> {
  if (demo.workspaceCleaned) return;
  // The adapter may have saved ownership just before the process interrupted a starting demo.
  if (!demo.workspaceStarted && !computer.owns(demo.workspaceId)) return;
  demo.workspaceStarted = true;
  if (!demo.workspaceStopped) {
    try { await computer.stop(demo.workspaceId); }
    catch (error) { throw new Error(`demo workspace stop failed: ${String(error)}`, { cause: error }); }
    demo.workspaceStopped = true;
    saveDemo(demo);
  }
  try { await computer.cleanup(demo.workspaceId); }
  catch (error) { throw new Error(`demo workspace cleanup failed: ${String(error)}`, { cause: error }); }
  demo.workspaceCleaned = true;
  saveDemo(demo);
}

async function screenshot(computer: Computer, demo: Demo, filename: string): Promise<void> {
  const shot = join(artifactsDir(demo.id), filename);
  writeFileSync(shot, "", { flag: "wx", mode: 0o600 });
  try {
    await computer.screenshot(shot, demo.workspaceId);
    const stat = lstatSync(shot);
    if (!stat.isFile() || stat.size === 0) throw new Error("demo screenshot did not produce an artifact");
    chmodSync(shot, 0o600);
    demo.shots.push(shot);
  } catch (error) {
    rmSync(shot, { force: true });
    throw error;
  }
}

/** Start a manual demonstration after explicit UI approval, not automatic learning.
 * Main can separately openViewer(workspaceId, { inputForwarding: true }) after the user's choice.
 */
export async function startDemo(computer: Computer, bot: string, purpose: string, opts: { acknowledge?: boolean } = {}): Promise<Demo> {
  bot = requiredText(bot, "demo bot", 40);
  if (!validName(bot) || !getBot(bot)) throw new InputError(`unknown demo bot: ${bot}`);
  purpose = requiredText(purpose, "demo purpose", 1800);
  if (opts?.acknowledge !== true) throw new InputError("demo start requires explicit acknowledgement", 403);
  const uuid = randomUUID();
  const id = `demo-${uuid}`;
  return serialize(id, async () => {
    const root = join(dataDir(), "demos");
    const existing = lstatSync(root, { throwIfNoEntry: false });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new InputError("unsafe demo artifact directory");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    mkdirSync(join(root, id), { mode: 0o700 });
    const demo: Demo = {
      id, bot, purpose, startedAt: new Date().toISOString(), workspaceId: `linubot-${uuid}`,
      shots: [], state: "starting", workspaceStarted: false, workspaceStopped: false,
      workspaceCleaned: false, finished: false, errors: [],
    };
    saveDemo(demo);
    try {
      const ws = await computer.start({ purpose: `demo for ${bot}: ${purpose}`, id: demo.workspaceId, acknowledge: true });
      if (ws.id !== demo.workspaceId || ws.dryRun) throw new Error("demo start returned the wrong workspace");
      demo.workspaceStarted = true;
      saveDemo(demo);
      await screenshot(computer, demo, "start.png");
      demo.state = "recording";
      saveDemo(demo);
      return demo;
    } catch (error) {
      let failure = error;
      try { await releaseWorkspace(computer, demo); }
      catch (cleanupError) {
        failure = new AggregateError([error, cleanupError], `${String(error)}; ${String(cleanupError)}`);
      }
      failed(demo, failure);
      throw failure;
    }
  });
}

export async function captureDemo(computer: Computer, id: string): Promise<Demo> {
  getDemo(id);
  return serialize(id, async () => {
    const demo = getDemo(id);
    if (demo.state !== "recording") throw new InputError(`demo is not recording: ${id}`, 409);
    try {
      await screenshot(computer, demo, `shot-${demo.shots.length}.png`);
      saveDemo(demo);
      return demo;
    } catch (error) {
      failed(demo, error);
      throw error;
    }
  });
}

/** Save a reviewable draft, never overwrite an existing skill or claim the procedure was verified. */
export async function finishDemo(computer: Computer, id: string, skillName: string, notes: string): Promise<{ demo: Demo; skill: string; created: boolean }> {
  getDemo(id);
  if (typeof skillName !== "string" || !validSkillName(skillName)) throw new InputError(`invalid skill name: ${skillName}`);
  return serialize(id, async () => {
    const demo = getDemo(id);
    if (demo.state === "finished") {
      if (demo.cancelled || demo.skill !== skillName) throw new InputError("demo already finished with a different outcome", 409);
      return { demo, skill: skillName, created: false };
    }
    if (!demo.shots.length || (!demo.workspaceStarted && !computer.owns(demo.workspaceId)) || demo.state === "starting") throw new InputError("demo has not started recording", 409);
    if (typeof notes !== "string" || notes.length > 20000) throw new InputError("demo notes must be a string of at most 20000 characters");
    const log = readDemoLog(id).trim();
    const procedure = [log, notes.trim()].filter(Boolean).join("\n\n");
    if (!procedure) throw new InputError("record the demonstration steps or notes before finishing");
    if (lstatSync(join(dataDir(), "skills", skillName), { throwIfNoEntry: false })) throw new InputError(`skill already exists; choose another name: ${skillName}`, 409);
    demo.state = "finishing";
    saveDemo(demo);
    try {
      await releaseWorkspace(computer, demo);
      const body = [
        `# ${skillName}`, "",
        "Draft from a manual demonstration. Not automatically learned, tested, or verified.",
        `Use when: ${demo.purpose}`, `Demonstrated for: ${demo.bot}`, `Recorded: ${demo.startedAt}`, "",
        "## Recorded Steps And Notes", procedure, "",
        "## Review Before Use",
        "1. Review the recorded steps against the screenshots. Specify exact controls, inputs, prerequisites, and expected output where missing.",
        "2. Reproduce the procedure in an explicitly approved isolated workspace and check the expected output.",
        "3. Resolve any missing or unsafe steps before marking this draft ready or scheduling it.", "",
        `## Evidence (${demo.id})`,
        ...demo.shots.map((shot, index) => `${index + 1}. ${shot}`),
      ].join("\n");
      const saved = saveSkill({ name: skillName, description: `Manual demonstration for ${demo.bot}: ${demo.purpose}`.slice(0, 200), body, status: "draft" });
      if (!saved) throw new InputError(`skill already exists; nothing was overwritten: ${skillName}`, 409);
      demo.skill = skillName;
      demo.state = "finished";
      demo.finished = true;
      demo.finishedAt = new Date().toISOString();
      saveDemo(demo);
      return { demo, skill: skillName, created: true };
    } catch (error) {
      failed(demo, error);
      throw error;
    }
  });
}

/** Clean up an unfinished demonstration without creating a skill. Repeated finished calls do nothing. */
export async function cancelDemo(computer: Computer, id: string): Promise<Demo> {
  getDemo(id);
  return serialize(id, async () => {
    const demo = getDemo(id);
    if (demo.state === "finished") return demo;
    demo.state = "finishing";
    saveDemo(demo);
    try {
      await releaseWorkspace(computer, demo);
      demo.state = "finished";
      demo.finished = true;
      demo.cancelled = true;
      demo.finishedAt = new Date().toISOString();
      saveDemo(demo);
      return demo;
    } catch (error) {
      failed(demo, error);
      throw error;
    }
  });
}

export function readDemoLog(id: string): string {
  getDemo(id);
  return readText(notesPath(id));
}

export function writeDemoLog(id: string, text: string): void {
  const demo = getDemo(id);
  if (!["recording", "failed"].includes(demo.state)) throw new InputError("demo notes cannot change in this state", 409);
  if (typeof text !== "string" || text.length > 20000) throw new InputError("demo notes must be a string of at most 20000 characters");
  const path = notesPath(id);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function appendDemoLog(id: string, text: string): void {
  const previous = readDemoLog(id);
  const entry = requiredText(text, "demo log entry");
  writeDemoLog(id, `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${entry}\n`);
}
