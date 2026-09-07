export class InputError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "InputError";
    this.status = status;
  }
}

export function requiredText(value: unknown, label: string, max = 20000): string {
  if (typeof value !== "string" || !value.trim()) throw new InputError(`${label} is required`);
  const text = value.trim();
  if (text.length > max) throw new InputError(`${label} must be at most ${max} characters`);
  return text;
}

export function textList(value: unknown, label: string, maxItems = 20, maxLength = 2000): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new InputError(`${label} must be a list of at most ${maxItems} items`);
  return [...new Set(value.map((item) => requiredText(item, label, maxLength)))];
}
