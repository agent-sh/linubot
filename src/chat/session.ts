import { forgetBrowserProfiles } from "../computer/profiles.ts";
import { join } from "node:path";
import { dataDir, readJson, writeJson } from "../store.ts";
import { ensureBot, getBot, validName } from "../bots/manager.ts";
import { InputError, requiredText, textList } from "../errors.ts";
import { appendEvent, tailEvents } from "../events/log.ts";
import type { FeedEvent } from "../events/log.ts";
import { routeGroup } from "./router.ts";

export interface Group {
  id: string;
  members: string[];
  name?: string;
}

export function validGroupId(id: string): boolean {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(id);
}

function groupsPath(): string {
  return join(dataDir(), "groups.json");
}

export function listGroups(): Group[] {
  return readJson<Group[]>(groupsPath(), []);
}

/** Programmatic creation still ensures missing bots locally. The UI should supply its selected roster. */
export async function createGroup(id: string, members: string[], name?: string): Promise<Group> {
  if (!validGroupId(id)) throw new InputError(`invalid group id: ${id}`);
  const unique = textList(members, "group members", 20, 40);
  if (unique.length < 2) throw new InputError("a group needs at least two bots");
  for (const member of unique) {
    if (!validName(member)) throw new InputError(`invalid bot name: ${member}`);
  }
  const label = name === undefined ? undefined : requiredText(name, "group name", 80);
  if (getGroup(id)) throw new InputError(`group already exists: ${id}`, 409);
  for (const m of unique) await ensureBot(m);
  const groups = listGroups();
  if (groups.some((group) => group.id === id)) throw new InputError(`group already exists: ${id}`, 409);
  const group: Group = { id, members: unique, name: label };
  writeJson(groupsPath(), [...groups, group]);
  appendEvent("group:" + id, { kind: "notice", text: `Group started: ${unique.join(", ")}` });
  return group;
}

export function getGroup(id: string): Group | null {
  if (!validGroupId(id)) throw new InputError(`invalid group id: ${id}`);
  return listGroups().find((g) => g.id === id) ?? null;
}

/** Remove group membership, retaining its transcript. Even disabled jobs protect their delivery target. */
export function deleteGroup(id: string): boolean {
  if (!getGroup(id)) return false;
  const jobs = readJson<Array<{ name: string; deliver?: string }>>(join(dataDir(), "jobs.json"), []);
  const references = jobs.filter((job) => typeof job?.deliver === "string" && job.deliver.trim() === `group:${id}`);
  if (references.length) throw new InputError(`group is referenced by jobs: ${references.map((job) => job.name).join(", ")}`, 409);
  forgetBrowserProfiles(`group:${id}`);
  writeJson(groupsPath(), listGroups().filter((group) => group.id !== id));
  return true;
}

/** Direct message: input from one bot lands in another bot's feed, with a handoff card. */
export async function sendDm(from: string, to: string, text: string): Promise<FeedEvent> {
  from = requiredText(from, "sender", 40);
  to = requiredText(to, "recipient", 40);
  if (!validName(from) || !validName(to)) throw new InputError("invalid bot name");
  text = requiredText(text, "message");
  await ensureBot(from);
  await ensureBot(to);
  appendEvent("bot:" + to, { kind: "handoff", from, to, text });
  return appendEvent("bot:" + to, { kind: "message", from, text });
}

export function readFeed(scope: string, limit = 50, beforeSeq?: number): { entries: FeedEvent[]; nextBeforeSeq: number | null } {
  return tailEvents(scope, limit, beforeSeq);
}

/**
 * Standalone group helper; production runtime owns its own queue instead.
 * This helper alone persists final messages. `speak` may stream progress, but must only RETURN
 * its final text, not persist it. Replies stay in the group feed, attributed to the speaking bot.
 */
export async function postToGroup(
  id: string,
  from: string,
  text: string,
  speak: (bot: string, text: string) => Promise<string>,
  cancelled?: () => boolean,
): Promise<Array<{ bot: string; text: string }>> {
  const group = getGroup(id);
  if (!group) throw new InputError(`unknown group: ${id}`, 404);
  text = requiredText(text, "message");
  from = requiredText(from, "sender", 40);
  if (from !== "user" && !group.members.includes(from)) throw new InputError(`sender is not a group member: ${from}`);
  if (group.members.length < 2 || group.members.some((member) => !validName(member) || !getBot(member))) {
    throw new InputError("group contains missing or invalid members", 409);
  }
  appendEvent("group:" + id, { kind: "message", from, text });
  const order = routeGroup(text, group.members);
  const turns: Array<{ bot: string; text: string }> = [];
  for (const bot of order) {
    if (cancelled?.()) {
      appendEvent("group:" + id, { kind: "notice", text: `Stopped by user before ${bot}'s turn.` });
      break;
    }
    appendEvent("group:" + id, { kind: "handoff", from, to: bot, text });
    const reply = requiredText(await speak(bot, text), "bot reply");
    appendEvent("group:" + id, { kind: "message", from: bot, text: reply });
    turns.push({ bot, text: reply });
  }
  return turns;
}
