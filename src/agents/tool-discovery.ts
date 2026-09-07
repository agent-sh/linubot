import type { ToolDefinition } from "../auth/providers.ts";
import { InputError } from "../errors.ts";
/** Core schemas stay loaded; extension schemas load when searched or reused by name. */
export function createToolDiscovery(tools: ToolDefinition[], core: Iterable<string>) {
  const coreNames = new Set(core);
  const catalog = new Map(tools.map(tool => [tool.name, tool]));
  if (catalog.size !== tools.length) throw new InputError("Duplicate tool names in discovery catalog");
  const loaded = new Map<string, ToolDefinition>();
  const base = tools.filter(tool => coreNames.has(tool.name));
  function activate(name: string) {
    const tool = catalog.get(name);
    if (!tool || coreNames.has(name)) return tool;
    loaded.delete(name); loaded.set(name, tool);
    while (loaded.size > 12) loaded.delete(loaded.keys().next().value!);
    return tool;
  }
  return {
    active: () => [...base, ...loaded.values()],
    resolve: activate,
    names() {
      const extensionCount = tools.length - base.length;
      if (!extensionCount) return "No connected MCP tools are available.";
      const names: string[] = []; let size = 0;
      for (const name of catalog.keys()) {
        if (coreNames.has(name)) continue;
        if (names.length >= 128 || size + name.length > 6000) break;
        names.push(name); size += name.length + 2;
      }
      const remaining = extensionCount - names.length;
      return `Connected MCP tool names (schemas load on demand): ${names.join(", ")}.${remaining ? ` ${remaining} more tools are searchable.` : ""}\nUse search_tools with a name or the task you need to do to load relevant connected MCP tool schemas before using them. Search again when the task changes. Known tools from earlier session context can be reused by name; their current definition and permissions are checked.`;
    },
    search(query: string, limit = 5) {
      if (typeof query !== "string" || !query.trim() || query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 5) throw new InputError("Search tools with a query and a limit from 1 to 5");
      const phrase = query.toLowerCase().trim(), terms = phrase.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      const matches = tools.filter(tool => !coreNames.has(tool.name)).map(tool => {
        const name = tool.name.toLowerCase(), description = tool.description.toLowerCase();
        const metadata = tool as ToolDefinition & { originalName?: string; server?: string };
        const identifiers = [name, metadata.originalName?.toLowerCase(), metadata.server?.toLowerCase()].filter((value): value is string => Boolean(value));
        const score = identifiers.includes(phrase) ? 1000 : terms.reduce((sum, term) => sum + (identifiers.some(value => value.includes(term)) ? 15 : description.includes(term) ? 3 : 0), 0);
        return { tool, score };
      }).filter(value => value.score > 0).sort((a,b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name)).slice(0,limit);
      for (const {tool} of matches) activate(tool.name);
      return { tools: matches.map(({tool}) => ({name:tool.name,description:tool.description.slice(0,1200)})), schemasAvailableNextTurn: true,
        message: matches.length ? "Matching tool schemas are available for your next call. Built-in schemas stay loaded; only recently used MCP schemas stay loaded." : "No matching tools. Try a server name or a more specific action." };
    },
  };
}
