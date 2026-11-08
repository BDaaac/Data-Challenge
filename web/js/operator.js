export { appeals } from "./operator_appeals.js";
export { growthChart, strengths, comparison, dates, inPeriod, period, bindPeriod, coaching as criterionAdvice };
import {api,esc,fmt,dt,CH,LANG,AP_ST,failed,ansLabel,pill,busy} from './ui.js';
const head=(title,sub='',actions='')=>`<header class="ph"><div><h1>${title}</h1>${sub?`<p>${sub}</p>`:''}</div>${actions}</header>`;
const stat=(label,value,extra='')=>`<div><div class="l">${label}</div><div class="v">${value}</div>${extra?`<div class="d">${extra}</div>`:''}</div>`;
const empty=t=>`<p class="op-empty">${t}</p>`;
const avg=rs=>{const a=rs.filter(r=>r.total!=null);return a.length?a.reduce((n,r)=>n+Number(r.total),0)/a.length:null;};
const states=new Map();
function state(ctx){if(!states.has(ctx.me.id))states.set(ctx.me.id,{period:'month',from:'',to:'',q:'',channel:'',lang:'',score:'',failed:''});return states.get(ctx.me.id);}
function dates(s){
  if(s.period==='custom')return [s.from,s.to];
  if(s.period==='all')return ['',''];
  const end=new Date(),start=new Date();
  if(s.period==='month')start.setDate(1);else start.setDate(end.getDate()-Number(s.period)+1);
  const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return [iso(start),iso(end)];
}
function inPeriod(r,s){const [a,b]=dates(s),d=String(r.occurred_at||'').slice(0,10);return (!a||d>=a)&&(!b||d<=b);}
function period(s,profile=false){
  const [from,to]=dates(s);
  const short=d=>new Date(d+'T12:00:00').toLocaleDateString('ru-RU',{day:'numeric',month:'short'});
  const range=from&&to?`${short(from)} — ${short(to)}`:'Вся история оценок';
  return `<div class="op-period ${profile?'growth-period-control':''}"><label>${profile?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18"/></svg>':'Период '}<select class="f sm" id="op-period" aria-label="Период оценок">${[['month','Этот месяц'],['all','За всё время'],['7','7 дней'],['30','30 дней'],['custom','Выбрать даты']].map(([v,t])=>`<option value="${v}" ${s.period===v?'selected':''}>${t}</option>`).join('')}</select></label>${profile&&s.period!=='custom'?`<span class="growth-period-range">${esc(range)}</span>`:''}${s.period==='custom'?`<label>С <input class="f sm" type="date" id="op-from" value="${s.from}"></label><label>По <input class="f sm" type="date" id="op-to" value="${s.to}" min="${s.from}"></label>`:''}</div>`;}
