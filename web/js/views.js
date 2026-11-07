// Экраны приложения: плоская архитектурная сетка с разделителями 1px (Linear / Vercel / Stripe Data Ledger).
import { $, $$, api, esc, fmt, fmt0, money, scls, dt, ago, plural, toast, fail, busy, pill, stPill, reasonPills, ansLabel, ansPill, linkify,
  emptyBox, dialogTable, bindOpen, LANG, CH, SECS, ROLE, ST, REASON, AP_ST, VIOL, TRIGGER } from "./ui.js";
export { dialog } from "./v_dialog.js";
export { checklists, rules } from "./v_checklists.js";
export { home } from "./workspace.js";

const ph = (title, text, acts = "") => `<div class="ph"><div><h1>${title}</h1>${text ? `<p>${text}</p>` : ""}</div>${acts ? `<div class="acts">${acts}</div>` : ""}</div>`;
const stat = (l, v, d = "", txt = false) => `<div><div class="l">${l}</div><div class="v ${txt ? "txt" : ""}">${v}</div>${d ? `<div class="d">${d}</div>` : ""}</div>`;
const isStaff = r => ["qa", "adm"].includes(r);

// ======================= очередь разбора =======================
export async function queue(el, ctx) {
  const list = await api("/queue");
  if (!ctx.alive()) return;
  const st = queue.st || (queue.st = { f: "" });
  const has = (d, k) => k === "appeal" ? d.wf_status === "appeal" : (d.review || []).some(r => r.code === k);
  const keys = ["critical", "appeal", "error", "invalid", "no_evidence", "low_conf", "sample"];
  const lbl = k => k === "appeal" ? "Апелляции" : REASON[k][1];
  const cnt = Object.fromEntries(keys.map(k => [k, list.filter(d => has(d, k)).length]));
  const rows = st.f ? list.filter(d => has(d, st.f)) : list;
  el.innerHTML = ph(ctx.me.role === "qa" ? "Очередь QA" : "Очередь разбора", "",
      rows.length ? `<button class="btn pri sm" id="first">Разобрать первый</button>` : "")
    + `<div class="filters"><div class="chips"><button class="chip ${!st.f ? "on" : ""}" data-f="">Все<span class="c">${list.length}</span></button>${keys.filter(k => cnt[k]).map(k => `<button class="chip ${st.f === k ? "on" : ""}" data-f="${k}">${lbl(k)}<span class="c">${cnt[k]}</span></button>`).join("")}</div></div>`
    + dialogTable(rows, { reason: true, active: ctx.me.checklist.version, emptyT: "Очередь разбора пуста", emptyP: "Все спорные диалоги проверены и опубликованы.", emptyActs: `<a class="btn sm" href="#/upload">Загрузить диалоги</a>` });
  $$("[data-f]", el).forEach(b => b.onclick = () => { st.f = b.dataset.f; queue(el, ctx); });
  bindOpen(el, ctx.go);
  const f = $("#first", el); if (f) f.onclick = () => ctx.go("dialog/" + rows[0].id);
}

// ======================= загрузка новых диалогов =======================
export async function upload(el, ctx) {
  const st = upload.st || (upload.st = { tab: "file", text: "", channel: "agent chat", pick: new Set() });
  const [fresh, jobs] = await Promise.all([api("/dialogs?status=new"), api("/jobs")]);
  if (!ctx.alive()) return;
  const tabs = [["file", "JSON-выгрузка"], ["text", "Текстовый ввод"], ["new", `Ожидают оценки · ${fresh.length}`]];
  let body = "";
  if (st.tab === "file") body = `<div class="col-pane">
      <div class="drop" id="drop" tabindex="0" role="button" aria-label="Выбрать файл JSON">
        <h3>Перетащите JSON-файл выгрузки или нажмите для выбора</h3>
        <p class="sm muted" style="margin-top:4px;max-width:65ch">Формат выгрузки контакт-центра: массив или объект с <code>conversation_id</code> и <code>transcript</code>. Дубликаты пропускаются автоматически.</p>
        <input type="file" id="fi" accept=".json,application/json" hidden>
      </div>
      <label class="chk" style="margin-top:12px"><input type="checkbox" id="ev"> Сразу оценить моделью (расходует бюджет API)</label>
    </div>`;
  else if (st.tab === "text") body = `<div class="cols w flush-cols"><div class="col-pane">
      <label class="l" for="tx" style="margin-top:0">Текст диалога (одна реплика на строку)</label>
      <textarea class="f mono sm" id="tx" rows="11" placeholder="Клиент: Здравствуйте, не могу вывести деньги на карту&#10;Оператор: Здравствуйте! Меня зовут Айгерим. Подскажите номер договора?&#10;Клиент: 12345">${esc(st.text)}</textarea>
      <div class="err hidden" id="txerr" role="alert"></div>
      <div class="row" style="margin-top:12px"><select class="f sm" id="ch" style="width:auto"><option value="agent chat">Чат</option><option value="voice call" ${st.channel === "voice call" ? "selected" : ""}>Звонок (ASR)</option></select>
        <button class="btn pri sm" id="send">Импортировать и оценить</button></div></div>
      <div class="col-pane"><h3>Правила разбора</h3><p class="sm fg2" style="margin-top:6px;line-height:1.5">Каждая строка начинается с роли говорящего: <b>Клиент:</b>, <b>Оператор:</b>, <b>Бот:</b> или <b>Система:</b>. Таймстемпы вида <code>[10:42]</code> распознаются автоматически. Язык (RU / KZ / EN) определяется по тексту.</p></div></div>`;
  else body = fresh.length ? `<div class="filters"><span class="muted sm" id="pc">Выбрано: ${st.pick.size}</span><span class="grow"></span><button class="btn sm" id="all">Выбрать все</button><button class="btn pri sm" id="go" ${st.pick.size ? "" : "disabled"}>Оценить выбранные</button></div>` + dialogTable(fresh, { check: true })
    : emptyBox("Нет неоценённых диалогов", "Все импортированные обращения уже обработаны моделью.");

  el.innerHTML = ph("Загрузка данных", "Добавьте JSON-файл или вставьте текст разговора. Оценка моделью расходует бюджет API.")
    + `<div class="tabs" role="tablist">${tabs.map(([k, t]) => `<button role="tab" data-tab="${k}" class="${st.tab === k ? "on" : ""}" aria-selected="${st.tab === k}">${t}</button>`).join("")}</div>${body}`
    + `<div class="sec-hd">История пакетной оценки</div>${jobs.length ? `<div class="tw"><table class="t"><thead><tr><th>Пакет</th><th>Инициатор</th><th class="r">Диалогов</th><th>Запущен</th><th>Статус</th></tr></thead><tbody>${jobs.slice(0, 8).map(j => `<tr class="go" data-job="${j.id}"><td class="id">${esc(j.title)}</td><td>${esc(j.who || "система")}</td><td class="r num">${j.dialog_ids.length}</td><td class="muted">${ago(j.created_at)}</td><td>${j.finished_at ? pill("ok", "Готово") : pill("info pulse", "В работе", "pulse")}</td></tr>`).join("")}</tbody></table></div>` : `<div class="col-pane muted sm">Пакетов оценки пока нет.</div>`}`;

  $$("[data-tab]", el).forEach(b => b.onclick = () => { st.tab = b.dataset.tab; upload(el, ctx); });
  $$("[data-job]", el).forEach(r => r.onclick = () => ctx.go("jobs/" + r.dataset.job));
  const done = r => {
    ctx.refresh();
    const msg = `Загружено: ${r.added.length}` + (r.skipped.length ? `, пропущено повторов: ${r.skipped.length}` : "");
    toast(msg);
    if (r.job) ctx.go("jobs/" + r.job.id); else if (r.added.length) ctx.go("dialog/" + r.added[0]); else upload(el, ctx);
  };
  if (st.tab === "file") {
    const drop = $("#drop", el), fi = $("#fi", el);
    const read = async f => {
      if (!f) return;
      drop.innerHTML = `<h3>Чтение ${esc(f.name)}…</h3>`;
      try {
        let data; try { data = JSON.parse(await f.text()); } catch { throw new Error(`${f.name}: некорректный JSON`); }
        done(await api("/dialogs", { body: { records: data, evaluate: $("#ev", el).checked } }));
      } catch (e) { fail(e); upload(el, ctx); }
    };
    drop.onclick = () => fi.click();
    drop.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fi.click(); } };
    fi.onchange = () => read(fi.files[0]);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); read(e.dataTransfer.files[0]); };
  } else if (st.tab === "text") {
    const tx = $("#tx", el); tx.oninput = () => { st.text = tx.value; };
    $("#ch", el).onchange = e => { st.channel = e.target.value; };
    $("#send", el).onclick = e => busy(e.currentTarget, async () => {
      const er = $("#txerr", el); er.classList.add("hidden");
      if (!st.text.trim()) { er.textContent = "Вставьте текст диалога"; er.classList.remove("hidden"); return tx.focus(); }
      try { const r = await api("/dialogs", { body: { text: st.text, channel: st.channel } }); st.text = ""; done(r); }
      catch (x) { er.textContent = x.message; er.classList.remove("hidden"); tx.focus(); }
    });
  } else if (fresh.length) {
    const sync = () => { $("#pc", el).textContent = "Выбрано: " + st.pick.size; $("#go", el).disabled = !st.pick.size; $$("[data-pick]", el).forEach(c => { c.checked = st.pick.has(c.dataset.pick); c.closest("tr").classList.toggle("sel", c.checked); }); };
    $$("[data-pick]", el).forEach(c => c.onchange = () => { c.checked ? st.pick.add(c.dataset.pick) : st.pick.delete(c.dataset.pick); sync(); });
    const all = () => { const on = st.pick.size < fresh.length; st.pick = new Set(on ? fresh.map(d => d.id) : []); sync(); };
    $("#all", el).onclick = all; const ha = $("[data-all]", el); if (ha) ha.onchange = all;
    bindOpen(el, ctx.go); sync();
    $("#go", el).onclick = e => busy(e.currentTarget, async () => {
      const r = await api("/evaluate", { body: { dialog_ids: [...st.pick], title: `Оценка ${st.pick.size} ${plural(st.pick.size, "диалога", "диалогов", "диалогов")}` } });
      st.pick.clear(); ctx.go("jobs/" + r.job.id);
    });
  }
}

