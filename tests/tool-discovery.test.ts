import {createMcpRuntime} from "../src/mcp/client.ts";
import {addMcpServer} from "../src/mcp/manager.ts";
import {fileURLToPath} from "node:url";
import {it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createToolDiscovery} from '../src/agents/tool-discovery.ts';
import {createBot,updateBot} from '../src/bots/manager.ts';
import {setProvider} from '../src/auth/store.ts';
import {saveLearnedSkill,approveSkill} from '../src/marketplace/search.ts';
import {savePermission} from '../src/agents/permissions.ts';
import {agentContext,createAgentRuntime} from '../src/agents/runtime.ts';

it('search loads only matching tool schemas and bounds the recent schema set',()=>{
 const tools=Array.from({length:60},(_,i)=>({name:`tool_${i}`,description:`Operation ${i}`,parameters:{type:'object',properties:{}}}));
 const discovery=createToolDiscovery(tools);
 assert.deepEqual(discovery.active(),[]);
 for(let i=0;i<30;i++)assert.equal(discovery.search(`tool_${i}`,1).tools[0].name,`tool_${i}`);
 assert.equal(discovery.active().length,12);assert.equal(discovery.active().some(tool=>tool.name==='tool_0'),false);
 assert.equal(discovery.resolve('tool_0')?.name,'tool_0');assert.equal(discovery.active().length,12);
 assert.equal(discovery.resolve('not_registered'),undefined);
 assert.throws(()=>discovery.search('all',60),/limit/);
});
it('keeps skill bodies and MCP schemas out of the initial context, then discovers and uses them',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'linubot-discovery-')),prior=process.env.LINUBOT_DATA;process.env.LINUBOT_DATA=dir;
 setProvider({kind:'openai-compat',baseUrl:'https://fixture.example/v1',model:'fixture',apiKey:'fixture-key'});createBot('Finder');
 saveLearnedSkill({name:'research',description:'Research source evidence',body:'SKILL_BODY_ONLY_AFTER_READ'});approveSkill('research');updateBot('Finder',{skills:['research']});savePermission('auto','Finder');
 const schemas=Array.from({length:200},(_,i)=>({name:`remote_${i}`,server:'fixture',originalName:`operation_${i}`,readOnly:true,description:`Search record ${i}`,parameters:{type:'object',properties:{query:{type:'string',description:'FULL_SCHEMA_SENTINEL'.repeat(80)}}}}));
 let calls=0,invoked=0;
 const mcp={tools:async()=>schemas,status:()=>({}),call:async()=>{invoked++;return {content:[{type:'text',text:'REMOTE_FOUND'}]};}};
 const runtime=createAgentRuntime({review:false,mcp:mcp as never,complete:async(_provider,messages,tools)=>{
  calls++;
  if(calls===1){
   assert.ok(messages[0].content.includes('research'));assert.ok(!messages[0].content.includes('SKILL_BODY_ONLY_AFTER_READ'));assert.ok(!messages[0].content.includes('FULL_SCHEMA_SENTINEL'));
   assert.ok(tools.some(tool=>tool.name==='search_tools'));assert.ok(!tools.some(tool=>tool.name.startsWith('remote_')));assert.ok(JSON.stringify(tools).length<20000);
   return {text:'',toolCalls:[{id:'discover',name:'search_tools',arguments:'{"query":"remote_199","limit":1}'}]};
  }
  if(calls===2){assert.ok(tools.some(tool=>tool.name==='remote_199'));assert.ok(!tools.some(tool=>tool.name==='remote_198'));return {text:'',toolCalls:[{id:'use',name:'remote_199',arguments:'{"query":"source evidence"}'}]};}
  if(calls===3)return {text:'',toolCalls:[{id:'read-skill',name:'read_skill_file',arguments:'{"skill":"research","path":"SKILL.md"}'}]};
  assert.ok(messages.some(message=>message.role==='tool'&&message.content.includes('SKILL_BODY_ONLY_AFTER_READ')));
  return {text:'Discovered and used the relevant tool and skill',toolCalls:[]};
 }});
 try{assert.ok(!agentContext('Finder').system.includes('SKILL_BODY_ONLY_AFTER_READ'));const [run]=runtime.enqueue({scope:'bot:Finder',message:'Find the relevant tool and research skill'});const result=await runtime.wait(run.id);assert.equal(result.status,'completed',result.error??'');assert.equal(invoked,1);}finally{await runtime.close();if(prior===undefined)delete process.env.LINUBOT_DATA;else process.env.LINUBOT_DATA=prior;rmSync(dir,{recursive:true,force:true});}
});

it('searches tools beyond the old prompt caps through real paginated MCP discovery', async () => {
 const dir=mkdtempSync(join(tmpdir(),'linubot-mcp-discovery-')),prior=process.env.LINUBOT_DATA;process.env.LINUBOT_DATA=dir;
 addMcpServer('many',{command:process.execPath,args:[fileURLToPath(new URL('./fixtures/mcp-server.mjs',import.meta.url)),'--many-tools'],approved:true});
 const mcp=createMcpRuntime();
 try{
  const tools=await mcp.tools();assert.equal(tools.length,150);
  const target=tools.find(tool=>tool.originalName==='long_original_tool_name_149')!;
  const discovery=createToolDiscovery(tools);assert.equal(discovery.search('long_original_tool_name_149',1).tools[0].name,target.name);
  const result=await mcp.call(target,{text:'PAGINATED_TOOL_OK'},new AbortController().signal);assert.ok(JSON.stringify(result).includes('PAGINATED_TOOL_OK'));
 }finally{await mcp.close();if(prior===undefined)delete process.env.LINUBOT_DATA;else process.env.LINUBOT_DATA=prior;rmSync(dir,{recursive:true,force:true});}
});
