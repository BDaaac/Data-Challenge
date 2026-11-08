// Точка входа: вход, каркас, меню по роли, мгновенное переключение демо-роли без потери контекста, маршрутизация.
import { $, $$, api, esc, toast, fail, initials, ROLE, ago, busy, setCritNames } from "./ui.js";
import * as V from "./views.js";
import { qaOverview } from "./qa_overview.js";
import * as OP from "./operator.js";
import * as LEAD from "./lead.js";
import { WORK } from "./workspace.js";
import { development } from "./development.js";
import { integrations } from "./integrations.js";

const NAV = {
  qa: [["Проверка", [["queue", "Очередь разбора", "queue"], ["dialogs", "Все диалоги"], ["appeals", "Апелляции", "appeals"], ["violations", "Инциденты", "violations"], ["upload", "Загрузка данных"]]],
       ["Стандарты", [["checklists", "Чек-листы"], ["calibration", "Проверка ИИ"], ["dashboard", "Аналитика качества"]]]],
  op: [["Кабинет", [["my", "Мои диалоги", "unread"], ["appeals", "Мои апелляции", "appeals"], ["rules", "Стандарты оценки"]]]],
  lead: [["Команда", [["team", "Операторы группы"], ["dialogs", "Диалоги группы"], ["appeals", "Апелляции", "appeals"], ["violations", "Инциденты", "violations"]]], ["Аналитика", [["dashboard", "Точки потери баллов"]]]],
  adm: [["Система", [["users", "Пользователи"], ["settings", "Настройки оценки"], ["audit", "История действий"]]], ["Данные", [["upload", "Загрузка данных"], ["dialogs", "Все диалоги"]]]]
};
// Collapse navigation when a desktop window becomes narrow; keep the menu button available.
matchMedia("(max-width: 860px)").addEventListener("change", event => {
  if (event.matches) $(".app")?.classList.add("collapsed");
});
const HOME = Object.fromEntries(Object.keys(NAV).map(r => [r, "home"]));
for (const groups of Object.values(NAV)) groups.unshift(["", [["home", "Рабочий стол"]]]);
const EXTRA = { qa: ["dialog", "jobs", "rules"], op: ["dialog", "appeal-new"], lead: ["dialog", "rules", "group", "employee", "coaching", "qa-control"], adm: ["dialog", "jobs", "checklists"] };
const TITLES = { queue: "Очередь разбора", upload: "Загрузка данных", jobs: "Пакет оценки", dialogs: "Диалоги", violations: "Инциденты", appeals: "Апелляции",
  checklists: "Чек-листы", calibration: "Проверка ИИ", my: "Мои диалоги", rules: "Стандарты оценки", team: "Операторы", dashboard: "Аналитика качества",
  users: "Пользователи", settings: "Настройки оценки", audit: "История действий", dialog: "Инспектор диалога" };

const SHORT_ROLE = { qa: "QA", op: "Оператор", lead: "Руководитель группы", adm: "Админ" };
const DEMO_ROLES = ["qa", "op", "lead", "adm"];

let me = null, pop = null, poll = null, curView = null, demoUsers = [];
let lastList = (() => { try { return sessionStorage.getItem("cqa-last"); } catch { return null; } })();
const go = h => { location.hash = "#/" + h; };

async function loadCritNames() {
  try { const c = await api("/checklists/" + me.checklist.id); setCritNames(c.criteria); } catch {}
}
async function ensureDemoUsers() {
  if (!demoUsers.length && me?.demo) {
    try { demoUsers = (await api("/auth/demo")).users || []; } catch {}
  }
}
const supportedRole = r => Object.hasOwn(NAV, r);
const allowed = (r, v) => supportedRole(r) && (NAV[r].some(g => g[1].some(i => i[0] === v)) || EXTRA[r].includes(v));
function validateSessionRole() {
  if (me && supportedRole(me.role)) return true;
  me = null;
  curView = null;
  lastList = null;
  clearInterval(poll);
  closePop();
  try { sessionStorage.removeItem("cqa-last"); } catch {}
  history.replaceState(null, "", "#/");
  renderLogin();
  toast("Эта роль больше недоступна. Выберите роль для входа.", true);
  return false;
}
TITLES.home = "Рабочий стол";
TITLES.development = "Задачи развития";
TITLES.integrations = "Dynamics 365";
EXTRA.op.push("development");
EXTRA.lead.push("development");
EXTRA.adm.push("integrations");
TITLES["appeal-new"] = "Подать апелляцию";
Object.assign(TITLES, {group:"Обзор группы", employee:"Карточка сотрудника", coaching:"Развитие сотрудника", "qa-control":"Мониторинг проверок"});

