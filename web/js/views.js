import { periodURL, periodControls } from "./period.js";
// Экраны приложения. Каждый экспорт — функция (el, ctx), которая рисует раздел в el.
import { $, $$, api, esc, fmt, fmt0, money, scls, dt, ago, plural, toast, fail, busy, pill, stPill, reasonPills, ansLabel, ansPill, linkify,
  emptyBox, dialogTable, bindOpen, LANG, CH, SECS, ROLE, ST, REASON, AP_ST, VIOL, TRIGGER } from "./ui.js";
export { dialog } from "./v_dialog.js";
export { checklists, rules } from "./v_checklists.js";

const ph = (title, text, acts = "") => `<div class="ph"><div><h1>${title}</h1>${text ? `<p>${text}</p>` : ""}</div>${acts ? `<div class="acts">${acts}</div>` : ""}</div>`;
const stat = (l, v, d = "", txt = false) => `<div><div class="l">${l}</div><div class="v ${txt ? "txt" : ""}">${v}</div>${d ? `<div class="d">${d}</div>` : ""}</div>`;
const isStaff = r => ["qa", "adm"].includes(r);

// ======================= очередь проверки =======================
export async function queue(el, ctx) {
  const list = await api("/queue");
  if (!ctx.alive()) return;
  const st = queue.st || (queue.st = { f: "" });
  const has = (d, k) => k === "appeal" ? d.wf_status === "appeal" : (d.review || []).some(r => r.code === k);
  const keys = ["critical", "appeal", "error", "invalid", "no_evidence", "low_conf", "sample"];
  const lbl = k => k === "appeal" ? "Апелляции" : REASON[k][1];
  const cnt = Object.fromEntries(keys.map(k => [k, list.filter(d => has(d, k)).length]));
  const rows = st.f ? list.filter(d => has(d, st.f)) : list;
  const oldest = list.length ? list.reduce((a,b)=>a.waiting_since < b.waiting_since ? a : b) : null;
  el.innerHTML = ph("Очередь проверки", `Модель оценила все диалоги. Сюда попадает только то, что требует человека: грубые ошибки, сбои, неуверенные и неподтверждённые ответы, апелляции и случайная выборка для контроля модели. Сначала самое рискованное.`,
      rows.length ? `<button class="btn pri" id="first">Открыть первый</button>` : "")
    + `<div class="filters"><div class="chips"><button class="chip ${!st.f ? "on" : ""}" data-f="">Все<span class="c">${list.length}</span></button>${keys.filter(k => cnt[k]).map(k => `<button class="chip ${st.f === k ? "on" : ""}" data-f="${k}">${lbl(k)}<span class="c">${cnt[k]}</span></button>`).join("")}</div></div>`
    + (oldest ? "<p class=muted>Самое долгое ожидание: " + ago(oldest.waiting_since) + ". Это время ожидания, не согласованный SLA.</p>" : "")
    + dialogTable(rows, { reason: true, active: ctx.me.checklist.version, emptyT: "Очередь пуста", emptyP: "Все оценки проверены и опубликованы. Новые диалоги загружаются в разделе «Новые диалоги», после оценки спорные появятся здесь.", emptyActs: `<a class="btn" href="#/upload">Загрузить диалоги</a>` });
  $$("[data-f]", el).forEach(b => b.onclick = () => { st.f = b.dataset.f; queue(el, ctx); });
  bindOpen(el, ctx.go);
  const f = $("#first", el); if (f) f.onclick = () => ctx.go("dialog/" + rows[0].id);
}

