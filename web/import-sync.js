import {post,esc,dialog,action,feedback} from './ui.js';
export async function openImportSync(ctx,scope) {
 const modal=dialog('Sync latest from source','<p>Checking newer sessions and saved knowledge…</p><div data-feedback hidden></div>');
 try {
  const value=await post('/api/imports/sync/preview',{scope},{timeout:60000});if(!modal.alive()||!ctx.current())return;
  const conflicts=value.changes.filter(change=>change.status==='conflict');
  modal.root.innerHTML=`<h2>Review source updates</h2><p>${value.messages} new historical messages · ${value.changes.filter(change=>change.status!=='conflict').length} knowledge updates · ${conflicts.length} conflicts</p><p>Only the checked source snapshot will be applied. Active tasks must finish first. New skills will be attached and available to these bots.</p>${value.changes.map(change=>`<article class="import-preview-bot"><h3>${esc(change.bot)} · ${esc(change.kind)}${change.name?` · ${esc(change.name)}`:''}</h3><p>${change.status==='conflict'?'Changed locally: your Linubot version will be kept unless you choose replacement below.':change.status==='new'?'New source content':'Updated source content'}</p><details><summary>Source version</summary><pre class="technical">${esc(change.sourceText)}</pre>${change.files?.length?`<p>Supporting files: ${change.files.map(esc).join(', ')}</p>`:''}</details>${change.status==='conflict'?`<details><summary>Your Linubot version</summary><pre class="technical">${esc(change.localText)}</pre></details>`:''}</article>`).join('')}${value.warnings.length?`<details open><summary>Source limitations</summary><ul>${value.warnings.map(warning=>`<li>${esc(warning)}</li>`).join('')}</ul></details>`:''}${conflicts.length?'<label class="check-label"><input type="checkbox" data-replace-conflicts>Replace conflicting Linubot knowledge with the source versions shown above</label>':''}<div data-feedback hidden></div><div class="actions"><button class="primary" data-apply-sync>Sync now</button><button data-close-sync>Cancel</button></div>`;
  modal.root.querySelector('[data-close-sync]').onclick=()=>modal.close();
  modal.root.querySelector('[data-apply-sync]').onclick=()=>void action(modal.root,async()=>{
   const result=await post('/api/imports/sync/commit',{id:value.id,replaceConflicts:modal.root.querySelector('[data-replace-conflicts]')?.checked??false},{timeout:60000});
   if(!modal.alive())return;ctx.changed();
   modal.root.innerHTML=`<h2>Sync complete</h2><p>${result.messages} messages added. ${result.updated} knowledge items updated.${result.conflicts?` ${result.conflicts} local changes kept.`:''}</p><button class="primary" data-done-sync>Back to conversation</button>`;
   modal.root.querySelector('[data-done-sync]').onclick=()=>{modal.close();if(ctx.current())ctx.reload();};
  },'Syncing the reviewed snapshot…');
 } catch(error) {if(modal.alive())feedback(modal.root,error.message);}
}
