import { $, $$, api, esc, busy, emptyBox } from './ui.js';

export async function development(el, ctx) {
  const tasks = await api('/development');
  if (!ctx.alive()) return;
  const lead = ctx.me.role === 'lead';
  const labels = {assigned:'К выполнению', submitted:'На проверке', completed:'Выполнена'};
  el.innerHTML = '<div class="ph"><h1>Задачи развития</h1></div>'
    + (lead ? '<form id="task-create" class="panel"><label class="l">ID опубликованного диалога<input name="dialog" class="f" required></label><label class="l">Обратная связь и ожидаемый результат<textarea name="instruction" class="f" minlength="10" required></textarea></label><button class="btn pri">Назначить</button></form>' : '')
    + (tasks.length ? tasks.map(t=>`<section class="panel" id="task-${t.id}" style="margin-top:16px"><h2>Задача №${t.id} · ${labels[t.status]}</h2><p>${esc(t.operator_name)} · <a href="#/dialog/${encodeURIComponent(t.dialog_id)}">${esc(t.dialog_id)}</a></p><p>${esc(t.instruction)}</p>${t.response?`<p>Выполнено: ${esc(t.response)}</p>`:''}${t.feedback?`<p>Обратная связь: ${esc(t.feedback)}</p>`:''}${(!lead && t.status==='assigned') || (lead && t.status==='submitted') ? `<form data-task="${t.id}"><label class="l">${lead?'Результат проверки':'Что выполнено'}<textarea class="f" name="text" minlength="5" required></textarea></label>${lead?'<label><input type="checkbox" name="accepted" checked> Выполнение подтверждено</label>':''}<button class="btn pri">Отправить</button></form>`:''}</section>`).join('') : emptyBox('Задач пока нет','Назначенные задачи появятся здесь.'));
  const totals=document.createElement('p');
  totals.className='muted';
  totals.textContent='Всего задач: '+tasks.length+' · Выполнено: '+tasks.filter(t=>t.status==='completed').length+' · На проверке: '+tasks.filter(t=>t.status==='submitted').length;
  el.querySelector('.ph').after(totals);
  for(const t of tasks) {
    if(!t.history?.length) continue;
    const details=document.createElement('details'), summary=document.createElement('summary');
    summary.textContent='История работы'; details.append(summary);
    for(const event of t.history) {
      const p=document.createElement('p');
      p.textContent=(labels[event.action]||event.action)+': '+event.text;
      details.append(p);
    }
    document.getElementById('task-'+t.id)?.append(details);
  }
  const form=$('#task-create',el);
  if(form) {
    const request_key=crypto.randomUUID();
    form.onsubmit=e=>{e.preventDefault();busy($('button',form),async()=>{await api('/development',{body:{request_key,dialog_id:form.elements.dialog.value,instruction:form.elements.instruction.value}});await development(el,ctx);});};
  }
  $$('[data-task]',el).forEach(form=>form.onsubmit=e=>{e.preventDefault();busy($('button',form),async()=>{await api(`/development/${form.dataset.task}/${lead?'review':'submit'}`,{body:lead?{feedback:form.elements.text.value,accepted:form.elements.accepted.checked}:{response:form.elements.text.value}});await development(el,ctx);});});
  const id=location.hash.split('/')[2];
  if(id && /^\d+$/.test(id)) document.getElementById('task-'+id)?.scrollIntoView();
}
