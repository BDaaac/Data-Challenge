import {api,esc,fmt,dt,AP_ST,pill,busy,ansLabel} from './ui.js';
const status=a=>pill(...AP_ST[a.status]);
const steps=()=>`<section class="appeal-guide" id="appeal-guide" tabindex="-1"><h2>Как проходит рассмотрение</h2><div class="appeal-steps">${[['Выберите оценку','Откройте нужный диалог в разделе «Мои оценки».'],['Укажите причину','Выберите критерий, опишите несогласие и добавьте реплику в подтверждение.'],['Получите решение QA','После рассмотрения здесь появятся решение и итоговая оценка.']].map(([title,text],i)=>`<div><span>${String(i+1).padStart(2,'0')}</span><div><h3>${title}</h3><p>${text}</p></div></div>`).join('')}</div></section>`;
const illustration=`<svg class="appeal-empty-art" viewBox="0 0 360 280" fill="none" aria-hidden="true"><path d="M45 95c0-40 25-58 77-58s75 19 75 59-25 57-75 57h-25l-37 19 9-30c-17-9-24-25-24-47Z" stroke="#85838b" stroke-width="1.5"/><g fill="#faf9f6" stroke="#85838b"><circle cx="96" cy="91" r="3"/><circle cx="122" cy="91" r="3"/><circle cx="148" cy="91" r="3"/></g><rect x="129" y="112" width="159" height="150" rx="17" fill="#faf9f6" stroke="#85838b" stroke-width="1.5"/><rect x="155" y="139" width="22" height="22" rx="4" fill="#c6e773"/><path d="m159 149 6 6 15-17" stroke="#374625" stroke-width="1.5"/><g stroke="#85838b" stroke-width="1.5"><rect x="155" y="180" width="22" height="22" rx="4"/><rect x="155" y="221" width="22" height="22" rx="4"/><path d="M197 150h64m-64 41h64m-64 41h64"/></g><path d="M277 82V65m17 27 12-15m-4 30 17-6" stroke="#b5d94d" stroke-width="3" stroke-linecap="round"/></svg>`;
export async function appeals(el,ctx){
  const [list,checklists]=await Promise.all([api('/appeals'),api('/checklists')]);
  const current=checklists.find(c=>c.status==='published');
  const names=current?(await api('/checklists/'+current.id)).criteria:[];
  if(!ctx.alive())return;
  el.classList.add('op-page','appeal-hub');
  let selected=ctx.arg||list[0]?.id,filter='all',seq=0;
  const cache=new Map();
  const criterionName=id=>names.find(c=>c.id===id)?.name||id;
  const header=()=>`<header class="ph"><div><h1>Апелляции</h1><p>Пересмотр оценок и история решений</p></div>${list.length?'<div class="acts"><button class="btn pri" id="appeal-create">Подать апелляцию</button></div>':''}</header>`;
  const pickDialog=async()=>{
    const dialogs=(await api('/dialogs')).filter(d=>['published','acknowledged','revised'].includes(d.wf_status));
    if(!ctx.alive())return;
    const picker=document.createElement('dialog');picker.className='appeal-picker';
    picker.innerHTML=`<form method="dialog"><div class="op-section-heading"><h2>Выберите оценку</h2><button class="btn sm">Закрыть</button></div></form>${dialogs.length?dialogs.map(d=>`<a href="#/appeal-new/${encodeURIComponent(d.id)}"><span>${esc(d.id)}<small>${dt(d.occurred_at)}</small></span><b>${fmt(d.total)} / 100</b></a>`).join(''):'<p>Нет оценок, доступных для пересмотра. По открытым апелляциям дождитесь решения QA.</p>'}`;
    document.body.append(picker);picker.addEventListener('close',()=>picker.remove());picker.querySelectorAll('a').forEach(a=>a.onclick=()=>picker.close());picker.showModal();
  };
  const render=async()=>{
    const token=++seq,rows=list.filter(a=>filter==='all'||(filter==='open'?a.status==='open':a.status!=='open'));
    if(!rows.some(a=>String(a.id)===String(selected)))selected=rows[0]?.id;
    let item=null;
    if(selected){if(!cache.has(String(selected)))cache.set(String(selected),await api('/appeals/'+selected));item=cache.get(String(selected));}
    if(!ctx.alive()||token!==seq)return;
    if(!list.length){
      el.innerHTML=header()+`<section class="appeal-empty">${illustration}<div><h2>Пока нет апелляций</h2><p>Если вы не согласны с оценкой разговора, можете запросить её пересмотр. Выберите диалог, укажите критерий и объясните свою позицию.</p><div class="acts"><a class="btn pri" href="#/my">Перейти к моим оценкам</a></div></div></section>${steps()}<p class="appeal-footnote">Когда появится первая апелляция, здесь будут её статус, аргументы и история решения.</p>`;
      return;
    }
    const detail=a=>{
      const criteria=a.evaluation.checklist.criteria,transcript=a.dialog.transcript||[];
      const refs=[...new Set([...a.text.matchAll(/#(\d+)/g)].map(m=>+m[1]))];
      if(!refs.length)a.items.forEach(i=>(a.evaluation.items[i.crit]?.evidence||[]).forEach(n=>{if(!refs.includes(n))refs.push(n);}));
      const valid=refs.filter(n=>Number.isInteger(n)&&n>0&&n<=transcript.length);
      return `<section class="appeal-case" aria-label="Апелляция А-${a.id}"><header><h2>Апелляция #А-${a.id}</h2>${status(a)}</header><p class="appeal-case-meta">Диалог ${esc(a.dialog_id)} · Подана ${dt(a.created_at)}</p><div class="appeal-case-score"><strong>${fmt(a.score_before)} <small>/ 100</small></strong><span class="appeal-score-separator">→</span>${a.status==='open'?'<span class="pill warn">На пересмотре</span>':a.score_after!=null?`<strong>${fmt(a.score_after)} <small>/ 100</small></strong>`:`${status(a)}`}</div>
      <dl class="appeal-case-rows"><div><dt>Оспариваемый критерий</dt><dd>${a.items.map(i=>{const c=criteria.find(c=>c.id===i.crit);return `<div class="op-item-change"><b>${esc(c?.name||i.crit)}</b><span>${esc(c?ansLabel(c,i.from):i.from)} · Запрошено: ${esc(c?ansLabel(c,i.want):i.want)}</span></div>`;}).join('')}</dd></div><div><dt>Почему я не согласен</dt><dd>${esc(a.text)}</dd></div><div><dt>Связанное доказательство</dt><dd>${valid.length?valid.map(n=>`<blockquote class="appeal-evidence">${esc(transcript[n-1].text)}<details><summary>Открыть реплику №${n}</summary><div>${transcript.slice(Math.max(0,n-2),Math.min(transcript.length,n+1)).map((t,i)=>`<p><b>#${Math.max(0,n-2)+i+1} · ${esc(({client:'Клиент',operator:'Оператор',bot:'Бот',system:'Система'})[t.speaker]||t.speaker)}</b>${esc(t.text)}</p>`).join('')}</div></details></blockquote>`).join(''):'Реплики не указаны'}</dd></div><div><dt>Ход рассмотрения</dt><dd><ol class="appeal-timeline"><li><b>Апелляция подана</b><time>${dt(a.created_at)}</time></li>${a.status==='open'?'<li class="pending"><b>Ожидает решения QA</b></li>':`<li><b>${AP_ST[a.status][1]}</b>${a.decided_at?`<time>${dt(a.decided_at)}</time>`:''}${a.decided_name?`<span>${esc(a.decided_name)}</span>`:''}</li>`}</ol></dd></div>${a.status!=='open'?`<div><dt>Решение QA</dt><dd>${esc(a.comment||'Комментарий не указан')}</dd></div>`:''}</dl>
      ${a.status==='open'?'<p class="appeal-footnote">Решение QA появится здесь после рассмотрения.</p>':''}<footer><a class="btn" href="#/dialog/${encodeURIComponent(a.dialog_id)}">Открыть исходную оценку</a>${a.status==='open'?'<button class="btn" id="op-withdraw">Отозвать апелляцию</button>':''}</footer></section>`;
    };
    el.innerHTML=header()+`<div class="appeal-tabs" role="group" aria-label="Статусы апелляций">${[['all','Все',list.length],['open','На рассмотрении',list.filter(a=>a.status==='open').length],['closed','Решены',list.filter(a=>a.status!=='open').length]].map(([k,t,n])=>`<button type="button" data-appeal-filter="${k}" class="${filter===k?'on':''}" aria-pressed="${filter===k}">${t} <span>${n}</span></button>`).join('')}</div><div class="appeal-hub-grid"><nav class="appeal-cards" aria-label="Мои обращения">${rows.map(a=>`<button type="button" class="appeal-card ${String(a.id)===String(selected)?'on':''}" data-appeal="${a.id}" aria-pressed="${String(a.id)===String(selected)}"><span class="appeal-card-top"><b>#А-${a.id}</b>${status(a)}</span><span class="appeal-card-context">Диалог ${esc(a.dialog_id)} · ${a.items.map(i=>esc(criterionName(i.crit))).join('; ')}</span><span class="appeal-card-bottom"><span>${a.status==='open'?'Подана':'Обновлена'} ${dt(a.decided_at||a.created_at)}</span><b>${fmt(a.score_after??a.score_before)} / 100</b></span></button>`).join('')||'<p class="op-empty">Обращений в этом статусе нет</p>'}</nav>${item?detail(item):'<section class="appeal-case"><p class="op-empty">Нет обращений для просмотра</p></section>'}</div>`;
    el.querySelector('#appeal-create').onclick=e=>busy(e.currentTarget,pickDialog);
    el.querySelectorAll('[data-appeal-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.appealFilter;render();});
    el.querySelectorAll('[data-appeal]').forEach(b=>b.onclick=()=>{selected=b.dataset.appeal;history.replaceState(null,'','#/appeals/'+selected);render();});
    const wd=el.querySelector('#op-withdraw');if(wd)wd.onclick=()=>busy(wd,async()=>{await api('/appeals/'+item.id+'/withdraw',{body:{comment:'Отозвана оператором'}});ctx.refresh();await appeals(el,ctx);});
  };await render();
}