// ======================= пакет оценки =======================
export async function jobs(el, ctx) {
  if (!ctx.arg) return ctx.go("upload");
  const j = await api("/jobs/" + ctx.arg);
  if (!ctx.alive()) return;
  const ev = j.evaluations, total = j.dialog_ids.length;
  const fin = ev.filter(e => e.status !== "running").length;
  const its = ev.flatMap(e => e.items || []);
  const doneIt = its.filter(i => i.status !== "pending").length;
  const cost = ev.reduce((s, e) => s + Number(e.cost || 0), 0), calls = ev.reduce((s, e) => s + (e.calls || 0), 0);
  const reused = its.filter(i => i.source === "reused").length;
  const running = !j.finished_at;
  const crit = ev.filter(e => e.critical).length, part = ev.filter(e => e.status === "partial").length, rev = ev.filter(e => e.wf_status === "review").length;
  el.innerHTML = ph(esc(j.title), running ? "Параллельная оценка критериев моделью…" : `Завершено ${dt(j.finished_at)}.`,
      !running && rev ? `<a class="btn pri sm" href="#/queue">В очередь разбора (${rev})</a>` : "")
    + `<div class="strip">${stat("Диалогов", `${fin} / ${total}`)}${stat("Критериев", `${doneIt} / ${its.length}`, reused ? `${reused} из кеша` : "")}${stat("Вызовов LLM", fmt0(calls))}${stat("Стоимость", money(cost, 3))}${stat("Грубые ошибки", crit, part ? `сбоев: ${part}` : "")}</div>`
    + `<div class="prog" role="progressbar" aria-valuenow="${doneIt}" aria-valuemax="${its.length}"><b style="width:${its.length ? doneIt / its.length * 100 : 0}%"></b></div>`
    + `<div class="tw"><table class="t"><thead><tr><th>Диалог</th><th>Матрица критериев (1–8)</th><th class="r">Балл</th><th>Риск</th><th>Статус</th><th class="r">Время</th><th class="r">Цена</th></tr></thead><tbody>
      ${ev.map(e => `<tr class="go" data-open="${esc(e.dialog_id)}"><td class="id">${esc(e.dialog_id)}<span class="sub">${TRIGGER[e.trigger] || ""}</span></td>
        <td><div class="cells">${(e.items || []).map(i => `<i class="${i.status === "pending" ? "p" : i.status === "error" ? "e" : i.source === "reused" ? "r" : i.low ? "w" : "d"}" title="Пункт ${i.crit.slice(1)}"></i>`).join("")}</div></td>
        <td class="r">${e.status === "running" ? "…" : e.total != null ? `<span class="score ${scls(e.total)}">${fmt(e.total)}</span>` : "—"}</td>
        <td>${e.critical ? pill("bad", "Грубая ошибка") : '<span class="muted">—</span>'}</td>
        <td>${e.status === "running" ? pill("info pulse", "В работе", "pulse") : `${stPill(e.wf_status)} ${reasonPills(e.review)}`}</td>
        <td class="r muted num">${e.seconds != null ? String(e.seconds).replace(".", ",") + " с" : "—"}</td><td class="r muted num">${money(e.cost, 3)}</td></tr>`).join("")}</tbody></table></div>`;
  bindOpen(el, ctx.go);
  if (running) setTimeout(() => ctx.alive() && jobs(el, ctx), 1500);
  else if (jobs.last !== j.id) { jobs.last = j.id; ctx.refresh(); }
}

