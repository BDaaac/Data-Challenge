// Role-specific starting points. All counts and links come from existing APIs.
import { api, esc, fmt, money, CH, REASON, stPill } from './ui.js';

export const WORK = {
  qa: { title: 'Проверка качества', intro: 'Проверьте спорные оценки. Всё необходимое для решения — рядом с репликами.', label: 'Рабочий стол QA', steps: ['Выберите диалог', 'Сверьте ответ с репликой', 'Опубликуйте решение'], links: [['queue', 'Очередь проверки', 'Диалоги, которым нужен человек'], ['appeals', 'Апелляции', 'Аргументы сотрудников и решения'], ['calibration', 'Проверка ИИ', 'Где оценки расходятся с эталоном']] },
  op: { title: 'Мои оценки и обратная связь', intro: 'Ваши оценки с объяснениями и примерами. Если не согласны — попросите пересмотр.', label: 'Мой рабочий стол', steps: ['Откройте оценку', 'Посмотрите объяснение', 'Ознакомьтесь или оспорьте'], links: [['my', 'Мои оценки', 'Все проверенные разговоры'], ['appeals', 'Мои апелляции', 'Следите за решением QA'], ['rules', 'Как меня оценивают', 'Правила, веса и примеры условий']] },
  lead: { title: 'Качество работы команды', intro: 'Найдите повторяющуюся ошибку и разберите её на реальном разговоре.', label: 'Моя команда', steps: ['Выберите сотрудника', 'Откройте его примеры', 'Разберите ситуацию вместе'], links: [['team', 'Сотрудники', 'Результаты и темы для разбора'], ['dashboard', 'Качество группы', 'Какие критерии требуют внимания'], ['appeals', 'Споры по оценкам', 'Апелляции вашей команды']] },
  adm: { title: 'Управление системой', intro: 'Доступ сотрудников, параметры оценки и обработка данных в одном месте.', label: 'Администрирование', steps: ['Настройте доступ', 'Проверьте параметры', 'Загрузите диалоги'], links: [['users', 'Сотрудники и доступ', 'Роли, группы и учётные записи'], ['settings', 'Настройки оценки', 'Модель, ручная проверка и бюджет'], ['upload', 'Загрузить диалоги', 'JSON-файл или текст разговора']] }
};

const metric = (value, label) => `<div><div class="l">${esc(label.charAt(0).toUpperCase() + label.slice(1))}</div><div class="v">${esc(value)}</div></div>`;
const task = (href, title, sub, state = '') => `<div class="role-task"><div><b>${esc(title)}</b>${sub ? `<p>${esc(sub)}</p>` : ''}</div><div class="role-task-actions">${state}<a class="btn sm" href="#/${href}">Открыть</a></div></div>`;
const dialogTask = d => task('dialog/' + encodeURIComponent(d.id), d.operator + ' · ' + (CH[d.channel] || d.channel), [d.id, d.language, ...(d.review || []).slice(0, 2).map(r => REASON[r.code]?.[1]).filter(Boolean)].join(' · '), stPill(d.wf_status));

export async function home(el, ctx) {
  const r = ctx.me.role, config = WORK[r];
  let stats = '', tasks = '', heading = '', count = 0, action = config.links[0], detail = '', detailTitle = 'Разделы';
  if (r === 'qa') {
    const rows = await api('/queue'); count = rows.length;
    const risks = rows.filter(d => d.critical).length, appeals = rows.filter(d => d.wf_status === 'appeal').length;
    stats = metric(count, 'ждут разбора') + metric(risks, 'сигналов риска') + metric(appeals, 'апелляций в очереди');
    heading = 'Начните с этих диалогов'; tasks = rows.slice(0, 5).map(dialogTask).join('');
    action = count ? ['dialog/' + encodeURIComponent(rows[0].id), 'Разобрать первый диалог'] : ['dialogs', 'Открыть все диалоги'];
  } else if (r === 'op') {
    const [s, rows] = await Promise.all([api('/stats/me'), api('/dialogs')]);
    const fresh = rows.filter(d => d.wf_status === 'published'); count = fresh.length;
    stats = metric(fmt(s.avg), 'мой средний балл', `${s.n} проверенных диалогов`) + metric(s.new, 'новых оценок') + metric(s.appeals.open, 'апелляций на рассмотрении');
    heading = fresh.length ? 'Новые оценки' : 'Последние оценки';
    detailTitle = 'Зоны внимания';
    detail = (s.weak ? [s.weak] : []).map(w => task('my', w.name, `${w.n} замечаний`)).join('') || '<p class="role-empty">Замечаний по критериям нет</p>';
    tasks = (fresh.length ? fresh : rows).slice(0, 5).map(d => task('dialog/' + encodeURIComponent(d.id), `${CH[d.channel] || 'Диалог'} · ${d.id}`, `${d.language} · ${d.total == null ? 'Итог уточняется' : fmt(d.total) + ' из 100'}`, stPill(d.wf_status))).join('');
    if (fresh.length) action = ['dialog/' + encodeURIComponent(fresh[0].id), 'Посмотреть новую оценку'];
  } else if (r === 'lead') {
    const s = await api('/stats/team'); const ops = s.operators; count = ops.filter(o => o.weak).length;
    stats = metric(ops.length, 'сотрудников в группе') + metric(ops.reduce((n, o) => n + o.n, 0), 'проверенных диалогов') + metric(count, 'тем для личного разбора');
    heading = 'Кому нужна обратная связь';
    tasks = ops.filter(o => o.weak).slice(0, 5).map(o => task(`dialogs/operator=${encodeURIComponent(o.operator)}&failed=${o.weak.crit}`, o.operator, o.weak.name + ' · ' + o.weak.n + ' замечаний', `<span class="work-score">${fmt(o.avg)}</span>`)).join('');
  } else {
    const [users, s, jobs] = await Promise.all([api('/users'), api('/settings'), api('/jobs')]);
    const running = jobs.filter(j => !j.finished_at); count = running.length;
    stats = metric(users.filter(u => u.active).length, 'активных сотрудников') + metric(running.length, 'пакетов в работе') + metric(money(s.spent, 2), 'израсходовано на оценку');
    heading = 'Рабочие инструменты'; tasks = config.links.map(([href, title, sub]) => task(href, title, sub)).join('');
    detailTitle = 'Последние пакеты';
    detail = jobs.slice(0, 5).map(j => task('jobs/' + j.id, j.title, `${j.dialog_ids.length} диалогов · ${j.finished_at ? 'Завершён' : 'В работе'}`)).join('') || '<p class="role-empty">Пакетов оценки пока нет</p>';
  }
  if (!ctx.alive()) return;
  el.classList.add('role-workspace');
  const titles = { op: 'Мои результаты', lead: 'Обзор команды', adm: 'Управление системой' };
  const links = config.links.filter(([href]) => href !== action[0] && !tasks.includes(`href="#/${href}"`));
  if (!detail) detail = links.map(([href, title]) => task(href, title, '')).join('');
  el.innerHTML = `<header class="ph"><h1>${titles[r] || config.title}</h1><a class="btn pri" href="#/${action[0]}">${esc(action[1])}</a></header>
    <section class="strip" aria-label="Ключевые показатели">${stats}</section>
    <div class="role-overview-grid"><section><h2>${heading}</h2><div>${tasks || '<p class="role-empty">Нет задач, требующих внимания</p>'}</div></section>
    <section><h2>${detailTitle}</h2>${detail}${r === 'op' ? `<div class="role-related"><a class="btn" href="#/rules">Критерии оценки</a><a class="btn" href="#/appeals">Мои апелляции</a></div>` : ''}</section></div>`;
}
