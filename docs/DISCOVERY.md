# Skills and tools on demand

Bots start with a small set of discovery and conversation-management tools, plus
compact catalogs of names. Full skill instructions and all MCP schemas are not
injected into every prompt.

- `list_skills` searches approved skills attached to the bot and returns a
  bounded page of names and descriptions.
- `read_skill_file` loads `SKILL.md` for a selected skill, or one supporting file.
- `search_tools` searches available built-in and connected MCP tool names and
  descriptions. It loads up to five matching tool schemas for the next model call.

The runtime retains at most twelve recently searched/used non-core tool schemas.
A known tool from earlier session context can be reused by name; its current
catalog entry and normal permissions are checked. Tool search does not execute
the returned tools or grant approval. Disconnected/unavailable tools are not
made callable just because the model remembers their names.

MCP metadata is indexed on the Linux runtime, outside the model prompt. Each
server can expose up to 1,000 tools across 20 pages; larger or unfinished catalogs
produce a visible connection error rather than silently hiding the tail. The
initial names-only tool catalog is bounded; searches can find tools beyond that
visible list. This portable implementation works across Linubot's supported
function-calling providers without requiring a provider-specific hosted search
API. It uses lexical name/description matching, not an embedding service.

Loaded instructions and tool results remain normal session observations and can
be compacted. Original records stay available through `read_session`. Imported
memories stay in the bot's context store, with a bounded prompt excerpt and
`read_memory` retrieval for other details.