// ======================= все диалоги =======================
export async function dialogs(el, ctx) {
  const request = Symbol();
  ctx.dialogsRequest = request;
  const R = ctx.me.role;
  const stores = dialogs.states || (dialogs.states = {});
  const st = stores[ctx.me.id] || (stores[ctx.me.id] = { q: "", status: "", lang: "", channel: "", critical: false, failed: "", team: "", operator: "", pick: new Set() });
  if (ctx.arg) { Object.assign(st, {q:"", status:"", lang:"", channel:"", critical:false, failed:"", team:"", operator:"", pick:new Set()}); const p = new URLSearchParams(ctx.arg); for (const [k, v] of p) st[k] = k === "critical" ? v === "1" : v; history.replaceState(null, "", "#/dialogs"); ctx.arg = ""; }
  const qs = new URLSearchParams(); ["q", "status", "lang", "channel", "failed", "team", "operator"].forEach(k => st[k] && qs.set(k, st[k])); if (st.critical) qs.set("critical", "true");
  const [list, teams] = await Promise.all([api("/dialogs?" + qs), dialogs.teams || api("/teams")]);
  dialogs.teams = teams;
  if (!ctx.alive()) return;
  const crit = (await rulesCache()).criteria.filter(c => c.type !== "flag");
  if (!ctx.alive() || ctx.dialogsRequest !== request) return;
  const can = isStaff(R);
  const opt = (v, t, cur) => `<option value="${esc(v)}" ${cur === v ? "selected" : ""}>${esc(t)}</option>`;
  el.innerHTML = ph(R === "lead" ? "Диалоги группы" : "Диалоги", st.operator ? esc(st.operator) : "",
      `${R === "qa" ? `<a class="btn pri sm" href="#/upload">Загрузить диалог</a>` : ""}<a class="btn sm" href="/api/export/dialogs.csv">Экспорт CSV</a>${can ? `<a class="btn sm" href="/api/export/results.json">Экспорт JSON</a>` : ""}`)
    + (R === "qa" ? `<div class="strip">${stat("Всего",list.length)}${stat("На проверке",list.filter(d=>d.wf_status === "review").length)}${stat("Грубые ошибки",list.filter(d=>d.critical).length)}</div>` : "")
    + (st.operator && ["lead", "qa"].includes(R) ? `<div class="list-context"><span>Разбор разговоров сотрудника: <b>${esc(st.operator)}</b></span><a class="btn sm" href="#/team">К сотрудникам</a></div>` : "")
    + `<div class="filters" role="search">
       <input type="search" id="q" placeholder="Поиск по ID или оператору…" value="${esc(st.q)}" aria-label="Поиск">
       <select id="status" aria-label="Статус"><option value="">Все статусы</option>${Object.entries(ST).map(([k, v]) => opt(k, v[1], st.status)).join("")}</select>
       <select id="failed" aria-label="Нарушен критерий"><option value="">Все критерии</option>${crit.map(c => opt(c.id, `Нарушен п.${c.id.slice(1)}: ${c.name}`, st.failed)).join("")}</select>
       <select id="lang" aria-label="Язык"><option value="">Все языки</option>${Object.entries(LANG).map(([k, v]) => opt(k, v, st.lang)).join("")}</select>
       <select id="channel" aria-label="Канал"><option value="">Все каналы</option>${Object.entries(CH).map(([k, v]) => opt(k, v, st.channel)).join("")}</select>
       ${R !== "lead" ? `<select id="team" aria-label="Группа"><option value="">Все группы</option>${teams.map(t => opt(t, t, st.team)).join("")}</select>` : ""}
       <label class="chk sm"><input type="checkbox" id="critical" ${st.critical ? "checked" : ""}> Грубые ошибки</label>
       ${st.operator ? `<button class="chip on" id="unop">${esc(st.operator)} ✕</button>` : ""}
       ${Object.entries(st).some(([k, v]) => k !== "pick" && v) ? `<button class="btn sm link" id="reset">Сбросить</button>` : ""}</div>`
    + (can ? `<div class="filters bulk-selection ${st.pick.size ? "" : "hidden"}" id="bulk" role="region" aria-label="Действия с выбранными диалогами"><span id="pc" role="status"></span><div class="bulk-selection-actions"><button class="btn sm" id="clr">Снять выбор</button><button class="btn pri sm" id="re">Переоценить выбранные</button></div></div>` : "")
    + dialogTable(list, { check: can, active: ctx.me.checklist.version, emptyT: "Диалоги не найдены", emptyP: "Попробуйте изменить параметры фильтрации." });
  const re = () => dialogs(el, ctx);
  let t; $("#q", el).oninput = e => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value; re().then(() => { const q = $("#q", el); q?.focus(); q?.setSelectionRange(q.value.length, q.value.length); }); }, 300); };
  ["status", "failed", "lang", "channel", "team"].forEach(k => { const s = $("#" + k, el); if (s) s.onchange = () => { st[k] = s.value; re(); }; });
  $("#critical", el).onchange = e => { st.critical = e.target.checked; re(); };
  const un = $("#unop", el); if (un) un.onclick = () => { st.operator = ""; re(); };
  const rs = $("#reset", el); if (rs) rs.onclick = () => { Object.assign(st, { q: "", status: "", lang: "", channel: "", critical: false, failed: "", team: "", operator: "" }); re(); };
  bindOpen(el, ctx.go);
  if (can) {
    const sync = () => { $("#bulk", el).classList.toggle("hidden", !st.pick.size); $("#pc", el).textContent = `Выбрано ${st.pick.size} ${plural(st.pick.size, "диалог", "диалога", "диалогов")}`; const allBox = $("[data-all]", el); if (allBox) { const eligible = list.filter(d => d.wf_status !== "evaluating"); const selected = eligible.filter(d => st.pick.has(d.id)).length; allBox.checked = eligible.length > 0 && selected === eligible.length; allBox.indeterminate = selected > 0 && selected < eligible.length; } $$("[data-pick]", el).forEach(c => { c.checked = st.pick.has(c.dataset.pick); c.closest("tr").classList.toggle("sel", c.checked); }); };
    $$("[data-pick]", el).forEach(c => c.onchange = () => { c.checked ? st.pick.add(c.dataset.pick) : st.pick.delete(c.dataset.pick); sync(); });
    const ha = $("[data-all]", el); if (ha) ha.onchange = () => { st.pick = new Set(ha.checked ? list.filter(d => d.wf_status !== "evaluating").map(d => d.id) : []); sync(); };
    $("#clr", el).onclick = () => { st.pick.clear(); sync(); };
    $("#re", el).onclick = e => busy(e.currentTarget, async () => { const r = await api("/evaluate", { body: { dialog_ids: [...st.pick], title: `Переоценка ${st.pick.size} диалогов` } }); st.pick.clear(); ctx.go("jobs/" + r.job.id); });
    sync();
  }
}

let _rules = null;
async function rulesCache() { if (!_rules || Date.now() - _rules.t > 30000) { const ls = await api("/checklists"); const a = ls.find(c => c.status === "published"); _rules = { t: Date.now(), ...(await api("/checklists/" + a.id)) }; } return _rules; }

