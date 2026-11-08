import {api,esc,dt,failed,CH,LANG,AP_ST,pill,busy,toast} from './ui.js';
import {growthChart,strengths,comparison,inPeriod,period,bindPeriod,criterionAdvice} from './operator.js';
import {dialog as inspector} from './v_dialog.js';

const states=new Map();
const state=ctx=>{if(!states.has(ctx.me.id))states.set(ctx.me.id,{period:'month',from:'',to:''});return states.get(ctx.me.id);};
const empty=t=>`<p class="lead-empty">${t}</p>`;
const mean=rows=>{const a=rows.filter(r=>r.total!=null&&r.eval_status==='done');return a.length?a.reduce((n,r)=>n+Number(r.total),0)/a.length:null;};
const done=r=>r.total!=null&&r.eval_status==='done';
const published=r=>['published','acknowledged','revised','appeal'].includes(r.wf_status)&&done(r);
const num=v=>v==null?'—':Number(v).toLocaleString('ru-RU',{maximumFractionDigits:1});
const delta=(a,b)=>a==null||b==null?'':`<span class="${a>=b?'lead-up':'lead-down'}">${a>=b?'+':''}${num(a-b)} п.п.</span>`;
const link=(href,label='Открыть')=>`<a class="btn sm" href="#/${href}">${label}</a>`;
const ph=(title,sub='',actions='')=>`<header class="ph"><div><h1>${title}</h1>${sub?`<p>${esc(sub)}</p>`:''}</div>${actions}</header>`;
const stat=(title,value,extra='')=>`<div><span>${title}</span><strong>${value}</strong>${extra}</div>`;
const option=(v,t,selected)=>`<option value="${esc(v)}" ${v===selected?'selected':''}>${esc(t)}</option>`;
const employeeHref=name=>'employee/'+encodeURIComponent(name);
const planHref=(kind='plan',operator='',dialog='',criterion='')=>'coaching/'+encodeURIComponent(new URLSearchParams({kind,operator,dialog,criterion}).toString());
const statusNames={planned:'Запланировано',work:'В работе',done:'Выполнено'};
const dateOnly=v=>v?new Date(v+'T12:00:00').toLocaleDateString('ru-RU'):'Без срока';
function decorate(data){for(const r of data.rows){r.fails=r.criteria.filter(c=>r.items[c.id]?.status==='ok'&&failed(c,r.items[c.id]?.answer));}return data;}
async function load(){const [data,appeals]=await Promise.all([api('/lead/workspace'),api('/appeals')]);return {...decorate(data),appeals};}
function groupMembers(data,rows,s){
  const names=[...new Set([...data.members.map(m=>m.name),...data.rows.map(r=>r.operator)])];
  return names.map(name=>{const rs=rows.filter(r=>r.operator===name&&done(r)),old=comparison(data.rows.filter(r=>r.operator===name&&done(r)),s).rows;
    const skills=strengths(rs),weak=skills.filter(c=>c.failures).sort((a,b)=>b.failures-a.failures)[0];
    return {name,id:data.members.find(m=>m.name===name)?.id,rows:rs,avg:mean(rs),previous:mean(old),critical:rs.filter(r=>r.critical).length,weak,skills};
  }).sort((a,b)=>(a.avg??101)-(b.avg??101));
}
function rowItem(title,sub,href,extra=''){return `<div class="lead-item"><div><b>${esc(title)}</b>${sub?`<small>${esc(sub)}</small>`:''}</div>${extra}${link(href)}</div>`;}
function people(members){return members.length?members.map(m=>`<div class="lead-person"><div><b>${esc(m.name)}</b><small>${num(m.avg)} / 100 · ${esc(m.weak?.name||'Нет замечаний')}</small></div>${link(employeeHref(m.name),'Разобрать')}</div>`).join(''):empty('Нет сотрудников с замечаниями');}
function dialogTable(rows,withEmployee=true){return rows.length?`<div class="tw"><table class="t"><thead><tr><th>Дата</th>${withEmployee?'<th>Сотрудник</th>':''}<th>Диалог</th><th>Оценка</th><th>Замечания</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td>${dt(r.occurred_at)}</td>${withEmployee?`<td>${esc(r.operator)}</td>`:''}<td class="mono">${esc(r.id)}<small class="sub">${esc(CH[r.channel]||r.channel)} · ${esc(r.language)}</small></td><td class="lead-nowrap">${num(r.total)} / 100</td><td>${esc(r.fails.map(c=>c.name).join(', ')||'Без замечаний')}</td><td>${link('dialog/'+encodeURIComponent(r.id),'Разобрать')}</td></tr>`).join('')}</tbody></table></div>`:empty('Диалогов за выбранный период нет');}
function plansHTML(plans){return plans.length?plans.map(p=>`<div class="lead-plan"><div><b>${esc(p.title)}</b><small>${esc(p.operator||'Вся группа')} · ${dateOnly(p.due)}</small>${p.criterion_name?`<small>${esc(p.criterion_name)} · Приоритет: ${esc(({low:'низкий',medium:'средний',high:'высокий'})[p.priority]||'средний')}</small>`:''}${p.expected_result?`<p><b>Ожидаемый результат:</b> ${esc(p.expected_result)}</p>`:''}${p.note?`<p>${esc(p.note)}</p>`:''}${p.dialog_id?link('dialog/'+encodeURIComponent(p.dialog_id),'Диалог'):''}</div>${p.task_id?`<a class="btn" href="#/development/${p.task_id}">${p.task_status==='submitted'?'Проверить результат':p.task_status==='completed'?'Выполнена':'Открыть задачу'}</a>`:`<label class="lead-plan-status"><span class="sr-only">Статус ${esc(p.title)}</span><select class="f sm" data-plan-status="${p.id}">${Object.entries(statusNames).map(([v,t])=>option(v,t,p.status)).join('')}</select></label>`}</div>`).join(''):empty('Пока нет записей');}
function bindPlans(el,data){el.querySelectorAll('[data-plan-status]').forEach(select=>select.onchange=async()=>{const p=data.plans.find(p=>p.id===Number(select.dataset.planStatus)),before=p.status;select.disabled=true;try{const result=await api('/lead/plans/'+p.id,{method:'PATCH',body:{status:select.value}});Object.assign(p,result);toast('Статус сохранён');}catch(e){select.value=before;toast(e.message,true);}finally{select.disabled=false;}});}
function section(title,body,action=''){return `<section><div class="lead-section-head"><h2>${title}</h2>${action}</div>${body}</section>`;}
function metrics(rows,old,appeals){return `<div class="lead-stats">${stat('Качество группы',num(mean(rows))+' / 100',delta(mean(rows),mean(old)))}${stat('Диалогов оценено',rows.filter(done).length)}${stat('Грубые ошибки',rows.filter(r=>done(r)&&r.critical).length)}${stat('Апелляции в работе',appeals.filter(a=>a.status==='open').length)}</div>`;}
function chart(rows,old,s){return `<div class="growth-legend"><span>Текущий период</span><span class="previous">Предыдущий период</span></div>${growthChart(rows.filter(done),{...old,rows:old.rows.filter(done)},s)}`;}

export async function home(el,ctx){
  const data=await load();if(!ctx.alive())return;el.classList.add('lead-page');const s=state(ctx);
  const draw=()=>{const rows=data.rows.filter(r=>inPeriod(r,s)),old=comparison(data.rows,s),members=groupMembers(data,rows,s),attention=members.filter(m=>m.critical||m.weak),tasks=data.plans.filter(p=>p.kind==='task'&&p.status!=='done'),pending=rows.filter(r=>r.wf_status==='review');
    el.innerHTML=`<header class="lead-profile"><div><h1>${new Date().getHours()<12?'Доброе утро':new Date().getHours()<18?'Добрый день':'Добрый вечер'}, ${esc(ctx.me.name.split(' ')[0])}</h1><p>${esc(ctx.me.name)} · Руководитель группы · ${esc(ctx.me.team||'Группа не назначена')}</p><div class="lead-chips"><span>ID TL-${ctx.me.id}</span><span>${data.members.length} сотрудников</span></div></div>${period(s,true)}</header>
    ${metrics(rows,old.rows,data.appeals)}
    <div class="lead-grid">${section('Качество моей группы',chart(rows,old,s))}${section('Что требует моего внимания',people(attention.slice(0,3))+(pending.length?rowItem('Ожидают проверки QA',pending.length+' диалогов','qa-control'):'') )}</div>
    <div class="lead-grid">${section('Мои задачи',plansHTML(tasks),link(planHref('task'),'Добавить задачу'))}${section('Сотрудники — внимание',people(attention.slice(0,4)),link('team','Вся команда'))}</div>
    <div class="lead-section">${section('Планы улучшения',plansHTML(data.plans.filter(p=>p.kind==='plan')),link(planHref(),'Добавить план'))}</div>
    <div class="lead-section">${section('Последние события',data.events.slice(0,6).map(e=>rowItem(e.text,dt(e.at)+' · '+e.operator,'dialog/'+encodeURIComponent(e.dialog_id))).join('')||empty('Событий пока нет'))}</div>`;
    bindPeriod(el,s,draw);bindPlans(el,data);
  };draw();
}

export async function overview(el,ctx){
  const data=await load();if(!ctx.alive())return;el.classList.add('lead-page','lead-group-overview');const s=state(ctx);
  const draw=()=>{
    const rows=data.rows.filter(r=>inPeriod(r,s)),evaluated=rows.filter(done),old=comparison(data.rows,s),previous=old.rows.filter(done),currentMean=mean(evaluated),previousMean=mean(previous);
    const skills=strengths(evaluated).filter(c=>c.failures).sort((a,b)=>b.failures-a.failures);
    const members=groupMembers(data,rows,s).filter(m=>m.critical||m.weak).sort((a,b)=>Number(b.critical>0)-Number(a.critical>0)||(a.avg??101)-(b.avg??101));
    const appealCount=data.appeals.filter(a=>inPeriod({occurred_at:a.created_at},s)).length;
    const comparisonLabel=previousMean!=null&&currentMean!=null?`${delta(currentMean,previousMean)} <span>к предыдущему периоду</span>`:'<span>Нет данных для сравнения</span>';
    const trend=`${growthChart(evaluated,{...old,rows:previous},s)}<div class="growth-legend group-chart-legend"><span>Текущий период — ${num(currentMean)}</span>${previous.length?`<span class="previous">Предыдущий период — ${num(previousMean)}</span>`:''}</div>`;
    const criteria=skills.length?`<ol class="group-criteria">${skills.slice(0,5).map((c,i)=>`<li><span class="group-rank">${i+1}</span><span>${esc(c.name)}</span><b>${c.failures}</b><meter min="0" max="${c.n}" value="${c.failures}" aria-label="${esc(c.name)}: замечания в ${c.failures} из ${c.n} применимых оценок">${c.failures} из ${c.n}</meter>${link('dialogs/failed='+encodeURIComponent(c.id),'Диалоги')}</li>`).join('')}</ol>`:empty('В выбранном периоде замечаний нет');
    const peopleTable=members.length?`<div class="tw"><table class="t group-attention"><thead><tr><th>Сотрудник</th><th>Средний балл</th><th>Слабый критерий</th><th>Грубая ошибка</th><th></th></tr></thead><tbody>${members.map(m=>`<tr><td>${esc(m.name)}</td><td><b>${num(m.avg)}</b> / 100</td><td>${esc(m.weak?.name||'—')}</td><td>${m.critical?pill('bad','Есть'):'—'}</td><td>${link(employeeHref(m.name),'Разобрать')}</td></tr>`).join('')}</tbody></table></div>`:empty('Нет сотрудников, которым нужен разбор по оценкам за этот период');
    el.innerHTML=ph('Обзор группы','Группа «'+ctx.me.team+'»',period(s,true))+`<div class="lead-stats">${stat('Средний балл качества',num(currentMean)+' / 100',delta(currentMean,previousMean))}${stat('Оценено диалогов',evaluated.length)}${stat('Грубых ошибок',evaluated.filter(r=>r.critical).length)}${stat('Апелляций',appealCount)}</div>
      <div class="lead-grid group-quality-grid"><section><div class="lead-section-head"><h2>Динамика качества</h2><div class="group-comparison">${comparisonLabel}</div></div>${trend}</section>${section('Критерии с частыми замечаниями',criteria)}</div>
      <div class="lead-section">${section('Сотрудники, которым нужен разбор',peopleTable,link('team','Вся команда'))}</div>
      <p class="group-data-note">На графике — средний балл за день. Сравнение — с предыдущим периодом такой же длительности.</p>`;
    bindPeriod(el,s,draw);
  };draw();
}

export async function team(el,ctx){
  const data=await load();if(!ctx.alive())return;el.classList.add('lead-page');const s=state(ctx);let q='',filter='',sort='avg';
  const draw=()=>{let members=groupMembers(data,data.rows.filter(r=>inPeriod(r,s)),s).filter(m=>(m.name+' '+(m.id||'')).toLowerCase().includes(q.toLowerCase())&&(!filter||filter==='risk'&&m.critical||filter==='weak'&&m.weak));
    if(sort==='name')members.sort((a,b)=>a.name.localeCompare(b.name));else if(sort==='critical')members.sort((a,b)=>b.critical-a.critical);
    el.innerHTML=ph('Команда',ctx.me.team)+`<div class="filters"><input class="f" type="search" id="lead-search" value="${esc(q)}" placeholder="Найти сотрудника" aria-label="Найти сотрудника">${period(s)}<select class="f" id="lead-filter" aria-label="Состояние сотрудника">${[['','Все сотрудники'],['risk','Грубые ошибки'],['weak','Есть замечания']].map(([v,t])=>option(v,t,filter)).join('')}</select><select class="f" id="lead-sort" aria-label="Сортировка">${[['avg','Сначала низкий балл'],['name','По имени'],['critical','По грубым ошибкам']].map(([v,t])=>option(v,t,sort)).join('')}</select></div>
    ${members.length?`<div class="tw"><table class="t lead-team"><thead><tr><th>Сотрудник</th><th>Средняя оценка</th><th>Изменение</th><th>Оценено</th><th>Грубые ошибки</th><th>Проблемный критерий</th><th></th></tr></thead><tbody>${members.map(m=>`<tr><td><a class="lead-name" href="#/${employeeHref(m.name)}">${esc(m.name)}</a></td><td>${num(m.avg)} / 100</td><td>${delta(m.avg,m.previous)||'—'}</td><td>${m.rows.length}</td><td>${m.critical}</td><td>${esc(m.weak?.name||'—')}</td><td>${link(employeeHref(m.name),'Разобрать')}</td></tr>`).join('')}</tbody></table></div>`:empty('Сотрудники не найдены')}`;
    bindPeriod(el,s,draw);el.querySelector('#lead-filter').onchange=e=>{filter=e.target.value;draw();};el.querySelector('#lead-sort').onchange=e=>{sort=e.target.value;draw();};el.querySelector('#lead-search').oninput=e=>{q=e.target.value;const pos=e.target.selectionStart;draw();const n=el.querySelector('#lead-search');n.focus();n.setSelectionRange(pos,pos);};
  };draw();
}

export async function employee(el,ctx){
  const data=await load();if(!ctx.alive())return;el.classList.add('lead-page','lead-employee-review');const s=state(ctx),name=ctx.arg,cache=new Map();let version=0;
  const draw=async()=>{
    const token=++version,m=groupMembers(data,data.rows.filter(r=>inPeriod(r,s)),s).find(m=>m.name===name);
    if(!m){el.innerHTML=ph('Сотрудник недоступен')+link('team','К команде');return;}
    const rows=[...m.rows].sort((a,b)=>new Date(b.evaluated_at||b.occurred_at)-new Date(a.evaluated_at||a.occurred_at)),last=rows[0];
    let evaluation=null;
    if(last){if(!cache.has(last.eval_id))cache.set(last.eval_id,api('/evaluations/'+last.eval_id));try{evaluation=await cache.get(last.eval_id);}catch(e){cache.delete(last.eval_id);if(ctx.alive()&&token===version){el.innerHTML=ph('Карточка сотрудника')+`<p class="lead-empty">${esc(e.message)}</p><button class="btn" id="employee-retry">Повторить</button>`;el.querySelector('#employee-retry').onclick=()=>draw();}return;}}
    if(!ctx.alive()||token!==version)return;
    const plans=data.plans.filter(p=>p.operator===name&&p.kind!=='feedback'),feedback=data.plans.filter(p=>p.operator===name&&p.kind==='feedback'),criteria=evaluation?.checklist.criteria||[],items=evaluation?.items||{},score=evaluation?.score;
    const issues=criteria.filter(c=>items[c.id]?.status==='ok'&&failed(c,items[c.id]?.answer)).sort((a,b)=>Number(b.type==='flag')-Number(a.type==='flag')||((score?.max[b.id]||0)-(score?.pts[b.id]||0))-((score?.max[a.id]||0)-(score?.pts[a.id]||0)));
    const why=c=>items[c.id]?.override_reason||items[c.id]?.explanation||'Откройте диалог, чтобы разобрать критерий в контексте разговора.';
    const all=data.rows.filter(r=>r.operator===name),old=comparison(all,s),days=new Set(rows.map(r=>r.occurred_at?.slice(0,10)));
    const scoreRows=criteria.map(c=>{const it=items[c.id],answer=it?.answer,issue=it?.status==='ok'&&failed(c,answer);let points=it?.status!=='ok'||answer==null?'Нет оценки':c.type==='flag'?(answer==='yes'?'Есть нарушение':'Нет нарушения'):answer==='na'?'N/A':score?.max[c.id]!=null?`${num(score.pts[c.id])} / ${num(score.max[c.id])}`:'Нет оценки';return `<tr><td>${esc(c.name)}</td><td class="employee-points ${issue?'lead-down':''}">${esc(points)}</td></tr>`;}).join('');
    const reason=issues.slice(0,2).map(c=>`<p><b>${esc(c.name)}.</b> ${esc(why(c))}</p>`).join('');
    const breakdown=last?`<p class="employee-dialog-meta">${link('dialog/'+encodeURIComponent(last.id),last.id)}<span>${esc(CH[last.channel]||last.channel)}</span><span>${dt(last.occurred_at)}</span></p><div class="employee-score-summary"><div><strong>${num(evaluation.total)} / 100</strong><small>Итоговая оценка за диалог</small></div><div><meter min="0" max="100" value="${Number(evaluation.total)||0}" aria-label="Итоговая оценка">${num(evaluation.total)}</meter><div class="employee-score-legend"><span>${num(evaluation.total)} баллов получено</span><span>${num(100-Number(evaluation.total))} не набрано</span></div></div></div><div class="tw"><table class="t employee-criteria"><thead><tr><th>Критерий</th><th>Получено / максимум</th></tr></thead><tbody>${scoreRows}</tbody></table></div>${reason?`<div class="employee-reason"><span>Причины замечаний</span><div>${reason}${link('dialog/'+encodeURIComponent(last.id),'Открыть диалог')}</div></div>`:empty('По этой оценке замечаний нет')}`:empty('За выбранный период нет завершённых оценок');
    const priority=issues.length?`<ol class="employee-priorities">${issues.slice(0,2).map(c=>`<li><h3>${esc(c.name)}</h3><p>${esc(criterionAdvice[c.id]||c.rule||why(c))}</p>${link(planHref('task',name,last.id,c.id),'Создать задачу')}</li>`).join('')}</ol>`:empty('В последней оценке нет замечаний для разбора');
    const recent=rows.length?`<div class="tw"><table class="t"><thead><tr><th>Дата оценки</th><th>Диалог</th><th>Итоговая оценка</th><th>Замечаний</th><th></th></tr></thead><tbody>${rows.slice(0,10).map(r=>`<tr><td>${dt(r.evaluated_at||r.occurred_at)}</td><td>${esc(r.id)}</td><td><b>${num(r.total)} / 100</b></td><td>${r.fails.length}</td><td>${link('dialog/'+encodeURIComponent(r.id),'Разобрать')}</td></tr>`).join('')}</tbody></table></div>`:empty('Оценок за выбранный период нет');
    el.innerHTML=`<nav class="lead-coaching-crumbs" aria-label="Путь страницы"><a href="#/team">Команда</a><span>/</span><span>${esc(name)}</span></nav><header class="lead-employee-head employee-result-head"><div class="lead-employee-identity"><div><h1>${esc(name)}</h1><p>Оператор · ${esc(ctx.me.team)}${m.id?' · ID OP-'+m.id:''}</p></div></div><div class="employee-result-stats">${stat('Последняя оценка',last?num(evaluation.total)+' / 100':'—')}${stat('Оценено диалогов',rows.length)}${stat('Замечаний в последней оценке',issues.length)}${stat('Активных планов и задач',plans.filter(p=>p.status!=='done').length)}</div>${period(s,true)}${rows.length===1?'<p class="employee-sample-note">Пока только одна оценка — динамику и устойчивые тенденции показать нельзя.</p>':''}</header>
    <div class="employee-review-layout"><section>${section('Разбор последней оценки',breakdown)}</section><aside>${section('Что улучшить в первую очередь',priority)}${section('План развития',plansHTML(plans),link(planHref('plan',name,last?.id||'',issues[0]?.id||''),'Создать план'))}${section('Обратная связь',feedback.length?feedback.map(p=>`<div class="employee-feedback"><small>${dt(p.created_at)}</small><b>${esc(p.title)}</b><p>${esc(p.note||p.expected_result)}</p></div>`).join(''):empty('Нет записей'),link(planHref('feedback',name,last?.id||''),'Добавить обратную связь'))}</aside></div>
    <div class="lead-section">${section('Последние оценки',recent)}</div>${rows.length>1&&days.size>1?`<details class="employee-trend"><summary>Динамика качества за период</summary>${chart(rows,old,s)}</details>`:''}`;
    bindPeriod(el,s,draw);bindPlans(el,data);
  };await draw();
}

export async function dialogs(el,ctx){
  const data=await load();if(!ctx.alive())return;el.classList.add('lead-page');const s=state(ctx),params=new URLSearchParams(ctx.arg||'');let q='',operator=params.get('operator')||'',criterion=params.get('failed')||'',lang='',channel='';
  const criteria=[...new Map(data.rows.flatMap(r=>r.criteria).map(c=>[c.id,c])).values()];
  const draw=()=>{const rows=data.rows.filter(r=>inPeriod(r,s)&&(!operator||r.operator===operator)&&(!criterion||r.fails.some(c=>c.id===criterion))&&(!lang||r.language===lang)&&(!channel||r.channel===channel)&&(r.id+' '+r.operator).toLowerCase().includes(q.toLowerCase()));
    el.innerHTML=ph('Разборы','Диалоги вашей группы')+`<div class="filters"><input class="f" type="search" id="lead-search" value="${esc(q)}" placeholder="Диалог или сотрудник" aria-label="Поиск диалога">${period(s)}<select class="f" id="lead-operator" aria-label="Сотрудник">${option('','Все сотрудники',operator)}${[...new Set(data.rows.map(r=>r.operator))].sort().map(n=>option(n,n,operator)).join('')}</select><select class="f" id="lead-criterion" aria-label="Критерий">${option('','Все критерии',criterion)}${criteria.map(c=>option(c.id,c.name,criterion)).join('')}</select><select class="f" id="lead-language" aria-label="Язык">${option('','Все языки',lang)}${Object.entries(LANG).map(([v,t])=>option(v,t,lang)).join('')}</select><select class="f" id="lead-channel" aria-label="Канал">${option('','Все каналы',channel)}${Object.entries(CH).map(([v,t])=>option(v,t,channel)).join('')}</select></div>${dialogTable(rows)}`;
    bindPeriod(el,s,draw);for(const [id,set] of [['operator',v=>operator=v],['criterion',v=>criterion=v],['language',v=>lang=v],['channel',v=>channel=v]])el.querySelector('#lead-'+id).onchange=e=>{set(e.target.value);draw();};el.querySelector('#lead-search').oninput=e=>{q=e.target.value;draw();const n=el.querySelector('#lead-search');n.focus();n.setSelectionRange(q.length,q.length);};
  };draw();
}

export async function coaching(el,ctx){
  const [data,checklist]=await Promise.all([load(),api('/checklists/'+ctx.me.checklist.id)]);if(!ctx.alive())return;
  el.classList.add('lead-page','lead-coaching');
  const p=new URLSearchParams(ctx.arg),kind=['plan','task','feedback'].includes(p.get('kind'))?p.get('kind'):'plan';
  let did=p.get('dialog')||'',operator=p.get('operator')||data.rows.find(r=>r.id===did)?.operator||'';
  const criteria=[...new Map([...data.rows.flatMap(r=>r.criteria),...(checklist.criteria||[])].map(c=>[c.id,c])).values()];
  const initialSkills=strengths(data.rows.filter(r=>done(r)&&(!operator||r.operator===operator)));
  const initialCriterion=p.get('criterion')||data.rows.find(r=>r.id===did)?.fails[0]?.id||initialSkills.filter(c=>c.failures).sort((a,b)=>a.percent-b.percent)[0]?.id||'';
  const title={plan:'Новый план развития',task:'Новая задача развития',feedback:'Обратная связь сотруднику'}[kind];
  el.innerHTML=`<nav class="lead-coaching-crumbs" aria-label="Путь страницы"><a href="#/team">Команда</a><span>/</span><a id="coaching-person-link" href="#/${operator?employeeHref(operator):'group'}">${esc(operator||'Обзор группы')}</a><span>/</span><span>План развития</span></nav>`+ph(title,'Конкретное действие для улучшения качества обслуживания')+`
  <div class="lead-coaching-layout"><section><h2 class="lead-lined-title">Детали задачи</h2><form id="lead-plan-form" class="lead-development-form">
    <label class="lead-field"><span>Сотрудник</span><select class="f" name="operator" ${kind==='feedback'?'required':''}>${option('','Вся группа',operator)}${[...new Set([...data.members.map(m=>m.name),...data.rows.map(r=>r.operator)])].sort().map(n=>option(n,n,operator)).join('')}</select></label>
    <label class="lead-field"><span>Критерий для улучшения</span><select class="f" name="criterion">${option('','Без привязки к критерию',initialCriterion)}${criteria.map(c=>option(c.id,c.name,initialCriterion)).join('')}</select></label>
    <label class="lead-field"><span>Что нужно сделать</span><input class="f" name="title" required minlength="3" maxlength="240" placeholder="Уточнять цель обращения до предложения решения"></label>
    <label class="lead-field"><span>Ожидаемый результат</span><textarea class="f" name="expected_result" required rows="4" maxlength="4000" placeholder="В следующих 5 проверенных диалогах сотрудник уточняет цель обращения перед консультацией"></textarea></label>
    ${kind==='feedback'?'<label class="lead-field"><span>Комментарий</span><textarea class="f" name="note" rows="3" maxlength="4000" placeholder="Что разобрали с сотрудником"></textarea></label>':''}
    <div class="lead-form-pair"><label><span>Срок выполнения</span><input class="f" name="due" type="date" required></label><label><span>Приоритет</span><select class="f" name="priority"><option value="low">Низкий</option><option value="medium" selected>Средний</option><option value="high">Высокий</option></select></label></div>
    <footer class="lead-form-footer"><a class="btn" id="coaching-cancel" href="#/${operator?employeeHref(operator):'home'}">Отмена</a><button class="btn pri" type="submit">${kind==='task'?'Создать задачу':kind==='plan'?'Создать план':'Сохранить'}</button></footer>
  </form></section><aside><h2 class="lead-lined-title">Контекст сотрудника</h2><div id="coaching-context"></div></aside></div>`;
  const form=el.querySelector('form'),criterionInput=form.elements.criterion;
  const drawContext=()=>{
    operator=form.elements.operator.value;const criterion=criterionInput.value,c=criteria.find(c=>c.id===criterion);
    const rows=data.rows.filter(r=>done(r)&&(!operator||r.operator===operator)),skill=strengths(rows).find(c=>c.id===criterion),groupSkill=strengths(data.rows.filter(done)).find(c=>c.id===criterion);
    const matches=rows.filter(r=>!criterion||r.fails.some(c=>c.id===criterion));
    if(!matches.some(r=>r.id===did))did=operator?(matches[0]?.id||''):'';
    const d=matches.find(r=>r.id===did),reason=d&&(criterion?d.items[criterion]?.explanation:d.fails.map(c=>d.items[c.id]?.explanation).filter(Boolean).join(' '));
    el.querySelector('#coaching-context').innerHTML=`<div class="lead-context-person"><h3>${esc(operator||'Вся группа')}</h3><p>${esc(ctx.me.team)}</p></div><div class="lead-context-stats"><div><strong>${num(mean(rows))}<small> / 100</small></strong><span>средний балл</span></div><div><strong>${skill?skill.percent+'%':'—'}</strong><span>${esc(c?.name||'Критерий не выбран')}</span></div><div><strong>${criterion?matches.length:'—'}</strong><span>диалогов с замечанием</span></div></div>
    <div class="lead-context-criterion"><div><span>${esc(c?.name||'Выберите критерий для сравнения')}</span><small>${skill?skill.percent+'%':'—'}${groupSkill?' · по группе '+groupSkill.percent+'%':''}</small></div>${skill?`<meter min="0" max="100" value="${skill.percent}" aria-label="Результат по критерию">${skill.percent}%</meter>`:''}<small>По всем завершённым оценкам</small></div>
    <section class="lead-context-evidence"><h3>Основание для задачи</h3>${matches.length?`<label><span class="sr-only">Связанный диалог</span><select class="f" id="coaching-dialog"><option value="">Не привязывать диалог</option>${matches.map(r=>option(r.id,r.id+' · '+dt(r.occurred_at),did)).join('')}</select></label>${d?`<p>${esc(d.operator)} · ${dt(d.occurred_at)}</p>${reason?`<blockquote>${esc(reason)}</blockquote>`:''}${link('dialog/'+encodeURIComponent(d.id),'Открыть разбор')}`:''}`:empty('Нет подходящих диалогов для выбранного критерия')}</section>`;
    const choice=el.querySelector('#coaching-dialog');if(choice)choice.onchange=()=>{did=choice.value;const d=matches.find(r=>r.id===did);const section=el.querySelector('.lead-context-evidence');section.querySelectorAll('p,blockquote,a').forEach(e=>e.remove());if(d){section.insertAdjacentHTML('beforeend',`<p>${esc(d.operator)} · ${dt(d.occurred_at)}</p>${d.items[criterion]?.explanation?`<blockquote>${esc(d.items[criterion].explanation)}</blockquote>`:''}${link('dialog/'+encodeURIComponent(d.id),'Открыть разбор')}`);}};
    el.querySelector('#coaching-person-link').textContent=operator||'Обзор группы';el.querySelector('#coaching-person-link').href='#/'+(operator?employeeHref(operator):'group');el.querySelector('#coaching-cancel').href='#/'+(operator?employeeHref(operator):'home');
  };
  form.elements.operator.onchange=()=>{did='';drawContext();};criterionInput.onchange=()=>{did='';drawContext();};drawContext();
  form.onsubmit=e=>{e.preventDefault();const body=Object.fromEntries(new FormData(form));busy(form.querySelector('[type=submit]'),async()=>{await api('/lead/plans',{body:{...body,kind,dialog_id:did}});toast('Сохранено');ctx.go(body.operator?employeeHref(body.operator):'home');});};
}

export async function dialog(el,ctx){
  await inspector(el,ctx);if(!ctx.alive())return;
  const bar=document.createElement('div');bar.className='lead-inspector-actions';bar.innerHTML=link('dialogs','К разборам')+link(planHref('feedback','',ctx.arg),'Оставить обратную связь');el.prepend(bar);
}

export function monitoringCases(data,now=Date.now()){
  const cases=[...data.rows.filter(r=>r.wf_status==='review').map(r=>({id:r.id,operator:r.operator,type:'review',title:'Проверка оценки',since:r.evaluation_finished_at,href:'dialog/'+encodeURIComponent(r.id)})),...data.appeals.filter(a=>a.status==='open').map(a=>({id:a.dialog_id,operator:a.operator_name,type:'appeal',title:'Апелляция А-'+a.id,since:a.created_at,href:'appeals/'+a.id}))];
  return cases.map(c=>{const timestamp=c.since?Date.parse(c.since):NaN;return {...c,hours:Number.isFinite(timestamp)?Math.max(0,(now-timestamp)/3600000):null};}).sort((a,b)=>(b.hours??-1)-(a.hours??-1));
}
const waitLabel=hours=>hours==null?'Время не указано':hours<1?'Меньше часа':hours<24?`${Math.floor(hours)} ч`:`${Math.floor(hours/24)} д ${Math.floor(hours%24)} ч`;
export async function qaControl(el,ctx){
  const data=await load();if(!ctx.alive())return;el.classList.add('lead-page','lead-monitor');let filter='all',type='',q='';
  const draw=()=>{
    const cases=monitoringCases(data),long=cases.filter(c=>c.hours!=null&&c.hours>48),reviews=cases.filter(c=>c.type==='review'),appeals=cases.filter(c=>c.type==='appeal');
    const shown=cases.filter(c=>(filter!=='long'||c.hours!=null&&c.hours>48)&&(!type||c.type===type)&&(c.operator+' '+c.id).toLowerCase().includes(q.toLowerCase()));
    el.innerHTML=ph('Мониторинг проверок',ctx.me.team+' · Оценки и апелляции, по которым команда ждёт ответа', '<button class="btn" id="monitor-refresh">Обновить</button>')+`
    <div class="lead-stats">${stat('Оценки доступны сотрудникам',data.rows.filter(published).length)}${stat('Ждут проверки QA',reviews.length)}${stat('Ждут решения по апелляции',appeals.length)}${stat('Ждут больше 48 часов',long.length)}</div>
    <section class="monitor-queue"><div class="lead-section-head"><div><h2>Кто ждёт ответа</h2><p>Сначала — случаи с самым долгим ожиданием.</p></div><div class="monitor-tabs" role="group" aria-label="Время ожидания"><button class="btn sm ${filter==='all'?'on':''}" data-monitor-filter="all" aria-pressed="${filter==='all'}">Все ожидающие · ${cases.length}</button><button class="btn sm ${filter==='long'?'on':''}" data-monitor-filter="long" aria-pressed="${filter==='long'}">Больше 48 ч · ${long.length}</button></div></div>
    <div class="filters"><input type="search" class="f" id="monitor-search" value="${esc(q)}" placeholder="Сотрудник или диалог" aria-label="Сотрудник или диалог"><select class="f" id="monitor-type" aria-label="Тип ожидания">${[['','Все случаи'],['review','Проверки оценок'],['appeal','Апелляции']].map(([v,t])=>option(v,t,type)).join('')}</select></div>
    ${shown.length?`<div class="tw"><table class="t monitor-table"><thead><tr><th>Сотрудник</th><th>Что ожидается</th><th>Диалог</th><th>С какого времени</th><th>Ожидание</th><th></th></tr></thead><tbody>${shown.map(c=>`<tr><td>${esc(c.operator)}</td><td>${esc(c.title)}</td><td class="mono">${esc(c.id)}</td><td>${dt(c.since)}</td><td><span class="${c.hours>48?'monitor-long':''}">${waitLabel(c.hours)}</span></td><td>${link(c.href,'Открыть')}</td></tr>`).join('')}</tbody></table></div>`:empty(cases.length?'Нет случаев по выбранным условиям':'Команда не ждёт проверок или решений по апелляциям')}
    <p class="monitor-note">Ожидание проверки считаем с завершения последней оценки, апелляции — с момента подачи. Больше 48 часов — ориентир для внимания, а не установленный срок QA.</p></section>`;
    el.querySelector('#monitor-refresh').onclick=e=>busy(e.currentTarget,()=>qaControl(el,ctx));
    el.querySelectorAll('[data-monitor-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.monitorFilter;draw();});
    el.querySelector('#monitor-type').onchange=e=>{type=e.target.value;draw();};
    el.querySelector('#monitor-search').oninput=e=>{q=e.target.value;const pos=e.target.selectionStart;draw();const input=el.querySelector('#monitor-search');input.focus();input.setSelectionRange(pos,pos);};
  };draw();
}

export async function appeals(el,ctx){
  const [list,checklist]=await Promise.all([api('/appeals'),api('/checklists/'+ctx.me.checklist.id)]);if(!ctx.alive())return;
  el.classList.add('lead-page','lead-appeals-page');const s={...state(ctx)},cache=new Map(),names=Object.fromEntries((checklist.criteria||[]).map(c=>[c.id,c.name]));
  let selected=ctx.arg||'',status='',tab='all',q='',ticket=0;
  if(selected&&list.some(a=>String(a.id)===selected&&!inPeriod({occurred_at:a.created_at},s)))s.period='all';
  const statePill=a=>pill(AP_ST[a.status]?.[0]||'na',AP_ST[a.status]?.[1]||a.status);
  const illustration=`<svg class="team-appeals-art" viewBox="0 0 200 150" fill="none" aria-hidden="true"><path d="M91 23h73l14 15v90H91Z" fill="#edf5c8"/><path d="M81 14h80v103H81Z" stroke="currentColor" stroke-width="1.4"/><path d="M95 34h50M95 50h50M95 66h50M95 82h32" stroke="currentColor" stroke-width="1.4"/><path d="M63 70c-26 0-43 12-43 29 0 12 7 21 20 26l-3 14 20-11c28 2 48-9 48-29S87 70 63 70Z" fill="var(--surface)" stroke="currentColor" stroke-width="1.4"/><circle cx="45" cy="99" r="2.5" stroke="currentColor"/><circle cx="62" cy="99" r="2.5" stroke="currentColor"/><circle cx="79" cy="99" r="2.5" stroke="currentColor"/></svg>`;
  const detail=a=>{
    const criteria=a.evaluation?.checklist.criteria||[];for(const c of criteria)names[c.id]=c.name;
    const transcript=a.dialog?.transcript||[],refs=[...new Set([...String(a.text||'').matchAll(/(?:#|№)\s*(\d+)/g)].map(m=>Number(m[1])))];
    const fromAppeal=refs.length>0;
    if(!refs.length)for(const i of a.items||[])for(const n of a.evaluation?.items?.[i.crit]?.evidence||[])if(!refs.includes(n))refs.push(n);
    const valid=refs.filter(n=>Number.isInteger(n)&&n>0&&n<=transcript.length);
    const evidence=valid.length?valid.map(n=>`<blockquote class="team-appeal-evidence"><p>${esc(transcript[n-1].text)}</p><details><summary>Открыть реплику №${n}</summary><div>${transcript.slice(Math.max(0,n-2),Math.min(transcript.length,n+1)).map((t,i)=>`<p><b>#${Math.max(0,n-2)+i+1} · ${esc(({operator:'Оператор',client:'Клиент',bot:'Бот',system:'Система'})[t.speaker]||t.speaker)}</b><br>${esc(t.text)}</p>`).join('')}</div></details></blockquote>`).join(''):empty('К обращению не приложены ссылки на реплики');
    return `<section class="team-appeal-detail"><header><h2>Апелляция А-${a.id}</h2>${statePill(a)}</header><p class="team-appeal-meta">Сотрудник: ${esc(a.operator_name)} · Диалог: ${esc(a.dialog_id)}</p><div class="team-appeal-score"><div><small>Исходная оценка</small><strong>${num(a.score_before)} <span>/ 100</span></strong></div><div><small>Оспариваемый критерий</small><b>${(a.items||[]).map(i=>esc(names[i.crit]||i.crit)).join(', ')}</b></div></div>
    <dl class="lead-case"><dt>Аргумент сотрудника</dt><dd>${esc(a.text)}</dd><dt>${fromAppeal?'Материалы к обращению':'Реплики из исходной оценки'}</dt><dd>${evidence}</dd>${a.status!=='open'?`<dt>Решение QA</dt><dd>${esc(a.comment||'Комментарий не указан')}${a.decided_name?`<p class="muted">${esc(a.decided_name)}</p>`:''}</dd><dt>Итоговая оценка</dt><dd>${num(a.score_after??a.score_before)} / 100</dd>`:''}</dl>
    <div class="team-appeal-timeline"><div class="complete"><b>Подана</b><small>${dt(a.created_at)}</small></div><div class="${a.status==='open'?'pending':'complete'}"><b>${a.status==='open'?'Ожидает решения QA':esc(AP_ST[a.status]?.[1]||a.status)}</b>${a.decided_at?`<small>${dt(a.decided_at)}</small>`:''}</div></div><footer><small>Решение по оценке принимает QA.</small><div>${link('dialog/'+encodeURIComponent(a.dialog_id),'Открыть диалог')}${link(employeeHref(a.operator_name),'Карточка сотрудника')}</div></footer></section>`;
  };
  const draw=async()=>{
    const turn=++ticket,focused=el.querySelector('#lead-search')===document.activeElement,pos=el.querySelector('#lead-search')?.selectionStart;
    const periodRows=list.filter(a=>inPeriod({occurred_at:a.created_at},s));
    const rows=periodRows.filter(a=>(tab==='all'||tab==='open'&&a.status==='open'||tab==='closed'&&a.status!=='open')&&(!status||a.status===status)&&(a.operator_name+' '+a.dialog_id+' '+a.id).toLowerCase().includes(q.toLowerCase()));
    if(!rows.some(a=>String(a.id)===selected))selected=String(rows[0]?.id||'');
    let a=null,error='';
    if(selected){try{if(!cache.has(selected))cache.set(selected,api('/appeals/'+selected));a=await cache.get(selected);}catch(e){cache.delete(selected);error=e.message;}}
    if(!ctx.alive()||turn!==ticket)return;
    if(a)for(const c of a.evaluation?.checklist.criteria||[])names[c.id]=c.name;
    const header=ph('Апелляции команды','Запросы на пересмотр оценок сотрудников группы')+`<div class="team-appeal-scope"><span class="team-appeal-group">${esc(ctx.me.team)}</span>${period(s,true)}<span>Обращений за период: <b>${periodRows.length}</b></span></div>`;
    const emptyState=`<div class="team-appeals-empty">${illustration}<div><h2>${list.length?'За этот период апелляций нет':'Апелляций пока нет'}</h2><p>${list.length?'Выберите другой период, чтобы посмотреть обращения команды.':'Когда сотрудники оспорят оценку, здесь появятся их обращения, статусы и решения QA.'}</p>${link('dialogs','Посмотреть оценки команды')}</div></div><div class="team-appeal-steps"><span>Оператор подаёт запрос</span><span>QA проверяет аргументы</span><span>Руководитель видит решение</span><small>Решения по баллам принимает QA</small></div>`;
    el.innerHTML=header+(!periodRows.length?emptyState:`<div class="lead-appeals team-appeal-layout"><section class="team-appeal-list"><nav class="team-appeal-tabs" aria-label="Состояние обращений">${[['all','Все',periodRows.length],['open','На рассмотрении',periodRows.filter(a=>a.status==='open').length],['closed','Завершены',periodRows.filter(a=>a.status!=='open').length]].map(([v,t,n])=>`<button data-appeal-tab="${v}" class="${tab===v?'on':''}" aria-pressed="${tab===v}">${t} <span>${n}</span></button>`).join('')}</nav><div class="filters"><input class="f" type="search" id="lead-search" value="${esc(q)}" placeholder="Сотрудник, диалог или номер обращения" aria-label="Поиск апелляции"><select class="f" id="lead-ap-status" aria-label="Статус апелляции">${option('','Все статусы',status)}${Object.entries(AP_ST).map(([v,t])=>option(v,t[1],status)).join('')}</select></div>
    ${rows.length?`<div class="tw"><table class="t team-appeal-table"><thead><tr><th>№</th><th>Сотрудник</th><th>Диалог</th><th>Критерий</th><th>Дата подачи</th><th>Статус</th></tr></thead><tbody>${rows.map(r=>`<tr class="${String(r.id)===selected?'on':''}" data-appeal="${r.id}" tabindex="0" aria-label="Открыть апелляцию А-${r.id}"><td><button class="team-appeal-select" aria-pressed="${String(r.id)===selected}">А-${r.id}</button></td><td>${esc(r.operator_name)}</td><td>${esc(r.dialog_id)}</td><td>${(r.items||[]).map(i=>esc(names[i.crit]||i.crit)).join(', ')}</td><td>${dt(r.created_at)}</td><td>${statePill(r)}</td></tr>`).join('')}</tbody></table></div>`:empty('Апелляций по выбранным условиям нет')}</section>${a?detail(a):error?`<section class="team-appeal-detail"><p>${esc(error)}</p><button class="btn" id="appeal-retry">Повторить</button></section>`:'<section class="team-appeal-detail"></section>'}</div>`);
    bindPeriod(el,s,draw);
    el.querySelectorAll('[data-appeal-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.appealTab;status='';draw();});
    el.querySelectorAll('[data-appeal]').forEach(b=>{const select=()=>{selected=b.dataset.appeal;history.replaceState(null,'','#/appeals/'+selected);draw();};b.onclick=select;b.onkeydown=e=>{if(e.target===b&&(e.key==='Enter'||e.key===' ')){e.preventDefault();select();}};});
    const statusInput=el.querySelector('#lead-ap-status');if(statusInput)statusInput.onchange=e=>{status=e.target.value;tab='all';draw();};
    const search=el.querySelector('#lead-search');if(search){search.oninput=e=>{q=e.target.value;draw();};if(focused){search.focus();search.setSelectionRange(pos,pos);}}
    const retry=el.querySelector('#appeal-retry');if(retry)retry.onclick=draw;
  };await draw();
}
