// Карточка диалога в духе Observe.AI AutoQA: шапка с действиями, оценочный лист по разделам
// («Вопрос N» → ответ → «Модель ответила… / Основание» → реплики-доказательства), ниже переписка с метками критериев.
import { $, $$, api, esc, fmt, money, dt, toast, busy, pill, stPill, ansLabel, optLabel, linkify, reasonPills, failed, initials,
  LANG, CH, SECS, TRIGGER, AP_ST, REASON } from "./ui.js";

const UI = {}; // состояние карточки по диалогу: раскрытые критерии, черновики

export async function dialog(el, ctx) {
  const id = ctx.arg;
  el.classList.add("flush", "dcv");
  const st = UI[id] || (UI[id] = { sel: null, edit: null, draft: {}, reason: {}, apText: "", jump: true });
  let data;
  try { data = await api("/dialogs/" + encodeURIComponent(id)); }
  catch (e) { el.classList.remove("flush", "dcv"); el.innerHTML = `<div class="note bad">${esc(e.message)}</div>`; return; }
  if (!ctx.alive()) return;
  draw(el, ctx, data, st);
  const running = data.evaluation?.status === "running" || data.dialog.wf_status === "evaluating";
  if (running) setTimeout(() => ctx.alive() && dialog(el, ctx), 1500);
}

const WHO = { client: "Клиент", bot: "Бот", operator: "Оператор" };
const cut = (s, n) => (s = String(s || "").replace(/\s+/g, " ").trim()).length > n ? s.slice(0, n - 1) + "…" : s;
const ICON = {
  ok: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.5l2.5 2.5L12 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  bad: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5l6 6M11 5l-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  warn: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4.5v4.5M8 11.5v.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  na: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 8h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  info: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.2v3.6M8 5.2v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
};
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return m > 10 && m < 20 ? c : k > 1 && k < 5 ? b : k === 1 ? a : c; };