// ======================= загрузка новых диалогов =======================
export async function upload(el, ctx) {
  const st = upload.st || (upload.st = { tab: "file", text: "", channel: "agent chat", pick: new Set() });
  const [fresh, jobs] = await Promise.all([api("/dialogs?status=new"), api("/jobs")]);
  if (!ctx.alive()) return;
  const tabs = [["file", "Файл выгрузки"], ["text", "Вставить текст"], ["new", `Неоценённые · ${fresh.length}`]];
  let body = "";
  if (st.tab === "file") body = `<div class="drop" id="drop" tabindex="0" role="button" aria-label="Выбрать файл JSON">
      <h3>Перетащите файл JSON или нажмите, чтобы выбрать</h3>
      <p class="sm" style="margin-top:6px;max-width:70ch">Подходит выгрузка контакт-центра в формате хакатона: объекты с <code>conversation_id</code> и <code>transcript</code> на любой глубине. Повторы с тем же текстом пропускаются, оценка начнётся сразу после загрузки.</p>
      <input type="file" id="fi" accept=".json,application/json" hidden></div>
      <label class="chk" style="margin-top:12px"><input type="checkbox" id="ev" checked> Сразу оценить моделью</label>`;
  else if (st.tab === "text") body = `<div class="cols w"><div>
      <label class="l" for="tx" style="margin-top:0">Переписка: одна реплика на строку</label>
      <textarea class="f" id="tx" rows="12" placeholder="Клиент: Здравствуйте, не могу вывести деньги на карту&#10;Оператор: Здравствуйте! Меня зовут Айгерим. Подскажите номер договора?&#10;Клиент: 12345">${esc(st.text)}</textarea>
      <div class="err hidden" id="txerr" role="alert"></div>
      <div class="row" style="margin-top:12px"><select class="f" id="ch" style="width:auto"><option value="agent chat">Чат</option><option value="voice call" ${st.channel === "voice call" ? "selected" : ""}>Звонок (расшифровка)</option></select>
        <button class="btn pri" id="send">Загрузить и оценить</button></div></div>
      <div class="panel"><h3>Формат</h3><p class="sm fg2" style="margin-top:6px">Строка начинается с говорящего: <b>Клиент</b>, <b>Оператор</b>, <b>Бот</b> или <b>Система</b>. Время в начале необязательно: <code>[10:42] Оператор: …</code>. Язык определяется автоматически. Если в тексте нет реплик оператора, оценивать нечего — система скажет об этом до вызова модели.</p></div></div>`;
  else body = fresh.length ? `<div class="row" style="margin-bottom:12px"><span class="muted sm" id="pc">Выбрано: ${st.pick.size}</span><span class="grow"></span><button class="btn" id="all">Выбрать все</button><button class="btn pri" id="go" ${st.pick.size ? "" : "disabled"}>Оценить выбранные</button></div>` + dialogTable(fresh, { check: true })
    : emptyBox("Все диалоги оценены", "Здесь появляются загруженные без оценки диалоги: например, если при загрузке сняли галочку «Сразу оценить».");
  el.innerHTML = ph("Новые диалоги", "Загрузка выгрузки, ввод переписки вручную или оценка уже загруженных. Модель проверяет каждый критерий отдельным запросом, общий текст диалога кешируется: ~5 секунд и ~$0,02 на диалог.")
    + `<div class="tabs" role="tablist">${tabs.map(([k, t]) => `<button role="tab" data-tab="${k}" class="${st.tab === k ? "on" : ""}" aria-selected="${st.tab === k}">${t}</button>`).join("")}</div>${body}`
    + `<div class="sec" style="margin-top:var(--s-2xl)"><h2>Последние пакеты</h2>${jobs.length ? `<div class="tw"><table class="t"><thead><tr><th>Пакет</th><th>Запустил</th><th class="r">Диалогов</th><th>Начат</th><th>Статус</th></tr></thead><tbody>${jobs.slice(0, 8).map(j => `<tr class="go" data-job="${j.id}"><td class="id">${esc(j.title)}</td><td>${esc(j.who || "система")}</td><td class="r num">${j.dialog_ids.length}</td><td class="muted">${ago(j.created_at)}</td><td>${j.finished_at ? pill("ok", "Готово") : pill("info pulse", "Идёт", "pulse")}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Пакетов пока нет.</p>`}</div>`;

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
      drop.innerHTML = `<h3><span class="spin" style="display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite;vertical-align:-2px"></span> Читаем ${esc(f.name)}…</h3>`;
      try {
        let data; try { data = JSON.parse(await f.text()); } catch { throw new Error(`${f.name}: это не JSON. Нужна выгрузка с conversation_id и transcript`); }
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
      if (!st.text.trim()) { er.textContent = "Вставьте переписку"; er.classList.remove("hidden"); return tx.focus(); }
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
  el.innerHTML = ph(esc(j.title), running ? "Модель оценивает критерии параллельно. Можно уйти со страницы: оценка продолжится, результат придёт в уведомления." : `Готово ${dt(j.finished_at)}. Спорное ушло в очередь проверки, остальное опубликовано или ждёт подтверждения.`,
      !running && rev ? `<a class="btn pri" href="#/queue">К очереди проверки · ${rev}</a>` : "")
    + `<div class="strip">${stat("Диалогов", `${fin} из ${total}`)}${stat("Критериев оценено", `${doneIt} из ${its.length}`, reused ? `${reused} переиспользовано без модели` : "")}${stat("Вызовов модели", fmt0(calls))}${stat("Стоимость", money(cost, 3))}${stat("Грубые ошибки", crit, part ? `сбой оценки: ${part}` : "")}</div>`
    + `<div class="prog" style="margin-bottom:var(--s-xl)" role="progressbar" aria-valuenow="${doneIt}" aria-valuemax="${its.length}"><b style="width:${its.length ? doneIt / its.length * 100 : 0}%"></b></div>`
    + `<div class="tw"><table class="t"><thead><tr><th>Диалог</th><th>Критерии</th><th class="r">Балл</th><th>Флаг</th><th>Итог проверки</th><th class="r">Время</th><th class="r">Стоимость</th></tr></thead><tbody>
      ${ev.map(e => `<tr class="go" data-open="${esc(e.dialog_id)}"><td class="id">${esc(e.dialog_id)}<span class="sub">${TRIGGER[e.trigger] || ""}</span></td>
        <td><div class="cells">${(e.items || []).map(i => `<i class="${i.status === "pending" ? "p" : i.status === "error" ? "e" : i.source === "reused" ? "r" : i.low ? "w" : "d"}" title="${i.crit.slice(1)}: ${i.status === "pending" ? "оценивается" : i.status === "error" ? "сбой" : i.source === "reused" ? "переиспользован" : i.low ? "модель не уверена" : "готово"}"></i>`).join("")}</div></td>
        <td class="r">${e.status === "running" ? "…" : e.total != null ? `<span class="score ${scls(e.total)}">${fmt(e.total)}</span>` : "—"}</td>
        <td>${e.critical ? pill("bad", "Грубая ошибка") : '<span class="muted">—</span>'}</td>
        <td>${e.status === "running" ? pill("info pulse", "Оценивается", "pulse") : `${stPill(e.wf_status)} ${reasonPills(e.review)}`}</td>
        <td class="r muted num">${e.seconds != null ? String(e.seconds).replace(".", ",") + " с" : "—"}</td><td class="r muted num">${money(e.cost, 3)}</td></tr>`).join("")}</tbody></table></div>
      <p class="sm muted" style="margin-top:10px">Клетка — критерий. Яркая — ответ модели, приглушённая — ответ переиспользован (смысл критерия не менялся), жёлтая — модель не уверена, красная — сбой: остальные критерии сохранены, упавшие повторяются из карточки.</p>`;
  bindOpen(el, ctx.go);
  if (running) setTimeout(() => ctx.alive() && jobs(el, ctx), 1500);
  else if (jobs.last !== j.id) { jobs.last = j.id; ctx.refresh(); }
}

// ======================= все диалоги =======================
export async function dialogs(el, ctx) {
  const R = ctx.me.role;
  const st = dialogs.st || (dialogs.st = { q: "", status: "", lang: "", channel: "", critical: false, failed: "", team: "", operator: "", pick: new Set() });
  if (ctx.arg) { const p = new URLSearchParams(ctx.arg); for (const [k, v] of p) st[k] = k === "critical" ? v === "1" : v; history.replaceState(null, "", "#/dialogs"); }
  const qs = new URLSearchParams(); ["q", "status", "lang", "channel", "failed", "team", "operator"].forEach(k => st[k] && qs.set(k, st[k])); if (st.critical) qs.set("critical", "true");
  const [list, teams] = await Promise.all([api("/dialogs?" + qs), dialogs.teams || api("/teams")]);
  dialogs.teams = teams;
  if (!ctx.alive()) return;
  const crit = (await rulesCache()).criteria.filter(c => c.type !== "flag");
  const can = isStaff(R);
  const opt = (v, t, cur) => `<option value="${esc(v)}" ${cur === v ? "selected" : ""}>${esc(t)}</option>`;
  el.innerHTML = ph(R === "lead" ? "Диалоги группы" : "Диалоги", `${list.length} ${plural(list.length, "диалог", "диалога", "диалогов")}${st.operator ? ` оператора ${esc(st.operator)}` : ""}. Откройте строку, чтобы увидеть баллы, обоснования и реплики-доказательства.`,
      `<a class="btn" href="/api/export/dialogs.csv">Выгрузить CSV</a>${can ? `<a class="btn" href="/api/export/results.json">Результаты JSON 1.0</a>` : ""}`)
    + `<div class="filters" role="search">
       <input type="search" id="q" placeholder="Номер диалога или оператор" value="${esc(st.q)}" aria-label="Поиск">
       <select id="status" aria-label="Статус"><option value="">Любой статус</option>${Object.entries(ST).map(([k, v]) => opt(k, v[1], st.status)).join("")}</select>
       <select id="failed" aria-label="Нарушен критерий"><option value="">Любые критерии</option>${crit.map(c => opt(c.id, `Не выполнен: ${c.name}`, st.failed)).join("")}</select>
       <select id="lang" aria-label="Язык"><option value="">Все языки</option>${Object.entries(LANG).map(([k, v]) => opt(k, v, st.lang)).join("")}</select>
       <select id="channel" aria-label="Канал"><option value="">Чаты и звонки</option>${Object.entries(CH).map(([k, v]) => opt(k, v, st.channel)).join("")}</select>
       ${R !== "lead" ? `<select id="team" aria-label="Группа"><option value="">Все группы</option>${teams.map(t => opt(t, t, st.team)).join("")}</select>` : ""}
       <label class="chk"><input type="checkbox" id="critical" ${st.critical ? "checked" : ""}> Только грубые ошибки</label>
       ${st.operator ? `<button class="chip on" id="unop">${esc(st.operator)} ✕</button>` : ""}
       ${Object.entries(st).some(([k, v]) => k !== "pick" && v) ? `<button class="btn link" id="reset">Сбросить</button>` : ""}</div>`
    + (can ? `<div class="row ${st.pick.size ? "" : "hidden"}" id="bulk" style="margin-bottom:10px"><span class="sm muted" id="pc"></span><button class="btn pri sm" id="re">Переоценить выбранные</button><button class="btn sm" id="clr">Снять выбор</button></div>` : "")
    + dialogTable(list, { check: can, active: ctx.me.checklist.version, emptyT: "Ничего не найдено", emptyP: "Под фильтры не попал ни один диалог. Измените условия или сбросьте их." });
  const re = () => dialogs(el, ctx);
  let t; $("#q", el).oninput = e => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value; re().then(() => { const q = $("#q", el); q?.focus(); q?.setSelectionRange(q.value.length, q.value.length); }); }, 300); };
  ["status", "failed", "lang", "channel", "team"].forEach(k => { const s = $("#" + k, el); if (s) s.onchange = () => { st[k] = s.value; re(); }; });
  $("#critical", el).onchange = e => { st.critical = e.target.checked; re(); };
  const un = $("#unop", el); if (un) un.onclick = () => { st.operator = ""; re(); };
  const rs = $("#reset", el); if (rs) rs.onclick = () => { Object.assign(st, { q: "", status: "", lang: "", channel: "", critical: false, failed: "", team: "", operator: "" }); re(); };
  bindOpen(el, ctx.go);
  if (can) {
    const sync = () => { $("#bulk", el).classList.toggle("hidden", !st.pick.size); $("#pc", el).textContent = `Выбрано: ${st.pick.size}`; $$("[data-pick]", el).forEach(c => { c.checked = st.pick.has(c.dataset.pick); c.closest("tr").classList.toggle("sel", c.checked); }); };
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
  const { rows, counts } = await api("/violations?status=" + st.s);
  if (!ctx.alive()) return;
  const tabs = [["open", "Открытые"], ["new", "Новые"], ["work", "В работе"], ["closed", "Закрытые"], ["all", "Все"]];
  el.innerHTML = ph("Грубые ошибки", "Диалоги, где модель или QA зафиксировали грубое нарушение: передачу данных без подтверждения личности, обещание доходности, грубость. Флаг не обнуляет балл, но каждое нарушение разбирается отдельно. Причина и цитата — из оценки.")
    + `<div class="tabs" role="tablist">${tabs.map(([k, t]) => `<button role="tab" data-s="${k}" class="${st.s === k ? "on" : ""}">${t} · ${counts[k]}</button>`).join("")}</div>`
    + (rows.length ? `<div class="tw"><table class="t"><thead><tr><th>Диалог</th><th>Оператор</th><th>Причина и цитата</th><th class="r">Балл</th><th>Статус</th><th>Дата</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="go" data-row="${esc(r.id)}"><td class="id">${esc(r.id)}<span class="sub">${CH[r.channel] || ""} · ${esc(r.language)}</span></td><td>${esc(r.operator)}<span class="sub">${esc(r.team)}</span></td>
        <td class="wrap"><div class="sm">${linkify(r.reason || "")}</div>${r.quote ? `<div class="quote" style="margin-top:6px">#${r.quote.turn} · «${esc(r.quote.text.length > 220 ? r.quote.text.slice(0, 220) + "…" : r.quote.text)}»</div>` : ""}${r.source === "qa" ? `<div style="margin-top:6px">${pill("info", "Подтверждено QA")}</div>` : ""}</td>
        <td class="r"><span class="score ${scls(r.total)}">${fmt(r.total)}</span></td><td>${pill(VIOL[r.viol_status][0], VIOL[r.viol_status][1])}${r.viol_note ? `<span class="sub" style="max-width:220px">${esc(r.viol_note)}</span>` : ""}</td><td class="muted num" style="white-space:nowrap">${dt(r.occurred_at)}</td></tr>
        ${can && st.open === r.id ? `<tr><td colspan="6" style="background:var(--sunken)"><div class="row" style="align-items:flex-start;gap:12px"><div class="grow"><label class="l" for="vn" style="margin-top:0">Принятые меры ${r.viol_status === "closed" ? "" : "(обязательно для закрытия)"}</label><textarea class="f" id="vn" placeholder="Например: разбор с оператором 12.11, повторное обучение по верификации">${esc(st.note[r.id] ?? r.viol_note ?? "")}</textarea></div>
          <div class="acts" style="padding-top:24px">${r.viol_status !== "work" ? `<button class="btn" data-vs="work">В работу</button>` : ""}${r.viol_status !== "closed" ? `<button class="btn pri" data-vs="closed">Закрыть</button>` : `<button class="btn" data-vs="work">Вернуть в работу</button>`}<a class="btn link" href="#/dialog/${esc(r.id)}">Открыть диалог</a></div></div></td></tr>` : ""}`).join("")}</tbody></table></div>`
      : emptyBox(st.s === "closed" ? "Закрытых нарушений нет" : "Открытых нарушений нет", "Как только модель найдёт грубое нарушение, диалог появится здесь, а комплаенс и руководитель группы получат уведомление."));
  $$("[data-s]", el).forEach(b => b.onclick = () => { st.s = b.dataset.s; st.open = null; violations(el, ctx); });
  $$("[data-row]", el).forEach(r => r.onclick = e => { if (e.target.closest("button,a")) return; if (!can) return ctx.go("dialog/" + r.dataset.row); st.open = st.open === r.dataset.row ? null : r.dataset.row; violations(el, ctx).then(() => $("#vn", el)?.focus()); });
  const vn = $("#vn", el); if (vn) vn.oninput = () => { st.note[st.open] = vn.value; };
  $$("[data-vs]", el).forEach(b => b.onclick = () => busy(b, async () => {
    await api("/violations/" + encodeURIComponent(st.open), { method: "PATCH", body: { status: b.dataset.vs, note: st.note[st.open] ?? vn.value } });
    toast(b.dataset.vs === "closed" ? "Нарушение закрыто" : "Нарушение взято в работу"); delete st.note[st.open]; st.open = null; ctx.refresh(); await violations(el, ctx);
  }));
}

