// Чек-листы: версии, редактор черновика, разница с активной версией, пробный прогон, публикация и применение. Плюс «Как меня оценивают».
import { $, $$, api, esc, fmt, money, dt, toast, fail, busy, pill, ansPill, ansLabel, linkify, emptyBox, plural, SECS } from "./ui.js";

const TYPE = { binary: "Да / Нет", scale: "Шкала", flag: "Флаг грубой ошибки" };
const ST = { draft: ["warn", "Черновик"], published: ["ok", "Активна"], archived: ["na", "Архив"] };
const KIND = { added: "Новый критерий — модель оценит его во всех диалогах", removed: "Удалён — его баллы уйдут из итога", weight: "Вес — пересчёт без модели", semantic: "Изменён смысл — модель переоценит только этот критерий", section: "Перенесён в другой раздел" };
const FIELD = { name: "название", rule: "правило", answers: "варианты ответа", type: "тип", na_allowed: "N/A", code: "код" };

export async function checklists(el, ctx) {
  if (ctx.arg) return editor(el, ctx);
  const list = await api("/checklists");
  if (!ctx.alive()) return;
  const R = ctx.me.role, can = ["head", "qa"].includes(R), draft = list.find(c => c.status === "draft");
  el.innerHTML = `<div class="ph"><div><h1>Чек-листы</h1><p>Критерии, веса и правила, по которым модель оценивает диалоги. Активная версия одна; изменения готовятся в черновике, проверяются пробным прогоном и публикуются руководителем QA. Каждая оценка помнит, по какой версии сделана.</p></div>
    ${can ? `<div class="acts">${draft ? `<a class="btn pri" href="#/checklists/${draft.id}">Продолжить черновик v${draft.version}</a>` : `<button class="btn pri" id="nd">Изменить чек-лист</button>`}</div>` : ""}</div>
    <div class="tw"><table class="t"><thead><tr><th>Версия</th><th>Название</th><th class="r">Критериев</th><th>Статус</th><th>Создал</th><th>Опубликовал</th><th>Комментарий</th></tr></thead><tbody>
    ${list.map(c => `<tr class="go" data-cl="${c.id}"><td class="id">v${c.version}</td><td>${esc(c.name)}</td><td class="r num">${c.n}</td><td>${pill(...ST[c.status])}</td><td>${esc(c.created_name || "импорт")}<span class="sub">${dt(c.created_at)}</span></td>
      <td>${c.published_name ? esc(c.published_name) + `<span class="sub">${dt(c.published_at)}</span>` : '<span class="muted">—</span>'}</td><td class="sm muted wrap">${esc(c.note || "")}</td></tr>`).join("")}</tbody></table></div>`;
  $$("[data-cl]", el).forEach(r => r.onclick = () => ctx.go("checklists/" + r.dataset.cl));
  const nd = $("#nd", el);
  if (nd) nd.onclick = () => busy(nd, async () => { const r = await api("/checklists/draft", { body: {} }); ctx.go("checklists/" + r.id); });
}

