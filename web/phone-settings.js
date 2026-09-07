import { api, post, esc, action, feedback, confirmAction } from './ui.js';
export async function phoneSettings(ctx, root) {
  if (ctx.getOverview().capabilities?.phone) {
    root.innerHTML = '<section class="section"><h2>This phone is connected</h2><p>Your tasks run on Linux. Manage pairing, revoke devices and connect OAuth providers in the Linux app’s Settings.</p></section>'; return;
  }
  const initial = await ctx.get('/api/phone'); if (!ctx.current()) return;
  let deviceCount = initial.devices.length;
  function render(value) {
    deviceCount = value.devices.length;
    root.innerHTML = `<section class="section"><h2>Your bots on your phone</h2><p>Use Linubot from an Android app or your phone’s browser, on Wi-Fi or away from home. Your Linux computer runs the tasks and keeps the data.</p><p>Install and sign in to <a href="https://tailscale.com/download" target="_blank" rel="noopener">Tailscale</a> on both devices using the same account. Keep Linubot running on Linux; enable “Keep running in background” in its app menu.</p><div class="actions">${value.enabled ? '<button class="primary" data-pair>Pair a phone</button><button class="small danger" data-disable>Disable phone access</button>' : '<button class="primary" data-enable>Enable phone access</button>'}<a class="button small" href="https://github.com/agent-sh/linubot/releases/latest" target="_blank" rel="noopener">Download Android app</a></div>${value.origin ? `<p>Computer address: <a href="${esc(value.origin)}" target="_blank" rel="noopener">${esc(value.origin)}</a></p>` : ''}${value.error ? `<p class="form-feedback error">${esc(value.error)}</p>` : ''}<div data-feedback hidden></div><section data-pairing hidden></section><h3>Paired devices</h3>${value.devices.length ? value.devices.map(device => `<div class="section-heading"><span>${esc(device.name)} · expires ${esc(new Date(device.expiresAt).toLocaleDateString())}</span><button class="small danger" data-revoke="${esc(device.id)}">Revoke</button></div>`).join('') : '<p class="field-hint">No phones paired yet.</p>'}<details><summary>Use your own HTTPS proxy</summary><p>Forward your HTTPS origin to <code>127.0.0.1:${value.port}</code>, preserving the Host header. This grants paired devices full control of this Linubot installation. Keep the proxy private.</p><form data-custom><label>HTTPS computer address<input name="origin" type="url" placeholder="https://computer.example.com" required></label><button class="small">Use this address</button></form></details></section>`;
    root.querySelector('[data-enable]')?.addEventListener('click', () => void action(root, async () => { const next = await post('/api/phone/enable', {}, { timeout:60000 }); if (ctx.current()) render(next); }, 'Setting up private phone access…'));
    root.querySelector('[data-disable]')?.addEventListener('click', () => confirmAction('Disable phone access?', 'Connected phones will be disconnected. Your Linux bots keep running.', async modal => { const next = await post('/api/phone/disable'); modal.close(); if (ctx.current()) render(next); }, {label:'Disable'}));
    root.querySelector('[data-pair]')?.addEventListener('click', () => void action(root, async () => {
      const pair = await post('/api/phone/pair'); if (!ctx.current()) return;
      const area = root.querySelector('[data-pairing]'); area.hidden = false;
      area.innerHTML = `<h3>Scan with your phone camera</h3><img src="${esc(pair.qr)}" width="256" height="256" alt="Pair this phone with Linubot"><p>Or open the computer address above in the Android app and enter <strong>${esc(pair.code)}</strong>.</p><p class="field-hint">One use, expires in five minutes. Anyone who uses this code can access your bots, approve actions and control their computers. Share it only with your own device.</p>`;
    }, 'Creating pairing code…'));
    root.querySelectorAll('[data-revoke]').forEach(button => { button.onclick = () => confirmAction('Revoke this phone?', 'This device will lose access immediately and will need a new pairing code.', async modal => { const next = await api(`/api/phone/devices/${encodeURIComponent(button.dataset.revoke)}`, {method:'DELETE'}); modal.close(); if (ctx.current()) render(next); }, {label:'Revoke',danger:true}); });
    root.querySelector('[data-custom]').onsubmit = event => { event.preventDefault(); const origin = new FormData(event.currentTarget).get('origin'); void action(root, async () => { const next = await post('/api/phone/enable', {origin}); if (ctx.current()) render(next); }, 'Saving phone access…'); };
  }
  render(initial);
  const timer = setInterval(async () => {
    try { const value = await ctx.get('/api/phone'); if (ctx.current() && !root.querySelector('[data-pairing]')?.hidden && value.devices.length > deviceCount) { render(value); feedback(root, 'Phone paired. You can use your bots there now.', 'success'); } } catch { /* The next refresh can retry. */ }
  }, 3000);
  ctx.onCleanup(() => clearInterval(timer));
}