// ======================= грубые ошибки =======================
export async function violations(el, ctx) {
  const st = violations.st || (violations.st = { s: "open", open: null, note: {} });
  const R = ctx.me.role, can = ["qa"].includes(R);
  if (ctx.arg) { st.open = ctx.arg; st.s = "all"; ctx.arg = ""; history.replaceState(null, "", "#/violations"); }
  const { rows, counts } = await api("/violations?status=" + st.s);
  if (!ctx.alive()) return;
  const tabs = [["open", "Открытые"], ["new", "Новые"], ["work", "В работе"], ["closed", "Закрытые"], ["all", "Все"]];
  el.innerHTML = ph("Инциденты", "")
    + `<div class="tabs" role="tablist">${tabs.map(([k, t]) => `<button role="tab" data-s="${k}" class="${st.s === k ? "on" : ""}">${t} · ${counts[k]}</button>`).join("")}</div>`
    + (rows.length ? `<div class="tw"><table class="t"><thead><tr><th>Диалог</th><th>Оператор</th><th>Обоснование и цитата</th><th class="r">Балл</th><th>Статус</th><th>Дата</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="go" data-row="${esc(r.id)}"><td class="id">${esc(r.id)}<span class="sub">${CH[r.channel] || ""} · ${esc(r.language)}</span></td><td>${esc(r.operator)}<span class="sub">${esc(r.team)}</span></td>
        <td class="wrap"><div class="sm">${linkify(r.reason || "")}</div>${r.quote ? `<div class="quote" style="margin-top:4px">#${r.quote.turn} · «${esc(r.quote.text.length > 200 ? r.quote.text.slice(0, 200) + "…" : r.quote.text)}»</div>` : ""}</td>
        <td class="r"><span class="score ${scls(r.total)}">${fmt(r.total)}</span></td><td>${pill(VIOL[r.viol_status][0], VIOL[r.viol_status][1])}${r.viol_note ? `<span class="sub" style="max-width:220px">${esc(r.viol_note)}</span>` : ""}</td><td class="muted num" style="white-space:nowrap">${dt(r.occurred_at)}</td></tr>
        ${can && st.open === r.id ? `<tr><td colspan="6" style="background:var(--sunken);padding:12px 28px"><div class="row" style="align-items:flex-end;gap:10px"><div class="grow"><label class="l" for="vn" style="margin-top:0">Решение по инциденту</label><input class="f sm" id="vn" placeholder="Принятые меры (разбор с оператором, повторный инструктаж)…" value="${esc(st.note[r.id] ?? r.viol_note ?? "")}"></div>
          <div class="acts">${r.viol_status !== "work" ? `<button class="btn sm" data-vs="work">В работу</button>` : ""}${r.viol_status !== "closed" ? `<button class="btn pri sm" data-vs="closed">Закрыть инцидент</button>` : `<button class="btn sm" data-vs="work">Переоткрыть</button>`}<a class="btn sm" href="#/dialog/${esc(r.id)}">Проверить разговор</a></div></div></td></tr>` : ""}`).join("")}</tbody></table></div>`
      : emptyBox("Инцидентов не найдено", "В выбранном статусе грубых нарушений нет."));
  $$("[data-s]", el).forEach(b => b.onclick = () => { st.s = b.dataset.s; st.open = null; violations(el, ctx); });
  $$("[data-row]", el).forEach(r => r.onclick = e => { if (e.target.closest("button,a,input")) return; if (!can) return ctx.go("dialog/" + r.dataset.row); st.open = st.open === r.dataset.row ? null : r.dataset.row; violations(el, ctx).then(() => $("#vn", el)?.focus()); });
  const vn = $("#vn", el); if (vn) vn.oninput = () => { st.note[st.open] = vn.value; };
  $$("[data-vs]", el).forEach(b => b.onclick = () => busy(b, async () => {
    await api("/violations/" + encodeURIComponent(st.open), { method: "PATCH", body: { status: b.dataset.vs, note: st.note[st.open] ?? vn.value } });
    toast(b.dataset.vs === "closed" ? "Инцидент закрыт" : "Статус обновлён"); delete st.note[st.open]; st.open = null; ctx.refresh(); await violations(el, ctx);
  }));
}

// ======================= апелляции =======================
export async function appeals(el, ctx) {
  if (ctx.arg) return appealOne(el, ctx);
  const R = ctx.me.role;
  const st = appeals.st || (appeals.st = { s: "" });
  const list = await api("/appeals" + (st.s ? "?status=" + st.s : ""));
  if (!ctx.alive()) return;
  el.innerHTML = ph(R === "op" ? "Мои апелляции" : "Апелляции", "")
    + `<div class="filters"><div class="chips">${[["", "Все"], ["open", "На рассмотрении"], ["accepted", "Приняты"], ["partial", "Частично"], ["rejected", "Отклонены"], ["withdrawn", "Отозваны"]].map(([k, t]) => `<button class="chip ${st.s === k ? "on" : ""}" data-s="${k}">${t}</button>`).join("")}</div></div>`
    + (list.length ? `<div class="tw"><table class="t"><thead><tr><th>ID</th><th>Диалог</th><th>Оператор</th><th>Оспариваемые критерии и довод</th><th class="r">Балл</th><th>Статус</th><th>Дата</th></tr></thead><tbody>
      ${list.map(a => `<tr class="go" data-ap="${a.id}"><td class="id">А-${a.id}</td><td class="id">${esc(a.dialog_id)}</td><td>${esc(a.operator_name)}<span class="sub">${esc(a.team)}</span></td>
        <td class="wrap"><div class="sm"><b>Пункты: ${a.items.map(i => "#" + i.crit.slice(1)).join(", ")}</b></div><div class="sm muted">«${esc(a.text.length > 140 ? a.text.slice(0, 140) + "…" : a.text)}»</div></td>
        <td class="r num">${fmt(a.score_before)}${a.score_after != null && a.score_after !== a.score_before ? `  —  <b>${fmt(a.score_after)}</b>` : ""}</td><td>${pill(AP_ST[a.status][0], AP_ST[a.status][1])}</td><td class="muted">${ago(a.created_at)}</td></tr>`).join("")}</tbody></table></div>`
      : emptyBox("Апелляций нет", "Спорных обращений по выбранному фильтру не найдено."));
  $$("[data-s]", el).forEach(b => b.onclick = () => { st.s = b.dataset.s; appeals(el, ctx); });
  $$("[data-ap]", el).forEach(r => r.onclick = () => ctx.go("appeals/" + r.dataset.ap));
}

