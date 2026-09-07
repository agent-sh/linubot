import { it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createPhoneAccess } from "../src/phone/access.ts";
import { phoneNetwork } from "../src/phone/tailscale.ts";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "linubot-phone-")), prior = process.env.LINUBOT_DATA; process.env.LINUBOT_DATA = dir;
  cleanup.push(() => { if (prior === undefined) delete process.env.LINUBOT_DATA; else process.env.LINUBOT_DATA = prior; rmSync(dir, {recursive:true,force:true}); });
  const target = createServer((req,res) => { res.setHeader('content-type','application/json'); res.end(JSON.stringify({path:req.url,token:req.headers['x-linubot-token'],origin:req.headers.origin})); });
  await new Promise<void>(resolve => target.listen(0,'127.0.0.1',resolve)); cleanup.push(() => new Promise<void>(resolve => target.close(() => resolve())));
  const port = (target.address() as {port:number}).port;
  const gateway = createPhoneAccess({ target:() => ({port,token:'desktop-secret'}),webRoot:resolve('web'),port:0 }); cleanup.push(() => gateway.close());
  const origin='https://fixture.ts.net:45874'; await gateway.enable(origin);
  const accessPort=(gateway.server.address() as {port:number}).port;
  function request(path:string, options:{method?:string;body?:unknown;cookie?:string;host?:string;origin?:string}={}) {
    return new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;body:string}>((resolve,reject) => {
      const req=httpRequest({hostname:'127.0.0.1',port:accessPort,path,method:options.method??'GET',headers:{host:options.host??'fixture.ts.net:45874',...(options.origin?{origin:options.origin}:{}),...(options.cookie?{cookie:options.cookie}:{}),...(options.body?{'content-type':'application/json'}:{})}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body}));});req.on('error',reject);req.end(options.body?JSON.stringify(options.body):undefined);
    });
  }
  const pair=async()=>{const code=gateway.pair().code;const result=await request('/phone-session',{method:'POST',origin,body:{code,name:'Fixture phone'}});assert.equal(result.status,200,result.body);return result.headers['set-cookie']![0].split(';')[0];};
  return {dir,gateway,request,pair,origin,target};
}
it('requires one-use pairing, proxies authenticated requests and protects desktop-only management',async()=>{
  const {gateway,request,origin,dir}=await fixture();
  assert.equal((await request('/api/bots')).status,401);
  assert.equal((await request('/',{host:'attacker.example'})).status,403);
  const pairing=gateway.pair();
  assert.equal((await request('/phone-session',{method:'POST',body:{code:pairing.code,name:'Phone'}})).status,403);
  const paired=await request('/phone-session',{method:'POST',origin,body:{code:pairing.code,name:'Phone'}});assert.equal(paired.status,200);
  const setCookie=paired.headers['set-cookie']![0];assert.match(setCookie,/Secure; HttpOnly; SameSite=Strict/);const cookie=setCookie.split(';')[0];
  assert.equal((await request('/phone-session',{method:'POST',origin,body:{code:pairing.code,name:'Again'}})).status,401);
  assert.equal(JSON.parse((await request('/api/bots',{cookie})).body).token,'desktop-secret');
  for(const path of ['/api/phone','/api/%70hone/pair'])assert.equal((await request(path,{cookie})).status,403);
  assert.equal((await request('/api/bots',{cookie,origin:'https://attacker.example'})).status,403);
  assert.ok(!readFileSync(join(dir,'phone-devices.json'),'utf8').includes(cookie.split('=')[1]));
  gateway.revoke(gateway.status().devices[0].id);assert.equal((await request('/api/bots',{cookie})).status,401);
});
it('limits pairing attempts and preserves paired devices across a gateway restart',async()=>{
  const {gateway,request,origin,dir,pair}=await fixture();const cookie=await pair();
  const code=gateway.pair().code;
  for(let i=0;i<5;i++)assert.equal((await request('/phone-session',{method:'POST',origin,body:{code:'wrong',name:'Other'}})).status,401);
  assert.equal((await request('/phone-session',{method:'POST',origin,body:{code,name:'Other'}})).status,401);
  await gateway.close();
  const restored=createPhoneAccess({target:()=>({port:9,token:'unused'}),webRoot:resolve('web'),port:0});cleanup.push(()=>restored.close());
  assert.equal(restored.status().devices.length,1);assert.equal(restored.status().enabled,true);
  assert.ok(readFileSync(join(dir,'phone-devices.json'),'utf8').includes('Fixture phone'));assert.ok(cookie.length>40);
  await restored.disable();assert.equal(restored.status().enabled,false);
});
it('does not overwrite another Tailscale service or configure Funnel',async()=>{
  const calls:string[][]=[];
  const command=async(args:string[])=>{calls.push(args);return args[0]==='status'?JSON.stringify({BackendState:'Running',Self:{DNSName:'fixture.ts.net.'}}):JSON.stringify({TCP:{443:{HTTPS:true}},Web:{'fixture.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:9000'}}}}});};
  const network=await phoneNetwork(command);await network.configure();assert.deepEqual(calls.at(-1),['serve','--bg','--https=45874','--yes','http://127.0.0.1:45873']);
  await assert.rejects(()=>phoneNetwork(async args=>args[0]==='status'?await command(args):JSON.stringify({TCP:{45874:{HTTPS:true}},Web:{'fixture.ts.net:45874':{Handlers:{'/':{Proxy:'http://127.0.0.1:9999'}}}}})),/already used/);
});

it('closes downstream streams when the backend aborts and when a paired device is revoked', async () => {
  const {gateway,pair,target} = await fixture(); const cookie=await pair();
  let backend: import('node:http').ServerResponse | undefined;
  target.removeAllListeners('request'); target.on('request',(_req,res)=>{ backend=res; res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: ready\n\n'); });
  const port=(gateway.server.address() as {port:number}).port;
  async function stream() {
    return new Promise<{ended:Promise<void>}>((resolve,reject)=>{
      const req=httpRequest({hostname:'127.0.0.1',port,path:'/api/stream',headers:{host:'fixture.ts.net:45874',cookie}},res=>{
        const ended=new Promise<void>(done=>{res.once('aborted',done);res.once('end',done);res.once('error',()=>done());});
        res.once('data',()=>resolve({ended}));res.resume();
      });req.once('error',reject);req.end();
    });
  }
  const first=await stream();backend!.destroy();await first.ended;
  const second=await stream();gateway.revoke(gateway.status().devices[0].id);await second.ended;
});
