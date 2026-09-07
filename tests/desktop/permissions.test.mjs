import {test,expect,_electron as electron} from '@playwright/test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
test('permission settings persist global automatic mode and a per-bot ask override',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'linubot-permission-ui-'));
 const env={...process.env,WAYLAND_DISPLAY:'',XDG_SESSION_TYPE:'x11',LINUBOT_UPDATE_CHECK:'0',LINUBOT_DATA:join(directory,'store'),LINUBOT_DESKTOP_PROFILE:join(directory,'profile')};delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({args:[resolve('desktop/main.cjs')],env,...(process.env.LINUBOT_TEST_EXECUTABLE?{executablePath:process.env.LINUBOT_TEST_EXECUTABLE,args:[]}: {})});
 try{
  const page=await app.firstWindow();await expect(page.getByRole('heading',{name:'Your bots',exact:true})).toBeVisible();
  await page.evaluate(async()=>{for(const name of ['Trusted','Ask'])await fetch('/api/bots',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})});location.hash='#/settings/permissions';});
  await page.getByLabel('Default for bots',{exact:true}).selectOption('auto');
  await page.getByRole('button',{name:'Save permission mode',exact:true}).click();
  await expect(page.locator('[data-default-permission]')).toContainText('Permission mode saved');
  const ask=page.locator('[data-bot-permission="Ask"]');await ask.locator('select').selectOption('ask');await ask.getByRole('button',{name:'Save for Ask',exact:true}).click();
  await expect(ask).toContainText('Bot permission mode saved');
  const value=await page.evaluate(()=>fetch('/api/permissions').then(r=>r.json()));expect(value.mode).toBe('auto');expect(value.bots.find(bot=>bot.name==='Ask').mode).toBe('ask');
  await page.evaluate(()=>{location.hash='#/bot/Trusted';});
  await expect(page.locator('[data-bot-status]')).toContainText('Always approve');
 }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});
