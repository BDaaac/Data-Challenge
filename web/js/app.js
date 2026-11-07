// Точка входа: вход, каркас, меню по роли, маршрутизация по #/адресу, уведомления.
import { $, $$, api, esc, toast, fail, initials, ROLE, ago, busy, setCritNames } from "./ui.js";
import * as V from "./views.js";

const NAV = {
  qa: [["Работа", [["queue", "Очередь проверки", "queue"], ["upload", "Новые диалоги"], ["dialogs", "Все диалоги"], ["violations", "Грубые ошибки", "violations"], ["appeals", "Апелляции", "appeals"]]],
       ["Качество", [["checklists", "Чек-листы"], ["calibration", "Калибровка модели"], ["dashboard", "Где теряем качество"]]]],
  op: [["Мои оценки", [["my", "Мои диалоги", "unread"], ["appeals", "Мои апелляции", "appeals"], ["rules", "Как меня оценивают"]]]],
  lead: [["Группа", [["team", "Моя группа"], ["dialogs", "Диалоги группы"], ["appeals", "Апелляции группы", "appeals"], ["violations", "Грубые ошибки", "violations"]]], ["Аналитика", [["dashboard", "Где теряем качество"]]]],
  head: [["Аналитика", [["dashboard", "Обзор качества"], ["team", "Операторы"], ["calibration", "Калибровка модели"]]],
         ["Работа", [["queue", "Очередь проверки", "queue"], ["upload", "Новые диалоги"], ["dialogs", "Все диалоги"], ["violations", "Грубые ошибки", "violations"], ["appeals", "Апелляции", "appeals"]]],
         ["Настройка", [["checklists", "Чек-листы"], ["audit", "Журнал действий"]]]],
  dir: [["Аналитика", [["dashboard", "Обзор качества"], ["violations", "Грубые ошибки", "violations"]]]],
  comp: [["Комплаенс", [["violations", "Грубые ошибки", "violations"], ["audit", "Журнал действий"]]]],
  adm: [["Администрирование", [["users", "Пользователи"], ["settings", "Модель и оценка"], ["audit", "Журнал действий"]]], ["Данные", [["upload", "Новые диалоги"], ["dialogs", "Все диалоги"]]]]
};
const HOME = { qa: "queue", op: "my", lead: "team", head: "dashboard", dir: "dashboard", comp: "violations", adm: "users" };
const EXTRA = { qa: ["dialog", "jobs", "rules"], op: ["dialog"], lead: ["dialog", "rules"], head: ["dialog", "jobs", "rules"], dir: ["dialog"], comp: ["dialog", "dialogs"], adm: ["dialog", "jobs", "checklists"] };
const TITLES = { queue: "Очередь проверки", upload: "Новые диалоги", jobs: "Оценка пакета", dialogs: "Диалоги", violations: "Грубые ошибки", appeals: "Апелляции",
  checklists: "Чек-листы", calibration: "Калибровка модели", my: "Мои диалоги", rules: "Как меня оценивают", team: "Операторы", dashboard: "Обзор качества",
  users: "Пользователи", settings: "Модель и оценка", audit: "Журнал действий", dialog: "Диалог" };

let me = null, pop = null, poll = null, curView = null, demoUsers = [];
let lastList = (() => { try { return sessionStorage.getItem("cqa-last") } catch { return null } })();
const go = h => { location.hash = "#/" + h; };
const DEMO_ROLES = ["qa", "op", "head", "lead", "dir", "comp", "adm"]; // первые три — основные сценарии защиты
async function loadCritNames() { try { const c = await api("/checklists/" + me.checklist.id); setCritNames(c.criteria); } catch {} }
const allowed = (r, v) => NAV[r].some(g => g[1].some(i => i[0] === v)) || EXTRA[r].includes(v);