window.addEventListener("cqa:logout", e => { if (me) { me = null; toast(e.detail || "Сессия истекла. Войдите снова", true); } renderLogin(); });
window.addEventListener("hashchange", route);
document.addEventListener("click", e => { if (pop && !e.target.closest(".pop") && !e.target.closest("[data-pop]")) closePop(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closePop(); });

async function boot() {
  try {
    me = await api("/auth/me");
    if (!validateSessionRole()) return;
    await Promise.all([loadCritNames(), ensureDemoUsers()]);
    await resolveDynamicsContext();
    route();
  } catch (e) {
    if (e.status === 401) renderLogin();
    else $("#root").innerHTML = `<div class="loading">${esc(e.message)}</div>`;
  }
}

async function resolveDynamicsContext() {
  const url = new URL(location.href), external = url.searchParams.get('dynamics_id');
  if (!external) return false;
  url.searchParams.delete('dynamics_id');
  try {
    const result = await api('/integrations/dynamics/dialog/' + encodeURIComponent(external));
    url.hash = '#/dialog/' + encodeURIComponent(result.dialog_id);
    history.replaceState(null, '', url);
    return true;
  } catch (e) {
    history.replaceState(null, '', url);
    toast(e.message, true);
    return false;
  }
}

// ---------- Вход ----------
async function renderLogin() {
  clearInterval(poll); me = null;
  let demo = { enabled: false, users: [] };
  try { demo = await api("/auth/demo"); } catch {}
  demoUsers = demo.users || [];

  const pick = rs => rs.map(r => demoUsers.find(u => u.role === r)).filter(Boolean);

  const icons = {
    qa: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="m8 12 3 3 6-7"/>',
    op: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2Z"/>',
    lead: '<circle cx="9" cy="7" r="3"/><path d="M2 21v-3a7 7 0 0 1 14 0v3M17 4a3 3 0 0 1 0 6m2 3a6 6 0 0 1 3 5v3"/>',
    adm: '<circle cx="12" cy="12" r="4"/><path d="m9 3 1-2h4l1 2 3 2 3 0 2 4-2 2v3l2 2-2 4-3 0-3 2h-6l-3-2H3l-2-4 2-2v-3L1 9l2-4h3Z"/>'
  };
  const icon = (body, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const arrow = icon('<path d="M4 12h16m-6-6 6 6-6 6"/>');
  const descriptions = {qa:'Проверка и оценки',op:'Мои результаты',lead:'Команда и обратная связь',adm:'Доступ и настройки'};
  $("#root").innerHTML = `<main class="entry-page">
    <section class="entry-story" aria-labelledby="entry-title">
      <a class="entry-brand" href="#/home">FREEDOM <i>/</i> <span>QUALITY</span></a>
      <div class="entry-message"><h1 id="entry-title">Единая система <br>контроля <br>качества</h1><p>Оценки диалогов, проверка и обратная связь</p></div>
      <div class="entry-illustration" aria-hidden="true"><div>${icon('<path d="M5 4h14a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-6l-5 4v-4H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z"/><path d="M7 11h.1m4.9 0h.1m4.9 0h.1"/>')}</div><span></span><div>${icon('<path d="m2 5 2 2 3-4m-5 9 2 2 3-4m-5 9 2 2 3-4M11 5h11M11 12h11M11 19h11"/>')}</div><span></span><div class="entry-complete">${icon('<path d="m4 12 5 5L20 5"/>')}</div></div>
      <footer>Demo Environment <span>·</span> Data Challenge 2026</footer>
    </section>
    <section class="entry-panel" aria-labelledby="entry-welcome">
      <div class="entry-kicker">Вход в систему</div><h2 id="entry-welcome">Добро пожаловать</h2>
      <form id="lf">
        <div class="entry-field">${icon('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m3 6 9 7 9-7"/>')}<input id="lu" autocomplete="username" placeholder="Рабочая почта или логин" aria-label="Рабочая почта или логин" required></div>
        <div class="entry-field">${icon('<rect x="4" y="10" width="16" height="12" rx="2"/><path d="M7 10V6a5 5 0 0 1 10 0v4"/>')}<input id="lp" type="password" autocomplete="current-password" placeholder="Пароль" aria-label="Пароль" required><button type="button" id="password-toggle" aria-label="Показать пароль" aria-pressed="false">${icon('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z"/><circle cx="12" cy="12" r="3"/>')}</button></div>
        <button type="button" class="entry-help" id="password-help" aria-expanded="false" aria-controls="password-note">Забыли пароль?</button>
        <p id="password-note" class="entry-note" hidden>Для восстановления доступа обратитесь к администратору вашей команды.</p>
        <div class="err hidden" id="lerr" role="alert"></div>
        <button class="entry-submit btn pri" type="submit">Войти ${arrow}</button>
      </form>
      ${demo.enabled ? `<div class="entry-divider"><span>Быстрый вход для демонстрации</span></div>
      <div class="entry-roles">${pick(DEMO_ROLES).map(u => `<button type="button" class="entry-role" data-demo="${u.id}">${icon(icons[u.role])}<span><b>${ROLE[u.role]}</b><small>${descriptions[u.role]}</small></span>${arrow}</button>`).join('')}</div>
      ` : ''}
    </section></main>`;

  $("#password-toggle").onclick = e => {
    const show = $("#lp").type === "password";
    $("#lp").type = show ? "text" : "password";
    e.currentTarget.setAttribute("aria-pressed", String(show));
    e.currentTarget.setAttribute("aria-label", show ? "Скрыть пароль" : "Показать пароль");
  };
  $("#password-help").onclick = e => {
    const note = $("#password-note"); note.hidden = !note.hidden;
    e.currentTarget.setAttribute("aria-expanded", String(!note.hidden));
  };

  $("#lf").onsubmit = async e => {
    e.preventDefault(); const err = $("#lerr"); err.classList.add("hidden");
    const btn = e.submitter || $("#lf .btn.pri");
    await busy(btn, async () => {
      try { await api("/auth/login", { body: { login: $("#lu").value, password: $("#lp").value } }); await afterLogin(); }
      catch (x) { err.textContent = x.message; err.classList.remove("hidden"); $("#lp").select(); }
    });
  };
  $$("[data-demo]").forEach(b => b.onclick = () => busy(b, async () => {
    await api("/auth/demo/" + b.dataset.demo, { body: {} });
    await afterLogin();
  }));
  if (!demo.enabled) $("#lu")?.focus();
}

async function afterLogin(preserveHash = true) {
  const prevHash = location.hash.replace(/^#\/?/, "");
  me = await api("/auth/me");
  if (!validateSessionRole()) return;
  await Promise.all([loadCritNames(), ensureDemoUsers()]);
  if (await resolveDynamicsContext()) { route(); return; }
  if (preserveHash && prevHash) {
    const [v, ...rest] = prevHash.split("/");
    const arg = decodeURIComponent(rest.join("/"));
    if (v === "dialog" && arg) {
      try {
        await api("/dialogs/" + encodeURIComponent(arg));
        route();
        return;
      } catch {}
    } else if (allowed(me.role, v)) {
      route();
      return;
    }
  }
  lastList = null;
  try { sessionStorage.removeItem("cqa-last"); } catch {}
  history.replaceState(null, "", "#/" + HOME[me.role]);
  route();
}

async function switchRole(uid) {
  await api("/auth/demo/" + uid, { body: {} });
  $("#root").innerHTML = "";
  await afterLogin(true);
  if (me) toast(`Роль: ${ROLE[me.role]} (${me.name})`);
}

async function logout() {
  await api("/auth/logout", { body: {} }).catch(() => {});
  me = null;
  history.replaceState(null, "", "#/");
  renderLogin();
}

// ---------- Каркас ----------
async function refreshMe() {
  try {
    const previousRole = me?.role;
    me = await api("/auth/me");
    if (!validateSessionRole()) return;
    if (previousRole !== me.role) return route();
    drawSideCounts(); drawBell();
  } catch {}
}

function route() {
  if (!me) return boot();
  if (!validateSessionRole()) return;
  const h = location.hash.replace(/^#\/?/, "");
  let [v, ...rest] = h.split("/");
  const arg = decodeURIComponent(rest.join("/"));
  if (!v || !allowed(me.role, v)) {
    if (v) toast("Раздел недоступен для выбранной роли — открыт стартовый экран");
    history.replaceState(null, "", "#/" + HOME[me.role]);
    v = HOME[me.role];
  }
  if (v !== "dialog" && NAV[me.role].some(g => g[1].some(i => i[0] === v))) {
    lastList = v;
    try { sessionStorage.setItem("cqa-last", v); } catch {}
  }
  renderShell(v, arg);
  if (matchMedia("(max-width: 860px)").matches) $(".app")?.classList.add("collapsed");
}

function renderShell(v, arg) {
  if (!validateSessionRole()) return;
  closePop();
  if (!$(".app")) {
    $("#root").innerHTML = `<div class="app qa-shell">
     <aside class="side" aria-label="Навигация">
       <div class="brand"><div class="mark">f.</div><div><b>Freedom</b><span>Контроль качества</span></div></div>
       <nav class="nav" id="nav"></nav>
       <div class="side-demo" id="sdemo"></div>
       <div class="foot" id="sfoot"></div>
     </aside>
     <div class="main">
       <header class="top">
         <a class="qa-brand" href="#/home">FREEDOM <i>/</i> <span>QUALITY</span></a><nav class="qa-nav" id="qa-nav" aria-label="Разделы QA"></nav>
         <button class="ib" id="navt" aria-label="Скрыть или показать меню" title="Боковое меню"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg></button>
         <div class="crumbs" id="crumbs"></div>
         <div class="top-right">
           <button class="ib" id="theme" aria-label="Сменить тему" title="Светлая / тёмная тема"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg></button>
           <button class="ib" id="bell" data-pop aria-label="Уведомления" title="Уведомления"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg></button>
           <button class="who" id="who" data-pop></button>
         </div>
       </header>
       <section class="view" id="view" tabindex="-1"></section>
     </div></div>`;
    const A = $(".app");
    try { if (localStorage.getItem("cqa-nav") === "0" || matchMedia("(max-width: 860px)").matches) A.classList.add("collapsed"); } catch {}
    $("#navt").onclick = () => { const c = A.classList.toggle("collapsed"); try { localStorage.setItem("cqa-nav", c ? "0" : "1"); } catch {} };
    $("#bell").onclick = () => togglePop("bell");
    $("#who").onclick = () => togglePop("who");
    $("#theme").onclick = () => {
      const r = document.documentElement;
      const dark = r.dataset.theme === "dark";
      r.dataset.theme = dark ? "light" : "dark";
      try { localStorage.setItem("cqa-theme-v4", r.dataset.theme); } catch {}
    };
    clearInterval(poll);
    poll = setInterval(refreshMe, 20000);
  }

  $("#who").innerHTML = `<span class="ava">${esc(initials(me.name))}</span><span class="who-txt"><b>${esc(me.name)}</b><small>${SHORT_ROLE[me.role] || ROLE[me.role]}</small></span><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" style="color:var(--fg-3)"><path d="M4 6l4 4 4-4"/></svg>`;
  $("#sfoot").innerHTML = `<div class="side-context"><span class="live-dot"></span>${esc(SHORT_ROLE[me.role])}</div><p>${esc(WORK[me.role].steps[0])}.<br>${esc(WORK[me.role].steps[1])}.</p><div class="sfoot-row"><span>Стандарт оценки</span><b>v${me.checklist.version}</b></div>`;
  // The approved QA shell is the common visual foundation for every role.
  $(".app").classList.add("qa-shell");
  $(".app").dataset.role = me.role;
  const demoBox = $("#sdemo");
  $(".side").appendChild(demoBox);
  const menus = {
    qa: [["home","Обзор"],["dialogs","Диалоги"],["checklists","Чек-листы"],["appeals","Апелляции"],["queue","Очередь QA"]],
    op: [["home","Мои результаты"],["my","Мои оценки"],["rules","Критерии"],["appeals","Апелляции"],["development","Развитие"]],
    lead: [["home","Моя главная"],["group","Обзор группы"],["team","Команда"],["dialogs","Разборы"],["appeals","Апелляции"],["qa-control","Мониторинг проверок"],["development","Развитие"]],
    adm: [["home","Обзор"],["users","Пользователи"],["settings","Настройки"],["upload","Загрузка"],["dialogs","Диалоги"],["audit","История"],["integrations","Интеграция"]]
  };
  const reviewPages = ["queue", "dialogs", "dialog", "appeals", "violations", "upload", "jobs"];
  const active = v === "employee" || v === "coaching" ? "team" : v === "appeal-new" ? "appeals" : v === "dialog" ? ({op:"my",lead:"dialogs",adm:"dialogs",qa:"dialogs"}[me.role]) : v === "jobs" ? "upload" : v;
  const navLink = ([key, label], current) => `<a href="#/${key}"${current === key ? ' class="on" aria-current="page"' : ""}>${label}</a>`;
  $("#qa-nav").setAttribute("aria-label", "Основные разделы");
  $("#qa-nav").innerHTML = menus[me.role].map(item => navLink(item, active)).join("");
  $("#role-subnav")?.remove();

  drawSideDemo();
  drawNav(v);
  drawBell();

  const title = v === "home" ? "Обзор" : v === "dialogs" && me.role === "lead" ? "Диалоги группы" : TITLES[v];
  const back = backList();
  $("#crumbs").innerHTML = arg && v === "dialog" ? `<a href="#/${back}">${esc(navTitle(back))}</a><span class="sep">/</span><b class="mono">${esc(arg)}</b>`
    : arg && ["jobs", "appeals", "checklists"].includes(v) ? `<a href="#/${v === "jobs" ? "upload" : v}">${TITLES[v === "jobs" ? "upload" : v]}</a><span class="sep">/</span><b>${v === "appeals" ? "А-" + esc(arg) : v === "jobs" ? "Пакет #" + esc(arg) : "v" + esc(arg)}</b>`
    : `<b>${title}</b>`;
  document.title = `${title} — CQA Freedom`;

  const el = $("#view");
  el.className = "view";
  el.dataset.page = v;
  el.dataset.role = me.role;
  el.innerHTML = `<div class="loading">Загрузка…</div>`;
  const token = Symbol();
  curView = token;
  const ctx = { me, go, arg, refresh: refreshMe, rerender: () => renderShell(v, arg), alive: () => curView === token && el.isConnected, switchRole };
  const opViews = {home:OP.home,my:OP.my,rules:OP.rules,appeals:OP.appeals,"appeal-new":OP.appealNew};
  const leadViews = {home:LEAD.home,group:LEAD.overview,team:LEAD.team,employee:LEAD.employee,dialogs:LEAD.dialogs,dialog:LEAD.dialog,appeals:LEAD.appeals,coaching:LEAD.coaching,"qa-control":LEAD.qaControl,dashboard:LEAD.overview};
  const fn = v === "development" ? development : v === "integrations" ? integrations : me.role === "lead" && leadViews[v] ? leadViews[v] : me.role === "op" && opViews[v] ? opViews[v] : me.role === "qa" && v === "home" ? qaOverview : V[v];
  Promise.resolve(fn(el, ctx)).catch(e => {
    if (curView === token) el.innerHTML = `<div class="note bad" style="margin:24px">${esc(e.message)}</div>`;
  });
}

function drawSideDemo() {
  const box = $("#sdemo");
  if (!box) return;
  box.innerHTML = "";
}

function backList() {
  return (lastList && allowed(me.role, lastList) ? lastList : null) || (me.role === "op" ? "my" : allowed(me.role, "dialogs") ? "dialogs" : HOME[me.role]);
}
function navTitle(k) {
  for (const [, items] of NAV[me.role]) for (const [key, t] of items) if (key === k) return t;
  return TITLES[k] || "Назад";
}
function drawNav(v) {
  const c = me.counts || {};
  $("#nav").innerHTML = NAV[me.role].map(([g, items]) => {
    const secondary = g === "Стандарты";
    const heading = secondary ? `<details class="more-nav" ${items.some(([k]) => k === v) ? "open" : ""}><summary>${g}</summary>` : `<div class="nav-g">${g}</div>`;
    return heading + items.map(([k, t, cnt]) => {
    const n = cnt ? c[cnt] : 0;
    const on = v === k || (v === "jobs" && k === "upload") || (v === "dialog" && k === backList());
    return `<a href="#/${k}" class="${on ? "on" : ""}" ${on ? 'aria-current="page"' : ""}><span>${t}</span>${n ? `<span class="cnt ${cnt === "violations" ? "hot" : ""}" data-cnt="${cnt}">${n}</span>` : `<span class="cnt" data-cnt="${cnt || ""}"></span>`}</a>`;
  }).join("") + (secondary ? "</details>" : "");
  }).join("");
}
function drawSideCounts() {
  $$("#nav [data-cnt]").forEach(s => { const k = s.dataset.cnt; if (!k) return; const n = me.counts[k]; s.textContent = n || ""; });
}
function drawBell() {
  const b = $("#bell"); if (!b) return;
  b.querySelector(".badge")?.remove();
  if (me.unread) b.insertAdjacentHTML("beforeend", `<span class="badge">${me.unread > 99 ? "99+" : me.unread}</span>`);
}
function closePop() { pop = null; $$(".pop").forEach(p => p.remove()); }

async function togglePop(k) {
  if (pop === k) return closePop();
  closePop(); pop = k;
  const p = document.createElement("div"); p.className = "pop"; p.setAttribute("role", "dialog"); $(".main").appendChild(p);
  if (k === "who") {
    await ensureDemoUsers();
    const others = me.demo ? DEMO_ROLES.filter(r => r !== me.role).map(r => demoUsers.find(u => u.role === r)).filter(Boolean) : [];
    p.innerHTML = `<div class="eyebrow" style="padding:6px 10px 4px">${esc(me.name)} · ${ROLE[me.role]}</div>
      ${others.length ? `<div class="eyebrow" style="padding:8px 10px 4px">Быстрое переключение роли</div>${others.map(u => `<button class="it" data-sw="${u.id}"><b>${ROLE[u.role]}</b><small>${esc(u.name)}${u.team ? " · " + esc(u.team) : ""}</small></button>`).join("")}` : ""}
      <div style="border-top:1px solid var(--line);margin:6px 0"></div>
      <button class="it" data-a="logout" style="color:var(--bad)">Выйти из аккаунта</button>`;
    p.onclick = e => {
      const s = e.target.closest("[data-sw]"); if (s) { closePop(); switchRole(s.dataset.sw).catch(fail); return; }
      const b = e.target.closest("[data-a]"); if (!b) return; closePop();
      if (b.dataset.a === "logout") logout();
    };
    return;
  }
  p.innerHTML = `<div class="loading" style="padding:16px">Загрузка…</div>`;
  try {
    const ns = await api("/notifications");
    p.innerHTML = `<div class="eyebrow" style="padding:6px 10px 6px">Уведомления</div>` + (ns.length ? ns.map(n => `<button class="it ${n.read ? "" : "unread"}" data-link="${esc(n.link || "")}">${esc(n.text)}<small>${ago(n.at)}</small></button>`).join("")
      : `<p class="muted sm" style="padding:10px">Новых уведомлений нет.</p>`);
    p.onclick = e => { const b = e.target.closest("[data-link]"); if (!b) return; closePop(); if (b.dataset.link) go(b.dataset.link); };
    if (me.unread) { await api("/notifications/read", { body: {} }); me.unread = 0; drawBell(); }
  } catch (e) { p.innerHTML = `<p class="err" style="padding:10px">${esc(e.message)}</p>`; }
}

document.documentElement.dataset.theme = "light";
try {
  const t = localStorage.getItem("cqa-theme-v4");
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
} catch {}
boot();