const ED = {};
async function editor(el, ctx) {
  const id = +ctx.arg;
  const c = await api("/checklists/" + id);
  if (!ctx.alive()) return;
  const R = ctx.me.role, isDraft = c.status === "draft", can = isDraft && ["head", "qa"].includes(R);
  const st = ED[id] || (ED[id] = { crit: structuredClone(c.criteria), dirty: false, open: null, note: c.note || "", trial: null, tsel: new Set(c.diff?.model_crits?.slice(0, 4) || []) });
  if (!st.dirty) st.crit = structuredClone(c.criteria);
  const draw = (srv = c) => {
    const sum = st.crit.filter(x => x.type !== "flag").reduce((s, x) => s + (+x.weight || 0), 0);
    const df = srv.diff;
    let last = -1;
    const rows = st.crit.map((x, i) => {
      const head = ""; // разделы убраны из вида: плоский список проще читать и менять
      const ch = df?.changes.filter(d => d.crit === x.id) || [];
      const open = st.open === x.id;
      return head + `<div class="panel" style="padding:12px 16px;margin-top:0;margin-bottom:8px">
        <div class="row"><span class="num muted" style="width:22px">${x.id.slice(1)}</span><b style="font-weight:500" class="grow">${esc(x.name || "Новый критерий")}</b>
          ${ch.map(d => pill(d.kind === "weight" ? "info" : d.kind === "removed" ? "bad" : "warn", { added: "новый", weight: `вес ${d.before} → ${d.after}`, semantic: "смысл изменён", section: "раздел" }[d.kind] || d.kind)).join("")}
          <span class="sm muted">${TYPE[x.type]}</span>
          ${x.type !== "flag" ? (can ? `<label class="sm muted" style="display:flex;gap:6px;align-items:center">вес <input class="f" type="number" min="1" max="100" data-w="${i}" value="${x.weight}" style="width:64px;height:30px;padding:0 6px" aria-label="Вес критерия ${x.id.slice(1)}"></label>` : `<span class="num">вес ${x.weight}</span>`) : `<span class="sm muted">без баллов</span>`}
          <button class="btn sm" data-open="${x.id}" aria-expanded="${open}">${open ? "Свернуть" : can ? "Правило" : "Подробнее"}</button></div>
        ${open ? `<div style="margin-top:10px">${can ? `<div class="cols" style="grid-template-columns:2fr 1fr;gap:12px">
            <div><label class="l" for="n${i}">Название</label><input class="f" id="n${i}" data-f="name" data-i="${i}" value="${esc(x.name)}"></div>
            <div><label class="l" for="t${i}">Тип ответа</label><select class="f" id="t${i}" data-f="type" data-i="${i}">${Object.entries(TYPE).map(([k, v]) => `<option value="${k}" ${x.type === k ? "selected" : ""}>${v}</option>`).join("")}</select></div></div>
            <details style="margin-top:10px"${x.code ? "" : " open"}><summary class="sm muted" style="cursor:pointer">Дополнительно: код критерия в файле результатов${x.code ? ` · ${esc(x.code)}` : " — заполните"}</summary>
              <div class="cols" style="grid-template-columns:1fr 1fr;gap:12px"><div><label class="l" for="k${i}">Код (латиница, уникальный)</label><input class="f" id="k${i}" data-f="code" data-i="${i}" value="${esc(x.code)}" placeholder="greeting"></div>
              <div><label class="l" for="s${i}">Раздел отчёта</label><select class="f" id="s${i}" data-f="sec" data-i="${i}">${SECS.map((v, k) => `<option value="${k}" ${x.sec === k ? "selected" : ""}>${v}</option>`).join("")}</select></div></div></details>
            ${x.type === "scale" ? `<label class="l" for="a${i}">Ступени шкалы через запятую</label><input class="f" id="a${i}" data-f="answers" data-i="${i}" value="${x.answers.filter(a => /^\d+$/.test(a)).join(", ")}" style="max-width:240px">` : ""}
            ${x.type !== "flag" ? `<label class="chk" style="margin-top:12px"><input type="checkbox" data-f="na_allowed" data-i="${i}" ${x.na_allowed ? "checked" : ""}> Допускается N/A — критерий может быть неприменим, его вес перераспределится</label>` : ""}
            <label class="l" for="r${i}">Правило для модели и для оператора</label><textarea class="f" id="r${i}" data-f="rule" data-i="${i}" rows="5" placeholder="Когда Да, когда Нет, когда N/A. Модель видит ровно этот текст">${esc(x.rule)}</textarea>
            ${x.conditions ? `<p class="sm muted" style="margin-top:6px">У критерия есть дерево условий (${Object.keys(x.conditions).length} вопроса модели, ответ выводит код). Оно сохраняется, пока правило не переписано.</p>` : ""}
            <div class="row" style="margin-top:10px"><span class="grow"></span><button class="btn sm danger" data-del="${i}">Удалить критерий</button></div>`
          : `<p class="fg2" style="max-width:80ch">${esc(x.rule)}</p><div class="kv sm" style="margin-top:8px"><span>Ответы</span><b>${x.answers.filter(a => a !== "na").map(a => ansLabel(x, a)).join(" · ")}</b>${x.type !== "flag" ? `<span>N/A</span><b>${x.na_allowed ? "допускается — вес перераспределится" : "нет"}</b>` : ""}</div>`}
          ${ch.filter(d => d.kind === "semantic").map(d => `<div class="diff" style="margin-top:10px">${d.fields.map(f => `<div class="w"><b>${FIELD[f] || f}</b></div><div class="m">− ${esc(fmtV(d.before[f]))}</div><div class="p">+ ${esc(fmtV(d.after[f]))}</div>`).join("")}</div>`).join("")}
        </div>` : ""}</div>`;
    }).join("");
    const errs = srv.errors || [];
    el.innerHTML = `<div class="ph"><div><h1>«${esc(c.name)}» v${c.version} ${pill(...ST[c.status])}</h1><p>${isDraft ? `Черновик на основе активной v${df?.base_version}. Модель и операторы его не видят, пока руководитель QA не опубликует.` : c.status === "published" ? `Активная версия. Опубликована ${dt(c.published_at)}${c.published_by ? "" : ""}. Изменения — через черновик.` : "Архивная версия: по ней сделаны старые оценки, они хранятся с этой версией."}</p></div>
      <div class="acts">${c.status === "published" && ["head", "qa"].includes(R) && c.stale ? `<button class="btn" id="apply">Применить к старым оценкам (${c.stale})</button>` : ""}${can ? `<button class="btn danger" id="drop">Удалить черновик</button>` : ""}</div></div>
      <div class="cols ww"><div>
        ${can ? `<div class="row" style="margin-bottom:4px"><span class="${sum === 100 ? "fg2" : ""}" style="${sum === 100 ? "" : "color:var(--bad);font-weight:500"}">Сумма весов: <b class="num">${sum}</b> из 100</span><span class="grow"></span><button class="btn sm" id="addc">Добавить критерий</button>${st.dirty ? `<button class="btn pri sm" id="save">Сохранить изменения</button>` : `<span class="sm muted">Сохранено</span>`}</div>` : ""}
        ${rows}</div>
      <div style="position:sticky;top:0;align-self:start">
        ${isDraft ? `<div class="panel"><h3>Что изменится</h3>${st.dirty ? `<p class="note warn" style="margin-top:8px">Есть несохранённые правки — сохраните, чтобы увидеть точную разницу.</p>` : ""}
          ${df && df.changes.length ? `<ul style="margin:10px 0 0;padding-left:18px;display:grid;gap:6px" class="sm">${df.changes.map(d => `<li><b>${d.crit.slice(1)}. ${esc(d.name)}</b> — ${KIND[d.kind]}${d.kind === "weight" ? `: ${d.before} → ${d.after}` : ""}${d.kind === "semantic" ? ` (${d.fields.map(f => FIELD[f] || f).join(", ")})` : ""}</li>`).join("")}</ul>
            <div class="box" style="margin-top:12px"><div class="h">Стоимость применения к ${df.dialogs} оценённым диалогам</div><div class="sm">${df.model_crits.length ? `Модель вызовется только для критериев ${df.model_crits.map(x => x.slice(1)).join(", ")}: ${df.calls} ${plural(df.calls, "запрос", "запроса", "запросов")}, около ${money(df.cost, 2)}. Остальные ответы переиспользуются.` : "Ни одного вызова модели: меняются только веса, итоги пересчитаются мгновенно."}</div></div>`
            : `<p class="sm muted" style="margin-top:8px">Пока черновик совпадает с активной версией. Поменяйте вес, правило или добавьте критерий.</p>`}
          ${errs.length ? `<div class="note bad" style="margin-top:12px"><b>Перед публикацией исправьте:</b><ul style="margin:6px 0 0;padding-left:18px">${errs.map(e => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
        </div>` : ""}
        ${can && df?.model_crits.length ? `<div class="panel"><h3>Пробный прогон</h3><p class="sm muted" style="margin-top:4px">Изменённые критерии на 3 случайных оценённых диалогах — до 12 запросов, около $0,03. В оценки не сохраняется.</p>
          <div class="chips" style="margin-top:10px">${df.model_crits.map(x => `<label class="chk sm"><input type="checkbox" data-ts="${x}" ${st.tsel.has(x) ? "checked" : ""}> ${x.slice(1)}</label>`).join("")}</div>
          <div class="row" style="margin-top:10px"><button class="btn" id="trial" ${st.tsel.size && st.tsel.size <= 4 && !st.dirty ? "" : "disabled"}>Проверить на диалогах</button>${st.tsel.size > 4 ? `<span class="sm" style="color:var(--bad)">не больше 4 критериев</span>` : ""}</div>
          ${st.trial ? trialTable(st.trial, st.crit) : ""}</div>` : ""}
        ${isDraft ? `<div class="panel"><label class="l" for="note" style="margin-top:0">Комментарий к версии</label><textarea class="f" id="note" rows="2" placeholder="Например: уточнили правило решения вопроса" ${can ? "" : "disabled"}>${esc(st.note)}</textarea>
          ${R === "head" ? `<button class="btn pri" id="pub" style="margin-top:12px" ${errs.length || st.dirty || !df?.changes.length ? "disabled" : ""}>Опубликовать v${c.version}</button><p class="sm muted" style="margin-top:6px">После публикации новые диалоги оцениваются по v${c.version}. Старые оценки остаются по своей версии, пока вы их не примените.</p>`
            : `<p class="sm muted" style="margin-top:10px">Публикует руководитель QA. Сохраните черновик — он увидит его в списке версий.</p>`}</div>` : ""}
      </div></div>`;
    bind(srv);
  };
  const bind = srv => {
    $$("[data-open]", el).forEach(b => b.onclick = () => { st.open = st.open === b.dataset.open ? null : b.dataset.open; draw(srv); });
    const mark = () => { if (!st.dirty) { st.dirty = true; draw(srv); } };
    $$("[data-w]", el).forEach(inp => inp.oninput = () => { st.crit[+inp.dataset.w].weight = +inp.value || 0; const keep = document.activeElement === inp; const pos = inp.selectionStart; st.dirty = true; draw(srv); if (keep) { const n = $(`[data-w="${inp.dataset.w}"]`, el); n.focus(); try { n.setSelectionRange(pos, pos); } catch {} } });
    $$("[data-f]", el).forEach(inp => {
      const i = +inp.dataset.i, f = inp.dataset.f, x = st.crit[i];
      const ev = inp.tagName === "SELECT" || inp.type === "checkbox" ? "onchange" : "oninput";
      inp[ev] = () => {
        if (f === "na_allowed") x.na_allowed = inp.checked;
        else if (f === "sec") x.sec = +inp.value;
        else if (f === "type") { x.type = inp.value; if (x.type === "flag") { x.weight = 0; x.na_allowed = false; } x.answers = x.type === "scale" ? ["10", "5", "0"] : ["yes", "no"]; if (x.type !== "flag" && !x.weight) x.weight = 5; st.dirty = true; return draw(srv); }
        else if (f === "answers") x.answers = inp.value.split(/[,\s]+/).filter(a => /^\d+$/.test(a));
        else x[f] = inp.value;
        if (inp.type === "checkbox") { st.dirty = true; return draw(srv); }
        if (!st.dirty) { st.dirty = true; const id_ = inp.id, pos = inp.selectionStart; draw(srv); const n = $("#" + id_, el); n?.focus(); try { n.setSelectionRange(pos, pos); } catch {} }
      };
    });
    $$("[data-del]", el).forEach(b => b.onclick = () => { const x = st.crit[+b.dataset.del]; st.crit.splice(+b.dataset.del, 1); st.dirty = true; st.open = null; toast(`Критерий «${x.name}» убран из черновика. Сохраните, чтобы применить`); draw(srv); });
    const add = $("#addc", el);
    if (add) add.onclick = () => {
      const n = Math.max(...st.crit.map(x => +x.id.slice(1))) + 1, fl = st.crit.findIndex(x => x.type === "flag");
      const nc = { id: "c" + n, code: "", name: "", answers: ["yes", "no"], weight: 5, rule: "", type: "binary", na_allowed: true, sec: 2 };
      if (fl >= 0) st.crit.splice(fl, 0, nc); else st.crit.push(nc);
      st.open = nc.id; st.dirty = true; draw(srv); $(`#n${st.crit.indexOf(nc)}`, el)?.focus();
    };
    const sv = $("#save", el);
    if (sv) sv.onclick = () => busy(sv, async () => { const r = await api("/checklists/" + id, { method: "PUT", body: { criteria: st.crit, note: st.note } }); st.crit = structuredClone(r.criteria); st.dirty = false; st.trial = null; st.tsel = new Set((r.diff?.model_crits || []).slice(0, 4)); toast(r.errors.length ? "Сохранено. Есть что исправить перед публикацией" : "Черновик сохранён"); draw(r); });
    const nt = $("#note", el); if (nt) nt.oninput = () => { st.note = nt.value; };
    $$("[data-ts]", el).forEach(cb => cb.onchange = () => { cb.checked ? st.tsel.add(cb.dataset.ts) : st.tsel.delete(cb.dataset.ts); draw(srv); });
    const tr = $("#trial", el);
    if (tr) tr.onclick = () => busy(tr, async () => { const crits = [...st.tsel]; const r = await api(`/checklists/${id}/trial`, { body: { crits, dialog_ids: await pickDialogs(Math.floor(12 / crits.length)) } }); st.trial = r; draw(srv); });
    const pub = $("#pub", el);
    if (pub) pub.onclick = () => busy(pub, async () => {
      await api(`/checklists/${id}/publish`, { body: { note: st.note } });
      delete ED[id]; toast(`v${c.version} опубликована. Новые диалоги оцениваются по ней`); ctx.refresh(); await editor(el, ctx);
    });
    const ap = $("#apply", el);
    if (ap) ap.onclick = () => busy(ap, async () => { const r = await api(`/checklists/${id}/apply`, { body: {} }); ctx.go("jobs/" + r.job.id); });
    const dr = $("#drop", el);
    if (dr) dr.onclick = () => {
      if (dr.dataset.sure) return busy(dr, async () => { await api("/checklists/" + id, { method: "DELETE" }); delete ED[id]; toast("Черновик удалён"); ctx.go("checklists"); });
      dr.dataset.sure = "1"; dr.textContent = "Точно удалить? Нажмите ещё раз"; setTimeout(() => { if (dr.isConnected) { delete dr.dataset.sure; dr.textContent = "Удалить черновик"; } }, 4000);
    };
  };
  draw();
}
async function pickDialogs(n) {
  const list = await api("/dialogs?status=published");
  const pool = list.length >= n ? list : await api("/dialogs");
  return pool.filter(d => d.eval_id).sort(() => Math.random() - .5).slice(0, Math.max(1, Math.min(3, n))).map(d => d.id);
}
const fmtV = v => Array.isArray(v) ? v.join(", ") : v === true ? "да" : v === false ? "нет" : String(v ?? "—");
function trialTable(t, crit) {
  const C = Object.fromEntries(crit.map(x => [x.id, x]));
  return `<div class="tw" style="margin-top:12px"><table class="t"><thead><tr><th>Диалог</th><th>Крит.</th><th>Было</th><th>Стало</th></tr></thead><tbody>${t.results.map(r => `<tr><td class="id"><a href="#/dialog/${esc(r.dialog)}">${esc(r.dialog)}</a></td><td>${r.crit.slice(1)}</td><td>${r.before != null ? ansPill(C[r.crit], r.before) : '<span class="muted">—</span>'}</td>
    <td>${r.error ? pill("bad", "Сбой") : ansPill(C[r.crit], r.answer)}${r.confidence != null ? `<span class="sub">уверенность ${Math.round(r.confidence * 100)}%</span>` : ""}</td></tr>
    <tr><td colspan="4" class="sm muted" style="padding-top:0">${esc(r.error || (r.explanation || "").replace(/\[(\d+)\]/g, "#$1"))}</td></tr>`).join("")}</tbody></table></div><p class="sm muted" style="margin-top:6px">Стоимость прогона: ${money(t.cost, 4)}</p>`;
}