window.addEventListener("cqa:logout", e => { if (me) { me = null; toast(e.detail || "Сессия истекла. Войдите снова", true); } renderLogin(); });
window.addEventListener("hashchange", route);
document.addEventListener("click", e => { if (pop && !e.target.closest(".pop") && !e.target.closest("[data-pop]")) closePop(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closePop(); });

async function boot() {
  try { me = await api("/auth/me"); await loadCritNames(); route(); }
  catch (e) { if (e.status === 401) renderLogin(); else $("#root").innerHTML = `<div class="loading">${esc(e.message)}</div>`; }
}

// ---------- вход ----------
async function renderLogin() {
  clearInterval(poll); me = null;
  let demo = { enabled: false, users: [] };
  try { demo = await api("/auth/demo"); } catch {}
  demoUsers = demo.users || [];
  const hint = { qa: "Разбирает то, что модель отдала человеку: грубые ошибки, сомнения, апелляции", op: "Видит свои оценки с обоснованием и может их оспорить",
    head: "Меняет чек-лист: критерии, веса, публикация новой версии", lead: "Своя группа операторов, коучинг, апелляции группы",
    dir: "Обзор качества и грубые ошибки по всему контакт-центру", comp: "Реестр грубых нарушений и журнал действий", adm: "Пользователи, модель, бюджет, журнал" };
  const tryIt = { qa: "Покажите: грубые ошибки и почему", op: "Покажите: апелляция на оценку", head: "Покажите: добавить критерий или изменить вес" };
  const pick = rs => rs.map(r => demoUsers.find(u => u.role === r)).filter(Boolean);
  const opt = u => `<option value="${u.id}" data-role="${u.role}">${ROLE[u.role]} — ${esc(u.name)}</option>`;
  $("#root").innerHTML = `<main class="login">
   <section class="l1">
     <div class="brand" style="padding:0"><div class="mark">CQA</div><div><b>Контроль качества диалогов</b><span>Freedom Broker · контакт-центр</span></div></div>
     <div><h1>Вход в систему</h1><p class="muted" style="margin-top:8px">Корпоративная учётная запись.</p></div>
     <form id="lf" novalidate>
       <label class="l" for="lu">Логин</label><input class="f" id="lu" autocomplete="username" required>
       <label class="l" for="lp">Пароль</label><input class="f" id="lp" type="password" autocomplete="current-password" required>
       <div class="err hidden" id="lerr" role="alert"></div>
       <div class="acts" style="margin-top:var(--s-lg)"><button class="btn ${demo.enabled ? "" : "pri"}" type="submit">Войти</button></div>
     </form>
     ${demo.enabled ? `<div class="or">или демо-доступ без пароля</div>
     <div class="demo"><label class="l" for="dr" style="margin:0">Роль</label>
       <select class="f" id="dr"><optgroup label="Основные сценарии">${pick(DEMO_ROLES.slice(0, 3)).map(opt).join("")}</optgroup><optgroup label="Другие роли">${pick(DEMO_ROLES.slice(3)).map(opt).join("")}</optgroup></select>
       <p class="hint" id="dh"></p>
       <button class="btn pri" id="dgo" type="button">Войти в роль</button></div>` : ""}
   </section>
   <section class="l2">
     <div><h2 style="font-size:28px;letter-spacing:-.03em;line-height:1.15;max-width:18ch">Каждый диалог проверен. Каждый балл объяснён.</h2>
       <p class="lead" style="margin-top:12px">Модель оценивает 100% чатов и звонков по чек-листу Freedom и ссылается на реплики. Грубые ошибки и спорное уходят человеку.</p></div>
     <div class="facts">
       <div><b>91,7%</b><span>совпадение с ручной разметкой QA на эталонных диалогах</span></div>
       <div><b>8</b><span>критериев чек-листа, включая флаг грубой ошибки</span></div>
       <div><b>≈ $0,02</b><span>стоимость проверки одного диалога моделью</span></div>
       <div><b>0</b><span>вызовов модели при смене веса критерия — только пересчёт</span></div>
     </div>
   </section></main>`;
  const dr = $("#dr");
  if (dr) {
    const showHint = () => { const r = dr.selectedOptions[0]?.dataset.role; $("#dh").innerHTML = `${esc(hint[r] || "")}${tryIt[r] ? `<br><b>${esc(tryIt[r])}</b>` : ""}`; };
    dr.onchange = showHint; showHint();
    $("#dgo").onclick = () => busy($("#dgo"), async () => { await api("/auth/demo/" + dr.value, { body: {} }); await afterLogin(); });
  }
  $("#lf").onsubmit = async e => {
    e.preventDefault(); const err = $("#lerr"); err.classList.add("hidden");
    const btn = e.submitter || $("#lf .btn.pri");
    await busy(btn, async () => {
      try { await api("/auth/login", { body: { login: $("#lu").value, password: $("#lp").value } }); await afterLogin(); }
      catch (x) { err.textContent = x.message; err.classList.remove("hidden"); $("#lp").select(); }
    });
  };
  $$("[data-demo]").forEach(b => b.onclick = () => busy(b, async () => { await api("/auth/demo/" + b.dataset.demo, { body: {} }); await afterLogin(); }));
  if (!demo.enabled) $("#lu")?.focus();
}
async function afterLogin() { me = await api("/auth/me"); await loadCritNames(); lastList = null; try { sessionStorage.removeItem("cqa-last") } catch {} history.replaceState(null, "", "#/" + HOME[me.role]); route(); }
async function switchRole(uid) {
  await api("/auth/demo/" + uid, { body: {} });
  $("#root").innerHTML = ""; // каркас перерисуется под новую роль
  await afterLogin();
  toast(`Вы вошли как ${ROLE[me.role]} · ${me.name}`);
}
async function logout() { await api("/auth/logout", { body: {} }).catch(() => {}); me = null; history.replaceState(null, "", "#/"); renderLogin(); }

// ---------- каркас ----------
async function refreshMe() { try { me = await api("/auth/me"); drawSideCounts(); drawBell(); } catch {} }
function route() {
  if (!me) return boot();
  const h = location.hash.replace(/^#\/?/, "");
  let [v, ...rest] = h.split("/"); const arg = decodeURIComponent(rest.join("/"));
  if (!v || !allowed(me.role, v)) { if (v) toast("Этот раздел недоступен для вашей роли. Открыт ваш стартовый экран"); history.replaceState(null, "", "#/" + HOME[me.role]); v = HOME[me.role]; }
  if (v !== "dialog" && NAV[me.role].some(g => g[1].some(i => i[0] === v))) { lastList = v; try { sessionStorage.setItem("cqa-last", v) } catch {} } // откуда пришли в карточку диалога
  renderShell(v, arg);
}
function renderShell(v, arg) {
  closePop();
  if (!$(".app")) {
    $("#root").innerHTML = `<div class="app">
     <aside class="side" aria-label="Навигация"><div class="brand"><div class="mark">CQA</div><div><b>Контроль качества</b><span>Freedom Broker</span></div></div><nav class="nav" id="nav"></nav><div class="foot" id="sfoot"></div></aside>
     <div class="main"><header class="top"><button class="ib" id="navt" aria-label="Скрыть или показать меню" title="Скрыть или показать меню"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg></button><div class="crumbs" id="crumbs"></div>
       <button class="ib" id="theme" aria-label="Сменить тему" title="Сменить тему"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z"/></svg></button>
       <button class="ib" id="bell" data-pop aria-label="Уведомления"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg></button>
       <button class="who" id="who" data-pop></button></header>
       <section class="view" id="view" tabindex="-1"></section></div></div>`;
    const A = $(".app"); try { if (localStorage.getItem("cqa-nav") === "0") A.classList.add("collapsed"); } catch {}
    $("#navt").onclick = () => { const c = A.classList.toggle("collapsed"); try { localStorage.setItem("cqa-nav", c ? "0" : "1"); } catch {} };
    $("#bell").onclick = () => togglePop("bell");
    $("#who").onclick = () => togglePop("who");
    $("#theme").onclick = () => { const r = document.documentElement; const dark = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; r.dataset.theme = dark ? "light" : "dark"; try { localStorage.setItem("cqa-theme", r.dataset.theme); } catch {} };
    clearInterval(poll); poll = setInterval(refreshMe, 20000);
  }
  $("#who").innerHTML = `<span class="ava">${esc(initials(me.name))}</span><span>${esc(me.name)}<small>${ROLE[me.role]}${me.team ? " · " + esc(me.team) : ""}</small></span>`;
  $("#sfoot").innerHTML = `Чек-лист «${esc(me.checklist.name)}» v${me.checklist.version}<br>Модель: ${me.model === "haiku" ? "Haiku 5.5" : "Sonnet 5.5"}`;
  drawNav(v); drawBell();
  const title = v === "dialogs" && me.role === "lead" ? "Диалоги группы" : TITLES[v];
  const back = backList();
  $("#crumbs").innerHTML = arg && v === "dialog" ? `<a href="#/${back}">${esc(navTitle(back))}</a><span>/</span><b>${esc(arg)}</b>`
    : arg && ["jobs", "appeals", "checklists"].includes(v) ? `<a href="#/${v === "jobs" ? "upload" : v}">${TITLES[v === "jobs" ? "upload" : v]}</a><span>/</span><b>${v === "appeals" ? "А-" + esc(arg) : v === "jobs" ? "Пакет " + esc(arg) : "Версия"}</b>` : `<b>${title}</b>`;
  document.title = `${title} — CQA`;
  const el = $("#view"); el.className = "view"; el.innerHTML = `<div class="loading">Загрузка…</div>`;
  const token = Symbol(); curView = token;
  const ctx = { me, go, arg, refresh: refreshMe, rerender: () => renderShell(v, arg), alive: () => curView === token && el.isConnected };
  const fn = V[v];
  Promise.resolve(fn(el, ctx)).catch(e => { if (curView === token) el.innerHTML = `<div class="note bad">${esc(e.message)}</div>`; });
}
function backList() { return (lastList && allowed(me.role, lastList) ? lastList : null) || (me.role === "op" ? "my" : allowed(me.role, "dialogs") ? "dialogs" : HOME[me.role]); }
function navTitle(k) { for (const [, items] of NAV[me.role]) for (const [key, t] of items) if (key === k) return t; return TITLES[k] || "Назад"; }
function drawNav(v) {
  const c = me.counts || {};
  $("#nav").innerHTML = NAV[me.role].map(([g, items]) => `<div class="nav-g">${g}</div>` + items.map(([k, t, cnt]) => {
    const n = cnt ? c[cnt] : 0; const on = v === k || (v === "jobs" && k === "upload") || (v === "dialog" && k === backList());
    return `<a href="#/${k}" class="${on ? "on" : ""}" ${on ? 'aria-current="page"' : ""}>${t}${n ? `<span class="cnt ${cnt === "violations" ? "hot" : ""}" data-cnt="${cnt}">${n}</span>` : `<span class="cnt" data-cnt="${cnt || ""}"></span>`}</a>`;
  }).join("")).join("");
}
function drawSideCounts() { $$("#nav [data-cnt]").forEach(s => { const k = s.dataset.cnt; if (!k) return; const n = me.counts[k]; s.textContent = n || ""; }); }
function drawBell() { const b = $("#bell"); if (!b) return; b.querySelector(".badge")?.remove(); if (me.unread) b.insertAdjacentHTML("beforeend", `<span class="badge">${me.unread > 99 ? "99+" : me.unread}</span>`); }
function closePop() { pop = null; $$(".pop").forEach(p => p.remove()); }
async function togglePop(k) {
  if (pop === k) return closePop(); closePop(); pop = k;
  const p = document.createElement("div"); p.className = "pop"; p.setAttribute("role", "dialog"); $(".main").appendChild(p);
  if (k === "who") {
    if (me.demo && !demoUsers.length) { try { demoUsers = (await api("/auth/demo")).users || []; } catch {} }
    const others = me.demo ? DEMO_ROLES.filter(r => r !== me.role).map(r => demoUsers.find(u => u.role === r)).filter(Boolean) : [];
    p.innerHTML = `<div class="sh" style="padding:4px 8px 8px">${esc(me.name)} · ${ROLE[me.role]}</div>
      ${others.length ? `<div class="sh" style="padding:8px 8px 4px">Сменить роль</div>${others.map(u => `<button class="it" data-sw="${u.id}">${ROLE[u.role]}<small>${esc(u.name)}</small></button>`).join("")}` : ""}
      <button class="it" data-a="rules">Как оценивается работа<small>Активный чек-лист и правила</small></button>
      <button class="it" data-a="logout">Выйти</button>`;
    p.onclick = e => {
      const s = e.target.closest("[data-sw]"); if (s) { closePop(); switchRole(s.dataset.sw).catch(fail); return; }
      const b = e.target.closest("[data-a]"); if (!b) return; closePop(); if (b.dataset.a === "logout") logout(); else go("rules");
    };
    return;
  }
  p.innerHTML = `<div class="loading">Загрузка…</div>`;
  try {
    const ns = await api("/notifications");
    p.innerHTML = `<div class="row" style="padding:4px 8px 8px"><div class="sh" style="padding:0">Уведомления</div></div>` + (ns.length ? ns.map(n => `<button class="it ${n.read ? "" : "unread"}" data-link="${esc(n.link || "")}">${esc(n.text)}<small>${ago(n.at)}</small></button>`).join("")
      : `<p class="muted" style="padding:8px">Здесь появятся новые оценки, апелляции, решения и публикации чек-листа.</p>`);
    p.onclick = e => { const b = e.target.closest("[data-link]"); if (!b) return; closePop(); if (b.dataset.link) go(b.dataset.link); };
    if (me.unread) { await api("/notifications/read", { body: {} }); me.unread = 0; drawBell(); }
  } catch (e) { p.innerHTML = `<p class="err" style="padding:8px">${esc(e.message)}</p>`; }
}

// Тёмная тема по умолчанию; светлая — по кнопке в шапке, выбор запоминается
document.documentElement.dataset.theme = "dark";
try { const t = localStorage.getItem("cqa-theme"); if (t) document.documentElement.dataset.theme = t; } catch {}
boot();
