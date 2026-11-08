// Инспектор диалога (Linear / Zendesk QA / LangSmith Split-Pane Architecture):
// - Слева: плоский табличный лог переписки без карточных рамок (таймстемпы, паузы, фильтр, сворачиваемый контекст до эскалации)
// - Справа: плоский оценочный лист с разделителями 1px (без вложенных карточек), мгновенно видимыми обоснованиями и кликабельными репликами
// - Флаг грубой ошибки (п.8) сигнализирует о комплаенс-риске отдельно и НЕ обнуляет арифметический балл

import { $, $$, api, esc, fmt, money, dt, toast, busy, pill, stPill, ansLabel, optLabel, linkify, reasonPills, failed,
  LANG, CH, SECS, TRIGGER, AP_ST, REASON, ST } from "./ui.js";

const UI = {};
let queueIds = null;

export async function dialog(el, ctx) {
  const id = ctx.arg;
  el.classList.add("flush", "dcv");
  const stateKey = `${ctx.me.id}:${id}`;
  const st = UI[stateKey] || (UI[stateKey] = { sel: null, expandAll: false, edit: null, draft: {}, reason: {}, apText: "", apDec: {}, apComment: "", showCtx: false, chatFilter: "all", jump: true });

  const reqs = [api("/dialogs/" + encodeURIComponent(id))];
  if (["qa"].includes(ctx.me.role) && !queueIds) {
    reqs.push(api("/queue").then(rs => { queueIds = rs.map(r => r.id); }).catch(() => {}));
  }
  let data;
  try { [data] = await Promise.all(reqs); }
  catch (e) { el.classList.remove("flush", "dcv"); el.innerHTML = `<div class="note bad" style="margin:24px">${esc(e.message)}</div>`; return; }
  if (!ctx.alive()) return;
  draw(el, ctx, data, st);
  const running = data.evaluation?.status === "running" || data.dialog.wf_status === "evaluating";
  if (running) setTimeout(() => ctx.alive() && dialog(el, ctx), 1500);
}

const WHO = { client: "Клиент", bot: "Бот", operator: "Оператор" };
const cut = (s, n) => (s = String(s || "").replace(/\s+/g, " ").trim()).length > n ? s.slice(0, n - 1) + "…" : s;
const plural = (n, a, b, c) => { const m = Math.abs(n) % 100, k = m % 10; return m > 10 && m < 20 ? c : k > 1 && k < 5 ? b : k === 1 ? a : c; };

function pauseMinutes(t1, t2) {
  if (!t1 || !t2) return 0;
  const parse = s => {
    // Without a declared format, 01:56 can mean mm:ss or HH:mm. Do not invent a pause.
    if (/^\d{1,2}:\d{2}$/.test(String(s))) return null;
    const m = String(s).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) return (+m[1]) * 60 + (+m[2]) + (+(m[3] || 0)) / 60;
    const d = Date.parse(s);
    return isNaN(d) ? null : d / 60000;
  };
  const a = parse(t1), b = parse(t2);
  if (a == null || b == null || b < a) return 0;
  return Math.round(b - a);
}

