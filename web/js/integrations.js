import { $, api, esc, busy, dt, emptyBox } from './ui.js';
export async function integrations(el, ctx) {
  const rows=await api('/integrations/dynamics');
  if(!ctx.alive()) return;
  el.innerHTML='<div class="ph"><h1>Dynamics 365</h1><button id="sync" class="btn pri">Получить диалоги</button></div><p>Полученные диалоги появятся в разделе «Новые диалоги». Оценка запускается отдельно.</p>'
    +(rows.length?'<div class="tw"><table class="t"><thead><tr><th>Запуск</th><th>Статус</th><th>Импортировано</th><th>Повторов</th><th>Ошибка</th></tr></thead><tbody>'+rows.map(r=>`<tr><td>${dt(r.started_at)}</td><td>${esc(r.status)}</td><td>${r.imported}</td><td>${r.skipped}</td><td>${esc(r.error||'')}</td></tr>`).join('')+'</tbody></table></div>':emptyBox('Синхронизаций пока нет','Настройте подключение по docs/dynamics.md.'));
  $('#sync',el).onclick=()=>busy($('#sync',el),async()=>{try {await api('/integrations/dynamics/sync',{body:{}});} finally {await integrations(el,ctx);}});
}
