import { join } from "node:path";
import { dataDir, readJson, writeJson } from "../store.ts";
import { getBot } from "../bots/manager.ts";
import { InputError } from "../errors.ts";
export type PermissionMode = "ask" | "auto";
export function permissionSettings(): { mode: PermissionMode } {
  const value = readJson<{ mode: PermissionMode }>(join(dataDir(), "permissions.json"), { mode: "ask" });
  if (!["ask", "auto"].includes(value.mode)) throw new InputError("Invalid saved permission mode");
  return value;
}
export function botPermission(name: string): { override: PermissionMode | "inherit"; mode: PermissionMode } {
  if (!getBot(name)) throw new InputError("Bot not found", 404);
  const value = readJson<{ mode: PermissionMode | "inherit" }>(join(dataDir(), "profiles", name, "permissions.json"), { mode: "inherit" });
  if (!["ask", "auto", "inherit"].includes(value.mode)) throw new InputError("Invalid saved bot permission mode");
  return { override: value.mode, mode: value.mode === "inherit" ? permissionSettings().mode : value.mode };
}
export function savePermission(mode: string, bot?: string): void {
  if (!["ask", "auto", ...(bot ? ["inherit"] : [])].includes(mode)) throw new InputError("Choose Ask first or Always approve");
  if (bot && !getBot(bot)) throw new InputError("Bot not found", 404);
  writeJson(bot ? join(dataDir(), "profiles", bot, "permissions.json") : join(dataDir(), "permissions.json"), { mode });
}