async function appealOne(el, ctx) {
  const R = ctx.me.role, id = ctx.arg;
  const st = (appealOne.st ||= {})[id] ||= { dec: {}, comment: "" };
  const a = await api("/appeals/" + id);
  if (!ctx.alive()) return;
  const e = a.evaluation, cr = Object.fromEntries(e.checklist.criteria.map(c => [c.id, c])), tr = a.dialog.transcript;
  const open = a.status === "open", canDecide = open && ["qa"].includes(R);
  const refs = new Set(a.items.flatMap(i => e.items[i.crit]?.evidence || []));
  (a.text.match(/#(\d+)/g) || []).forEach(m => refs.add(+m.slice(1)));
  el.innerHTML = ph(`Апелляция А-${a.id}`, `${esc(a.operator_name)} · диалог <a href="#/dialog/${esc(a.dialog_id)}" class="mono">${esc(a.dialog_id)}</a> · ${dt(a.created_at)}`, `<div class="acts">${pill(AP_ST[a.status][0], AP_ST[a.status][1])}<a class="btn sm" href="#/dialog/${esc(a.dialog_id)}">Проверить разговор</a></div>`)
    + `<div class="cols ww flush-cols appeal-layout">
       <div class="col-pane appeal-review" style="padding:0"><div class="appeal-section-title"><h2>Пересмотр оценки</h2></div>
         <div class="appeal-argument">
           <div class="sm muted">Аргумент оператора</div>
           <div style="margin-top:4px;font-weight:500">«${linkify(a.text)}»</div>
         </div>
         <div class="cl-list">
           ${a.items.map(it => {
             const c = cr[it.crit], m = e.items[it.crit] || {};
             return `<div class="cl-item appeal-criterion">
               <div class="row" style="justify-content:space-between">
                 <b>#${it.crit.slice(1)} ${esc(c.name)} <span class="muted sm" style="font-weight:400">(вес ${c.weight})</span></b>
                 <div class="row">${ansPill(c, it.from)}${ansPill(c, it.want)}</div>
               </div>
               <div class="sm fg2" style="margin-top:6px">${linkify(m.explanation || "—")}</div>
               <div class="sm muted" style="margin-top:4px">Правило: ${esc(c.rule)}</div>
               ${canDecide ? `<div class="seg sm" style="margin-top:10px"><button data-d="${it.crit}" data-v="1" class="${st.dec[it.crit] === true ? "on" : ""}">Принять (${esc(ansLabel(c, it.want))})</button><button data-d="${it.crit}" data-v="0" class="${st.dec[it.crit] === false ? "on" : ""}">Оставить (${esc(ansLabel(c, it.from))})</button></div>`
                 : it.accepted != null ? `<div style="margin-top:8px">${it.accepted ? pill("ok", "Принято") : pill("na", "Отклонено")}</div>` : ""}
             </div>`;
           }).join("")}
         </div>
         ${canDecide ? `<div class="appeal-resolution"><label class="l" for="cm" style="margin-top:0">Резолюция QA для оператора</label><textarea class="f sm" id="cm" rows="2" placeholder="Обоснование решения по апелляции…">${esc(st.comment)}</textarea>
           <div class="err hidden" id="aerr" role="alert"></div>
           <div class="row" style="margin-top:10px"><span class="sm muted" id="prev"></span><span class="grow"></span><button class="btn pri sm" id="dec">Утвердить решение</button></div></div>` : ""}
         ${!open ? `<div style="padding:16px 28px;background:var(--sunken)"><div class="sm muted">Решение QA (${esc(a.decided_name || "—")} · ${dt(a.decided_at)})</div><p class="sm" style="margin-top:4px">${esc(a.comment || "")}</p>${a.score_after != null ? `<p class="sm mono" style="margin-top:4px">Итоговый балл: ${fmt(a.score_before)}  —  <b>${fmt(a.score_after)}</b></p>` : ""}</div>` : ""}
         ${open && R === "lead" ? `<div style="padding:16px 28px"><label class="l" for="wd" style="margin-top:0">Отзыв апелляции тимлидом</label><input class="f sm" id="wd" placeholder="Причина отзыва…"><div class="row" style="margin-top:8px"><button class="btn sm" id="wdb">Отозвать апелляцию</button></div></div>` : ""}
         ${open && R === "op" ? `<div style="padding:16px 28px"><button class="btn sm" id="wdo">Отозвать мою апелляцию</button></div>` : ""}
       </div>
       <div class="col-pane appeal-transcript">
         <div class="pane-h appeal-section-title"><h2>Разговор</h2><p>${tr.length} реплик</p></div>
         <div class="chat-wrap" id="chat">${tr.map((m, i) => {
           const n = i + 1;
           if (m.speaker === "system") return `<div class="om-sys ${refs.has(n) ? "ev" : ""}" id="m${n}"><span>#${n} · ${esc(m.text)}</span></div>`;
           return `<div class="t-turn ${m.speaker} ${refs.has(n) ? "sel" : ""}" id="m${n}"><div class="t-no">#${n}</div><div class="t-who"><b>${{ client: "Клиент", bot: "Бот", operator: "Оператор" }[m.speaker]}</b><span class="mono">${esc(m.timestamp)}</span></div><div class="t-txt">${esc(m.text)}</div><div></div></div>`;
         }).join("")}</div>
       </div>
     </div>`;
  $$(".evc", el).forEach(b => b.onclick = () => { const m = $("#m" + b.dataset.ev, el), C = $("#chat", el)?.parentElement; if (!m || !C) return; C.scrollTo({ top: m.offsetTop - 80, behavior: "smooth" }); m.classList.add("flash"); setTimeout(() => m.classList.remove("flash"), 1200); });
  if (canDecide) {
    const prev = () => {
      const all = a.items.every(i => st.dec[i.crit] !== undefined), acc = a.items.filter(i => st.dec[i.crit]).length;
      $("#dec", el).disabled = !all || st.comment.trim().length < 5;
      $("#prev", el).textContent = !all ? `Выберите решение для всех пунктов` : acc === a.items.length ? "Будет принята полностью" : acc ? "Будет принята частично" : "Будет отклонена";
    };
    $$("[data-d]", el).forEach(b => b.onclick = () => { st.dec[b.dataset.d] = b.dataset.v === "1"; appealOne(el, ctx); });
    const cm = $("#cm", el); cm.oninput = () => { st.comment = cm.value; prev(); };
    prev();
    $("#dec", el).onclick = ev => busy(ev.currentTarget, async () => {
      try {
        const r = await api(`/appeals/${id}/decide`, { body: { decisions: st.dec, comment: st.comment } });
        toast(`Апелляция ${({ accepted: "принята", partial: "принята частично", rejected: "отклонена" })[r.status]}` + (r.before !== r.after ? `: ${fmt(r.before)}  —  ${fmt(r.after)}` : ""));
        delete appealOne.st[id]; ctx.refresh(); await appealOne(el, ctx);
      } catch (x) { const er = $("#aerr", el); er.textContent = x.message; er.classList.remove("hidden"); }
    });
  }
  const wdb = $("#wdb", el); if (wdb) wdb.onclick = () => busy(wdb, async () => { await api(`/appeals/${id}/withdraw`, { body: { comment: $("#wd", el).value } }); toast("Апелляция отозвана"); ctx.refresh(); await appealOne(el, ctx); });
  const wdo = $("#wdo", el); if (wdo) wdo.onclick = () => busy(wdo, async () => { await api(`/appeals/${id}/withdraw`, { body: { comment: "Отозвана оператором" } }); toast("Апелляция отозвана"); ctx.refresh(); await appealOne(el, ctx); });
}

// ======================= калибровка модели =======================
export async function calibration(el, ctx) {
  const c = await api("/calibration");
  if (!ctx.alive()) return;
  const st = calibration.st || (calibration.st = { crit: "" });
  const dis = st.crit ? c.disagreements.filter(d => d.crit === st.crit) : c.disagreements;
  const crit = Object.fromEntries((await rulesCache()).criteria.map(x => [x.id, x]));
  el.innerHTML = ph("Проверка оценок ИИ", "Сравнение с предварительной разметкой. Текущий эталон подготовлен Claude и требует проверки командой.")
    + `<div class="strip">${stat("Совпадение с разметкой", c.agreement != null ? String(c.agreement).replace(".", ",") + "%" : "—", `${c.answers} проверок критериев`)}${stat("Средняя погрешность (MAE)", c.mae != null ? fmt(c.mae) + " б." : "—", `на ${c.dialogs} ${plural(c.dialogs, "диалоге", "диалогах", "диалогах")}`)}${stat("Расхождений с эталоном", c.disagreements.length, `спорных в эталоне: ${c.disagreements.filter(d => d.unsure).length}`)}</div>`
    + `<div class="cols w flush-cols">
        <div class="col-pane" style="padding:0">
          <div class="sec-hd">Совпадение по критериям (кликните для фильтрации)</div>
          <div class="bars">${c.per.map(p => `<button class="bar ${st.crit === p.crit ? "on" : ""}" data-c="${p.crit}" aria-pressed="${st.crit === p.crit}"><span><b>#${p.crit.slice(1)}</b> ${esc(p.name)}</span><span class="tr"><span class="fl ${p.rate >= 90 ? "l" : p.rate >= 75 ? "m" : ""}" style="width:${p.rate}%;display:block"></span></span><span class="n">${p.rate}%</span><span class="n muted">${p.ok}/${p.n}</span></button>`).join("")}</div>
        </div>
        <div class="col-pane" style="padding:0">
          <div class="sec-hd">Реестр расхождений${st.crit ? ` · пункт #${st.crit.slice(1)}` : ""}</div>
          ${dis.length ? `<div class="tw"><table class="t"><thead><tr><th>Диалог</th><th>Пункт</th><th>Ответ ИИ</th><th>Предварительный эталон</th></tr></thead><tbody>${dis.map(d => `<tr class="go" data-open="${esc(d.dialog)}"><td class="id">${esc(d.dialog)}</td><td>#${d.crit.slice(1)}<span class="sub">${d.confidence != null ? Math.round(d.confidence * 100) + "%" : ""}</span></td><td>${crit[d.crit] ? ansPill(crit[d.crit], d.ai) : esc(d.ai)}</td><td>${crit[d.crit] ? ansPill(crit[d.crit], d.gold) : esc(d.gold)}${d.unsure ? `<span class="sub">спорный эталон</span>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<div style="padding:20px 28px" class="muted sm">Расхождений не обнаружено.</div>`}
        </div>
      </div>`;
  $$("[data-c]", el).forEach(b => b.onclick = () => { st.crit = st.crit === b.dataset.c ? "" : b.dataset.c; calibration(el, ctx); });
  bindOpen(el, ctx.go);
}

// ======================= аналитика качества =======================
export async function dashboard(el, ctx) {
  const o = await api("/stats/overview");
  if (!ctx.alive()) return;
  const st = dashboard.st || (dashboard.st = { open: null });
  const R = ctx.me.role, p = o.process, maxPts = Math.max(...o.loss.map(l => l.points), 0.01);
  const toDialogs = q => `dialogs/${q}`;
  el.innerHTML = ph(R === "lead" ? `Аналитика группы · ${esc(ctx.me.team)}` : "Аналитика качества", "")
    + `<div class="strip">${stat("Средний балл", fmt(o.avg), `${o.done} ${plural(o.done, "диалог", "диалога", "диалогов")}`)}${stat("Грубые ошибки (п.8)", o.critical, o.done ? `${Math.round(o.critical / o.done * 100)}% от проверенных` : "")}${stat("Покрытие оценкой", o.dialogs ? Math.round(o.evaluated / o.dialogs * 100) + "%" : "—", `${o.evaluated} из ${o.dialogs}`)}${stat("Стоимость оценки", money(o.cost_per, 3), `${String(Math.round(o.sec * 10) / 10).replace(".", ",")} с · всего ${money(o.cost, 2)}`)}</div>`
    + `<div class="cols w flush-cols">
        <div class="col-pane" style="padding:0">
          <div class="sec-hd">Потери баллов по критериям (средний штраф и % нарушений)</div>
          <div class="bars">
            ${o.loss.map(l => `<button class="bar ${st.open === l.crit ? "on" : ""}" data-l="${l.crit}" aria-expanded="${st.open === l.crit}"><span><b>#${l.crit.slice(1)}</b> ${esc(l.name)}</span><span class="tr"><span class="fl ${l.points / maxPts > .6 ? "" : l.points / maxPts > .3 ? "m" : "l"}" style="width:${l.points / maxPts * 100}%;display:block"></span></span><span class="n">−${fmt(l.points)}</span><span class="n muted">${l.rate}%</span></button>
              ${st.open === l.crit ? `<div class="bar-exp">${l.examples.length ? l.examples.map(x => `<div class="sm"><a href="#/dialog/${esc(x.dialog)}" class="mono">${esc(x.dialog)}</a> · ${esc((x.text || "").replace(/\[\d+\]/g, "").slice(0, 160))}</div>`).join("") : `<div class="sm muted">Нарушений нет.</div>`}
                ${l.failed && toDialogs("") ? `<div style="margin-top:6px"><a class="btn sm" href="#/dialogs/failed=${l.crit}">Открыть все диалоги с ошибкой (${l.failed})</a></div>` : ""}</div>` : ""}`).join("")}
          </div>
        </div>
        <div class="col-pane" style="padding:0">
          <div class="sec-hd">Срез по каналам и языкам</div>
          <div class="tw"><table class="t"><thead><tr><th>Сегмент</th><th class="r">Диалогов</th><th class="r">Средний балл</th></tr></thead><tbody>${o.segments.map(s => `<tr><td>${esc(s.name)}</td><td class="r muted num">${s.n}</td><td class="r"><span class="score ${scls(s.avg)}">${fmt(s.avg)}</span></td></tr>`).join("")}</tbody></table></div>
          ${R !== "lead" ? `<div class="sec-hd">Срез по группам операторов</div><div class="tw"><table class="t"><thead><tr><th>Группа</th><th class="r">Диалогов</th><th>Риск</th><th class="r">Средний балл</th></tr></thead><tbody>${o.teams.map(t => `<tr ${toDialogs("") ? `class="go" data-team="${esc(t.name)}"` : ""}><td><b>${esc(t.name)}</b></td><td class="r muted num">${t.n}</td><td>${t.critical ? pill("bad", t.critical + " груб.") : '<span class="muted">—</span>'}</td><td class="r"><span class="score ${scls(t.avg)}">${fmt(t.avg)}</span></td></tr>`).join("")}</tbody></table></div>` : ""}
          <div class="sec-hd">Состояние проверок</div>
          <div class="kv" style="padding:14px 28px"><span>Ожидают проверки QA</span><b class="mono">${p.review}</b><span>Открытые апелляции</span><b class="mono">${p.appeal}</b><span>В очереди на оценку</span><b class="mono">${p.new}</b><span>Ручных правок QA</span><b class="mono">${p.overrides}</b><span>Апелляций принято / отклонено</span><b class="mono">${p.won} / ${p.lost}</b></div>
        </div>
      </div>`;
  $$("[data-l]", el).forEach(b => b.onclick = () => { st.open = st.open === b.dataset.l ? null : b.dataset.l; dashboard(el, ctx); });
  $$("[data-team]", el).forEach(r => r.onclick = () => ctx.go("dialogs/team=" + encodeURIComponent(r.dataset.team)));
}

// ======================= группа / операторы =======================
export async function team(el, ctx) {
  const t = await api("/stats/team");
  if (!ctx.alive()) return;
  const R = ctx.me.role, ops = t.operators;
  const n = ops.reduce((s, o) => s + o.n, 0), cr = ops.reduce((s, o) => s + o.critical, 0);
  const all = ops.flatMap(o => o.avg != null ? Array(o.n).fill(o.avg) : []);
  el.innerHTML = ph("Команда", R === "lead" ? esc(t.team) : "")
    + `<div class="strip">${stat("Операторов", ops.length)}${stat("Проверено диалогов", n)}${stat("Средний балл", fmt(all.length ? all.reduce((a, b) => a + b, 0) / all.length : null))}${stat("Грубые ошибки", cr)}</div>`
    + (ops.length ? `<div class="tw"><table class="t"><thead><tr><th>Оператор</th>${R !== "lead" ? "<th>Группа</th>" : ""}<th class="r">Диалогов</th><th class="r">Средний балл</th><th>Грубые ошибки</th><th>Зона внимания</th><th>Апелляции</th><th class="r">Действие</th></tr></thead><tbody>
      ${ops.map(o => `<tr class="go" data-op="${esc(o.operator)}"><td><b style="font-weight:600">${esc(o.operator)}</b></td>${R !== "lead" ? `<td>${esc(o.team)}</td>` : ""}<td class="r num">${o.n}</td><td class="r"><span class="score ${scls(o.avg)}">${fmt(o.avg)}</span></td>
        <td>${o.critical ? pill("bad", o.critical) : '<span class="muted">—</span>'}</td><td>${o.weak ? `<b>#${o.weak.crit.slice(1)} ${esc(o.weak.name)}</b> <span class="muted">(${o.weak.n} наруш.)</span>` : '<span class="muted">Без ошибок</span>'}</td><td>${o.appeals ? pill("info", o.appeals + " спор.") : '<span class="muted">—</span>'}</td>
        <td class="r">${o.weak ? `<button type="button" class="btn sm" data-coach-op="${esc(o.operator)}" data-coach-crit="${o.weak.crit}">Разбор ошибок</button>` : `<button type="button" class="btn sm link" data-op-btn="${esc(o.operator)}">Все диалоги</button>`}</td></tr>`).join("")}</tbody></table></div>`
      : emptyBox("Нет данных по операторам", "Опубликованные оценки пока отсутствуют."));
  $$("[data-op]", el).forEach(r => r.onclick = e => { if (e.target.closest("button")) return; ctx.go("dialogs/operator=" + encodeURIComponent(r.dataset.op)); });
  $$("[data-op-btn]", el).forEach(b => b.onclick = () => ctx.go("dialogs/operator=" + encodeURIComponent(b.dataset.opBtn)));
  $$("[data-coach-op]", el).forEach(b => b.onclick = () => ctx.go(`dialogs/operator=${encodeURIComponent(b.dataset.coachOp)}&failed=${b.dataset.coachCrit}`));
}

// ======================= мои диалоги (оператор) =======================
export async function my(el, ctx) {
  const [s, list] = await Promise.all([api("/stats/me"), api("/dialogs")]);
  if (!ctx.alive()) return;
  const fresh = list.filter(d => d.wf_status === "published"), rest = list.filter(d => d.wf_status !== "published");
  el.innerHTML = ph("Мои оценки", "", `<a class="btn sm" href="#/rules">Стандарты оценки</a>`)
    + `<div class="strip">${stat("Мой средний балл", fmt(s.avg), `${s.n} ${plural(s.n, "проверка", "проверки", "проверок")}`)}${stat("Ждут ознакомления", s.new)}${stat("Зона внимания", s.weak ? `#${s.weak.crit.slice(1)} ${esc(s.weak.name)}` : "Без ошибок", s.weak ? `${s.weak.n} ${plural(s.weak.n, "замечание", "замечания", "замечаний")}` : "", true)}${stat("Мои апелляции", s.appeals.n, s.appeals.open ? `${s.appeals.open} на рассмотрении` : "")}</div>`
    + (fresh.length ? `<div class="sec-hd">Требуют ознакомления (${fresh.length})</div>${dialogTable(fresh, { own: true })}` : "")
    + (rest.length || !fresh.length ? `<div class="sec-hd">${fresh.length ? "Просмотренные диалоги" : "Все проверенные диалоги"}</div>${dialogTable(rest, { own: true, emptyT: "Оценок пока нет", emptyP: "Проверенные диалоги появятся здесь после публикации QA." })}` : "");
  bindOpen(el, ctx.go);
}

// ======================= пользователи =======================
export async function users(el, ctx) {
  const [list, teams] = await Promise.all([api("/users"), api("/teams")]);
  if (!ctx.alive()) return;
  const st = users.st || (users.st = { q: "", add: false, pw: null });
  const rows = list.filter(u => !st.q || (u.name + u.login).toLowerCase().includes(st.q.toLowerCase()));
  const roleSel = (id, cur) => `<select class="f sm" data-role="${id}" style="width:auto" aria-label="Роль">${Object.entries(ROLE).map(([k, v]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${v}</option>`).join("")}</select>`;
  const teamSel = (id, cur) => `<select class="f sm" data-team="${id}" style="width:auto" aria-label="Группа"><option value="">—</option>${teams.map(t => `<option ${t === cur ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
  el.innerHTML = ph("Пользователи", "", `<button class="btn pri sm" id="add">Добавить сотрудника</button>`)
    + (st.pw ? `<div class="sc-strip ok" style="padding:10px 28px">Создан аккаунт <b>${esc(st.pw.login)}</b> · Временный пароль: <code>${esc(st.pw.password)}</code></div>` : "")
    + (st.add ? `<form class="sc-strip info" id="uf" style="padding:14px 28px"><div class="cols" style="grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;border:0">
        <div><label class="l" for="ul" style="margin-top:0">Логин</label><input class="f sm" id="ul" required placeholder="a.nurlanova"></div><div><label class="l" for="un" style="margin-top:0">ФИО</label><input class="f sm" id="un" required></div>
        <div><label class="l" for="ur" style="margin-top:0">Роль</label><select class="f sm" id="ur">${Object.entries(ROLE).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
        <div><label class="l" for="ut" style="margin-top:0">Группа</label><select class="f sm" id="ut"><option value="">—</option>${teams.map(t => `<option>${esc(t)}</option>`).join("")}</select></div></div>
        <div class="err hidden" id="uerr" role="alert"></div><div class="acts" style="margin-top:10px"><button class="btn pri sm" type="submit">Создать</button><button class="btn sm" type="button" id="ucancel">Отмена</button></div></form>` : "")
    + `<div class="filters"><input type="search" id="q" placeholder="Поиск по имени или логину…" value="${esc(st.q)}" aria-label="Поиск пользователя"><span class="sm muted">${rows.length} из ${list.length}</span></div>`
    + `<div class="tw"><table class="t"><thead><tr><th>Сотрудник</th><th>Логин</th><th>Роль</th><th>Группа</th><th>Статус</th></tr></thead><tbody>${rows.map(u => `<tr class="${u.active ? "" : "muted"}"><td><b>${esc(u.name)}</b>${u.id === ctx.me.id ? ' <span class="sub">текущий сеанс</span>' : ""}</td><td class="num">${esc(u.login)}</td><td>${roleSel(u.id, u.role)}</td><td>${teamSel(u.id, u.team)}</td>
      <td><label class="chk sm"><input type="checkbox" data-act="${u.id}" ${u.active ? "checked" : ""} ${u.id === ctx.me.id ? "disabled" : ""}> ${u.active ? "Активен" : "Отключён"}</label></td></tr>`).join("")}</tbody></table></div>`;
  const re = () => users(el, ctx);
  $("#add", el).onclick = () => { st.add = !st.add; st.pw = null; re().then(() => $("#ul", el)?.focus()); };
  let t; $("#q", el).oninput = e => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value; re().then(() => { const q = $("#q", el); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }); }, 250); };
  const patch = async (id, body) => { try { await api("/users/" + id, { method: "PATCH", body }); toast("Сохранено"); } catch (e) { fail(e); } re(); };
  $$("[data-role]", el).forEach(s => s.onchange = () => patch(s.dataset.role, { role: s.value }));
  $$("[data-team]", el).forEach(s => s.onchange = () => patch(s.dataset.team, { team: s.value || null }));
  $$("[data-act]", el).forEach(c => c.onchange = () => patch(c.dataset.act, { active: c.checked }));
  const uf = $("#uf", el);
  if (uf) {
    $("#ucancel", el).onclick = () => { st.add = false; re(); };
    uf.onsubmit = e => { e.preventDefault(); busy(e.submitter, async () => {
      const body = { login: $("#ul", el).value, name: $("#un", el).value, role: $("#ur", el).value, team: $("#ut", el).value };
      try { const r = await api("/users", { body }); st.add = false; st.pw = { login: body.login, password: r.password }; await re(); }
      catch (x) { const er = $("#uerr", el); er.textContent = x.message; er.classList.remove("hidden"); }
    }); };
  }
}

// ======================= параметры модели =======================
export async function settings(el, ctx) {
  const s = await api("/settings");
  if (!ctx.alive()) return;
  const can = ctx.me.role === "adm";
  const st = { model: s.model, conf: s.conf, sample: s.sample, budget: s.budget };
  const draw = () => {
    el.innerHTML = ph("Настройки оценки", "Выберите модель и условия передачи оценки человеку. Изменения действуют для новых запусков.")
      + `<div class="cols w flush-cols"><div class="col-pane">
        <label class="l" style="margin-top:0">Модель оценки</label><div class="seg" role="group" aria-label="Модель">${[["sonnet", "Claude Sonnet 5.5"], ["haiku", "Claude Haiku 5.5"]].map(([k, t]) => `<button data-m="${k}" class="${st.model === k ? "on" : ""}" ${can ? "" : "disabled"}>${t}</button>`).join("")}</div>
        <p class="sm muted" style="margin-top:6px">Расход зависит от длины разговора, модели и повторных запросов.</p>
        <label class="l" for="conf">Порог направления на ручную проверку: <b class="mono" id="cv">${Math.round(st.conf * 100)}%</b></label><input type="range" id="conf" min="0.5" max="0.95" step="0.05" value="${st.conf}" style="width:100%;max-width:360px" ${can ? "" : "disabled"}>
        <p class="sm muted">При уверенности ниже порога диалог направляется в «Очередь разбора».</p>
        <label class="l" for="smp">Контрольная случайная выборка (Sampling), %</label><input class="f sm mono" type="number" id="smp" min="0" max="20" value="${st.sample}" style="width:100px" ${can ? "" : "disabled"}>
        <label class="l" for="bud">Общий лимит расходов на оценку, $</label><input class="f sm mono" type="number" id="bud" min="1" max="100" step="1" value="${st.budget}" style="width:100px" ${can ? "" : "disabled"}>
        ${can ? `<div class="acts" style="margin-top:18px"><button class="btn pri sm" id="save">Сохранить параметры</button></div>` : `<p class="sm muted" style="margin-top:16px">Только для чтения (требуется роль Администратора).</p>`}</div>
        <div class="col-pane"><h3>Текущее состояние</h3><div class="kv" style="margin-top:12px"><span>Активная модель</span><b>${esc(s.models[s.model])}</b><span>Хэш системного промпта</span><b><code>${esc(s.prompt_hash)}</code></b><span>Израсходовано всего</span><b class="mono">${money(s.spent, 2)}</b><span>Активный стандарт</span><b>«${esc(ctx.me.checklist.name)}» v${ctx.me.checklist.version}</b></div></div></div>`;
    if (!can) return;
    $$("[data-m]", el).forEach(b => b.onclick = () => { st.model = b.dataset.m; draw(); });
    $("#conf", el).oninput = e => { st.conf = +e.target.value; $("#cv", el).textContent = Math.round(st.conf * 100) + "%"; };
    $("#smp", el).oninput = e => { st.sample = +e.target.value; };
    $("#bud", el).oninput = e => { st.budget = +e.target.value; };
    $("#save", el).onclick = e => busy(e.currentTarget, async () => { await api("/settings", { method: "PUT", body: st }); toast("Параметры сохранены"); ctx.refresh(); settings(el, ctx); });
  };
  draw();
}

// ======================= журнал действий =======================
export async function audit(el, ctx) {
  const st = audit.st || (audit.st = { q: "" });
  const rows = await api("/audit?q=" + encodeURIComponent(st.q));
  if (!ctx.alive()) return;
  el.innerHTML = ph("История действий", "")
    + `<div class="filters"><input type="search" id="q" placeholder="Фильтр по событию, объекту или сотруднику…" value="${esc(st.q)}" aria-label="Поиск в журнале"><span class="sm muted">${rows.length} ${plural(rows.length, "событие", "события", "событий")}</span></div>`
    + (rows.length ? `<div class="tw"><table class="t"><thead><tr><th>Время</th><th>Субъект</th><th>Событие</th><th>Объект</th><th>Детализация</th></tr></thead><tbody>${rows.map(a => `<tr><td class="muted num" style="white-space:nowrap">${dt(a.at)}</td><td><b>${esc(a.who || "система")}</b><span class="sub">${ROLE[a.role] || ""}</span></td><td>${esc(a.action)}</td>
        <td class="id">${a.object && /^[\w-]+-\d+$|^p\d|^new-/.test(a.object) ? `<a href="#/dialog/${esc(a.object)}">${esc(a.object)}</a>` : esc(a.object || "—")}</td><td class="sm muted wrap">${a.details ? esc(fmtDetails(a.details)) : ""}</td></tr>`).join("")}</tbody></table></div>` : emptyBox("Записей не найдено", "Измените поисковый запрос."));
  let t; $("#q", el).oninput = e => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value; audit(el, ctx).then(() => { const q = $("#q", el); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }); }, 300); };
}
function fmtDetails(d) {
  if (typeof d !== "object") return String(d);
  if (d.from !== undefined) return `${d.from}  —  ${d.to}. ${d.reason || ""}`;
  if (d.before !== undefined) return `${fmt(d.before)}  —  ${fmt(d.after)}`;
  if (d.changes) return d.changes.map(c => `#${c.crit.slice(1)}: ${({ added: "добавлен", removed: "удалён", weight: `вес ${c.before} — ${c.after}`, semantic: "изменён смысл", section: "раздел" })[c.kind]}`).join(", ");
  return Object.entries(d).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.length : typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ");
}
