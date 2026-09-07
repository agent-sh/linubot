/** Group turn order: tagged @bots first (in tag order), rest in roster order, each once. */
export function routeGroup(message: string, roster: string[]): string[] {
  const tags = [...message.matchAll(/@([\p{L}\p{N}_-]+)/gu)].map((m) => m[1].toLowerCase());
  const inRoster = (n: string) => roster.find((r) => r.toLowerCase() === n);
  const first: string[] = [];
  for (const t of tags) {
    const hit = inRoster(t);
    if (hit && !first.includes(hit)) first.push(hit);
  }
  for (const name of roster) {
    if (!first.includes(name)) first.push(name);
  }
  return first;
}
