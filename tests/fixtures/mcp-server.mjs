import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'linubot-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
const many = process.argv.includes('--many-tools');
const tools = many ? Array.from({length:150},(_,i)=>({name:`long_original_tool_name_${i}`,description:`Record operation ${i}`,inputSchema:{type:'object',properties:{text:{type:'string'}}}})) : [{ name: 'echo_text', description: 'Echo supplied text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } }];
server.setRequestHandler(ListToolsRequestSchema, async request => { const offset=Number(request.params?.cursor??0);return {tools:tools.slice(offset,offset+75),...(offset+75<tools.length?{nextCursor:String(offset+75)}:{})}; });
server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: 'text', text: String(request.params.arguments?.text) }] }));
await server.connect(new StdioServerTransport());