function draw(el, ctx, data, st) {
  const { dialog: d, evaluation: e, events, appeals, history } = data;
  const R = ctx.me.role, tr = d.transcript, crit = e?.checklist.criteria || [];
  const items = e?.items || {};
  const openAp = appeals.find(a => a.status === "open");
  const canEdit = ["qa"].includes(R) && e && e.status !== "running" && d.wf_status !== "evaluating";
  const opCan = R === "op" && e && ["published", "acknowledged", "revised"].includes(d.wf_status) && !openAp;
  const running = e?.status === "running";
  const s = e?.score;

  // ---------- что требует внимания ----------
  const info = crit.map((c, idx) => {
    const it = items[c.id] || { status: "pending" };
    const a = it.answer, low = (it.flags || []).includes("low_conf");
    const touched = it.source === "qa" || it.source === "appeal" || appeals.some(x => x.items.some(i => i.crit === c.id)) || st.draft[c.id] != null;
    const problem = it.status !== "ok" || failed(c, a) || low || (it.flags || []).length > 0 || touched;
    // тон строки ответа: зелёный — выполнено, красный — нарушение/0, жёлтый — частично или сомнение
    let tone = "ok";
    if (it.status === "error" || (c.type === "flag" && a === "yes")) tone = "bad";
    else if (it.status !== "ok") tone = "na";
    else if (a == null || a === "na") tone = "na";
    else if (failed(c, a)) tone = c.type === "scale" && +a > 0 ? "warn" : "bad";
    else if (low) tone = "warn";
    return { c, it, a, low, idx, problem, tone };
  });
  const nProb = info.filter(x => x.problem).length;
  // выбранный вопрос: по умолчанию — грубая ошибка, иначе первый проблемный
  if (!st.sel || !items[st.sel]) st.sel = (info.find(x => x.tone === "bad" && x.c.type === "flag") || info.find(x => x.problem) || info[0])?.c.id || null;
  const selX = info.find(x => x.c.id === st.sel);
  const selEv = new Set(selX?.it.evidence || []);

  // реплика → критерии, для которых она доказательство (метки в переписке)
  const evMap = {};
  info.forEach(x => { if (x.it.status === "ok" && (x.problem || x.c.id === st.sel)) (x.it.evidence || []).forEach(n => (evMap[n] ||= []).push(x)); });

  const qnum = c => +c.id.slice(1);
  const pointsLbl = c => c.type === "flag" ? "без баллов · обнуляет итог" : s?.max?.[c.id] != null ? `до ${fmt(s.max[c.id])} балла` : `вес ${String(c.weight).replace(".", ",")}`;

  const question = x => {
    const { c, it, a, low, tone } = x;
    const id = c.id, open = st.sel === id;
    const ansText = it.status === "pending" ? "Оценивается…" : it.status === "error" ? "Сбой оценки" : ansLabel(c, a) === "нет ответа" ? "Нет ответа" : c.type === "flag" ? (a === "yes" ? "Есть нарушение" : "Нарушения нет") : ansLabel(c, a);
    const got = it.status === "ok" && c.type !== "flag" && a != null && a !== "na" ? `<span class="ox-pts">${fmt(s.pts[id] ?? 0)} / ${fmt(s.max[id])}</span>` : "";
    const tags = [];
    if (c.type === "flag" && a === "yes") tags.push(`<span class="ox-tag bad">Грубая ошибка</span>`);
    if (it.source === "qa") tags.push(`<span class="ox-tag info">Изменено QA</span>`);
    if (it.source === "appeal") tags.push(`<span class="ox-tag ok">По апелляции</span>`);
    if (low && ["qa"].includes(R)) tags.push(`<span class="ox-tag warn">Модель сомневается</span>`);
    (it.flags || []).filter(f => f !== "low_conf").forEach(f => tags.push(`<span class="ox-tag warn">${esc(REASON[f === "bad_evidence" ? "no_evidence" : f]?.[1] || f)}</span>`));
    if (st.draft[id] != null && R === "op") tags.push(`<span class="ox-tag info">В апелляции</span>`);

    let body = "";
    if (open) {
      if (it.status === "error") body += `<div class="ox-why"><b>Модель не ответила</b><p>${esc(it.error)}. Остальные критерии сохранены.</p></div>`;
      else if (it.status === "pending") body += `<div class="ox-why"><div class="skel"></div><div class="skel s2"></div></div>`;
      else {
        const src = it.source === "qa" || it.source === "appeal" ? `${it.source === "qa" ? "QA изменил ответ" : "Ответ изменён по апелляции"}: «${ansLabel(c, it.ai_answer)}» → «${ansLabel(c, a)}»` : `Модель ответила «${ansText}»`;
        body += `<div class="ox-why"><b>${src}</b>${it.confidence != null ? `<span class="ox-conf ${low ? "low" : ""}">уверенность ${Math.round(it.confidence * 100)}%</span>` : ""}
          <p><span class="muted">Основание:</span> ${linkify(it.explanation || "объяснения нет.")}</p>
          ${it.source === "qa" || it.source === "appeal" ? `<p class="muted">${esc(it.override_name || "")} · ${dt(it.override_at)}${it.override_reason ? ` · «${esc(it.override_reason)}»` : ""}</p>` : ""}
          ${it.evidence?.length ? `<div class="ox-ev">${it.evidence.map(n => { const m = tr[n - 1]; return `<button data-ev="${n}" title="Показать в переписке"><span class="t">#${n}</span><span class="w">${m ? WHO[m.speaker] || "Система" : ""}</span><span class="x">${m ? esc(cut(m.text, 200)) : "реплика не найдена"}</span></button>`; }).join("")}</div>`
            : `<p class="muted sm">Ссылок на реплики нет${c.type === "flag" && a === "no" || a === "na" ? ": нарушение не найдено или критерий неприменим" : ""}.</p>`}
          ${it.conditions ? `<div class="kv sm">${Object.entries(it.conditions).map(([k, v]) => `<span>${esc({ needs_account: "Нужно смотреть счёт", disclosure_turn: "Данные раскрыты в реплике", verified_before_disclosure: "Личность подтверждена до раскрытия" }[k] || k)}</span><b>${v === true ? "да" : v === false ? "нет" : v == null ? "—" : "#" + esc(v)}</b>`).join("")}</div>` : ""}
        </div>`;
      }
      appeals.filter(z => z.items.some(i => i.crit === id)).forEach(z => {
        const i = z.items.find(i => i.crit === id);
        body += `<div class="ox-why ap"><b>Апелляция А-${z.id} · ${AP_ST[z.status][1].toLowerCase()}</b><p>${esc(z.operator_name)}: ${ansLabel(c, i.from)} → ${ansLabel(c, i.want)}. «${esc(z.text)}»</p>${z.comment ? `<p class="muted">Решение${z.decided_name ? " · " + esc(z.decided_name) : ""}: ${esc(z.comment)}</p>` : ""}</div>`;
      });
      if (canEdit && it.status === "ok") {
        const pend = st.draft[id];
        if (st.edit === id || pend != null) {
          body += `<div class="ox-edit"><div class="ox-opts">${c.answers.map(o => `<button data-set="${id}" data-o="${o}" class="${(pend ?? a) === o ? "on" : ""}" aria-pressed="${(pend ?? a) === o}"><i></i>${optLabel(c, o)}${it.ai_answer === o ? "<sup>AI</sup>" : ""}</button>`).join("")}</div>`;
          if (pend != null && pend !== a) body += `<label class="l" for="rs-${id}">Почему вы не согласны</label><textarea class="f" id="rs-${id}" data-rs="${id}" placeholder="Например: оператор назвал срок ответа в #14">${esc(st.reason[id] || "")}</textarea>
            <div class="acts"><button class="btn pri sm" data-apply="${id}">Сохранить и пересчитать</button><button class="btn sm" data-cancel="${id}">Отмена</button></div>`;
          else body += `<div class="acts"><button class="btn sm" data-cancel="${id}">Закрыть</button></div>`;
          body += `</div>`;
        } else body += `<div class="acts"><button class="btn sm" data-edit="${id}">Изменить ответ</button></div>`;
      }
      if (opCan && it.status === "ok" && (c.type !== "flag" || a === "yes")) {
        if (st.edit === id || st.draft[id] != null) body += `<div class="ox-edit"><div class="sm muted">Какой ответ вы считаете верным?</div><div class="ox-opts">${c.answers.filter(o => o !== a).map(o => `<button data-want="${id}" data-o="${o}" class="${st.draft[id] === o ? "on" : ""}"><i></i>${optLabel(c, o)}</button>`).join("")}</div></div>`;
        else body += `<div class="acts"><button class="btn sm" data-edit="${id}">Оспорить</button></div>`;
      }
    }
    return `<div class="ox-q ${open ? "open" : ""} ${tone}" id="cr-${id}">
      <button class="ox-row" data-sel="${id}" aria-expanded="${open}"><span class="qn">${qnum(c)}</span><span class="qt">${esc(c.name)}</span><span class="qa ${tone}">${esc(ansText)}</span>${got || `<span class="ox-pts">${c.type === "flag" ? "флаг" : "—"}</span>`}<i class="ic ${tone}">${ICON[tone]}</i></button>
      ${tags.length ? `<div class="ox-tags">${tags.join("")}</div>` : ""}
      ${open ? `<div class="ox-body"><div class="ox-w">${pointsLbl(c)}</div>${body}</div>` : ""}</div>`;
  };

  const secs = [0, 1, 2, 3].map(si => {
    const xs = info.filter(x => (x.c.type === "flag" ? 3 : x.c.sec ?? 0) === si);
    if (!xs.length) return "";
    const sg = e?.sections?.[si];
    return `<div class="ox-grp"><div class="ox-sec"><span>${esc(SECS[si])}</span>${sg ? `<span class="ox-sg">${fmt(sg.got)} / ${fmt(sg.max)}</span>` : ""}</div>${xs.map(question).join("")}</div>`;
  }).join("");

  // ---------- итог ----------
  let grade = ["na", "—"];
  if (e && !running) {
    if (e.critical) grade = ["bad", "Не пройдено · грубая ошибка"];
    else if (s.total == null) grade = ["na", e.status === "partial" ? "Неполная оценка" : "Не применимо"];
    else if (s.total >= 85) grade = ["ok", "Пройдено"];
    else if (s.total >= 65) grade = ["warn", "Есть замечания"];
    else grade = ["bad", "Ниже нормы"];
  }
  const total = !e ? "" : running ? "…" : s.total == null ? "—" : fmt(s.total);

  // ---------- переписка ----------
  const escIdx = tr.findIndex(m => m.speaker === "system" && /эскалац|оператор|transferred|agent|жіберілді/i.test(m.text));
  const chat = tr.map((m, i) => {
    const n = i + 1, ev = evMap[n];
    const tags = ev ? `<div class="om-tags">${[...new Map(ev.map(x => [x.c.id, x])).values()].map(x => `<button data-goc="${x.c.id}" class="${x.tone} ${x.c.id === st.sel ? "on" : ""}" title="Вопрос ${qnum(x.c)}: ${esc(x.c.name)}">В${qnum(x.c)}</button>`).join("")}</div>` : "";
    if (m.speaker === "system") return `<div class="om-sys ${i === escIdx ? "esc" : ""}" id="m${n}"><span>#${n} · ${esc(m.timestamp)} · ${esc(m.text)}${i === escIdx ? " · далее оценивается оператор" : ""}</span>${tags}</div>`;
    const pre = m.speaker === "bot" || (escIdx >= 0 && i < escIdx);
    return `<div class="om ${m.speaker} ${pre ? "pre" : ""} ${ev ? "ev" : ""} ${selEv.has(n) ? "sel" : ""}" id="m${n}"><div class="om-h"><b>${WHO[m.speaker] || esc(m.speaker)}</b><span>${esc(m.timestamp)}</span><span class="n">#${n}</span></div><div class="om-b">${esc(m.text)}</div>${tags}</div>`;
  }).join("");

  // ---------- действия ----------
  const opDraft = R === "op" ? Object.keys(st.draft) : [];
  let acts = "", hint = "";
  if (["qa", "adm"].includes(R) && (!e || d.wf_status === "new")) { hint = "Диалог загружен, но ещё не оценён."; acts = `<button class="btn pri" data-eval>Оценить моделью</button>`; }
  else if (running) hint = "Модель оценивает критерии параллельно, ответы появляются по мере готовности.";
  else if (["qa"].includes(R)) {
    if (e?.status === "partial") { hint = "Часть критериев не оценена из-за сбоя."; acts = `<button class="btn pri" data-retry>Повторить упавшие</button>`; }
    else if (d.wf_status === "review") { hint = "Оператор увидит оценку после публикации."; acts = `<button class="btn" data-rescore title="Новый вызов модели по активной версии">Переоценить</button><button class="btn pri" data-confirm>Подтвердить и опубликовать</button>`; }
    else if (openAp) { hint = `Открыта апелляция А-${openAp.id}.`; acts = `<a class="btn pri" href="#/appeals/${openAp.id}">Рассмотреть апелляцию</a>`; }
    else { hint = ST_TEXT[d.wf_status] || ""; acts = `<button class="btn" data-rescore>Переоценить</button>`; }
  } else if (R === "op") {
    if (["published", "revised"].includes(d.wf_status)) { hint = "Ознакомьтесь с оценкой. Несогласие можно обосновать в апелляции."; acts = `<button class="btn pri" data-ack>Ознакомлен</button>`; }
    else if (opDraft.length) { hint = "Допишите довод для апелляции."; acts = `<button class="btn pri" data-goap>К апелляции</button>`; }
    else if (openAp) { hint = `Апелляция А-${openAp.id} на рассмотрении у QA.`; acts = `<button class="btn" data-apwd="${openAp.id}">Отозвать апелляцию</button>`; }
    else if (opCan) hint = "Не согласны? Нажмите «Оспорить» у вопроса.";
  } else if (R === "lead") { hint = "Просмотр. Изменить оценку может QA-специалист."; if (openAp) acts = `<a class="btn" href="#/appeals/${openAp.id}">Апелляция А-${openAp.id}</a>`; }
  else if (R === "qa" && e?.critical) { hint = `Грубое нарушение · ${({ new: "новое", work: "в работе", closed: "закрыто" })[d.viol_status]}`; acts = `<a class="btn pri" href="#/violations">К реестру нарушений</a>`; }
  else hint = "Только просмотр.";

  const ver = e?.checklist.version;
  const banners = [];
  if (e && d.wf_status === "review" && ["qa"].includes(R)) banners.push(`<div class="ox-note warn">${ICON.info}<span>Оценка ещё не видна оператору. ${reasonPills(e.review)}</span></div>`);
  if (openAp && R !== "op") banners.push(`<div class="ox-note">${ICON.info}<span>Оператор подал апелляцию А-${openAp.id}: «${esc(cut(openAp.text, 160))}» <a href="#/appeals/${openAp.id}">Открыть</a></span></div>`);

  const apForm = R === "op" && opDraft.length ? `<section class="ox-card apf" id="apform"><div class="ox-top"><b>Апелляция</b><span class="muted">вопросы ${opDraft.map(x => x.slice(1)).join(", ")}</span></div>
      <div class="ox-pad"><label class="l" for="aptext">Почему оценка неверна? Сошлитесь на реплики, например #12</label><textarea class="f" id="aptext">${esc(st.apText)}</textarea><div class="err hidden" id="aperr" role="alert"></div>
      <div class="acts"><button class="btn pri" data-apsend>Отправить апелляцию</button><button class="btn" data-apclear>Отменить</button></div></div></section>` : "";

  const reasons = e && d.wf_status === "review" && ["qa"].includes(R) ? `<div class="sc-why"><span class="muted">Почему на проверке:</span> ${reasonPills(e.review)}</div>` : "";
  const apNote = openAp && R !== "op" ? `<div class="ox-note">${ICON.info}<span>Апелляция А-${openAp.id}: «${esc(cut(openAp.text, 140))}» <a href="#/appeals/${openAp.id}">Открыть</a></span></div>` : "";

  const score = !e ? `<div class="sc-empty"><h2>${d.wf_status === "evaluating" ? "Оценивается…" : "Ещё не оценён"}</h2><p class="muted">${d.wf_status === "evaluating" ? "Модель проверяет критерии, страница обновится сама." : R === "op" ? "Оценка появится после проверки QA." : "Модель проверит диалог по активному чек-листу: по одному запросу на критерий, около 5 секунд и $0,02."}</p></div>`
    : `<div class="sc-top">
        <div class="sc-total"><div class="lbl">Итоговый балл</div><div class="val ${grade[0]}"><b>${total}</b>${s.total != null && !running ? "<span>/ 100</span>" : ""}</div></div>
        <div class="sc-meta"><span class="ox-grade ${grade[0]}">${ICON[grade[0] === "warn" ? "warn" : grade[0] === "ok" ? "ok" : grade[0] === "bad" ? "bad" : "na"]}${grade[1]}</span>
          <span class="muted">«${esc(e.checklist.name)}» v${ver}${ver !== data.active_version ? ` · активна v${data.active_version}` : ""} · AutoQA${!running && e.ai_total !== s.total && e.ai_total != null ? ` · модель: ${fmt(e.ai_total)}` : ""}</span></div>
      </div>
      ${reasons}${apNote}
      ${e.status === "partial" ? `<div class="ox-note bad">${ICON.info}<span>Часть критериев не оценена, итог не считается.</span></div>` : ""}
      <div class="ox-list">${secs}</div>
      ${apForm}
      <details class="more"><summary>Паспорт оценки и история</summary>
        <div class="pass"><span>Модель</span><b>${esc(e.model)}</b><span>Основание</span><b>${TRIGGER[e.trigger] || e.trigger}</b><span>Оценено</span><b>${dt(e.finished_at || e.created_at)}</b>
          <span>Вызовов модели</span><b>${e.calls}</b><span>Стоимость</span><b>${money(e.cost)}</b><span>Время</span><b>${e.seconds != null ? String(e.seconds).replace(".", ",") + " с" : "—"}</b><span>Версия промпта</span><b>${esc(e.prompt_hash)}</b></div>
        ${history.length > 1 ? `<div class="eyebrow">Версии оценки</div><ul class="hist">${history.map(h => `<li><span>${dt(h.created_at)}</span><div>${TRIGGER[h.trigger] || h.trigger} · v${h.version} · <b class="num">${fmt(h.total)}</b> <em>· ${h.calls} ${h.calls === 1 ? "вызов" : "вызовов"}${h.who ? " · " + esc(h.who) : ""}</em>${h.id === e.id ? " · текущая" : ""}</div></li>`).join("")}</ul>` : ""}
        <div class="eyebrow">История</div><ul class="hist">${events.map(x => `<li><span>${dt(x.at)}</span><div>${x.who ? `<em>${esc(x.who)}:</em> ` : ""}${esc(x.text)}</div></li>`).join("") || "<li><span></span><div class='muted'>Событий нет</div></li>"}</ul>
      </details>`;

  el.innerHTML = `<header class="dc-hd">
      <span class="ox-av">${esc(initials(d.operator))}</span>
      <div class="dc-id"><div class="t1"><h1>${esc(d.id)}</h1>${stPill(d.wf_status)}${e?.critical ? pill("bad", "Грубая ошибка") : ""}</div>
        <div class="meta">${esc(d.operator)} · ${esc(d.team)} · ${CH[d.channel] || esc(d.channel)} · ${LANG[d.language] || esc(d.language)} · ${dt(d.occurred_at)}</div></div>
      ${hint ? `<div class="hint">${esc(hint)}</div>` : ""}
      ${acts ? `<div class="acts">${acts}</div>` : ""}
    </header>
    <div class="dc-ws">
      <section class="dc-chat">
        <div class="pane-h"><b>Переписка</b><span class="muted">${tr.length} ${plural(tr.length, "реплика", "реплики", "реплик")}${selX ? ` · подсвечены доказательства вопроса ${qnum(selX.c)}` : ""}</span></div>
        ${d.channel === "voice call" ? `<div class="ox-ai">${ICON.info}<span>Звонок: текст распознан автоматически. Шум, маски имён и дубли реплик не считаются ошибкой оператора.${d.audio_url ? ` <a href="${esc(d.audio_url)}" target="_blank" rel="noopener">Запись разговора</a>` : ""}</span></div>` : ""}
        <div class="ox-chat" id="chat">${chat}</div>
      </section>
      <section class="dc-sc" id="sc">${score}</section>
    </div>`;

  // ---------- события ----------
  // две колонки скроллятся независимо; при перерисовке сохраняем позиции обеих
  const CH_ = () => $(".dc-chat", el), SC_ = () => $("#sc", el);
  const redraw = () => { const a = CH_()?.scrollTop, b = SC_()?.scrollTop, y = el.scrollTop; draw(el, ctx, data, st); if (CH_()) CH_().scrollTop = a; if (SC_()) SC_().scrollTop = b; el.scrollTop = y; };
  const reload = () => dialog(el, ctx);
  const inView = (box, node, flashIt) => {
    if (!node) return;
    if (box && getComputedStyle(box).overflowY !== "visible" && box.scrollHeight > box.clientHeight) {
      const r = node.getBoundingClientRect(), b = box.getBoundingClientRect();
      box.scrollTo({ top: box.scrollTop + r.top - b.top - box.clientHeight / 3, behavior: "smooth" });
    } else node.scrollIntoView({ block: "center", behavior: "smooth" });
    if (flashIt) flash(node);
  };
  // выбор вопроса: раскрыть его и показать первую реплику-доказательство в переписке
  $$("[data-sel]", el).forEach(b => b.onclick = () => {
    const k = b.dataset.sel; st.sel = st.sel === k ? null : k; st.edit = null; redraw();
    const ev = items[k]?.evidence?.[0]; if (st.sel && ev) inView(CH_(), $("#m" + ev, el), false);
  });
  $$("[data-ev]", el).forEach(b => b.onclick = () => scrollToTurn(+b.dataset.ev));
  $$("[data-goc]", el).forEach(b => b.onclick = () => {
    const k = b.dataset.goc; if (st.sel !== k) { st.sel = k; st.edit = null; redraw(); }
    inView(SC_(), $("#cr-" + k, el), true);
  });
  $$("[data-edit]", el).forEach(b => b.onclick = () => { st.edit = b.dataset.edit; redraw(); });
  $$("[data-set]", el).forEach(b => b.onclick = () => { const c = b.dataset.set; if (b.dataset.o === items[c].answer) delete st.draft[c]; else st.draft[c] = b.dataset.o; redraw(); $("#rs-" + c, el)?.focus({ preventScroll: true }); });
  $$("[data-rs]", el).forEach(t => t.oninput = () => { st.reason[t.dataset.rs] = t.value; });
  $$("[data-cancel]", el).forEach(b => b.onclick = () => { delete st.draft[b.dataset.cancel]; st.edit = null; redraw(); });
  $$("[data-apply]", el).forEach(b => b.onclick = () => busy(b, async () => {
    const c = b.dataset.apply;
    const r = await api(`/dialogs/${encodeURIComponent(d.id)}/override`, { body: { crit: c, answer: st.draft[c], reason: st.reason[c] || "" } });
    delete st.draft[c]; delete st.reason[c]; st.edit = null; toast(`Сохранено. Итог: ${fmt(r.total)}`); ctx.refresh(); await reload();
  }));
  const on = (sel, fn) => { const b = $(sel, el); if (b) b.onclick = () => busy(b, fn); };
  on("[data-confirm]", async () => {
    if (Object.keys(st.draft).length) { toast("Есть несохранённое изменение ответа. Сохраните или отмените его", true); return; }
    const r = await api(`/dialogs/${encodeURIComponent(d.id)}/confirm`, { body: {} });
    ctx.refresh(); toast("Опубликовано оператору" + (r.next ? ". Открыт следующий в очереди" : ""));
    if (r.next) { delete UI[r.next]; ctx.go("dialog/" + r.next); } else ctx.go("queue");
  });
  on("[data-eval]", async () => { await api("/evaluate", { body: { dialog_ids: [d.id], title: "Оценка " + d.id } }); toast("Оценка запущена"); await reload(); });
  on("[data-rescore]", async () => { await api("/evaluate", { body: { dialog_ids: [d.id], title: "Переоценка " + d.id } }); toast("Переоценка запущена: модель вызывается только для критериев, у которых изменился смысл"); st.sel = null; await reload(); });
  on("[data-retry]", async () => { await api(`/evaluations/${e.id}/retry`, { body: {} }); toast("Повторяем только упавшие критерии"); await reload(); });
  on("[data-ack]", async () => { await api(`/dialogs/${encodeURIComponent(d.id)}/acknowledge`, { body: {} }); toast("Отмечено. Если не согласны, нажмите «Оспорить» у вопроса"); ctx.refresh(); await reload(); });
  $$("[data-want]", el).forEach(b => b.onclick = () => {
    const c = b.dataset.want; if (st.draft[c] === b.dataset.o) delete st.draft[c]; else st.draft[c] = b.dataset.o;
    redraw(); const f = $("#apform", el); if (f && st.draft[c] != null) { f.scrollIntoView({ block: "center", behavior: "smooth" }); $("#aptext", el)?.focus({ preventScroll: true }); }
  });
  const ga = $("[data-goap]", el); if (ga) ga.onclick = () => { $("#apform", el)?.scrollIntoView({ block: "center", behavior: "smooth" }); $("#aptext", el)?.focus({ preventScroll: true }); };
  const apt = $("#aptext", el); if (apt) apt.oninput = () => { st.apText = apt.value; };
  const apc = $("[data-apclear]", el); if (apc) apc.onclick = () => { st.draft = {}; st.apText = ""; st.edit = null; redraw(); };
  on("[data-apsend]", async () => {
    try {
      const r = await api(`/dialogs/${encodeURIComponent(d.id)}/appeal`, { body: { items: Object.entries(st.draft).map(([crit, want]) => ({ crit, want })), text: st.apText } });
      st.draft = {}; st.apText = ""; st.edit = null; toast(`Апелляция А-${r.id} отправлена QA-специалисту`); ctx.refresh(); await reload();
    } catch (x) { const er = $("#aperr", el); er.textContent = x.message; er.classList.remove("hidden"); $("#aptext", el).focus(); }
  });
  on("[data-apwd]", async () => { await api(`/appeals/${$("[data-apwd]", el).dataset.apwd}/withdraw`, { body: { comment: "Отозвана оператором" } }); toast("Апелляция отозвана"); ctx.refresh(); await reload(); });

  function flash(m) { m.classList.remove("flash"); void m.offsetWidth; m.classList.add("flash"); setTimeout(() => m.classList.remove("flash"), 1400); }
  function scrollToTurn(n) { inView(CH_(), $("#m" + n, el), true); }
  // первое открытие: переписка сразу у доказательства выбранного вопроса
  if (st.jump) { st.jump = false; const ev = selX?.it.evidence?.[0], m = ev && $("#m" + ev, el), C = CH_(); if (m && C && C.scrollHeight > C.clientHeight) C.scrollTop = Math.max(0, m.getBoundingClientRect().top - C.getBoundingClientRect().top - C.clientHeight / 3); }
}
const ST_TEXT = { published: "Опубликовано оператору.", acknowledged: "Оператор ознакомился с оценкой.", revised: "Оценка пересмотрена по апелляции.", appeal: "Открыта апелляция." };
