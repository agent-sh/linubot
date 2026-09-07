import { appendMemory, updateUser } from "./store.ts";
import { appendSoul, ensureBot, validName } from "../bots/manager.ts";
import { InputError, textList } from "../errors.ts";
import { listInstalledSkills, saveLearnedSkill as saveSkill, validateLearnedSkill } from "../marketplace/search.ts";
import type { Skill } from "../marketplace/search.ts";

export { saveSkill };
export { approveSkill, validSkillName } from "../marketplace/search.ts";

export interface SoulDelta {
  bot: string;
  lines: string[];
}

export type LearnedSkill = Skill;

export interface TurnLearnings {
  memory?: string[];
  user?: string[];
  souls?: SoulDelta[];
  skills?: LearnedSkill[];
}

export interface TurnReport {
  memory: string[];
  user: string[];
  souls: Record<string, string[]>;
  skills: string[];
}

export function listLearnedSkills(): string[] {
  return listInstalledSkills(true).map((skill) => skill.name);
}

/** End-of-turn agent: persists memory, user facts, soul lines, new skills. All writes dedupe. */
export async function endOfTurn(learn: TurnLearnings): Promise<TurnReport> {
  if (!learn || typeof learn !== "object" || Array.isArray(learn)) throw new InputError("turn learnings must be an object");
  const memory = textList(learn.memory === undefined ? [] : learn.memory, "memory entries", 100, 4000);
  const user = textList(learn.user === undefined ? [] : learn.user, "user entries", 100, 4000);
  if (memory.concat(user).some((line) => line.includes("\n§\n"))) throw new InputError("entries cannot contain the entry separator");
  const souls = learn.souls === undefined ? [] : learn.souls;
  const skills = learn.skills === undefined ? [] : learn.skills;
  if (!Array.isArray(souls) || souls.length > 50) throw new InputError("souls must be a list of at most 50 items");
  if (!Array.isArray(skills) || skills.length > 20) throw new InputError("skills must be a list of at most 20 items");
  const deltas = souls.map((delta) => {
    if (!delta || typeof delta !== "object" || !validName(delta.bot)) throw new InputError("invalid bot name in soul delta");
    const lines = textList(delta.lines, "soul lines", 50, 4000);
    if (lines.some((line) => line.includes("\n§\n"))) throw new InputError("soul lines cannot contain the entry separator");
    return { bot: delta.bot, lines };
  });
  const drafts = skills.map(validateLearnedSkill);
  const report: TurnReport = { memory: [], user: [], souls: {}, skills: [] };
  report.memory = appendMemory(memory);
  report.user = updateUser(user);
  for (const delta of deltas) {
    await ensureBot(delta.bot);
    const previous = Object.hasOwn(report.souls, delta.bot) ? report.souls[delta.bot] : [];
    report.souls[delta.bot] = [...previous, ...appendSoul(delta.bot, delta.lines)];
  }
  for (const skill of drafts) {
    if (saveSkill(skill)) report.skills.push(skill.name);
  }
  return report;
}
