import { InputError } from "../errors.ts";

export function optionalText(value: unknown, label: string, max = 4000): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) throw new InputError(`${label} must be text of at most ${max} characters`);
  return value;
}
export function optionalBoolean(value: unknown): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") throw new InputError("Expected a boolean");
  return value;
}
export function number(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) throw new InputError("Expected an integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new InputError(`Expected an integer between ${min} and ${max}`);
  return parsed;
}