// ======================= апелляции =======================
export async function appeals(el, ctx) {
  if (ctx.arg) return appealOne(el, ctx);
  const R = ctx.me.role;
  const st = appeals.st || (appeals.st = { s: "" });
  const list = await api("/appeals" + (st.s ? "?status=" + st.s : ""));
  if (!ctx.alive()) return;
  const text = R === "op" ? "Апелляции на ваши оценки. Решение по каждому критерию принимает QA-специалист, балл пересчитывается автоматически." : R === "lead" ? "Апелляции операторов вашей группы. Вы можете отозвать необоснованную до решения QA." : "Оператор оспаривает ответ по конкретным критериям. Решение принимается по каждому, итог пересчитывается, версия оценки сохраняется в истории.";
  el.innerHTML = ph(R === "op" ? "Мои апелляции" : "Апелляции", text)
    + `<div class="filters"><div class="chips">${[["", "Все"], ["open", "На рассмотрении"], ["accepted", "Приняты"], ["partial", "Частично"], ["rejected", "Отклонены"], ["withdrawn", "Отозваны"]].map(([k, t]) => `<button class="chip ${st.s === k ? "on" : ""}" data-s="${k}">${t}</button>`).join("")}</div></div>`
    + (list.length ? `<div class="tw"><table class="t"><thead><tr><th>№</th><th>Диалог</th><th>Оператор</th><th>Критерии и довод</th><th class="r">Балл</th><th>Статус</th><th>Подана</th></tr></thead><tbody>
      ${list.map(a => `<tr class="go" data-ap="${a.id}"><td class="id">А-${a.id}</td><td class="id">${esc(a.dialog_id)}</td><td>${esc(a.operator_name)}<span class="sub">${esc(a.team)}</span></td>
        <td class="wrap"><div class="sm">Критерии ${a.items.map(i => i.crit.slice(1)).join(", ")}</div><div class="sm muted">«${esc(a.text.length > 140 ? a.text.slice(0, 140) + "…" : a.text)}»</div></td>
        <td class="r num">${fmt(a.score_before)}${a.score_after != null && a.score_after !== a.score_before ? ` → <b>${fmt(a.score_after)}</b>` : ""}</td><td>${pill(AP_ST[a.status][0], AP_ST[a.status][1])}</td><td class="muted">${ago(a.created_at)}</td></tr>`).join("")}</tbody></table></div>`
      : emptyBox("Апелляций нет", R === "op" ? "Если вы не согласны с оценкой, откройте диалог, выберите критерий и ответ, который считаете верным, и опишите довод." : "Здесь появятся апелляции операторов на опубликованные оценки."));
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
  const refs = new Set(a.items.flatMap(i => [...(i.evidence || []), ...(e.items[i.crit]?.evidence || [])]));
  (a.text.match(/#(\d+)/g) || []).forEach(m => refs.add(+m.slice(1)));
  el.innerHTML = ph(`Апелляция А-${a.id}`, `${esc(a.operator_name)} · диалог <a href="#/dialog/${esc(a.dialog_id)}">${esc(a.dialog_id)}</a> · подана ${dt(a.created_at)}`, pill(AP_ST[a.status][0], AP_ST[a.status][1]))
    + `<div class="cols ww"><div>
       <div class="panel"><div class="sm muted">Довод оператора</div><p style="margin-top:6px;max-width:70ch">${linkify(a.text).replace(/#(\d+)/g, '<button class="evc" data-ev="$1">#$1</button>')}</p></div>
       ${a.items.map(it => { const c = cr[it.crit], m = e.items[it.crit] || {}; return `<div class="panel">
         <div class="row"><b>${it.crit.slice(1)}. ${esc(c.name)}</b><span class="grow"></span><span class="sm muted">вес ${c.weight}</span></div>
         <div class="row" style="margin-top:8px"><span class="sm muted">Текущий ответ</span>${ansPill(c, it.from)}<span class="muted">→</span><span class="sm muted">оператор просит</span>${ansPill(c, it.want)}</div>
         <div class="box" style="margin-top:10px"><div class="h">Обоснование ${m.source === "qa" ? "QA" : "модели"}${m.confidence != null ? ` · уверенность ${Math.round(m.confidence * 100)}%` : ""}</div><div class="sm">${linkify(m.explanation || "—")}</div>
           ${m.evidence?.length ? `<div class="chips">${m.evidence.map(n => `<button class="evc" data-ev="${n}">#${n}</button>`).join("")}</div>` : ""}</div>
         <div class="sm muted" style="margin-top:8px">Правило: ${esc(c.rule)}</div>
         ${canDecide ? `<div class="seg" style="margin-top:12px" role="group" aria-label="Решение по критерию ${it.crit.slice(1)}"><button data-d="${it.crit}" data-v="1" class="${st.dec[it.crit] === true ? "on" : ""}">Принять: ${esc(ansLabel(c, it.want))}</button><button data-d="${it.crit}" data-v="0" class="${st.dec[it.crit] === false ? "on" : ""}">Оставить: ${esc(ansLabel(c, it.from))}</button></div>`
           : it.accepted != null ? `<div style="margin-top:10px">${it.accepted ? pill("ok", "Принято") : pill("na", "Оставлено без изменений")}</div>` : ""}</div>`; }).join("")}
       ${canDecide ? `<div class="panel"><label class="l" for="cm" style="margin-top:0">Комментарий для оператора</label><textarea class="f" id="cm" placeholder="Почему решение такое. Оператор увидит комментарий в уведомлении и в истории диалога">${esc(st.comment)}</textarea>
         <div class="err hidden" id="aerr" role="alert"></div>
         <div class="row" style="margin-top:12px"><span class="sm muted" id="prev"></span><span class="grow"></span><button class="btn pri" id="dec">Принять решение</button></div></div>` : ""}
       ${!open ? `<div class="panel"><div class="sm muted">Решение${a.decided_name ? " · " + esc(a.decided_name) : ""} · ${dt(a.decided_at)}</div><p style="margin-top:6px">${esc(a.comment || "")}</p>${a.score_after != null ? `<p class="sm" style="margin-top:6px">Балл: ${fmt(a.score_before)} → <b>${fmt(a.score_after)}</b></p>` : ""}</div>` : ""}
       ${open && R === "op" ? `<div class="row"><span class="grow"></span><button class="btn" id="wdo">Отозвать апелляцию</button></div>` : ""}
     </div>
     <div class="panel" style="padding:0;position:sticky;top:0;max-height:calc(100vh - 140px);display:flex;flex-direction:column"><div class="sh" style="padding:12px 16px;border-bottom:1px solid var(--line)">Переписка · ${tr.length} реплик · отмечены упомянутые</div>
       <div class="chat" id="chat" style="flex:1;overflow:auto">${tr.map((m, i) => { const n = i + 1; if (m.speaker === "system") return `<div class="sys ${refs.has(n) ? "ev" : ""}" id="m${n}">#${n} · ${esc(m.text)}</div>`;
         return `<div class="msg ${m.speaker === "operator" ? "op" : ""} ${m.speaker === "bot" ? "ctx" : ""} ${refs.has(n) ? "ev" : ""}" id="m${n}"><div class="n">#${n}</div><div class="w"><b>${{ client: "Клиент", bot: "Бот AIM", operator: "Оператор" }[m.speaker]}</b>${esc(m.timestamp)}</div><div>${esc(m.text)}</div></div>`; }).join("")}</div></div></div>`;
  $$(".evc", el).forEach(b => b.onclick = () => { const m = $("#m" + b.dataset.ev, el), C = $("#chat", el); if (!m) return; C.scrollTo({ top: m.offsetTop - C.offsetTop - 80, behavior: "smooth" }); m.classList.add("flash"); setTimeout(() => m.classList.remove("flash"), 1200); });
  if (canDecide) {
    const prev = () => {
      const all = a.items.every(i => st.dec[i.crit] !== undefined), acc = a.items.filter(i => st.dec[i.crit]).length;
      $("#prev", el).textContent = !all ? `Решение по ${a.items.filter(i => st.dec[i.crit] === undefined).length} из ${a.items.length} критериев не выбрано` : acc === a.items.length ? "Апелляция будет принята полностью" : acc ? "Апелляция будет принята частично" : "Апелляция будет отклонена";
    };
    $$("[data-d]", el).forEach(b => b.onclick = () => { st.dec[b.dataset.d] = b.dataset.v === "1"; appealOne(el, ctx); });
    const cm = $("#cm", el); cm.oninput = () => { st.comment = cm.value; };
    prev();
    $("#dec", el).onclick = ev => busy(ev.currentTarget, async () => {
      try {
        const r = await api(`/appeals/${id}/decide`, { body: { decisions: st.dec, comment: st.comment } });
        toast(`Апелляция ${({ accepted: "принята", partial: "принята частично", rejected: "отклонена" })[r.status]}` + (r.before !== r.after ? `: ${fmt(r.before)} → ${fmt(r.after)}` : ""));
        delete appealOne.st[id]; ctx.refresh(); await appealOne(el, ctx);
      } catch (x) { const er = $("#aerr", el); er.textContent = x.message; er.classList.remove("hidden"); }
    });
  }
  const wdo = $("#wdo", el); if (wdo) wdo.onclick = () => busy(wdo, async () => { await api(`/appeals/${id}/withdraw`, { body: { comment: "Отозвана оператором" } }); toast("Апелляция отозвана"); ctx.refresh(); await appealOne(el, ctx); });
}

// ======================= калибровка модели =======================
export async function calibration(el, ctx) {
  const c = await api("/calibration");
  if (!ctx.alive()) return;
  const st = calibration.st || (calibration.st = { crit: "" });
  const dis = st.crit ? c.disagreements.filter(d => d.crit === st.crit) : c.disagreements;
  const crit = Object.fromEntries((await rulesCache()).criteria.map(x => [x.id, x]));
  el.innerHTML = ph("Калибровка модели", "Первые ответы модели против эталонной разметки QA на тех же диалогах. Правки после проверки сюда не входят — это честная точность модели до человека. Расхождения — материал для уточнения правил чек-листа.")
    + `<div class="strip">${stat("Совпадение с эталоном", c.agreement != null ? String(c.agreement).replace(".", ",") + "%" : "—", `${c.answers} ответов по критериям`)}${stat("Средняя ошибка итога", c.mae != null ? fmt(c.mae) + " балла" : "—", `на ${c.dialogs} ${plural(c.dialogs, "диалоге", "диалогах", "диалогах")}`)}${stat("Расхождений", c.disagreements.length, `из них эталон под сомнением: ${c.disagreements.filter(d => d.unsure).length}`)}</div>`
    + `<div class="cols w"><div class="sec"><h2>Совпадение по критериям</h2><div class="bars">${c.per.map(p => `<button class="bar" data-c="${p.crit}" aria-pressed="${st.crit === p.crit}" style="${st.crit === p.crit ? "background:var(--sunken)" : ""}"><span>${p.crit.slice(1)}. ${esc(p.name)}</span><span class="tr"><span class="fl ${p.rate >= 90 ? "l" : p.rate >= 75 ? "m" : ""}" style="width:${p.rate}%;display:block"></span></span><span class="n">${p.rate}%</span><span class="n muted">${p.ok}/${p.n}</span></button>`).join("")}</div>
        <p class="sm muted" style="margin-top:8px">Нажмите на критерий, чтобы оставить только его расхождения.</p></div>
      <div class="sec"><h2>Расхождения${st.crit ? ` · критерий ${st.crit.slice(1)}` : ""}</h2>${dis.length ? `<div class="tw"><table class="t"><thead><tr><th>Диалог</th><th>Критерий</th><th>Модель</th><th>Эталон</th></tr></thead><tbody>${dis.map(d => `<tr class="go" data-open="${esc(d.dialog)}"><td class="id">${esc(d.dialog)}</td><td>${d.crit.slice(1)}<span class="sub">${d.confidence != null ? "уверенность " + Math.round(d.confidence * 100) + "%" : ""}</span></td><td>${crit[d.crit] ? ansPill(crit[d.crit], d.ai) : esc(d.ai)}</td><td>${crit[d.crit] ? ansPill(crit[d.crit], d.gold) : esc(d.gold)}${d.unsure ? `<span class="sub">разметка под сомнением</span>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Расхождений нет.</p>`}</div></div>`;
  $$("[data-c]", el).forEach(b => b.onclick = () => { st.crit = st.crit === b.dataset.c ? "" : b.dataset.c; calibration(el, ctx); });
  bindOpen(el, ctx.go);
}

// ======================= обзор качества =======================
export async function dashboard(el, ctx) {
  const o = await api(periodURL("/stats/overview"));
  if (!ctx.alive()) return;
  const st = dashboard.st || (dashboard.st = { open: null });
  const R = ctx.me.role, p = o.process, maxPts = Math.max(...o.loss.map(l => l.points), 0.01);
  const toDialogs = q => (["lead"].includes(R) ? null : `dialogs/${q}`);
  el.innerHTML = ph(R === "lead" ? `Где теряем качество · ${esc(ctx.me.team)}` : R === "lead" ? "Обзор качества" : "Где теряем качество", "Средний балл, грубые ошибки и критерии, на которых операторы теряют больше всего баллов. Считается по текущим оценкам; диалоги с неполной оценкой не входят.")
    + `<div class="strip">${stat("Средний балл", fmt(o.avg), `${o.done} ${plural(o.done, "оценённый диалог", "оценённых диалога", "оценённых диалогов")}`)}${stat("Грубые ошибки", o.critical, o.done ? `${Math.round(o.critical / o.done * 100)}% диалогов` : "")}${stat("Охват оценкой", o.dialogs ? Math.round(o.evaluated / o.dialogs * 100) + "%" : "—", `${o.evaluated} из ${o.dialogs}`)}${stat("Стоимость на диалог", money(o.cost_per, 3), `${String(Math.round(o.sec * 10) / 10).replace(".", ",")} с · всего ${money(o.cost, 2)}`)}</div>`
    + `<div class="cols w"><div class="sec"><h2>Потери баллов по критериям</h2><p class="sm muted" style="margin:-6px 0 10px">Сколько баллов в среднем теряет диалог на критерии · доля нарушений среди применимых.</p><div class="bars">
        ${o.loss.map(l => `<button class="bar" data-l="${l.crit}" aria-expanded="${st.open === l.crit}"><span>${l.crit.slice(1)}. ${esc(l.name)}</span><span class="tr"><span class="fl ${l.points / maxPts > .6 ? "" : l.points / maxPts > .3 ? "m" : "l"}" style="width:${l.points / maxPts * 100}%;display:block"></span></span><span class="n">−${fmt(l.points)}</span><span class="n muted">${l.rate}%</span></button>
          ${st.open === l.crit ? `<div class="box" style="margin:2px 0 8px">${l.examples.length ? l.examples.map(x => `<div class="sm"><a href="#/dialog/${esc(x.dialog)}">${esc(x.dialog)}</a> · ${esc((x.text || "").replace(/\[\d+\]/g, "").slice(0, 180))}</div>`).join("") : `<div class="sm muted">Нарушений нет.</div>`}
            ${l.failed && toDialogs("") ? `<div><a class="btn sm" href="#/dialogs/failed=${l.crit}">Все ${l.failed} ${plural(l.failed, "диалог", "диалога", "диалогов")} с нарушением</a></div>` : ""}</div>` : ""}`).join("")}</div></div>
      <div><div class="sec"><h2>По каналам и языкам</h2><div class="tw"><table class="t"><tbody>${o.segments.map(s => `<tr><td>${esc(s.name)}</td><td class="r muted num">${s.n}</td><td class="r"><span class="score ${scls(s.avg)}">${fmt(s.avg)}</span></td></tr>`).join("")}</tbody></table></div></div>
        ${R !== "lead" ? `<div class="sec"><h2>По группам</h2><div class="tw"><table class="t"><tbody>${o.teams.map(t => `<tr ${toDialogs("") ? `class="go" data-team="${esc(t.name)}"` : ""}><td>${esc(t.name)}</td><td class="r muted num">${t.n}</td><td class="r">${t.critical ? pill("bad", t.critical + " груб.") : ""}</td><td class="r"><span class="score ${scls(t.avg)}">${fmt(t.avg)}</span></td></tr>`).join("")}</tbody></table></div></div>` : ""}
        <div class="sec"><h2>Процесс проверки</h2><div class="kv"><span>Ждут проверки QA</span><b>${p.review}</b><span>Открытые апелляции</span><b>${p.appeal}</b><span>Не оценены</span><b>${p.new}</b><span>Сбой оценки</span><b>${p.error}</b><span>Правок QA в текущих оценках</span><b>${p.overrides}</b><span>Апелляций принято / отклонено</span><b>${p.won} / ${p.lost}</b></div></div></div></div>`;
  $$("[data-l]", el).forEach(b => b.onclick = () => { st.open = st.open === b.dataset.l ? null : b.dataset.l; dashboard(el, ctx); });
  $$("[data-team]", el).forEach(r => r.onclick = () => ctx.go("dialogs/team=" + encodeURIComponent(r.dataset.team)));
  periodControls(el,ctx);
}

// ======================= группа / операторы =======================
export async function team(el, ctx) {
  const t = await api(periodURL("/stats/team"));
  if (!ctx.alive()) return;
  const R = ctx.me.role, ops = t.operators;
  const n = ops.reduce((s, o) => s + o.n, 0), cr = ops.reduce((s, o) => s + o.critical, 0);
  const all = ops.flatMap(o => o.avg != null ? Array(o.n).fill(o.avg) : []);
  el.innerHTML = ph(R === "lead" ? `Моя группа · ${esc(t.team)}` : "Операторы", "Сначала операторы с самым низким средним баллом. Слабый критерий — тот, который оператор нарушает чаще всего: с него стоит начать разбор.")
    + `<div class="strip">${stat("Операторов", ops.length)}${stat("Оценённых диалогов", n)}${stat("Средний балл", fmt(all.length ? all.reduce((a, b) => a + b, 0) / all.length : null))}${stat("Грубые ошибки", cr)}</div>`
    + (ops.length ? `<div class="tw"><table class="t"><thead><tr><th>Оператор</th>${R !== "lead" ? "<th>Группа</th>" : ""}<th class="r">Диалогов</th><th class="r">Средний балл</th><th>Грубые</th><th>Слабый критерий</th><th>Апелляции</th></tr></thead><tbody>
      ${ops.map(o => `<tr class="go" data-op="${esc(o.operator)}"><td><b style="font-weight:500">${esc(o.operator)}</b></td>${R !== "lead" ? `<td>${esc(o.team)}</td>` : ""}<td class="r num">${o.n}</td><td class="r"><span class="score ${scls(o.avg)}">${fmt(o.avg)}</span></td>
        <td>${o.critical ? pill("bad", o.critical) : '<span class="muted">—</span>'}</td><td>${o.weak ? `${o.weak.crit.slice(1)}. ${esc(o.weak.name)} <span class="muted">· ${o.weak.n}</span>` : '<span class="muted">—</span>'}</td><td>${o.appeals ? pill("info", o.appeals + " открыто") : '<span class="muted">—</span>'}</td></tr>`).join("")}</tbody></table></div>`
      : emptyBox("Оценённых диалогов нет", "Как только оценки будут опубликованы, здесь появится сводка по операторам."));
  $$("[data-op]", el).forEach(r => r.onclick = () => ctx.go("dialogs/operator=" + encodeURIComponent(r.dataset.op)));
  periodControls(el,ctx);
}

// ======================= мои диалоги (оператор) =======================
export async function my(el, ctx) {
  const [s, list] = await Promise.all([api(periodURL("/stats/me")), api(periodURL("/dialogs"))]);
  if (!ctx.alive()) return;
  const fresh = list.filter(d => d.wf_status === "published"), rest = list.filter(d => d.wf_status !== "published");
  el.innerHTML = ph(`Здравствуйте, ${esc(ctx.me.name.split(" ")[0])}`, "Оценки ваших диалогов после проверки QA. У каждого балла есть объяснение и ссылка на реплику. Не согласны — откройте диалог и подайте апелляцию по конкретному критерию.")
    + `<div class="strip">${stat("Средний балл", fmt(s.avg), `${s.n} ${plural(s.n, "оценка", "оценки", "оценок")}`)}${stat("Новых оценок", s.new, s.new ? "ждут ознакомления" : "")}${stat("Чаще всего теряете", s.weak ? `${s.weak.crit.slice(1)}. ${esc(s.weak.name)}` : "—", s.weak ? `${s.weak.n} ${plural(s.weak.n, "раз", "раза", "раз")}` : "", true)}${stat("Апелляции", s.appeals.n, s.appeals.open ? `${s.appeals.open} на рассмотрении` : "")}</div>`
    + (fresh.length ? `<div class="sec"><h2>Новые оценки</h2>${dialogTable(fresh)}</div>` : "")
    + `<div class="sec"><h2>${fresh.length ? "Ранее" : "Все оценки"}</h2>${dialogTable(rest, { emptyT: "Оценок пока нет", emptyP: "Оценка появится здесь после того, как QA-специалист проверит диалог. Придёт уведомление." })}</div>`
    + (s.weak ? `<p class="sm muted">Как оценивается критерий «${esc(s.weak.name)}» — в разделе <a href="#/rules">Как меня оценивают</a>.</p>` : "");
  bindOpen(el, ctx.go);
  periodControls(el,ctx);
}

// ======================= пользователи =======================
export async function users(el, ctx) {
  const [list, teams] = await Promise.all([api("/users"), api("/teams")]);
  if (!ctx.alive()) return;
  const st = users.st || (users.st = { q: "", add: false, pw: null });
  const rows = list.filter(u => !st.q || (u.name + u.login).toLowerCase().includes(st.q.toLowerCase()));
  const roleSel = (id, cur) => `<select class="f" data-role="${id}" style="width:auto;height:30px;padding:0 6px" aria-label="Роль">${Object.entries(ROLE).map(([k, v]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${v}</option>`).join("")}</select>`;
  const teamSel = (id, cur) => `<select class="f" data-team="${id}" style="width:auto;height:30px;padding:0 6px" aria-label="Группа"><option value="">—</option>${teams.map(t => `<option ${t === cur ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
  el.innerHTML = ph("Пользователи", "Роль определяет, что человек видит и может менять. Оператор видит только свои диалоги, руководитель группы — свою группу. В рабочей версии роли приходят из групп Active Directory.", `<button class="btn pri" id="add">Добавить пользователя</button>`)
    + (st.pw ? `<div class="note ok" style="margin-bottom:16px">Пользователь <b>${esc(st.pw.login)}</b> создан. Временный пароль: <code>${esc(st.pw.password)}</code> — передайте его лично, повторно он не показывается.</div>` : "")
    + (st.add ? `<form class="panel" id="uf" style="margin-bottom:16px"><div class="cols" style="grid-template-columns:repeat(4,minmax(0,1fr));gap:12px">
        <div><label class="l" for="ul">Логин</label><input class="f" id="ul" required placeholder="a.nurlanova"></div><div><label class="l" for="un">Имя</label><input class="f" id="un" required></div>
        <div><label class="l" for="ur">Роль</label><select class="f" id="ur">${Object.entries(ROLE).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
        <div><label class="l" for="ut">Группа</label><select class="f" id="ut"><option value="">—</option>${teams.map(t => `<option>${esc(t)}</option>`).join("")}</select></div></div>
        <div class="err hidden" id="uerr" role="alert"></div><div class="acts" style="margin-top:12px"><button class="btn pri" type="submit">Создать</button><button class="btn" type="button" id="ucancel">Отмена</button></div></form>` : "")
    + `<div class="filters"><input type="search" id="q" placeholder="Имя или логин" value="${esc(st.q)}" aria-label="Поиск пользователя"><span class="sm muted">${rows.length} из ${list.length}</span></div>`
    + `<div class="tw"><table class="t"><thead><tr><th>Имя</th><th>Логин</th><th>Роль</th><th>Группа</th><th>Доступ</th></tr></thead><tbody>${rows.map(u => `<tr class="${u.active ? "" : "muted"}"><td>${esc(u.name)}${u.id === ctx.me.id ? ' <span class="sub">это вы</span>' : ""}</td><td class="num">${esc(u.login)}</td><td>${roleSel(u.id, u.role)}</td><td>${teamSel(u.id, u.team)}</td>
      <td><label class="chk"><input type="checkbox" data-act="${u.id}" ${u.active ? "checked" : ""} ${u.id === ctx.me.id ? "disabled" : ""}> ${u.active ? "активен" : "заблокирован"}</label></td></tr>`).join("")}</tbody></table></div>`;
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

// ======================= настройки модели =======================
export async function settings(el, ctx) {
  const s = await api("/settings");
  if (!ctx.alive()) return;
  const can = ctx.me.role === "adm";
  const st = { model: s.model, conf: s.conf, sample: s.sample, budget: s.budget };
  const draw = () => {
    el.innerHTML = ph("Модель и оценка", "Параметры, с которыми модель оценивает новые диалоги. Смена модели или промпта — это новая версия оценки: прошлые результаты остаются в истории с паспортом, по которому их можно воспроизвести.")
      + `<div class="cols w"><div class="panel">
        <label class="l" style="margin-top:0">Модель</label><div class="seg" role="group" aria-label="Модель">${[["sonnet", "Sonnet 5.5 · точнее"], ["haiku", "Haiku 5.5 · дешевле"]].map(([k, t]) => `<button data-m="${k}" class="${st.model === k ? "on" : ""}" ${can ? "" : "disabled"}>${t}</button>`).join("")}</div>
        <p class="sm muted" style="margin-top:6px">Sonnet на эталоне совпадает с QA чаще; Haiku примерно втрое дешевле и годится для массовой предварительной проверки.</p>
        <label class="l" for="conf">Порог уверенности: <b id="cv">${Math.round(st.conf * 100)}%</b></label><input type="range" id="conf" min="0.5" max="0.95" step="0.05" value="${st.conf}" style="width:100%" ${can ? "" : "disabled"}>
        <p class="sm muted">Ответы с уверенностью ниже порога уходят в очередь проверки с причиной «Модель не уверена».</p>
        <label class="l" for="smp">Случайная выборка на контроль, % диалогов</label><input class="f" type="number" id="smp" min="0" max="20" value="${st.sample}" style="width:120px" ${can ? "" : "disabled"}>
        <p class="sm muted" style="margin-top:6px">Даже уверенные оценки иногда проверяет человек — так видно, если модель начала ошибаться.</p>
        <label class="l" for="bud">Лимит расходов на один пакет, $</label><input class="f" type="number" id="bud" min="1" max="100" step="1" value="${st.budget}" style="width:120px" ${can ? "" : "disabled"}>
        ${can ? `<div class="acts" style="margin-top:var(--s-lg)"><button class="btn pri" id="save">Сохранить</button></div>` : `<p class="note" style="margin-top:var(--s-lg)">Менять параметры может администратор.</p>`}</div>
        <div class="panel"><h3>Паспорт оценки</h3><div class="kv" style="margin-top:10px"><span>Модель</span><b>${esc(s.models[s.model])}</b><span>Версия промпта</span><b><code>${esc(s.prompt_hash)}</code></b><span>Потрачено всего</span><b>${money(s.spent, 2)}</b><span>Чек-лист</span><b>«${esc(ctx.me.checklist.name)}» v${ctx.me.checklist.version}</b></div>
          <p class="sm muted" style="margin-top:12px">Ключ API хранится на сервере в переменной окружения и в интерфейс не передаётся. Транскрипты уходят только в выбранную модель; персональные данные в чатах уже маскированы.</p></div></div>`;
    if (!can) return;
    $$("[data-m]", el).forEach(b => b.onclick = () => { st.model = b.dataset.m; draw(); });
    $("#conf", el).oninput = e => { st.conf = +e.target.value; $("#cv", el).textContent = Math.round(st.conf * 100) + "%"; };
    $("#smp", el).oninput = e => { st.sample = +e.target.value; };
    $("#bud", el).oninput = e => { st.budget = +e.target.value; };
    $("#save", el).onclick = e => busy(e.currentTarget, async () => { await api("/settings", { method: "PUT", body: st }); toast("Настройки сохранены. Они действуют для новых оценок"); ctx.refresh(); settings(el, ctx); });
  };
  draw();
}

// ======================= журнал действий =======================
export async function audit(el, ctx) {
  const st = audit.st || (audit.st = { q: "" });
  const rows = await api("/audit?q=" + encodeURIComponent(st.q));
  if (!ctx.alive()) return;
  el.innerHTML = ph("Журнал действий", "Кто, когда и что сделал: входы, правки оценок, решения по апелляциям, публикация чек-листов, выгрузки. Записи только добавляются — изменить или удалить их нельзя.")
    + `<div class="filters"><input type="search" id="q" placeholder="Действие, объект или сотрудник" value="${esc(st.q)}" aria-label="Поиск в журнале"><span class="sm muted">${rows.length} ${plural(rows.length, "запись", "записи", "записей")}${rows.length === 300 ? " · показаны последние 300" : ""}</span></div>`
    + (rows.length ? `<div class="tw"><table class="t"><thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Объект</th><th>Подробности</th></tr></thead><tbody>${rows.map(a => `<tr><td class="muted num" style="white-space:nowrap">${dt(a.at)}</td><td>${esc(a.who || "система")}<span class="sub">${ROLE[a.role] || ""}</span></td><td>${esc(a.action)}</td>
        <td class="id">${a.object && /^[\w-]+-\d+$|^p\d|^new-/.test(a.object) ? `<a href="#/dialog/${esc(a.object)}">${esc(a.object)}</a>` : esc(a.object || "")}</td><td class="sm muted wrap">${a.details ? esc(fmtDetails(a.details)) : ""}</td></tr>`).join("")}</tbody></table></div>` : emptyBox("Ничего не найдено", "Измените запрос."));
  let t; $("#q", el).oninput = e => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value; audit(el, ctx).then(() => { const q = $("#q", el); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }); }, 300); };
}
function fmtDetails(d) {
  if (typeof d !== "object") return String(d);
  if (d.from !== undefined) return `${d.from} → ${d.to}. ${d.reason || ""}`;
  if (d.before !== undefined) return `${fmt(d.before)} → ${fmt(d.after)}`;
  if (d.changes) return d.changes.map(c => `${c.crit.slice(1)}: ${({ added: "добавлен", removed: "удалён", weight: `вес ${c.before}→${c.after}`, semantic: "изменён смысл", section: "раздел" })[c.kind]}`).join(", ");
  return Object.entries(d).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.length : typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ");
}

export { development } from "./development.js";

export { integrations } from "./integrations.js";