// ======================= как меня оценивают =======================
export async function rules(el, ctx) {
  const list = await api("/checklists");
  const a = list.find(c => c.status === "published");
  const c = await api("/checklists/" + a.id);
  if (!ctx.alive()) return;
  let last = -1;
  const flag = c.criteria.find(x => x.type === "flag");
  el.innerHTML = `<div class="ph"><div><h1>Как оценивается работа</h1><p>Чек-лист «${esc(c.name)}» v${c.version}, действует с ${dt(c.published_at || c.created_at)}. Модель проверяет каждый критерий отдельно и обязана сослаться на реплику диалога. Спорные оценки проверяет QA-специалист до того, как вы их увидите.</p></div></div>
   <div class="cols ww"><div>${c.criteria.map(x => { const h = x.sec !== last ? `<h2 style="margin:${last < 0 ? 0 : 24}px 0 10px">${SECS[x.sec] ?? ""}</h2>` : ""; last = x.sec;
     return h + `<div class="panel" style="margin-top:0;margin-bottom:8px"><div class="row"><b style="font-weight:500" class="grow">${x.id.slice(1)}. ${esc(x.name)}</b>${x.type === "flag" ? pill("bad", "Грубая ошибка · без баллов") : `<span class="num">${x.weight} ${plural(x.weight, "балл", "балла", "баллов")}</span>`}</div>
       <p class="fg2 sm" style="margin-top:6px;max-width:80ch">${esc(x.rule)}</p><div class="sm muted" style="margin-top:6px">Ответы: ${x.answers.map(o => ansLabel(x, o)).join(" · ")}</div></div>`; }).join("")}</div>
   <div style="position:sticky;top:0;align-self:start"><div class="panel"><h3>Как считается итог</h3><ul class="sm fg2" style="margin:10px 0 0;padding-left:18px;display:grid;gap:8px">
     <li>Сумма весов критериев — 100 баллов. «Да» даёт полный вес, «Нет» — ноль, шкала — пропорционально ступени.</li>
     <li>N/A — критерий неприменим к диалогу (например, не нужно было смотреть счёт). Его вес не теряется: он перераспределяется на остальные критерии.</li>
     <li>Бот и реплики до перевода на оператора не оцениваются — это контекст.</li>
     ${flag ? `<li>«${esc(flag.name)}» — отдельный флаг. Балл не обнуляет, но такой диалог обязательно проверит QA и разберёт комплаенс.</li>` : ""}
     <li>Итог округляется до сотых.</li></ul></div>
     <div class="panel"><h3>Если не согласны</h3><p class="sm fg2" style="margin-top:8px">Откройте диалог, разверните критерий и выберите ответ, который считаете верным. Опишите довод со ссылкой на реплику — например, «#12: я назвал срок». QA решает по каждому критерию, балл пересчитается автоматически, а прежняя версия оценки сохранится в истории.</p></div></div></div>`;
}
