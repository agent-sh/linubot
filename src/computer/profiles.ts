import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { dataDir, readJson, writeJson } from "../store.ts";
import { InputError } from "../errors.ts";

function root(scope: string): string {
  if (!/^(bot|group):[A-Za-z0-9_-]{1,60}$/.test(scope)) throw new InputError("Invalid browser owner");
  return join(resolve(dataDir()), "computer-profiles", scope.replace(":", "_"));
}
export function browserProfile(scope: string, mode: "standard" | "automated"): string {
  const directory = root(scope);
  for (const path of [join(resolve(dataDir()), "computer-profiles"), directory, join(directory, mode)]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new InputError("Unsafe saved browser directory");
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return join(directory, mode);
}
export function standardBrowserSaved(scope: string): boolean {
  return readJson<{ standard?: boolean }>(join(root(scope), "browser.json"), {}).standard === true;
}
export function saveStandardBrowser(scope: string): void {
  browserProfile(scope, "standard");
  writeJson(join(root(scope), "browser.json"), { standard: true });
}
export function assertBrowserIdle(scope: string): void {
  root(scope);
  const workspaces = readJson<{ scope?: string; state?: string }[]>(join(dataDir(), "computer-workspaces.json"), []);
  if (workspaces.some(entry => entry.scope === scope && entry.state === "running")) throw new InputError("Close this bot or group’s computer before deleting its saved logins.", 409);
}
export function forgetBrowserProfiles(scope: string): void {
  assertBrowserIdle(scope);
  const parent = join(resolve(dataDir()), "computer-profiles");
  const stat = lstatSync(parent, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new InputError("Unsafe saved browser directory");
  rmSync(root(scope), { recursive: true, force: true });
}
