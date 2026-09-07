import { test,expect,_electron as electron } from '@playwright/test';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
test('phone access pairs and revokes a device from desktop settings',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'linubot-phone-ui-'));
 const env={...process.env,WAYLAND_DISPLAY:'',XDG_SESSION_TYPE:'x11',LINUBOT_UPDATE_CHECK:'0',LINUBOT_DATA:join(directory,'store'),LINUBOT_DESKTOP_PROFILE:join(directory,'profile')};delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({args:[resolve('desktop/main.cjs')],env,...(process.env.LINUBOT_TEST_EXECUTABLE?{executablePath:process.env.LINUBOT_TEST_EXECUTABLE,args:[]}: {})});
 try{
  const page=await app.firstWindow();await expect(page.getByRole('heading',{name:'Your bots',exact:true})).toBeVisible();
  let enabled=false,devices=[];
  const status=()=>({enabled,listening:enabled,origin:enabled?'https://fixture.ts.net:45874':'',port:45873,devices});
  await page.route('**/api/phone',route=>route.fulfill({json:status()}));
  await page.route('**/api/phone/enable',route=>{enabled=true;return route.fulfill({json:status()});});
  await page.route('**/api/phone/pair',route=>route.fulfill({json:{code:'12345ABCDE',url:'https://fixture.ts.net:45874/phone-pair#12345ABCDE',expiresAt:Date.now()+300000,qr:'data:image/png;base64,'+readFileSync('desktop/icon.png').toString('base64')}}));
  await page.route('**/api/phone/devices/*',route=>{devices=[];return route.fulfill({json:status()});});
  await page.evaluate(()=>{location.hash='#/settings/phone';});
  await page.getByRole('button',{name:'Enable phone access',exact:true}).click();
  await page.getByRole('button',{name:'Pair a phone',exact:true}).click();
  await expect(page.getByAltText('Pair this phone with Linubot',{exact:true})).toBeVisible();
  await expect(page.locator('[data-pairing]')).toContainText('12345ABCDE');
  devices=[{id:'fixture-device',name:'My Android',expiresAt:Date.now()+86400000}];
  await expect(page.getByText('My Android',{exact:false})).toBeVisible({timeout:6000});
  await page.getByRole('button',{name:'Revoke',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Revoke',exact:true}).click();
  await expect(page.getByText('No phones paired yet.',{exact:true})).toBeVisible();
 }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});
