import { api, esc, fmt, REASON } from './ui.js';
const href = id => `#/dialog/${encodeURIComponent(id)}`;
const shortDate = date => `${date.slice(8,10)}.${date.slice(5,7)}`;
const empty = text => `<div class="qa-chart-empty">${text}</div>`;

export function analyticsMarkup(o, dialogs) {
  const done = dialogs.filter(d => d.eval_status === 'done' && d.total != null);
  const bins = Array.from({length:5},(_,i)=>({label:`${i*20}–${(i+1)*20}`,n:0}));
  for (const d of done) bins[Math.min(4,Math.max(0,Math.floor(Number(d.total)/20)))].n++;
  const maxPct = Math.max(20,...bins.map(b=>done.length ? b.n/done.length*100:0));
  const top = Math.ceil(maxPct/20)*20;
  const histogram = done.length ? `<svg viewBox="0 0 560 270" role="img" aria-label="Распределение оценок: ${bins.map(b=>`${b.label} баллов: ${b.n} диалогов`).join('; ')}">
    ${Array.from({length:5},(_,i)=>{const v=top*i/4,y=220-i*45;return `<line x1="48" x2="548" y1="${y}" y2="${y}"/><text x="0" y="${y+4}" text-anchor="start">${v}%</text>`}).join('')}
    ${bins.map((b,i)=>{const pct=b.n/done.length*100,h=pct/top*180,x=62+i*97;return `<rect x="${x}" y="${220-h}" width="74" height="${h}" fill="${i===4?'#64796c':'#cbd2cb'}"><title>${b.label}: ${b.n} из ${done.length}, ${fmt(pct)}%</title></rect><text x="${x+37}" y="${Math.max(22,210-h)}" text-anchor="middle" class="chart-value">${fmt(pct)}%</text><text x="${x+37}" y="245" text-anchor="middle">${b.label}</text>`}).join('')}</svg>` : empty('Распределение появится после завершения первых оценок.');
  const days=new Map();
  for(const d of done.filter(d=>d.occurred_at)){const date=d.occurred_at.slice(0,10);days.set(date,(days.get(date)||0)+(d.critical?1:0));}
  const daily=[...days].sort(([a],[b])=>a.localeCompare(b));
  const max=Math.max(4,...daily.map(([,n])=>n));
  const axis=Math.ceil(max/4)*4;
  const x=i=>52+i*474/Math.max(daily.length-1,1),y=n=>220-n/axis*180;
  const risks=daily.length ? `<svg viewBox="0 0 560 270" role="img" aria-label="Грубые ошибки по датам разговоров: ${daily.map(([d,n])=>`${d}: ${n}`).join('; ')}">${[0,1,2,3,4].map(i=>`<line x1="48" x2="548" y1="${220-i*45}" y2="${220-i*45}"/><text x="0" y="${224-i*45}" text-anchor="start">${axis*i/4}</text>`).join('')}<polyline points="${daily.map(([,n],i)=>`${x(i)},${y(n)}`).join(' ')}" fill="none" stroke="#bc6469" stroke-width="2"/>${daily.map(([d,n],i)=>`<circle cx="${x(i)}" cy="${y(n)}" r="4" fill="#bc6469"><title>${d}: ${n} диалогов с грубой ошибкой</title></circle>${i===0||i===daily.length-1||i%Math.max(1,Math.ceil(daily.length/6))===0?`<text x="${x(i)}" y="245" text-anchor="middle">${shortDate(d)}</text>`:''}`).join('')}</svg>`:empty('Нет завершённых оценок с датой разговора.');
  const losses=o.loss.filter(l=>l.failed>0).sort((a,b)=>b.failed-a.failed);
  const largest=Math.max(1,...losses.map(l=>l.failed));
  return `<section class="qa-analytics"><header><h2>Аналитика проверок</h2></header>
    <div class="qa-chart-grid"><section><h3>Распределение оценок</h3>${histogram}</section><section><h3>Грубые ошибки по дням</h3>${risks}</section></div>
    <section class="qa-losses"><h3>Нарушения по критериям</h3>${losses.length?losses.slice(0,7).map(l=>`<a class="qa-loss-row" href="#/dialogs/failed=${encodeURIComponent(l.crit)}"><span>${esc(l.name)}</span><span class="qa-bar-track" aria-hidden="true"><span style="width:${l.failed/largest*100}%"></span></span><b>${l.failed}</b></a>`).join(''):empty('Нарушений по критериям пока нет.')}</section>
    <section class="qa-quality"><header><h2>Ручной пересмотр</h2></header><div id="qa-human-checks" aria-live="polite"><p class="chart-caption">Загружаем сведения о ручных проверках…</p></div></section>
    <section class="qa-review-list"><div class="qa-subhead"><h3>Требуют ручной проверки</h3><a href="#/queue">Вся очередь</a></div><div id="qa-review-table" aria-live="polite"><p class="chart-caption">Загружаем очередь…</p></div></section>
    <details class="qa-data-notes"><summary>О данных</summary><div>
      <p>Графики построены по ${done.length} завершённым оценкам. Диапазоны включают нижнюю границу: 0–20 означает от 0 до 20, не включая 20; последний диапазон включает 100.</p>
      <p>Грубые ошибки сгруппированы по дате разговора. Показаны только дни с завершёнными оценками. В рейтинге нарушений один диалог может учитываться в нескольких критериях.</p>
      <p>Сравнение ИИ и QA показывает до 6 диалогов с ручными правками, в баллах из 100. Оно не измеряет точность модели. В таблице приведены первые 6 диалогов очереди.</p>
      <p>Уверенность — минимальная самооценка модели среди оценённых критериев, а не вероятность правильного ответа.</p>
    </div></details>
  </section>`;
}

