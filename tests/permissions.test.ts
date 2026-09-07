import { it,afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBot,deleteBot } from '../src/bots/manager.ts';
import { botPermission,permissionSettings,savePermission } from '../src/agents/permissions.ts';
import { createAgentRuntime } from '../src/agents/runtime.ts';
import { setProvider } from '../src/auth/store.ts';
import { bus } from '../src/events/log.ts';
import type { FeedEvent } from '../src/events/log.ts';
const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
function setup(){const prior=process.env.LINUBOT_DATA,dir=mkdtempSync(join(tmpdir(),'linubot-permissions-'));process.env.LINUBOT_DATA=dir;cleanup.push(()=>{if(prior===undefined)delete process.env.LINUBOT_DATA;else process.env.LINUBOT_DATA=prior;rmSync(dir,{recursive:true,force:true});});setProvider({kind:'openai-compat',baseUrl:'https://fixture.example/v1',model:'fixture',apiKey:'fixture-key'});createBot('Trusted');createBot('Ask');}
it('defaults to asking, applies bot overrides, and removes overrides with the bot',()=>{setup();assert.equal(permissionSettings().mode,'ask');assert.equal(botPermission('Trusted').mode,'ask');savePermission('auto');savePermission('ask','Ask');assert.equal(botPermission('Trusted').mode,'auto');assert.equal(botPermission('Ask').mode,'ask');savePermission('auto','Trusted');savePermission('ask');assert.equal(botPermission('Trusted').mode,'auto');deleteBot('Trusted');createBot('Trusted');assert.equal(botPermission('Trusted').mode,'ask');assert.throws(()=>savePermission('invalid'),/Choose/);});
it('always approve resolves the current request and skips later prompts across runtime restart',async()=>{
 setup();let calls=0;const id='linubot-10000000-0000-4000-8000-000000000001';
 const computer={owns:(value:string)=>value===id,start:async()=>({id}),stop:async()=>'{"ok":true}',cleanup:async()=>{}};
 const complete=async()=>++calls%2?{text:'',toolCalls:[{id:`start-${calls}`,name:'start_workspace',arguments:'{"purpose":"Approval-mode fixture"}'}]}:{text:'Finished without another prompt',toolCalls:[]};
 let runtime=createAgentRuntime({review:false,computer:computer as never,complete});
 const pending:FeedEvent[]=[],approved:FeedEvent[]=[];
 const listener=(scope:string,event:FeedEvent)=>{if(scope!=='bot:Trusted'||event.kind!=='approval')return;if(event.status==='pending'){pending.push(event);setImmediate(()=>runtime.decide(scope,event.seq,'always'));}else if(event.status==='approved')approved.push(event);};bus.on('event',listener);cleanup.push(()=>{bus.off('event',listener);});
 try{
  const [first]=runtime.enqueue({scope:'bot:Trusted',message:'Use the computer'});assert.equal((await runtime.wait(first.id)).status,'completed');assert.equal(botPermission('Trusted').mode,'auto');assert.equal(botPermission('Ask').mode,'ask');
  assert.throws(()=>runtime.decide('bot:Trusted',pending[0].seq,'always'),/expired/);
  await runtime.close();runtime=createAgentRuntime({review:false,computer:computer as never,complete});
  const [second]=runtime.enqueue({scope:'bot:Trusted',message:'Use the computer again'});assert.equal((await runtime.wait(second.id)).status,'completed');assert.equal(pending.length,1);assert.ok(approved.some(event=>event.text?.includes('Automatically approved')));
 }finally{await runtime.close();}
});
it('changing the default mode releases already-pending approvals',async()=>{
 setup();const id='linubot-10000000-0000-4000-8000-000000000001';let calls=0,ready!:()=>void;const pending=new Promise<void>(resolve=>ready=resolve);
 const computer={owns:(value:string)=>value===id,start:async()=>({id}),stop:async()=>'{"ok":true}',cleanup:async()=>{}};
 const runtime=createAgentRuntime({review:false,computer:computer as never,complete:async()=>++calls===1?{text:'',toolCalls:[{id:'start',name:'start_workspace',arguments:'{"purpose":"Default approval fixture"}'}]}:{text:'Done',toolCalls:[]}});
 const listener=(scope:string,event:FeedEvent)=>{if(scope==='bot:Trusted'&&event.kind==='approval'&&event.status==='pending')ready();};bus.on('event',listener);
 try{const [run]=runtime.enqueue({scope:'bot:Trusted',message:'Open the computer'});await pending;runtime.setPermissionMode('auto');assert.equal((await runtime.wait(run.id)).status,'completed');}finally{bus.off('event',listener);await runtime.close();}
});
