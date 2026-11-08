import { $, api, esc, busy, dt, emptyBox, toast } from './ui.js';
export async function integrations(el, ctx) {
  const [rows, config] = await Promise.all([api('/integrations/dynamics'),api('/integrations/dynamics/configuration')]);
  if(!ctx.alive()) return;
  const labels={running:'Синхронизация',done:'Завершена',error:'Ошибка'};
  el.innerHTML=`<header class="ph"><div><h1>Интеграция с Dynamics 365</h1><p class="muted">Импорт диалогов и история синхронизаций</p></div><button id="sync" class="btn pri" ${config.configured?'':'disabled'}>Получить диалоги</button></header>`
    + (config.configured?'<p>Диалоги загружаются без запуска AI-оценки. Повторная синхронизация не создаёт дубликаты.</p>':'<div class="note">Подключение ещё не настроено. Для импорта необходимы доступ к Dynamics 365 и сопоставление сотрудников и групп. Обратитесь к администратору интеграции.</div>')
    +(rows.length?'<div class="tw"><table class="t"><thead><tr><th>Запуск</th><th>Статус</th><th>Импортировано</th><th>Повторов</th><th>Ошибка</th></tr></thead><tbody>'+rows.map(r=>`<tr><td>${dt(r.started_at)}</td><td>${esc(labels[r.status]||r.status)}</td><td>${r.imported}</td><td>${r.skipped}</td><td>${esc(r.error||'—')}</td></tr>`).join('')+'</tbody></table></div>':emptyBox('Синхронизаций пока нет',config.configured?'Нажмите «Получить диалоги», чтобы запустить импорт.':'История появится после первого импорта.'));
  $('#sync',el).onclick=()=>busy($('#sync',el),async()=>{
    try {const result=await api('/integrations/dynamics/sync',{body:{}});toast(`Импортировано: ${result.imported}. Повторов: ${result.skipped}.`);}
    finally {if(ctx.alive())await integrations(el,ctx);}
  });
}