function bindPeriod(el,s,draw){el.querySelector('#op-period').onchange=e=>{s.period=e.target.value;draw();};for(const k of ['from','to']){const e=el.querySelector('#op-'+k);if(e)e.onchange=()=>{s[k]=e.value;if(s.from&&s.to&&s.from>s.to)s.to=s.from;draw();};}}
async function ownData(){const rows=await api('/dialogs');for(let i=0;i<rows.length;i+=4){await Promise.all(rows.slice(i,i+4).map(async r=>{const x=await api('/dialogs/'+encodeURIComponent(r.id));r.transcript=x.dialog?.transcript||[];r.criteria=x.evaluation?.checklist.criteria||[];r.items=x.evaluation?.items||{};r.fails=r.criteria.filter(c=>failed(c,r.items[c.id]?.answer));}));}return rows;}
function table(rows,compact=false){return rows.length?`<div class="tw"><table class="t"><thead><tr><th>Дата</th><th>ID</th><th>Канал</th>${compact?'':'<th>Язык</th>'}<th>Оценка</th>${compact?'':'<th>Замечание</th>'}<th></th></tr></thead><tbody>${rows.map(r=>`<tr><td class="num">${dt(r.occurred_at)}</td><td class="mono">${esc(r.id)}</td><td>${esc(CH[r.channel]||r.channel)}</td>${compact?'':`<td>${esc(LANG[r.language]||r.language)}</td>`}<td class="num">${fmt(r.total)} / 100</td>${compact?'':`<td class="wrap">${esc(r.fails.map(c=>c.name).join('; ')||'Без замечаний')}</td>`}<td class="r"><a class="btn sm" href="#/dialog/${encodeURIComponent(r.id)}">Разобрать</a></td></tr>`).join('')}</tbody></table></div>`:empty('За выбранный период оценок нет');}
function comparison(all,s){
  const [from,to]=dates(s);
  if(!from||!to)return {rows:[],from:null,to:null};
  const start=Date.parse(from),end=Date.parse(to),duration=end-start+86400000;
  const a=new Date(start-duration).toISOString().slice(0,10),b=new Date(start-86400000).toISOString().slice(0,10);
  return {from:a,to:b,rows:all.filter(r=>{const d=String(r.occurred_at).slice(0,10);return d>=a&&d<=b;})};
}
function strengths(rows){
  const map=new Map();
  for(const r of rows)for(const c of r.criteria){
    if(c.type==='flag')continue;
    const a=r.items[c.id]?.answer;if(a==null||a==='na')continue;
    const max=Math.max(...c.answers.filter(v=>/^\d+$/.test(v)).map(Number));
    const fraction=c.type==='scale'?(max>0?Number(a)/max:0):a==='yes'?1:0;
    if(!Number.isFinite(fraction))continue;
    const item=map.get(c.id)||{...c,sum:0,n:0,failures:0};
    item.sum+=fraction;item.n++;if(failed(c,a))item.failures++;map.set(c.id,item);
  }
  return [...map.values()].map(c=>({...c,percent:Math.round(100*c.sum/c.n)})).sort((a,b)=>b.percent-a.percent);
}
function growthChart(rows,previous,s){
  const [from,to]=dates(s),start=Date.parse(from),end=Date.parse(to);
  const group=rs=>{const m=new Map();rs.filter(r=>r.total!=null&&r.occurred_at).forEach(r=>{const d=r.occurred_at.slice(0,10),v=m.get(d)||[];v.push(Number(r.total));m.set(d,v);});return [...m].sort(([a],[b])=>a.localeCompare(b)).map(([d,a])=>({d,v:a.reduce((x,y)=>x+y,0)/a.length}));};
  const current=group(rows),past=group(previous.rows);if(!current.length&&!past.length)return empty('За выбранный период оценок нет');
  const first=Number.isFinite(start)?start:Date.parse(current[0]?.d||past[0].d),last=Number.isFinite(end)?end:Date.parse(current.at(-1)?.d||past.at(-1).d),span=Math.max(last-first,86400000);
  const shift=previous.from?first-Date.parse(previous.from):0;
  const x=(d,old=false)=>48+600*(Date.parse(d)+(old?shift:0)-first)/span,y=v=>220-v*1.9;
  const points=(items,old=false)=>items.map(p=>`${x(p.d,old)},${y(p.v)}`).join(' ');
  const line=(items,old)=>`<polyline data-series="${old?'previous':'current'}" points="${points(items,old)}" fill="none" stroke="${old?'#9da2a7':'#a5cd28'}" stroke-width="2" ${old?'stroke-dasharray="6 5"':''}/>${items.map(p=>`<circle cx="${x(p.d,old)}" cy="${y(p.v)}" r="${old?3:4}" fill="${old?'#9da2a7':'#a5cd28'}"><title>${old?'Предыдущий период: ':''}${p.d}: ${fmt(p.v)}</title></circle>`).join('')}`;
  return `<svg class="op-trend" viewBox="0 0 700 260" role="img" aria-label="Средний балл по дням; периоды сопоставлены по порядковому дню">${[0,25,50,75,100].map(v=>`<line x1="48" x2="650" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="6" y="${y(v)+4}">${v}</text>`).join('')}${past.length?line(past,true):''}${current.length?line(current,false):''}${[0,.25,.5,.75,1].map(f=>{const d=new Date(first+span*f).toISOString().slice(0,10);return `<text x="${48+600*f}" y="247" text-anchor="middle">${d.slice(8)}.${d.slice(5,7)}</text>`;}).join('')}${current.length?`<text x="${x(current.at(-1).d)}" y="${y(current.at(-1).v)-12}" text-anchor="middle" class="op-chart-value">${fmt(current.at(-1).v)}</text>`:''}</svg>`;
}
const coaching={c1:'Начните разговор с приветствия и представьтесь.',c2:'Уточните цель обращения и ключевые детали до предложения решения.',c3:'Подтвердите личность клиента до действий со счётом и раскрытия данных.',c4:'Дайте полный и точный ответ по запросу. Проверьте условия и ограничения.',c5:'Покажите, что поняли ситуацию клиента, и предложите конкретную помощь.',c6:'Ведите разговор последовательно, отвечайте своевременно и проверяйте формулировки.',c7:'Подведите итог, назовите следующие шаги и уточните, остались ли вопросы.'};
export async function home(el,ctx){
  const [all,appeals]=await Promise.all([ownData(),api('/appeals')]);if(!ctx.alive())return;
  el.classList.add('op-page','op-growth');const s=state(ctx);
  const draw=()=>{
    const rows=all.filter(r=>inPeriod(r,s)),fresh=rows.filter(r=>['published','revised'].includes(r.wf_status)),previous=comparison(all,s),skills=strengths(rows);
    const mean=avg(rows),old=avg(previous.rows),delta=mean!=null&&old!=null?mean-old:null;
    const currentRisk=rows.filter(r=>r.critical).length,oldRisk=previous.rows.filter(r=>r.critical).length;
    const change=(v,invert=false)=>v==null?'—':`<span class="${v===0?'':(invert?v<0:v>0)?'growth-good':'growth-bad'}">${v>0?'+':''}${fmt(v)}</span>`;
    const hour=new Date().getHours(),greeting=hour<6?'Доброй ночи':hour<12?'Доброе утро':hour<18?'Добрый день':'Добрый вечер';
    const name=ctx.me.name||'Оператор',initials=name.split(/\s+/).slice(0,2).map(x=>x[0]).join(''),languages=[...new Set(all.map(r=>LANG[r.language]||r.language))].filter(Boolean);
    const focus=skills.filter(c=>c.failures).sort((a,b)=>b.failures-a.failures).slice(0,4);
    el.innerHTML=`<header class="growth-profile"><div class="growth-avatar" aria-hidden="true">${esc(initials)}</div><div class="growth-identity"><h1>${greeting}, ${esc(name.split(' ')[0])}</h1><p>${esc(name)} · Оператор${ctx.me.team?' · Команда «'+esc(ctx.me.team)+'»':''}</p><div class="growth-tags"><span>ID ${esc(ctx.me.id)}</span>${languages.length?`<span>${esc(languages.join(' / '))}</span>`:''}</div></div>${period(s,true)}</header>
      <div class="strip growth-metrics">${stat('Средний балл',`${fmt(mean)} <small>/ 100</small>`,delta!=null?`${change(delta)} п.п. к предыдущему периоду`:'')}${stat('Проверено',rows.filter(r=>r.total!=null).length)}${stat('Новые оценки',fresh.length)}${stat('Апелляции',appeals.filter(a=>a.status==='open').length,'На рассмотрении')}</div>
      <div class="growth-grid"><section><h2>Динамика моего качества</h2><p class="growth-caption">Средний балл по оценкам качества</p><div class="growth-legend"><span>Текущий период</span>${previous.rows.length?'<span class="previous">Предыдущий период</span>':''}</div>${growthChart(rows,previous,s)}</section><section><h2>Мои сильные и слабые стороны</h2><p class="growth-caption">Доля полученных баллов по применимым критериям</p><div class="growth-skills">${skills.map(c=>`<div class="growth-skill"><div><span>${esc(c.name)}</span><b>${c.percent}%</b></div><div class="growth-track" role="meter" aria-label="${esc(c.name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${c.percent}"><span style="width:${c.percent}%"></span></div></div>`).join('')||empty('Пока нет применимых оценок')}</div></section></div>
      <div class="growth-grid growth-development"><section><h2>На что обратить внимание</h2><p class="growth-caption">Повторяющиеся замечания и рекомендации</p>${focus.map(c=>`<div class="growth-advice"><span class="growth-warning"></span><div><b>${esc(c.name)}</b><small>Замечаний: ${c.failures}</small></div><p>${esc(coaching[c.id]||c.rule)}</p><a class="btn sm op-error-row" href="#/my/failed=${c.id}">Диалоги</a></div>`).join('')||empty('В этом периоде замечаний нет')}<a class="btn sm" href="#/rules">Критерии оценки</a></section><section><h2>Мой прогресс</h2><p class="growth-caption">Сравнение с предыдущим периодом такой же длительности</p>${previous.from?`<div class="growth-period-note">${previous.from} — ${previous.to}</div>`:''}<div class="tw"><table class="t growth-progress"><thead><tr><th>Показатель</th><th>Предыдущий</th><th>Текущий</th><th>Изменение</th></tr></thead><tbody><tr><td>Средний балл</td><td>${fmt(old)}</td><td>${fmt(mean)}</td><td>${change(delta)}${delta!=null?' п.п.':''}</td></tr><tr><td>Грубые ошибки</td><td>${previous.rows.length?oldRisk:'—'}</td><td>${rows.length?currentRisk:'—'}</td><td>${previous.rows.length&&rows.length?change(currentRisk-oldRisk,true):'—'}</td></tr><tr><td>Проверено диалогов</td><td>${previous.rows.length||'—'}</td><td>${rows.length||'—'}</td><td>${previous.rows.length&&rows.length?rows.length-previous.rows.length:'—'}</td></tr></tbody></table></div>${!previous.rows.length?'<p class="growth-caption growth-no-comparison">Нет оценок за предыдущий период для сравнения.</p>':''}</section></div>
      <section class="growth-latest"><div class="op-section-heading"><div><h2>Новые оценки</h2><p class="growth-caption">Последние оценки качества вашей работы</p></div><a class="btn sm" href="#/my">Все оценки</a></div>${fresh.length?table(fresh.slice(0,5)):empty('Новых оценок нет')}</section>`;
    bindPeriod(el,s,draw);
  };draw();
}
export async function my(el,ctx){const all=await ownData();if(!ctx.alive())return;el.classList.add('op-page');const s=state(ctx);if(ctx.arg){s.failed=new URLSearchParams(ctx.arg).get('failed')||'';ctx.arg='';}const draw=()=>{const rows=all.filter(r=>inPeriod(r,s)&&(!s.channel||r.channel===s.channel)&&(!s.lang||r.language===s.lang)&&(!s.score||(r.total!=null&&(s.score==='high'?r.total>=85:s.score==='mid'?r.total>=65&&r.total<85:r.total<65)))&&(!s.failed||(s.failed==='all'?r.fails.length:r.fails.some(c=>c.id===s.failed)))&&(!s.q||[r.id,CH[r.channel],...r.fails.map(c=>c.name)].join(' ').toLowerCase().includes(s.q.toLowerCase())));const select=(id,values,label)=>`<select class="f sm" id="op-${id}" aria-label="${label}"><option value="">${label}</option>${values.map(([v,t])=>`<option value="${v}" ${s[id]===v?'selected':''}>${t}</option>`).join('')}</select>`;el.innerHTML=head('Мои оценки','Все мои оценки качества')+`<div class="filters op-filters"><input type="search" class="f" id="op-search" value="${esc(s.q)}" placeholder="Поиск по ID, каналу или замечанию" aria-label="Поиск оценок">${period(s)}${select('channel',Object.entries(CH),'Все каналы')}${select('lang',Object.entries(LANG),'Все языки')}${select('score',[['high','85–100'],['mid','65–85'],['low','Ниже 65']],'Все оценки')}${s.failed?'<button class="btn sm" id="op-reset">Снять фильтр ошибок</button>':''}</div>${table(rows)}`;bindPeriod(el,s,draw);for(const k of ['channel','lang','score'])el.querySelector('#op-'+k).onchange=e=>{s[k]=e.target.value;draw();};el.querySelector('#op-search').oninput=e=>{s.q=e.target.value;const pos=e.target.selectionStart;draw();const q=el.querySelector('#op-search');q.focus();q.setSelectionRange(pos,pos);};const reset=el.querySelector('#op-reset');if(reset)reset.onclick=()=>{s.failed='';history.replaceState(null,'','#/my');draw();};};draw();}
export async function rules(el,ctx){
  const list=await api('/checklists'),active=list.find(c=>c.status==='published');
  if(!active){el.innerHTML=empty('Нет опубликованного чек-листа');return;}
  const [checklist,rows]=await Promise.all([api('/checklists/'+active.id),ownData()]);
  if(!ctx.alive())return;
  el.classList.add('op-page','criteria-page');
  let selected=checklist.criteria.find(c=>c.type!=='flag')?.id||checklist.criteria[0]?.id;
  const flag=checklist.criteria.find(c=>c.type==='flag');
  // Split only explicit answer definitions; preserve every word of the published rule.
  const definitions=c=>{
    const text=c.rule||'',matches=[...text.matchAll(/(?:^|[\s;.!?])(Да|Нет|N\/A|\d+)\s*[—–-]\s*/g)]
      .filter(m=>c.answers.includes(({Да:'yes',Нет:'no','N/A':'na'})[m[1]]||m[1]));
    if(!matches.length)return {intro:text,items:[]};
    return {intro:text.slice(0,matches[0].index).trim(),items:matches.map((m,i)=>({label:m[1],answer:({Да:'yes',Нет:'no','N/A':'na'})[m[1]]||m[1],text:text.slice(m.index+m[0].length,matches[i+1]?.index??text.length).trim()}))};
  };
  const draw=()=>{
    const filtered=checklist.criteria;
    if(!filtered.some(c=>c.id===selected))selected=filtered[0]?.id;
    const c=filtered.find(c=>c.id===selected),parsed=c?definitions(c):null;
    const examples=[];
    if(c)for(const row of rows){
      const it=row.items[c.id],original=row.criteria.find(x=>x.id===c.id);
      if(!it||!original||original.rule!==c.rule||original.type!==c.type)continue;
      const quotes=(it.evidence||[]).map(n=>({n,turn:row.transcript[n-1]})).filter(x=>x.turn);
      if(!quotes.length||examples.some(x=>x.answer===it.answer))continue;
      examples.push({row,answer:it.answer,quotes:quotes.slice(0,2),explanation:it.explanation});if(examples.length===2)break;
    }
    el.innerHTML=head('Критерии оценки')+`
      <div class="criteria-workspace"><nav class="criteria-menu" aria-label="Критерии оценки">${filtered.map(x=>`<button type="button" data-criterion="${x.id}" class="${x.id===selected?'on':''}" aria-pressed="${x.id===selected}"><span>${esc(x.name)}</span><small>${x.type==='flag'?'Без веса':x.weight+' %'}</small></button>`).join('')||empty('Критерий не найден')}</nav>
      <section class="criteria-detail" aria-live="polite">${c?`<div class="criteria-heading"><h2>${esc(c.name)}</h2><span class="criteria-weight">${c.type==='flag'?'Флаг риска':c.weight+' %'}</span></div>${parsed.intro?`<p class="criteria-intro">${esc(parsed.intro)}</p>`:''}
      <div class="criteria-conditions">${parsed.items.map(i=>`<section class="criteria-condition ${i.answer==='yes'?'positive':i.answer==='no'?'negative':'neutral'}"><h3>${esc(i.label.toUpperCase())}</h3><p>${esc(i.text)}</p></section>`).join('')}</div>
      ${!parsed.items.length?`<div class="op-answers">${c.answers.map(a=>`<span class="pill na">${esc(ansLabel(c,a))}</span>`).join('')}</div>`:''}
      <section class="criteria-examples"><h3>Примеры из ваших диалогов</h3>${examples.map(x=>`<article class="criteria-example ${failed(c,x.answer)?'negative':'positive'}"><div class="criteria-example-heading"><span class="pill ${failed(c,x.answer)?'bad':'ok'}">${esc(ansLabel(c,x.answer))}</span><a class="btn sm" href="#/dialog/${encodeURIComponent(x.row.id)}">${esc(x.row.id)}</a></div>${x.quotes.map(({n,turn})=>`<blockquote><span>Реплика #${n} · ${esc(({client:'Клиент',operator:'Оператор',bot:'Бот',system:'Система'})[turn.speaker]||turn.speaker)}</span>${esc(turn.text)}</blockquote>`).join('')}${x.explanation?`<p>${esc(x.explanation)}</p>`:''}</article>`).join('')||empty('В ваших оценённых диалогах пока нет примеров для этого правила.')}</section>`:empty('Измените поисковый запрос')}</section>
      <aside class="criteria-help"><section><h3>Как рассчитывается балл</h3>${c&&c.type!=='flag'?`<div class="criteria-weight-track" role="meter" aria-label="Вес выбранного критерия" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Number(c.weight)}"><span style="width:${Math.max(0,Math.min(100,Number(c.weight)))}%"></span></div><div class="criteria-weight-label"><b>${c.weight} из 100</b><span>Базовый вес</span></div>`:''}<p>Каждый применимый критерий имеет свой вес в общем результате. Если ответ — N/A, его вес распределяется между остальными применимыми критериями пропорционально их весам.</p></section><section><h3>Грубые ошибки</h3><p>Направляют диалог на проверку. Флаг риска учитывается отдельно и не обнуляет арифметический балл.</p>${flag?`<p>${esc(flag.rule)}</p><button class="btn sm" id="criteria-show-risk">Все грубые ошибки</button>`:''}</section></aside></div>`;
    el.querySelectorAll('[data-criterion]').forEach(b=>b.onclick=()=>{selected=b.dataset.criterion;draw();});
    const risk=el.querySelector('#criteria-show-risk');if(risk)risk.onclick=()=>{selected=flag.id;draw();el.querySelector('.criteria-detail').scrollIntoView({block:'start',behavior:'smooth'});};
  };draw();
}
export async function appealNew(el,ctx){const [id,query='']=ctx.arg.split('?'),params=new URLSearchParams(query),data=await api('/dialogs/'+encodeURIComponent(id));if(!ctx.alive())return;el.classList.add('op-page');const e=data.evaluation,criteria=e?.checklist.criteria||[];if(!e||!['published','acknowledged','revised'].includes(data.dialog.wf_status)){el.innerHTML=head('Апелляция')+empty('На эту оценку сейчас нельзя подать апелляцию')+`<a class="btn" href="#/dialog/${encodeURIComponent(id)}">К оценке</a>`;return;}let crit=params.get('crit')||criteria.find(c=>failed(c,e.items[c.id]?.answer))?.id||criteria[0]?.id,want=params.get('want')||'',text='',proof='';const draw=()=>{const c=criteria.find(c=>c.id===crit)||criteria[0];crit=c.id;const options=c.answers.filter(a=>a!==e.items[crit]?.answer);if(!options.includes(want))want=options[0];el.innerHTML=head('Подать апелляцию','Запрос на пересмотр оценки',`<a class="btn sm" href="#/dialog/${encodeURIComponent(id)}">К оценке</a>`)+`<form class="op-appeal-form" id="op-appeal-form"><div class="op-form-grid"><label>Оценка (ID диалога)<input class="f" value="${esc(id)}" readonly></label><label>Критерий<select class="f" id="op-crit">${criteria.map(x=>`<option value="${x.id}" ${crit===x.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label></div><div class="op-desired"><span>Желаемое решение</span><div class="seg" role="group" aria-label="Желаемое решение">${c.answers.map(a=>`<button type="button" data-want-op="${a}" class="${want===a?'on':''}" aria-pressed="${want===a}" ${a===e.items[crit]?.answer?'disabled title="Текущий ответ"':''}>${esc(ansLabel(c,a))}</button>`).join('')}</div></div><label>Обоснование<textarea class="f" id="op-reason" rows="5" required minlength="10" maxlength="2000" placeholder="Объясните, почему ответ нужно изменить">${esc(text)}</textarea></label><div class="op-counter" id="op-counter">${text.length} / 2000</div><label>Доказательство (реплика)<select class="f" id="op-proof" required><option value="">Выберите реплику</option>${data.dialog.transcript.map((t,i)=>`<option value="${i+1}" ${proof===String(i+1)?'selected':''}>#${i+1} · ${esc(t.text.slice(0,120))}</option>`).join('')}</select></label>${proof?`<blockquote class="op-proof">${esc(data.dialog.transcript[Number(proof)-1].text)}</blockquote>`:''}<div class="err hidden" id="op-form-error" role="alert"></div><div class="acts"><button class="btn pri" type="submit">Отправить апелляцию</button></div></form>`;el.querySelector('#op-crit').onchange=x=>{crit=x.target.value;want='';draw();};el.querySelectorAll('[data-want-op]').forEach(b=>b.onclick=()=>{want=b.dataset.wantOp;draw();});el.querySelector('#op-reason').oninput=x=>{text=x.target.value;el.querySelector('#op-counter').textContent=text.length+' / 2000';};el.querySelector('#op-proof').onchange=x=>{proof=x.target.value;draw();};el.querySelector('form').onsubmit=x=>{x.preventDefault();const error=el.querySelector('#op-form-error');if(text.trim().length<10){error.textContent='Добавьте обоснование: минимум 10 символов';error.classList.remove('hidden');return;}busy(x.submitter,async()=>{try{const result=await api('/dialogs/'+encodeURIComponent(id)+'/appeal',{body:{items:[{crit,want}],text:text.trim()+(proof?'\nДоказательство: реплика #'+proof:'')}});ctx.refresh();ctx.go('appeals/'+result.id);}catch(e){error.textContent=e.message;error.classList.remove('hidden');}});};};draw();}
