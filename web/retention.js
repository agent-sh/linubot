import { api, post, esc, submit, action, feedback } from './ui.js';

export async function retentionControls(ctx, root) {
  const value = await ctx.get('/api/retention'); if (!ctx.current()) return;
  const labels = { 'computer-profiles': 'Browser profiles', screenshots: 'Screenshots', contexts: 'Contexts', artifacts: 'Artifacts', 'live-frames': 'Live frames' };
  const bytes = value => `${(value / 1048576).toFixed(2)} MiB`;
  root.innerHTML = `<h2>Disk usage</h2><dl class="retention-sizes" data-sizes></dl><p>Free browser caches from idle computers while keeping saved logins. Old screenshots are removed unless recent activity or an unfinished task still references them. Live frames expire after one hour.</p><form data-retention-settings><label>Screenshot retention (days)<input name="screenshotDays" type="number" min="1" max="3650" step="1" required value="${value.settings.screenshotDays}"></label><button>Save retention settings</button><div data-feedback hidden></div></form><div data-retention-run><button type="button" class="small" data-free>Free space now</button><div data-feedback hidden></div></div>`;
  const paint = sizes => { root.querySelector('[data-sizes]').innerHTML = Object.entries(sizes).map(([key, size]) => `<div><dt>${esc(labels[key] || key)}</dt><dd>${bytes(size.bytes)}</dd></div>`).join(''); };
  paint(value.sizes);
  const form = root.querySelector('form');
  submit(form, async data => { await api('/api/retention', { method: 'PUT', body: { screenshotDays: Number(data.get('screenshotDays')) } }); if (ctx.current()) feedback(form, 'Retention settings saved.', 'success'); });
  const run = root.querySelector('[data-retention-run]');
  root.querySelector('[data-free]').onclick = () => void action(run, async () => {
    const result = await post('/api/retention/run');
    const status = await ctx.get('/api/retention'); if (!ctx.current()) return;
    paint(status.sizes); feedback(run, `Freed ${bytes(result.bytes)} from ${result.files} files.`, 'success');
  }, 'Freeing space...');
}