export async function hydrateAnalytics(el, ctx, dialogs) {
  try {
    const queue=await api('/queue');
    if(!ctx.alive())return;
    const ids=[...new Set([...dialogs.filter(d=>d.eval_status==='done').map(d=>d.id),...queue.map(d=>d.id)])];
    const results=new Map();let cursor=0,failed=0;
    await Promise.all(Array.from({length:Math.min(4,ids.length)},async()=>{
      while(cursor<ids.length){const id=ids[cursor++];try{results.set(id,await api('/dialogs/'+encodeURIComponent(id)))}catch{failed++}}
    }));
    if(!ctx.alive())return;
    const edited=[...results.values()].filter(d=>Object.values(d.evaluation?.items||{}).some(i=>['qa','appeal'].includes(i.source)));
    const paired=edited.filter(d=>d.evaluation.status==='done' && d.evaluation.ai_total!=null && d.evaluation.total!=null);
    const changed=paired.filter(d=>Math.abs(Number(d.evaluation.ai_total)-Number(d.evaluation.total))>0.005);
    const comparable=paired.slice(0,6);
    const comparisons=comparable.length?`<div class="qa-compare-legend"><span><i class="ai-dot"></i>Исходная оценка ИИ</span><span><i class="qa-dot"></i>После ручных правок</span></div><div class="qa-comparison">${comparable.map(d=>{const ai=Number(d.evaluation.ai_total),qa=Number(d.evaluation.total);return `<a class="qa-compare-row" href="${href(d.dialog.id)}"><span>${esc(d.dialog.id)}</span><span class="qa-pair-track" aria-hidden="true"><i class="ai-dot" style="left:${ai}%"></i><i class="qa-dot" style="left:${qa}%"></i></span><span class="qa-pair-values">ИИ ${fmt(ai)} · QA ${fmt(qa)}</span></a>`}).join('')}</div>`:empty('Ручных правок пока нет.');
    el.querySelector('#qa-human-checks').innerHTML=`<div class="qa-quality-grid"><section><h3>Изменения балла</h3>${comparisons}</section><dl class="qa-quality-stats"><div><dt>Диалогов с ручными правками</dt><dd>${edited.length}</dd></div><div><dt>Изменился итоговый балл</dt><dd>${changed.length}</dd></div><div><dt>Апелляции в очереди</dt><dd>${queue.filter(d=>d.wf_status==='appeal').length}</dd></div></dl></div>${failed?'<p class="chart-footnote">Часть сведений не загрузилась; статистика ручных правок неполная.</p>':''}`;
    el.querySelector('#qa-review-table').innerHTML=queue.length?`<div class="tw"><table class="t"><thead><tr><th>Диалог</th><th>Причина</th><th>Мин. уверенность ИИ</th><th>Действие</th></tr></thead><tbody>${queue.slice(0,6).map(d=>{const items=Object.values(results.get(d.id)?.evaluation?.items||{});const conf=items.filter(i=>i.status==='ok'&&i.confidence!=null).map(i=>Number(i.confidence));const reasons=[...new Set((d.review||[]).map(r=>REASON[r.code]?.[1]||r.code))];if(d.wf_status==='appeal')reasons.unshift('Апелляция');return `<tr><td><b>${esc(d.id)}</b></td><td class="wrap">${esc(reasons.join(' · ')||'Проверка оценки')}</td><td>${conf.length?Math.round(Math.min(...conf)*100)+'%':'—'}</td><td><a href="${href(d.id)}">Открыть</a></td></tr>`}).join('')}</tbody></table></div>`:empty('Очередь пуста. Все диалоги, требовавшие внимания, разобраны.');
  } catch {
    if(!ctx.alive())return;
    for(const id of ['qa-human-checks','qa-review-table'])el.querySelector('#'+id).innerHTML=empty('Не удалось загрузить данные. Обновите страницу или откройте очередь проверки.');
  }
}
