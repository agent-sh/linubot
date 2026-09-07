import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { InputError } from "../errors.ts";

export const QWEN_PLANS: Record<string, string> = {
  "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1": "BAILIAN_TOKEN_PLAN_API_KEY",
  "https://coding-intl.dashscope.aliyuncs.com/v1": "BAILIAN_CODING_PLAN_API_KEY",
  "https://coding.dashscope.aliyuncs.com/v1": "BAILIAN_CODING_PLAN_API_KEY",
};
export function qwenCredential(base: string, sourceHome = homedir()): { key: string; model: string } {
  if (!Object.hasOwn(QWEN_PLANS, base)) throw new InputError("Choose a Qwen Token Plan or Coding Plan connection");
  const expected = QWEN_PLANS[base], path = join(sourceHome, ".qwen", "settings.json");
  let settings: Record<string, unknown>;
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Unsupported settings file");
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid settings");
    settings = value as Record<string, unknown>;
  } catch { throw new InputError("No supported Qwen Code settings were found. Paste your plan API key instead.", 409); }
  const providers = settings.modelProviders && typeof settings.modelProviders === "object" && !Array.isArray(settings.modelProviders) ? settings.modelProviders as Record<string, unknown> : {};
  const models = (Array.isArray(providers.openai) ? providers.openai : []).filter((p): p is { baseUrl: string; envKey: string; id: string } =>
    p && typeof p === "object" && typeof p.baseUrl === "string" && p.baseUrl.replace(/\/+$/, "") === base && p.envKey === expected && typeof p.id === "string" && Boolean(p.id.trim()) && p.id.length <= 200 && !/[\r\n]/.test(p.id));
  const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env) ? settings.env as Record<string, unknown> : {};
  const model = settings.model && typeof settings.model === "object" && !Array.isArray(settings.model) ? settings.model as Record<string, unknown> : {};
  const key = process.env[expected] || (Object.hasOwn(env, expected) ? env[expected] : undefined);
  if (!models.length || typeof key !== "string" || !key.trim() || key.length > 10000 || /[\r\n]/.test(key)) throw new InputError("Configure this plan in Qwen Code, or paste its API key below.", 409);
  return { key: key.trim(), model: models.find((m) => m.id === model.name)?.id || models[0].id };
}
