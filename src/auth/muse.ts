import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { InputError } from "../errors.ts";

export const META_BASE = "https://api.meta.ai/v1";
const directory = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "muse");
interface MuseConfig { providers?: { meta?: { api_base_url?: unknown; api_key?: unknown } }; model?: unknown }
function readConfig(name: string): MuseConfig | undefined {
  const path = join(directory(), name), stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new InputError("Invalid Muse Code configuration file");
  try { const value = JSON.parse(readFileSync(path, "utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid configuration"); return value; }
  catch { throw new InputError("Muse Code configuration could not be read. Sign in again with muse login.", 409); }
}

export function museCredential() {
  const meta = readConfig("auth.json")?.providers?.meta;
  if (!meta) return;
  if (typeof meta.api_base_url !== "string" || meta.api_base_url.replace(/\/+$/, "") !== META_BASE || typeof meta.api_key !== "string" || !meta.api_key.trim() || meta.api_key.length > 10000 || /[\r\n]/.test(meta.api_key)) {
    throw new InputError("Muse Code has no usable Meta Model API key. Sign in with muse login or enter a Meta API key.", 409);
  }
  // The account access token is never imported. Muse Code owns its account login.
  return meta.api_key as string;
}

export function museStatus() {
  let model = "muse-spark-1.3";
  try {
    const configured = readConfig("settings.json")?.model;
    if (typeof configured === "string" && configured.startsWith("muse-spark") && configured.length <= 200) model = configured;
    return { available: Boolean(museCredential()), model };
  } catch (error) { return { available: false, model, error: error instanceof Error ? error.message : "Muse Code sign-in is unavailable" }; }
}
