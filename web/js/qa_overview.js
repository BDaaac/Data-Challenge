import { analyticsMarkup, hydrateAnalytics } from './qa_analytics.js';
import { api, esc, fmt, dt } from './ui.js';
export async function qaOverview(el, ctx) {
  const [o, dialogs] = await Promise.all([api('/stats/overview'), api('/dialogs')]);
  if (!ctx.alive()) return;
  const scored = dialogs.filter(d => d.total != null && d.occurred_at);
  const days = new Map();
  for (const d of scored) { const key = d.occurred_at.slice(0,10); const a = days.get(key) || []; a.push(Number(d.total)); days.set(key,a); }
  const series = [...days].sort(([a],[b])=>a.localeCompare(b)).map(([date,a])=>({date,value:a.reduce((x,y)=>x+y,0)/a.length}));
  const pts=series.map((x,i)=>`${40+i*620/Math.max(series.length-1,1)},${220-x.value*1.8}`).join(' ');
  el.innerHTML = `<div class="ph"><div><h1>Обзор</h1><p>Качество работы контакт-центра</p></div><a class="btn" href="#/queue">К проверке · ${o.process.review}</a></div>
    <div class="strip"><div><div class="l">Средняя оценка</div><div class="v">${fmt(o.avg)} <small>/ 100</small></div></div><div><div class="l">Диалогов оценено</div><div class="v">${o.done}</div></div><div><div class="l">Доля грубых ошибок</div><div class="v">${o.done ? fmt(o.critical/o.done*100) + '%' : '—'}</div></div></div>
    <div class="qa-overview-grid"><section><h2>Динамика качества</h2>${series.length ? `<svg class="qa-trend" viewBox="0 0 700 260" role="img" aria-label="Динамика среднего балла: ${series.map(x=>`${x.date}: ${fmt(x.value)}`).join('; ')}">${[0,25,50,75,100].map(v=>`<line x1="40" x2="675" y1="${220-v*1.8}" y2="${220-v*1.8}" stroke="var(--line)"/><text x="0" y="${224-v*1.8}" fill="var(--fg-3)" font-size="12">${v}</text>`).join('')}<polyline points="${pts}" fill="none" stroke="#68766c" stroke-width="2"/>${series.map((x,i)=>`<circle cx="${40+i*620/Math.max(series.length-1,1)}" cy="${220-x.value*1.8}" r="4" fill="#68766c"><title>${x.date}: ${fmt(x.value)}</title></circle>`).join('')}<text x="40" y="250" fill="var(--fg-3)" font-size="12">${esc(series[0].date)}</text><text x="660" y="250" text-anchor="end" fill="var(--fg-3)" font-size="12">${esc(series.at(-1).date)}</text></svg>` : '<p class="qa-no-chart">Пока нет оценок с датой разговора.</p>'}</section>
    <section><h2>Зоны внимания</h2><div class="qa-problems">${o.loss.filter(x=>x.failed).sort((a,b)=>b.failed-a.failed).slice(0,5).map(x=>`<a href="#/dialogs/failed=${encodeURIComponent(x.crit)}"><span>${esc(x.name)}</span><b>${x.failed}</b></a>`).join('') || '<p>Нарушений в оценённых диалогах нет.</p>'}</div><a class="qa-text-link" href="#/dashboard">Подробная аналитика</a></section></div>
    ${analyticsMarkup(o, dialogs)}
    <div class="qa-overview-footer"><span>Всего в системе: ${o.dialogs} диалогов</span><a href="#/appeals">Апелляции</a></div>`;
  const analytics = el.querySelector('.qa-analytics');
  analytics.id = 'qa-analytics';
  el.insertAdjacentHTML('beforeend', `<button type="button" class="qa-scroll-cue" aria-controls="qa-analytics" aria-label="Перейти к статистике ниже" hidden><span class="qa-scroll-icon" aria-hidden="true"></span><span>Статистика ниже</span></button>`);
  const cue = el.querySelector('.qa-scroll-cue');
  const heading = analytics.querySelector('h2');
  const controller = new AbortController();
  const initialScroll = el.scrollTop;
  let dismissed = false;
  const updateCue = () => {
    if (!ctx.alive()) { controller.abort(); return; }
    if (Math.abs(el.scrollTop - initialScroll) > 8) dismissed = true;
    cue.hidden = dismissed || heading.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom - 24;
  };
  cue.onclick = () => {
    dismissed = true;
    cue.hidden = true;
    const top = el.scrollTop + analytics.getBoundingClientRect().top - el.getBoundingClientRect().top - 24;
    el.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };
  el.addEventListener('scroll', updateCue, { passive: true, signal: controller.signal });
  window.addEventListener('resize', updateCue, { signal: controller.signal });
  window.addEventListener('hashchange', () => controller.abort(), { once: true, signal: controller.signal });
  requestAnimationFrame(updateCue);
  document.fonts.ready.then(updateCue);
  void hydrateAnalytics(el, ctx, dialogs);
}
