import { $, $$, api, esc, busy, emptyBox, dt } from './ui.js';

export async function development(el, ctx) {
  const tasks = await api('/development');
  if (!ctx.alive()) return;
  const lead = ctx.me.role === 'lead';
  const labels = {assigned:'К выполнению', submitted:'На проверке', completed:'Выполнена'};
  el.innerHTML = `<header class="ph"><div><h1>${lead?'Развитие команды':'Моё развитие'}</h1><p class="muted">${lead?'Назначенные задачи и результаты сотрудников':'Задачи от руководителя и обратная связь по выполнению'}</p></div>${lead?'<a class="btn pri" href="#/coaching/kind%3Dtask">Создать задачу</a>':''}</header>
    <div class="development-summary"><span>К выполнению: <b>${tasks.filter(t=>t.status==='assigned').length}</b></span><span>На проверке: <b>${tasks.filter(t=>t.status==='submitted').length}</b></span><span>Выполнено: <b>${tasks.filter(t=>t.status==='completed').length}</b></span></div>
    ${tasks.length ? tasks.map(t=>`<section class="development-task" id="task-${t.id}"><header><div><h2>${esc(t.title||'Задача №'+t.id)}</h2><p class="muted">${esc(t.operator_name)}${t.due?' · Срок: '+esc(t.due.split('-').reverse().join('.')):''}${t.criterion_name?' · '+esc(t.criterion_name):''}</p></div><span class="pill ${t.status==='completed'?'ok':t.status==='submitted'?'warn':''}">${labels[t.status]}</span></header>
      <p class="development-text">${esc(t.title&&t.instruction.startsWith(t.title+'\n\n')?t.instruction.slice(t.title.length+2):t.instruction===t.title?'':t.instruction)}</p>${t.dialog_id&&(lead||t.dialog_available)?`<a class="btn sm" href="#/dialog/${encodeURIComponent(t.dialog_id)}">Открыть диалог</a>`:''}
      ${t.response?`<div class="development-response"><b>Результат сотрудника</b><p class="development-text">${esc(t.response)}</p></div>`:''}${t.feedback?`<div class="development-response"><b>Обратная связь руководителя</b><p class="development-text">${esc(t.feedback)}</p></div>`:''}
      ${(!lead&&t.status==='assigned')||(lead&&t.status==='submitted')?`<form data-task="${t.id}"><label class="l" for="task-text-${t.id}">${lead?'Комментарий к результату':'Что удалось сделать'}<textarea id="task-text-${t.id}" class="f" name="text" minlength="5" maxlength="4000" rows="3" required></textarea></label><div class="development-actions">${lead?'<button type="submit" class="btn" value="return">Вернуть на доработку</button><button type="submit" class="btn pri" value="accept">Подтвердить выполнение</button>':'<button class="btn pri" type="submit">Отправить результат</button>'}</div></form>`:''}
      ${t.history?.length?`<details><summary>История работы</summary>${t.history.map(e=>`<p><small class="muted">${dt(e.at)}</small> · ${esc(labels[e.action]||e.action)}<br>${esc(e.text)}</p>`).join('')}</details>`:''}</section>`).join(''):emptyBox('Задач пока нет',lead?'Выберите сотрудника и назначьте конкретное действие для улучшения качества.':'Здесь появятся задачи, назначенные вашим руководителем.')}`;
  $$('[data-task]',el).forEach(form=>form.onsubmit=e=>{
    e.preventDefault(); const accepted=e.submitter?.value==='accept';
    busy(e.submitter||$('button',form),async()=>{
      const buttons=$$('button',form);buttons.forEach(b=>b.disabled=true);
      try {await api(`/development/${form.dataset.task}/${lead?'review':'submit'}`,{body:lead?{feedback:form.elements.text.value,accepted}:{response:form.elements.text.value}});if(ctx.alive())await development(el,ctx);}
      finally {buttons.forEach(b=>b.disabled=false);}
    });
  });
  if (/^\d+$/.test(ctx.arg||'')) $('#task-'+ctx.arg,el)?.scrollIntoView({block:'center'});
}