function draw(el, ctx, data, st) {
  const { dialog: d, evaluation: e, events, appeals, history, gold = {} } = data;
  const R = ctx.me.role, tr = d.transcript, crit = e?.checklist.criteria || [];
  const items = e?.items || {};
  const openAp = appeals.find(a => a.status === "open");
  const canEdit = ["qa"].includes(R) && e && e.status !== "running" && d.wf_status !== "evaluating";
  const opCan = R === "op" && e && ["published", "acknowledged", "revised"].includes(d.wf_status) && !openAp;
  const running = e?.status === "running";
  const s = e?.score;

  // Анализ критериев
  const info = crit.map((c, idx) => {
    const it = items[c.id] || { status: "pending" };
    const a = it.answer, low = (it.flags || []).includes("low_conf");
    const inOpenAp = openAp?.items.find(i => i.crit === c.id);
    const touched = it.source === "qa" || it.source === "appeal" || appeals.some(x => x.items.some(i => i.crit === c.id)) || st.draft[c.id] != null;
    const problem = it.status !== "ok" || failed(c, a) || low || (it.flags || []).length > 0 || touched;
    let tone = "ok";
    if (it.status === "error" || (c.type === "flag" && a === "yes")) tone = "bad";
    else if (it.status !== "ok" || a == null || a === "na") tone = "na";
    else if (failed(c, a)) tone = c.type === "scale" && +a > 0 ? "warn" : "bad";
    else if (low) tone = "warn";
    return { c, it, a, low, idx, problem, tone, inOpenAp };
  });

  if (!st.sel || !items[st.sel]) {
    st.sel = (info.find(x => x.inOpenAp) || info.find(x => x.tone === "bad" && x.c.type === "flag") || info.find(x => x.problem) || info[0])?.c.id || null;
  }
  const selX = info.find(x => x.c.id === st.sel);
  const selEv = new Set(selX?.it.evidence || []);

  const evMap = {};
  info.forEach(x => {
    if (x.it.status === "ok") {
      (x.it.evidence || []).forEach(n => (evMap[n] ||= []).push(x));
    }
  });

  const escIdx = tr.findIndex(m => m.speaker === "system" && /эскалац|оператор|transferred|agent|жіберілді/i.test(m.text));
  const isPreTurn = idx => tr[idx]?.speaker === "bot" || (escIdx >= 0 && idx < escIdx && tr[idx]?.speaker !== "system");
  // Auto-reveal only on first open; respect an explicit collapse on redraw.
  if (st.jump && [...selEv].some(n => isPreTurn(n - 1))) st.showCtx = true;

  const qnum = c => +c.id.slice(1);

  // ---------- Плоская строка критерия (без вложенных рамок) ----------
  const question = x => {
    const { c, it, a, low, tone, inOpenAp } = x;
    const id = c.id;
    const isSel = st.sel === id;
    const open = st.expandAll || isSel || st.edit === id || st.draft[id] != null || Boolean(inOpenAp && canEdit);
    const ansText = it.status === "pending" ? "…" : it.status === "error" ? "Сбой" : ansLabel(c, a) === "нет ответа" ? "—" : c.type === "flag" ? (a === "yes" ? "Нарушение" : "Чисто") : ansLabel(c, a);
    const got = it.status === "ok" && c.type !== "flag" && a != null && a !== "na"
      ? `<span class="ox-pts">${fmt(s.pts[id] ?? 0)}<small>/${fmt(s.max[id])}</small></span>`
      : `<span class="ox-pts muted">${c.type === "flag" ? "флаг" : a === "na" ? `не учитывается` : "—"}</span>`;

    const badges = [];
    if (c.type === "flag" && a === "yes") badges.push(`<span class="ox-tag bad">Риск</span>`);
    if (inOpenAp) badges.push(`<span class="ox-tag info">Спор А-${openAp.id}  —  ${ansLabel(c, inOpenAp.want)}</span>`);
    if (it.source === "qa") badges.push(`<span class="ox-tag info">QA (ИИ: ${ansLabel(c, it.ai_answer)})</span>`);
    if (it.source === "appeal") badges.push(`<span class="ox-tag ok">По апелляции</span>`);
    if (low && ["qa"].includes(R)) badges.push(`<span class="ox-tag warn">${Math.round((it.confidence || 0) * 100)}%</span>`);
    (it.flags || []).filter(f => f !== "low_conf").forEach(f => badges.push(`<span class="ox-tag warn">${esc(REASON[f === "bad_evidence" ? "no_evidence" : f]?.[1] || f)}</span>`));
    if (gold[id] != null && ["qa"].includes(R)) {
      const match = gold[id] === it.ai_answer;
      badges.push(`<span class="ox-tag ${match ? "ok" : "warn"}" title="Предварительная разметка; требует проверки командой">Черновой эталон: ${ansLabel(c, gold[id])}</span>`);
    }
    if (st.draft[id] != null && R === "op") badges.push(`<span class="ox-tag info">К апелляции: ${ansLabel(c, st.draft[id])}</span>`);

    // Объяснение и ссылки на реплики всегда видны компактной второй строкой (без рамок и вложенных блоков)
    let explainLine = "";
    if (it.status === "error") {
      explainLine = `<div class="ox-sub bad">${esc(it.error)}</div>`;
    } else if (it.status === "pending") {
      explainLine = `<div class="ox-sub"><div class="skel" style="width:65%"></div></div>`;
    } else if (it.explanation) {
      const evLinks = (it.evidence || []).map(n => {
        const m = tr[n - 1];
        const snippet = m ? cut(m.text, open ? 110 : 52) : "";
        return `<button type="button" class="ev-inline" data-ev="${n}" title="Перейти к реплике #${n}"><b>#${n}</b>${snippet ? ` <span>«${esc(snippet)}»</span>` : ""}</button>`;
      }).join(" ");
      explainLine = `<div class="ox-sub">
        <span class="ox-exp">${open ? linkify(it.explanation) : esc(cut(it.explanation.replace(/\[(\d+)(?:\s*[-–]\s*\d+)?\]/g, "#$1"), 150))}</span>
        ${evLinks ? `<div class="ox-ev-inline">${evLinks}</div>` : ""}
      </div>`;
    }

    // Дополнительные действия в раскрытой строке (без вложенных карточек)
    let detailHtml = "";
    if (open && it.status === "ok") {
      const metaParts = [];
      if (c.type !== "flag") metaParts.push(`Вес: ${c.weight}${s?.k && s.k !== 1 && a !== "na" ? ` × ${fmt(s.k)} = ${fmt(s.max[id])} б.` : " б."}`);
      else metaParts.push("Не обнуляет балл");
      if (it.confidence != null && ["qa"].includes(R)) metaParts.push(`Уверенность ИИ: ${Math.round(it.confidence * 100)}%`);
      if (it.source === "qa" || it.source === "appeal") metaParts.push(`Изменил ${esc(it.override_name || "QA")}${it.override_reason ? `: «${esc(it.override_reason)}»` : ""}`);

      // Апелляции по критерию
      const apHist = appeals.filter(z => z.items.some(i => i.crit === id)).map(z => {
        const i = z.items.find(i => i.crit === id);
        return `<div class="ox-ap-line"><b>А-${z.id} (${AP_ST[z.status][1]}):</b> ${esc(z.operator_name)} просит «${ansLabel(c, i.want)}» — «${linkify(z.text)}»${z.comment ? ` · <em>Ответ QA: ${esc(z.comment)}</em>` : ""}</div>`;
      }).join("");

      // Inline-переключатель оценки для QA / Руководителя QA
      let controls = "";
      if (canEdit) {
        const pend = st.draft[id];
        controls = `<div class="ox-ctrl">
          <div class="ox-ctrl-row">
            <span class="muted sm">${ metaParts.join(" · ") }</span>
            <div class="seg sm">
              ${c.answers.map(o => `<button type="button" data-set="${id}" data-o="${o}" aria-pressed="${(pend ?? a) === o}" class="${(pend ?? a) === o ? "on" : ""}">${optLabel(c, o)}</button>`).join("")}
            </div>
          </div>
          ${pend != null && pend !== a ? `<div class="ox-override-bar">
            <input class="f sm" id="rs-${id}" data-rs="${id}" placeholder="Причина изменения для аудита (например: в #12 оператор назвал сроки)…" value="${esc(st.reason[id] || "")}">
            <button type="button" class="btn pri sm" data-apply="${id}">Сохранить</button>
            <button type="button" class="btn sm" data-cancel="${id}">Отмена</button>
          </div>` : ""}
        </div>`;
      } else if (opCan && (c.type !== "flag" || a === "yes")) {
        controls = `<div class="ox-ctrl">
          <div class="ox-ctrl-row">
            <span class="muted sm">Оспорить ответ по критерию:</span>
            <div class="seg sm">
              ${c.answers.filter(o => o !== a).map(o => `<button type="button" data-want="${id}" data-o="${o}" class="${st.draft[id] === o ? "on" : ""}">Прошу «${optLabel(c, o)}»</button>`).join("")}
              ${st.draft[id] != null ? `<button type="button" data-want="${id}" data-o="${st.draft[id]}">Снять</button>` : ""}
            </div>
          </div>
        </div>`;
      } else {
        controls = `<div class="ox-ctrl-row"><span class="muted sm">${metaParts.join(" · ")} · Правило: ${esc(cut(c.rule, 110))}</span></div>`;
      }

      detailHtml = `${apHist}${controls}`;
    }

    return `<div class="ox-q ${isSel ? "sel" : ""} ${open ? "open" : ""} ${tone}" id="cr-${id}">
      <div class="ox-row" data-sel="${id}" role="button" tabindex="0" aria-expanded="${open}">
        <span class="ox-dot ${tone}"></span>
        <span class="qn">${String(qnum(c)).padStart(2, "0")}</span>
        <span class="qt">${esc(c.name)}</span>
        ${badges.length ? `<span class="ox-badges">${badges.join("")}</span>` : ""}
        <span class="qa ${tone}">${esc(ansText)}</span>
        ${got}
      </div>
      ${explainLine}
      ${detailHtml}
    </div>`;
  };

  const secs = [0, 1, 2, 3].map(si => {
    const xs = info.filter(x => (x.c.type === "flag" ? 3 : x.c.sec ?? 0) === si);
    if (!xs.length) return "";
    const sg = e?.sections?.[si];
    return `<div class="ox-grp">
      <div class="ox-sec"><span>${esc(SECS[si])}</span><span class="ox-sg">${sg ? `${fmt(sg.got)} / ${fmt(sg.max)}` : si === 3 ? `контроль рисков` : `N/A`}</span></div>
      ${xs.map(question).join("")}
    </div>`;
  }).join("");

  // Итоговый балл
  let grade = ["na", "Не рассчитано"];
  if (e && !running) {
    if (s.total == null) grade = ["na", e.status === "partial" ? "Оценка неполная" : "Все критерии N/A"];
    else if (s.total >= 85) grade = ["ok", "Высокое качество"];
    else if (s.total >= 65) grade = ["warn", "Есть замечания"];
    else grade = ["bad", "Ниже стандарта"];
  }
  const total = !e ? "—" : running ? "…" : s.total == null ? "—" : fmt(s.total);
  const naCrits = info.filter(x => x.c.type !== "flag" && x.a === "na");

  // Встроенная полоса решения по апелляции (без карточной матрёшки)
  let inlineAppealStrip = "";
  if (openAp && ["qa"].includes(R)) {
    const crMap = Object.fromEntries(crit.map(c => [c.id, c]));
    inlineAppealStrip = `<div class="sc-strip info">
      <div class="row" style="justify-content:space-between">
        <b>Апелляция А-${openAp.id} · ${esc(openAp.operator_name)}</b>
        <a class="sm" href="#/appeals/${openAp.id}">Карточка А-${openAp.id}</a>
      </div>
      <div class="sm fg2" style="margin-top:3px">Довод: «${linkify(openAp.text)}»</div>
      <div class="ap-inline-items">
        ${openAp.items.map(it => {
          const c = crMap[it.crit];
          const curDec = st.apDec[it.crit];
          return `<div class="ap-inline-row">
            <span class="sm"><b>#${it.crit.slice(1)} ${esc(c?.name || it.crit)}</b> (${ansLabel(c, it.from)}  —  ${ansLabel(c, it.want)})</span>
            <div class="seg sm">
              <button type="button" data-apdec="${it.crit}" data-v="1" class="${curDec === true ? "on" : ""}">Принять</button>
              <button type="button" data-apdec="${it.crit}" data-v="0" class="${curDec === false ? "on" : ""}">Отклонить</button>
            </div>
          </div>`;
        }).join("")}
      </div>
      <div class="ox-override-bar" style="margin-top:8px">
        <input class="f sm" id="inl-ap-cm" placeholder="Комментарий к решению по апелляции…" value="${esc(st.apComment)}">
        <button class="btn pri sm" id="inl-ap-submit">Утвердить решение</button>
      </div>
      <div class="err hidden" id="inl-ap-err"></div>
    </div>`;
  }

  // ---------- Левая колонка: Лог переписки ----------
  const nCtx = tr.filter((_, i) => isPreTurn(i)).length;
  let prevOpOrClientTs = null;
  const chatRows = tr.map((m, i) => {
    const n = i + 1, ev = evMap[n];
    const pre = isPreTurn(i);
    if (pre && !st.showCtx && st.chatFilter === "all") return "";
    if (st.chatFilter === "op" && m.speaker !== "operator" && m.speaker !== "system") return "";
    if (st.chatFilter === "ev" && !ev && i !== escIdx) return "";

    const tags = ev
      ? `<div class="om-tags">${[...new Map(ev.map(x => [x.c.id, x])).values()].map(x => `<button type="button" data-goc="${x.c.id}" class="${x.tone} ${x.c.id === st.sel ? "on" : ""}" title="Критерий ${qnum(x.c)}: ${esc(x.c.name)}">К${qnum(x.c)}</button>`).join("")}</div>`
      : `<div></div>`;

    if (m.speaker === "system") {
      return `<div class="om-sys ${i === escIdx ? "esc" : ""} ${selEv.has(n) ? "ev" : ""}" id="m${n}">
        <span>#${n} · ${esc(m.timestamp || "")} · ${esc(m.text)}${i === escIdx ? " — начало оценки оператора" : ""}</span>
      </div>`;
    }

    const gap = (!pre && prevOpOrClientTs && m.speaker === "operator") ? pauseMinutes(prevOpOrClientTs, m.timestamp) : 0;
    if (!pre) prevOpOrClientTs = m.timestamp;

    return `<div class="t-turn ${m.speaker} ${pre ? "pre" : ""} ${ev ? "ev" : ""} ${selEv.has(n) ? "sel" : ""}" id="m${n}">
      <div class="t-no">#${n}</div>
      <div class="t-who">
        <b>${WHO[m.speaker] || esc(m.speaker)}</b>
        <span class="mono">${esc(m.timestamp || "")}</span>
        ${gap >= 3 ? `<span class="t-pause" title="Пауза перед ответом">+${gap}м</span>` : ""}
      </div>
      <div class="t-txt">${esc(m.text)}</div>
      ${tags}
    </div>`;
  }).join("");

  // ---------- Действия в шапке и навигация по очереди ----------
  const opDraft = R === "op" ? Object.keys(st.draft) : [];
  let acts = "";
  if (["qa", "adm"].includes(R) && (!e || d.wf_status === "new")) {
    acts = `<button class="btn pri sm" data-eval>Оценить моделью</button>`;
  } else if (running) {
    acts = `<span class="sm muted">Идёт оценка…</span>`;
  } else if (["qa"].includes(R)) {
    if (e?.status === "partial") {
      acts = `<button class="btn pri sm" data-retry>Повторить оценку ошибок</button>`;
    } else if (d.wf_status === "review") {
      acts = `<button class="btn sm" data-rescore>Переоценить</button><button class="btn pri sm" data-confirm>Подтвердить и опубликовать</button>`;
    } else {
      acts = `<button class="btn sm" data-rescore>Переоценить</button>`;
    }
  } else if (R === "op") {
    if (opDraft.length) {
      acts = `<button class="btn pri sm" data-goap>Далее: указать причину (${opDraft.length})</button>`;
    } else if (["published", "revised"].includes(d.wf_status)) {
      acts = `<button class="btn sm" data-start-appeal>Оспорить оценку</button><button class="btn pri sm" data-ack>Ознакомлен</button>`;
    } else if (openAp) {
      acts = `<button class="btn sm" data-apwd="${openAp.id}">Отозвать апелляцию</button>`;
    }
  }
  if (R === "op" && opCan && !acts) acts = `<button class="btn sm" data-start-appeal>Запросить пересмотр</button>`;

  const ver = e?.checklist.version;
  const apForm = R === "op" && opDraft.length ? `<section class="apf" id="apform">
    <div class="row" style="justify-content:space-between;margin-bottom:6px">
      <b>Апелляция по критериям: ${opDraft.map(x => `#${x.slice(1)} (${optLabel(crit.find(c => c.id === x), st.draft[x])})`).join(", ")}</b>
      <button class="btn sm link" data-apclear>Сбросить</button>
    </div>
    <label class="l" for="aptext">Почему оценку нужно пересмотреть?</label><p class="sm muted">QA получит выбранные пункты и ваш довод. Укажите реплику, подтверждающую вашу позицию.</p>
    <textarea class="f sm" id="aptext" rows="3" placeholder="Например: в реплике #12 я объяснил клиенту следующий шаг…">${esc(st.apText)}</textarea>
    <div class="err hidden" id="aperr" role="alert"></div>
    <div class="acts" style="margin-top:8px"><button class="btn pri sm" data-apsend>Отправить апелляцию</button></div>
  </section>` : "";

  const grossStrip = e?.critical ? `<div class="sc-strip bad"><b>Флаг грубой ошибки (п.8)</b> · Нарушение требует проверки QA. Арифметический балл (${total}/100) не обнуляется.</div>` : "";
  const reviewStrip = e?.review?.length && d.wf_status === "review" && ["qa"].includes(R) ? `<div class="review-note"><span class="review-note-label">На проверке:</span><span class="review-note-reasons">${reasonPills(e.review)}</span></div>` : "";

  // Сводка по секциям одной строкой без вложенных карточек
  const secInline = e && !running && e.sections
    ? [0, 1, 2].map(si => {
        const sg = e.sections[si];
        return `<span>${esc(SECS[si])}: <b class="mono">${sg ? `${fmt(sg.got)}/${fmt(sg.max)}` : "N/A"}</b></span>`;
      }).join(`<span class="sep">·</span>`)
    : "";

  const scorePane = !e
    ? `<div style="padding:32px 24px"><h2>${d.wf_status === "evaluating" ? "Оценивается моделью…" : "Диалог ещё не оценён"}</h2><p class="muted sm" style="margin-top:6px">${d.wf_status === "evaluating" ? "Модель проверяет критерии параллельно." : R === "op" ? "Оценка станет доступна после проверки QA." : "Нажмите «Оценить моделью» в верхней панели."}</p></div>`
    : `<div class="sc-head">
        <div class="sc-head-top">
          <div class="sc-score-wrap">
            <span class="sc-num ${grade[0]}">${total}</span>
            ${s.total != null && !running ? `<span class="sc-denom">/ 100</span>` : ""}
            <span class="pill ${grade[0]}" style="margin-left:6px">${grade[1]}</span>
          </div>
          <div class="sc-head-meta">
            <span class="mono sm muted">Стандарт v${ver}${naCrits.length ? ` · N/A: ${naCrits.length}` : ""}${!running && e.ai_total !== s.total && e.ai_total != null ? ` · ИИ: ${fmt(e.ai_total)}` : ""}</span>
            <button type="button" class="btn sm link" id="exp-all">${st.expandAll ? "Свернуть детали" : "Развернуть все"}</button>
          </div>
        </div>
        ${secInline ? `<div class="sc-sec-inline">${secInline}${naCrits.length ? `<span class="sep">·</span><span class="muted">N/A: п.${naCrits.map(x => qnum(x.c)).join(",")}</span>` : ""}</div>` : ""}
      </div>
      ${grossStrip}
      ${reviewStrip}
      ${inlineAppealStrip}
      ${e.status === "partial" ? `<div class="sc-strip bad">Часть критериев не оценена из-за ошибки вызова модели. Нажмите «Повторить оценку ошибок».</div>` : ""}
      <div class="ox-list">${secs}</div>
      ${apForm}
      <details class="more">
        <summary>История и сведения об оценке (${events.length})</summary>
        <div class="pass">
          <span>Модель</span><b>${esc(e.model)}</b>
          <span>Триггер</span><b>${TRIGGER[e.trigger] || e.trigger}</b>
          <span>Время</span><b>${dt(e.finished_at || e.created_at)} (${e.seconds != null ? String(e.seconds).replace(".", ",") + " с" : "—"})</b>
          <span>Запросов / Цена</span><b>${e.calls} вызов. · ${money(e.cost)}</b>
          <span>Хэш промпта</span><b><code>${esc(e.prompt_hash)}</code></b>
        </div>
        ${history.length > 1 ? `<div class="eyebrow">Версии оценки</div><ul class="hist">${history.map(h => `<li><span>${dt(h.created_at)}</span><div>${TRIGGER[h.trigger] || h.trigger} · v${h.version} · <b class="num">${fmt(h.total)}</b> <em>· ${h.calls} вызов.${h.who ? " · " + esc(h.who) : ""}</em>${h.id === e.id ? " · <b>текущая</b>" : ""}</div></li>`).join("")}</ul>` : ""}
        <div class="eyebrow">Аудит диалога</div>
        <ul class="hist">${events.map(x => `<li><span>${dt(x.at)}</span><div>${x.who ? `<em>${esc(x.who)}:</em> ` : ""}${esc(x.text)}</div></li>`).join("") || "<li><span>—</span><div class='muted'>Событий нет</div></li>"}</ul>
      </details>`;

  const back = R === "op" ? "my" : R === "lead" ? "team" : "dialogs";
  el.innerHTML = `${`<div class="qa-dialog-title"><div><a href="#/${back}">${R === "op" ? "Мои оценки" : "Диалоги"} / ${esc(d.id)}</a><h1>${R === "op" ? "Разбор оценки" : "Разбор диалога"}</h1><p>${esc(d.operator)} · ${esc(d.team)} · ${CH[d.channel] || esc(d.channel)} · ${dt(d.occurred_at)}</p></div><div class="qa-total"><strong>${total}${s?.total != null && !running ? " / 100" : ""}</strong><span class="${e?.critical ? "bad" : "muted"}">${e?.critical ? "Грубая ошибка" : grade[1]}</span></div></div>`}<header class="dc-hd">
      <div class="dc-hd-left">
        <a class="btn sm back-link" href="#/${back}" aria-label="Вернуться к списку">Назад</a>
        <b class="dc-id-code">${esc(d.id)}</b>
        ${stPill(d.wf_status)}
        ${e?.critical ? pill("bad", "Грубая ошибка") : ""}
        <span class="dc-meta-line"><b>${esc(d.operator)}</b><span>·</span><span>${esc(d.team)}</span><span>·</span><span>${CH[d.channel] || esc(d.channel)} (${esc(d.language)})</span><span>·</span><span class="mono">${dt(d.occurred_at)}</span></span>
      </div>
      <div class="dc-hd-right">
        ${acts ? `<div class="acts">${acts}</div>` : ""}
      </div>
    </header>
    ${st.notice ? `<div class="flow-result" role="status"><span><b>${esc(st.notice.text)}</b><small>${esc(st.notice.detail || "")}</small></span><a class="btn sm" href="#/${st.notice.href}">${esc(st.notice.label)}</a></div>` : ""}

    <div class="dc-ws">
      <section class="dc-chat" id="chat-pane">
        <div class="pane-h">
          <div class="pane-h-title"><b>${R === "qa" ? "01 / Разговор" : "Разговор"}</b><span class="muted">${tr.length} ${plural(tr.length, "реплика", "реплики", "реплик")}</span></div>
          <div class="seg sm" role="group" aria-label="Фильтр реплик">
            <button type="button" data-cf="all" class="${st.chatFilter === "all" ? "on" : ""}">Все</button>
            <button type="button" data-cf="op" class="${st.chatFilter === "op" ? "on" : ""}">Оператор</button>
            <button type="button" data-cf="ev" class="${st.chatFilter === "ev" ? "on" : ""}">Доказательства</button>
          </div>
        </div>
        ${d.channel === "voice call" ? `<div class="sc-strip info" style="padding:7px 20px"><b>Звонок (ASR):</b> артефакты распознавания речи и маски <code>[Имя скрыто]</code> не штрафуются.${d.audio_url ? ` <a href="${esc(d.audio_url)}" target="_blank" rel="noopener">Аудиозапись</a>` : ""}</div>` : ""}
        ${nCtx && st.chatFilter === "all" ? `<button type="button" class="ctxbar" id="ctx-toggle" aria-expanded="${st.showCtx}" aria-controls="chat"><span>${st.showCtx ? "Скрыть" : "Показать"} контекст с ботом до эскалации (${nCtx} ${plural(nCtx, "реплика", "реплики", "реплик")})</span><span class="muted sm">Не штрафует оператора</span></button>` : ""}
        <div class="chat-wrap" id="chat">${chatRows || `<p class="muted sm" style="padding:20px">Нет реплик под выбранный фильтр.</p>`}</div>
      </section>
      <section class="dc-sc" id="sc"><div class="score-panel-title"><div><b>${R === "qa" ? "02 / Оценка" : "Оценка по критериям"}</b></div><span>${crit.length} пунктов</span></div>${scorePane}</section>
    </div>`;

  // ---------- Обработчики событий ----------
  const CH_ = () => $("#chat-pane", el), SC_ = () => $("#sc", el);
  const redraw = () => {
    const a = CH_()?.scrollTop, b = SC_()?.scrollTop, y = el.scrollTop;
    draw(el, ctx, data, st);
    if (CH_()) CH_().scrollTop = a;
    if (SC_()) SC_().scrollTop = b;
    el.scrollTop = y;
  };
  const reload = () => dialog(el, ctx);

  const inView = (box, node, flashIt) => {
    if (!node) return;
    // Align the beginning, including blocks taller than the viewport.
    let scroller = node.parentElement;
    while (scroller && !( /^(auto|scroll)$/.test(getComputedStyle(scroller).overflowY)
      && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
    if (scroller) {
      const header = box?.querySelector(".pane-h");
      const inset = header && getComputedStyle(header).position === "sticky"
        && scroller === box ? header.offsetHeight + 12 : 12;
      const r = node.getBoundingClientRect(), b = scroller.getBoundingClientRect();
      scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + r.top - b.top - inset), behavior: "smooth" });
    } else {
      node.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    if (flashIt) flash(node);
  };

  const ctxBtn = $("#ctx-toggle", el);
  if (ctxBtn) ctxBtn.onclick = () => { st.showCtx = !st.showCtx; redraw(); };
  $$("[data-cf]", el).forEach(b => b.onclick = () => { st.chatFilter = b.dataset.cf; redraw(); });

  const expBtn = $("#exp-all", el);
  if (expBtn) expBtn.onclick = () => { st.expandAll = !st.expandAll; redraw(); };


  $$("[data-sel]", el).forEach(b => {
    const handler = e => {
      if (e.target.closest("button,input,textarea,a")) return;
      const k = b.dataset.sel;
      if (st.expandAll) { st.expandAll = false; st.sel = k; }
      else { st.sel = st.sel === k ? null : k; }
      st.edit = null;
      redraw();
      const ev = items[k]?.evidence?.[0];
      if (st.sel && ev && matchMedia("(min-width: 1151px)").matches) scrollToTurn(ev, true);
      if (st.sel) inView(SC_(), $("#cr-" + k, el), false);
    };
    b.onclick = handler;
    b.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handler(e); } };
  });

  $$("[data-ev]", el).forEach(b => b.onclick = e => {
    e.stopPropagation();
    scrollToTurn(+b.dataset.ev, true);
  });

  $$("[data-goc]", el).forEach(b => b.onclick = () => {
    const k = b.dataset.goc;
    if (st.sel !== k) { st.sel = k; st.edit = null; redraw(); }
    inView(SC_(), $("#cr-" + k, el), true);
  });

  $$("[data-set]", el).forEach(b => b.onclick = e => {
    e.stopPropagation();
    const c = b.dataset.set;
    if (b.dataset.o === items[c].answer) delete st.draft[c];
    else st.draft[c] = b.dataset.o;
    redraw();
    $("#rs-" + c, el)?.focus({ preventScroll: true });
  });
  $$("[data-rs]", el).forEach(t => t.oninput = () => { st.reason[t.dataset.rs] = t.value; });
  $$("[data-cancel]", el).forEach(b => b.onclick = e => { e.stopPropagation(); delete st.draft[b.dataset.cancel]; st.edit = null; redraw(); });
  $$("[data-apply]", el).forEach(b => b.onclick = e => {
    e.stopPropagation();
    busy(b, async () => {
      const c = b.dataset.apply;
      const r = await api(`/dialogs/${encodeURIComponent(d.id)}/override`, { body: { crit: c, answer: st.draft[c], reason: st.reason[c] || "" } });
      delete st.draft[c]; delete st.reason[c]; st.edit = null;
      toast(`Ответ изменён · Итог: ${fmt(r.total)}`);
      st.notice = {text: "Изменение сохранено", detail: d.wf_status === "review" ? "Проверьте остальные пункты и опубликуйте оценку кнопкой вверху." : "Новый ответ и причина добавлены в историю оценки.", href: "queue", label: "К очереди"};
      ctx.refresh();
      await reload();
    });
  });

  $$("[data-apdec]", el).forEach(b => b.onclick = () => {
    st.apDec[b.dataset.apdec] = b.dataset.v === "1";
    redraw();
  });
  const inlCm = $("#inl-ap-cm", el);
  if (inlCm) inlCm.oninput = () => { st.apComment = inlCm.value; };
  const inlSub = $("#inl-ap-submit", el);
  if (inlSub && openAp) inlSub.onclick = () => busy(inlSub, async () => {
    try {
      const r = await api(`/appeals/${openAp.id}/decide`, { body: { decisions: st.apDec, comment: st.apComment } });
      toast(`Апелляция А-${openAp.id} ${({ accepted: "принята", partial: "принята частично", rejected: "отклонена" })[r.status]}` + (r.before !== r.after ? `: ${fmt(r.before)}  —  ${fmt(r.after)}` : ""));
      st.apDec = {}; st.apComment = "";
      queueIds = null;
      ctx.refresh();
      await reload();
    } catch (x) {
      const er = $("#inl-ap-err", el);
      if (er) { er.textContent = x.message; er.classList.remove("hidden"); }
    }
  });

  const on = (sel, fn) => { const b = $(sel, el); if (b) b.onclick = () => busy(b, fn); };
  on("[data-confirm]", async () => {
    if (Object.keys(st.draft).length) { toast("Сначала сохраните или отмените правку критерия", true); return; }
    const r = await api(`/dialogs/${encodeURIComponent(d.id)}/confirm`, { body: {} });
    queueIds = null;
    ctx.refresh();
    st.notice = {text: "Оценка опубликована", detail: "Оператору отправлено уведомление. Он сможет ознакомиться с результатом или подать апелляцию.", href: r.next ? "dialog/" + encodeURIComponent(r.next) : "queue", label: r.next ? "Следующий диалог" : "К очереди"};
    await reload();
  });
  on("[data-eval]", async () => { await api("/evaluate", { body: { dialog_ids: [d.id], title: "Оценка " + d.id } }); toast("Оценка запущена"); await reload(); });
  on("[data-rescore]", async () => { await api("/evaluate", { body: { dialog_ids: [d.id], title: "Переоценка " + d.id } }); toast("Переоценка запущена"); st.sel = null; await reload(); });
  on("[data-retry]", async () => { await api(`/evaluations/${e.id}/retry`, { body: {} }); toast("Повторяем упавшие критерии"); await reload(); });
  on("[data-ack]", async () => { await api(`/dialogs/${encodeURIComponent(d.id)}/acknowledge`, { body: {} }); st.notice = {text: "Вы ознакомились с оценкой", detail: "При необходимости вы по-прежнему можете запросить пересмотр отдельных пунктов.", href: "my", label: "К моим оценкам"}; ctx.refresh(); await reload(); });
  const startAppeal = $("[data-start-appeal]", el);
  if (startAppeal) startAppeal.onclick = () => {
    if (R === "op") return ctx.go("appeal-new/" + encodeURIComponent(d.id));
    const first = info.find(x => failed(x.c, x.a)) || info[0];
    if (!first) return;
    st.sel = first.c.id; redraw(); inView(SC_(), $("#cr-" + st.sel, el), true);
    toast("Выберите ответ, который считаете верным, затем укажите причину");
  };

  $$("[data-want]", el).forEach(b => b.onclick = ev => {
    ev.stopPropagation();
    const c = b.dataset.want;
    if (R === "op") return ctx.go("appeal-new/" + encodeURIComponent(d.id) + "?crit=" + c + "&want=" + encodeURIComponent(b.dataset.o));
    if (st.draft[c] === b.dataset.o) delete st.draft[c];
    else st.draft[c] = b.dataset.o;
    redraw();
    const f = $("#apform", el);
    if (f && st.draft[c] != null) { inView(SC_(), f, false); $("#aptext", el)?.focus({ preventScroll: true }); }
  });
  const ga = $("[data-goap]", el);
  if (ga) ga.onclick = () => { $("#apform", el)?.scrollIntoView({ block: "center", behavior: "smooth" }); $("#aptext", el)?.focus({ preventScroll: true }); };
  const apt = $("#aptext", el);
  if (apt) apt.oninput = () => { st.apText = apt.value; };
  const apc = $("[data-apclear]", el);
  if (apc) apc.onclick = () => { st.draft = {}; st.apText = ""; st.edit = null; redraw(); };
  on("[data-apsend]", async () => {
    try {
      const r = await api(`/dialogs/${encodeURIComponent(d.id)}/appeal`, { body: { items: Object.entries(st.draft).map(([crit, want]) => ({ crit, want })), text: st.apText } });
      st.draft = {}; st.apText = ""; st.edit = null;
      queueIds = null;
      toast(`Апелляция А-${r.id} отправлена`);
      st.notice = {text: `Апелляция А-${r.id} отправлена`, detail: "QA рассмотрит доводы. Решение появится в ваших апелляциях и уведомлениях.", href: "appeals/" + r.id, label: "Отслеживать решение"};
      ctx.refresh();
      await reload();
    } catch (x) {
      const er = $("#aperr", el);
      if (er) { er.textContent = x.message; er.classList.remove("hidden"); }
      $("#aptext", el)?.focus();
    }
  });
  on("[data-apwd]", async () => {
    await api(`/appeals/${$("[data-apwd]", el).dataset.apwd}/withdraw`, { body: { comment: "Отозвана оператором" } });
    toast("Апелляция отозвана");
    queueIds = null;
    ctx.refresh();
    await reload();
  });

  function flash(m) {
    m.classList.remove("flash");
    void m.offsetWidth;
    m.classList.add("flash");
    setTimeout(() => m.classList.remove("flash"), 1400);
  }
  function scrollToTurn(n, flashIt) {
    if (isPreTurn(n - 1) && !st.showCtx) { st.showCtx = true; redraw(); }
    if (st.chatFilter !== "all" && !$("#m" + n, el)) { st.chatFilter = "all"; redraw(); }
    inView(CH_(), $("#m" + n, el), flashIt);
  }

  if (st.jump) {
    st.jump = false;
    const ev = selX?.it.evidence?.[0], m = ev && $("#m" + ev, el), C = CH_();
    if (m && C && C.scrollHeight > C.clientHeight) {
      C.scrollTop = Math.max(0, m.getBoundingClientRect().top - C.getBoundingClientRect().top - C.clientHeight / 3);
    }
  }
}
