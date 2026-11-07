// Чек-листы: версии, редактор черновика, разница с активной версией, пробный прогон, публикация и применение. Плюс «Стандарты оценки».
import { $, $$, api, esc, fmt, money, dt, toast, fail, busy, pill, ansPill, ansLabel, emptyBox, plural, SECS } from "./ui.js";

const TYPE = { binary: "Да / Нет", scale: "Шкала", flag: "Флаг риска" };
const ST = { draft: ["warn", "Черновик"], published: ["ok", "Активна"], archived: ["na", "Архив"] };
const KIND = { added: "Новый критерий — модель оценит его во всех диалогах", removed: "Удалён — его баллы уйдут из итога", weight: "Вес — пересчёт без вызова модели", semantic: "Изменён смысл — модель переоценит только этот критерий", section: "Перенесён в другой раздел" };
const FIELD = { name: "название", rule: "правило", answers: "варианты ответа", type: "тип", na_allowed: "N/A", code: "код" };

export async function checklists(el, ctx) {
  if (ctx.arg) return editor(el, ctx);
  const list = await api("/checklists");
  if (!ctx.alive()) return;
  const R = ctx.me.role, can = ["qa"].includes(R), draft = list.find(c => c.status === "draft");
  const active = ["qa"].includes(R) && list.find(c => c.status === "published");
  const current = active ? await api("/checklists/" + active.id) : null;
  if (!ctx.alive()) return;
  el.innerHTML = `<div class="ph"><div><h1>Чек-листы</h1></div>
    ${can ? `<div class="acts">${draft ? `<a class="btn pri" href="#/checklists/${draft.id}">Открыть черновик v${draft.version}</a>` : `<button class="btn pri" id="nd">Создать черновик</button>`}</div>` : ""}</div>
    ${current ? `<div class="qa-checklist-label"><span><b>${esc(current.name)}</b></span><a href="#/checklists/${current.id}">v${current.version} · действующая</a></div><div class="tw"><table class="t"><thead><tr><th>№</th><th>Критерий</th><th class="r">Вес, %</th></tr></thead><tbody>${current.criteria.map((x,i)=>`<tr><td>${String(i+1).padStart(2,"0")}</td><td><a href="#/checklists/${current.id}" aria-label="Посмотреть правило: ${esc(x.name)}">${esc(x.name)}</a></td><td class="r">${x.type === "flag" ? "Контроль риска" : fmt(x.weight)}</td></tr>`).join("")}</tbody></table></div><div class="qa-checklist-label"><span>Суммарный вес: ${fmt(current.criteria.filter(x=>x.type!=="flag").reduce((a,x)=>a+Number(x.weight),0))}%</span></div><h2 class="sec-hd">Версии чек-листа</h2>` : ""}
    <div class="tw"><table class="t"><thead><tr><th>Версия</th><th>Название</th><th class="r">Критериев</th><th>Статус</th><th>Автор</th><th>Опубликован</th><th>Комментарий</th></tr></thead><tbody>
    ${list.map(c => `<tr class="go" data-cl="${c.id}"><td class="id">v${c.version}</td><td><b>${esc(c.name)}</b></td><td class="r num">${c.n}</td><td>${pill(...ST[c.status])}</td><td>${esc(c.created_name || "система")}<span class="sub">${dt(c.created_at)}</span></td>
      <td>${c.published_name ? esc(c.published_name) + `<span class="sub">${dt(c.published_at)}</span>` : '<span class="muted">—</span>'}</td><td class="sm muted wrap">${esc(c.note || "—")}</td></tr>`).join("")}</tbody></table></div>`;
  $$("[data-cl]", el).forEach(r => r.onclick = () => ctx.go("checklists/" + r.dataset.cl));
  const nd = $("#nd", el);
  if (nd) nd.onclick = () => busy(nd, async () => { const r = await api("/checklists/draft", { body: {} }); ctx.go("checklists/" + r.id); });
}

const ED = {};
async function editor(el, ctx) {
  const id = +ctx.arg;
  const c = await api("/checklists/" + id);
  if (!ctx.alive()) return;
  const R = ctx.me.role, isDraft = c.status === "draft", can = isDraft && ["qa"].includes(R);
  const st = ED[id] || (ED[id] = { crit: structuredClone(c.criteria), dirty: false, open: null, note: c.note || "", trial: null, tsel: new Set(c.diff?.model_crits?.slice(0, 4) || []) });
  if (!st.dirty) st.crit = structuredClone(c.criteria);
  const draw = (srv = c) => {
    const sum = st.crit.filter(x => x.type !== "flag").reduce((s, x) => s + (+x.weight || 0), 0);
    const df = srv.diff;
    let last = -1;
    const rows = st.crit.map((x, i) => {
      const secIdx = x.type === "flag" ? 3 : (x.sec ?? 2);
      const head = secIdx !== last ? `<div class="ox-sec"><span>${esc(SECS[secIdx] || "")}</span><span class="ox-sg">${secIdx === 3 ? "Контроль рисков · без веса" : `Сумма секции: ${st.crit.filter(k => (k.type === "flag" ? 3 : (k.sec ?? 2)) === secIdx && k.type !== "flag").reduce((a, b) => a + (+b.weight || 0), 0)} б.`}</span></div>` : "";
      last = secIdx;
      const ch = df?.changes.filter(d => d.crit === x.id) || [];
      const open = st.open === x.id;
      return head + `<div class="cl-item ${open ? "open" : ""}">
        <div class="cl-row">
          <span class="num muted" style="width:24px">${String(x.id.slice(1)).padStart(2, "0")}</span>
          <b class="grow" style="font-weight:500;cursor:pointer" data-open="${x.id}">${esc(x.name || "Новый критерий")}</b>
          ${ch.map(d => pill(d.kind === "weight" ? "info" : d.kind === "removed" ? "bad" : "warn", { added: "новый", weight: `вес ${d.before}  —  ${d.after}`, semantic: "правило изм.", section: "раздел" }[d.kind] || d.kind)).join("")}
          <span class="sm muted">${TYPE[x.type]}</span>
          ${x.type !== "flag" ? (can ? `<label class="sm muted" style="display:inline-flex;gap:6px;align-items:center">Вес <input class="f sm mono" type="number" min="1" max="100" data-w="${i}" value="${x.weight}" style="width:58px;text-align:right" aria-label="Вес критерия ${x.id.slice(1)}"></label>` : `<span class="num sm">вес ${x.weight}</span>`) : `<span class="sm muted">флаг</span>`}
          <button class="btn sm" data-open="${x.id}" aria-expanded="${open}">${open ? "Свернуть" : can ? "Изменить" : "Правило"}</button>
        </div>
        ${!open ? `<div class="cl-preview muted sm">${esc((x.rule || "").slice(0, 140))}${(x.rule || "").length > 140 ? "…" : ""}</div>` : ""}
        ${open ? `<div class="cl-body">${can ? `<div class="cols" style="grid-template-columns:2fr 1fr;gap:12px;border:0;padding:0">
            <div><label class="l" for="n${i}" style="margin-top:0">Название критерия</label><input class="f" id="n${i}" data-f="name" data-i="${i}" value="${esc(x.name)}"></div>
            <div><label class="l" for="t${i}" style="margin-top:0">Тип ответа</label><select class="f" id="t${i}" data-f="type" data-i="${i}">${Object.entries(TYPE).map(([k, v]) => `<option value="${k}" ${x.type === k ? "selected" : ""}>${v}</option>`).join("")}</select></div></div>
            <div class="cols" style="grid-template-columns:1fr 1fr;gap:12px;border:0;padding:0;margin-top:8px">
              <div><label class="l" for="k${i}" style="margin-top:0">Код экспорта (латиница)</label><input class="f mono" id="k${i}" data-f="code" data-i="${i}" value="${esc(x.code)}" placeholder="greeting"></div>
              <div><label class="l" for="s${i}" style="margin-top:0">Секция чек-листа</label><select class="f" id="s${i}" data-f="sec" data-i="${i}">${SECS.map((v, k) => `<option value="${k}" ${x.sec === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
            </div>
            ${x.type === "scale" ? `<label class="l" for="a${i}">Ступени шкалы через запятую</label><input class="f mono" id="a${i}" data-f="answers" data-i="${i}" value="${x.answers.filter(a => /^\d+$/.test(a)).join(", ")}" style="max-width:220px">` : ""}
            ${x.type !== "flag" ? `<label class="chk" style="margin-top:10px"><input type="checkbox" data-f="na_allowed" data-i="${i}" ${x.na_allowed ? "checked" : ""}> Разрешить N/A (неприменимый вес перераспределяется пропорционально)</label>` : ""}
            <label class="l" for="r${i}">Правило оценки и условия применения</label><textarea class="f" id="r${i}" data-f="rule" data-i="${i}" rows="4" placeholder="Чёткое условие для Да / Нет / N/A">${esc(x.rule)}</textarea>
            <div class="row" style="margin-top:10px"><span class="grow"></span><button class="btn sm danger" data-del="${i}">Удалить критерий</button></div>`
          : `<p class="fg2 sm" style="line-height:1.55">${esc(x.rule)}</p><div class="sm muted" style="margin-top:6px">Допустимые ответы: <b>${x.answers.filter(a => a !== "na").map(a => ansLabel(x, a)).join(" · ")}</b>${x.type !== "flag" ? ` · N/A: <b>${x.na_allowed ? "разрешён (вес перераспределяется)" : "нет"}</b>` : ""}</div>`}
          ${ch.filter(d => d.kind === "semantic").map(d => `<div class="diff" style="margin-top:10px">${d.fields.map(f => `<div class="w"><b>Изменено поле: ${FIELD[f] || f}</b></div><div class="m">− ${esc(fmtV(d.before[f]))}</div><div class="p">+ ${esc(fmtV(d.after[f]))}</div>`).join("")}</div>`).join("")}
        </div>` : ""}</div>`;
    }).join("");
    const errs = srv.errors || [];
    el.innerHTML = `<div class="ph"><div><h1>«${esc(c.name)}» · v${c.version} ${pill(...ST[c.status])}</h1><p>${isDraft ? `Черновик на базе активной v${df?.base_version}. Изменения вступят в силу после публикации.` : c.status === "published" ? `Новые оценки используют эту версию. ${c.stale ? `У ${c.stale} диалогов осталась прежняя версия — нажмите «Пересчитать старые диалоги», чтобы обновить их.` : "Сохранённые оценки актуальны."}` : "Архивная версия стандарта."}</p></div>
      <div class="acts">${c.status === "published" && ["qa"].includes(R) && c.stale ? `<button class="btn" id="apply">Пересчитать старые диалоги (${c.stale})</button>` : ""}${can ? `<button class="btn danger" id="drop">Удалить черновик</button>` : ""}</div></div>
      <div class="cols ww flush-cols">
        <div class="col-pane" style="padding:0">
          ${can ? `<div class="cl-toolbar"><span class="${sum === 100 ? "fg2" : ""}" style="${sum === 100 ? "" : "color:var(--bad);font-weight:600"}">Сумма весов (п.1–7): <b class="num">${sum}</b> / 100</span><div class="acts"><button class="btn sm" id="addc">Добавить критерий</button>${st.dirty ? `<button class="btn pri sm" id="save">Сохранить черновик</button>` : `<span class="sm muted">Сохранено</span>`}</div></div>` : ""}
          <div class="cl-list">${rows}</div>
        </div>
        <div class="col-pane">
          ${isDraft ? `<div class="sec"><h2>Что изменится</h2>${st.dirty ? `<p class="note warn" style="margin-top:8px">Сохраните черновик для расчёта стоимости переоценки.</p>` : ""}
            ${df && df.changes.length ? `<ul style="margin:8px 0 0;padding-left:18px;display:grid;gap:6px" class="sm">${df.changes.map(d => `<li><b>#${d.crit.slice(1)} ${esc(d.name)}</b> — ${KIND[d.kind]}${d.kind === "weight" ? ` (${d.before}  —  ${d.after})` : ""}${d.kind === "semantic" ? ` (${d.fields.map(f => FIELD[f] || f).join(", ")})` : ""}</li>`).join("")}</ul>
              <div class="box" style="margin-top:12px"><div class="h">Оценка влияния на ${df.dialogs} диалогов</div><div class="sm">${df.model_crits.length ? `Переоценка ИИ потребуется только для п.${df.model_crits.map(x => x.slice(1)).join(", ")}: <b>${df.calls} ${plural(df.calls, "запрос", "запроса", "запросов")} (${money(df.cost, 2)})</b>. Остальные критерии переиспользуются из кеша.` : "<b>0 вызовов LLM ($0,00)</b> — меняются только веса, все оценки пересчитаются мгновенно."}</div></div>`
              : `<p class="sm muted" style="margin-top:6px">Отличий от активной версии пока нет.</p>`}
            ${errs.length ? `<div class="note bad" style="margin-top:12px"><b>Исправьте ошибки перед публикацией:</b><ul style="margin:4px 0 0;padding-left:18px">${errs.map(e => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
          </div>` : `<div class="sec"><h2>О версии v${c.version}</h2><p class="sm fg2">Комментарий: ${esc(c.note || "Без комментария")}</p></div>`}
          ${can && df?.model_crits.length ? `<div class="sec" style="border-top:1px solid var(--line);padding-top:16px"><h2>Тестовый прогон (Dry Run)</h2><p class="sm muted">Проверка изменённых правил на 3 случайных диалогах перед публикацией (~$0,03).</p>
            <div class="chips" style="margin-top:8px">${df.model_crits.map(x => `<label class="chk sm"><input type="checkbox" data-ts="${x}" ${st.tsel.has(x) ? "checked" : ""}> Критерий #${x.slice(1)}</label>`).join("")}</div>
            <div class="row" style="margin-top:10px"><button class="btn sm" id="trial" ${st.tsel.size && st.tsel.size <= 4 && !st.dirty ? "" : "disabled"}>Запустить тест на 3 диалогах</button>${st.tsel.size > 4 ? `<span class="sm" style="color:var(--bad)">Максимум 4 критерия</span>` : ""}</div>
            ${st.trial ? trialTable(st.trial, st.crit) : ""}</div>` : ""}
          ${isDraft ? `<div class="sec" style="border-top:1px solid var(--line);padding-top:16px"><label class="l" for="note" style="margin-top:0">Комментарий к релизу</label><textarea class="f sm" id="note" rows="2" placeholder="Причина изменения весов или правил…" ${can ? "" : "disabled"}>${esc(st.note)}</textarea>
            ${R === "qa" ? `<button class="btn pri" id="pub" style="margin-top:10px;width:100%;justify-content:center" ${errs.length || st.dirty || !df?.changes.length ? "disabled" : ""}>Опубликовать стандарт v${c.version}</button>`
              : `<p class="sm muted" style="margin-top:8px">Опубликовать черновик может QA-специалист.</p>`}</div>` : ""}
        </div>
      </div>`;
    bind(srv);
  };
  const bind = srv => {
    $$("[data-open]", el).forEach(b => b.onclick = () => { st.open = st.open === b.dataset.open ? null : b.dataset.open; draw(srv); });
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
    $$("[data-del]", el).forEach(b => b.onclick = () => { const x = st.crit[+b.dataset.del]; st.crit.splice(+b.dataset.del, 1); st.dirty = true; st.open = null; toast(`Критерий «${x.name}» удалён из черновика`); draw(srv); });
    const add = $("#addc", el);
    if (add) add.onclick = () => {
      const n = Math.max(...st.crit.map(x => +x.id.slice(1))) + 1, fl = st.crit.findIndex(x => x.type === "flag");
      const nc = { id: "c" + n, code: "", name: "", answers: ["yes", "no"], weight: 5, rule: "", type: "binary", na_allowed: true, sec: 2 };
      if (fl >= 0) st.crit.splice(fl, 0, nc); else st.crit.push(nc);
      st.open = nc.id; st.dirty = true; draw(srv); $(`#n${st.crit.indexOf(nc)}`, el)?.focus();
    };
    const sv = $("#save", el);
    if (sv) sv.onclick = () => busy(sv, async () => { const r = await api("/checklists/" + id, { method: "PUT", body: { criteria: st.crit, note: st.note } }); st.crit = structuredClone(r.criteria); st.dirty = false; st.trial = null; st.tsel = new Set((r.diff?.model_crits || []).slice(0, 4)); toast(r.errors.length ? "Сохранено с предупреждениями" : "Черновик сохранён"); draw(r); });
    const nt = $("#note", el); if (nt) nt.oninput = () => { st.note = nt.value; };
    $$("[data-ts]", el).forEach(cb => cb.onchange = () => { cb.checked ? st.tsel.add(cb.dataset.ts) : st.tsel.delete(cb.dataset.ts); draw(srv); });
    const tr = $("#trial", el);
    if (tr) tr.onclick = () => busy(tr, async () => { const crits = [...st.tsel]; const r = await api(`/checklists/${id}/trial`, { body: { crits, dialog_ids: await pickDialogs(Math.floor(12 / crits.length)) } }); st.trial = r; draw(srv); });
    const pub = $("#pub", el);
    if (pub) pub.onclick = () => busy(pub, async () => {
      await api(`/checklists/${id}/publish`, { body: { note: st.note } });
      delete ED[id]; toast(`Стандарт v${c.version} опубликован`); ctx.refresh(); await editor(el, ctx);
    });
    const ap = $("#apply", el);
    if (ap) ap.onclick = () => busy(ap, async () => { const r = await api(`/checklists/${id}/apply`, { body: {} }); ctx.go("jobs/" + r.job.id); });
    const dr = $("#drop", el);
    if (dr) dr.onclick = () => {
      if (dr.dataset.sure) return busy(dr, async () => { await api("/checklists/" + id, { method: "DELETE" }); delete ED[id]; toast("Черновик удалён"); ctx.go("checklists"); });
      dr.dataset.sure = "1"; dr.textContent = "Подтвердить удаление?"; setTimeout(() => { if (dr.isConnected) { delete dr.dataset.sure; dr.textContent = "Удалить черновик"; } }, 4000);
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
  return `<div class="tw" style="margin-top:12px;border:1px solid var(--line)"><table class="t"><thead><tr><th>Диалог</th><th>Крит.</th><th>Было</th><th>Стало</th></tr></thead><tbody>${t.results.map(r => `<tr><td class="id"><a href="#/dialog/${esc(r.dialog)}">${esc(r.dialog)}</a></td><td>#${r.crit.slice(1)}</td><td>${r.before != null ? ansPill(C[r.crit], r.before) : '<span class="muted">—</span>'}</td>
    <td>${r.error ? pill("bad", "Сбой") : ansPill(C[r.crit], r.answer)}${r.confidence != null ? `<span class="sub">${Math.round(r.confidence * 100)}%</span>` : ""}</td></tr>
    <tr><td colspan="4" class="sm muted" style="padding-top:0">${esc(r.error || (r.explanation || "").replace(/\[(\d+)\]/g, "#$1"))}</td></tr>`).join("")}</tbody></table></div><p class="sm muted" style="margin-top:6px">Стоимость теста: ${money(t.cost, 4)}</p>`;
}

// ======================= стандарты оценки =======================
export async function rules(el, ctx) {
  const list = await api("/checklists");
  const a = list.find(c => c.status === "published");
  const c = await api("/checklists/" + a.id);
  if (!ctx.alive()) return;
  let last = -1;
  const flag = c.criteria.find(x => x.type === "flag");
  el.innerHTML = `<div class="ph"><div><h1>Стандарты оценки</h1><p>Активный чек-лист «${esc(c.name)}» v${c.version} от ${dt(c.published_at || c.created_at)}. Каждый ответ ИИ обязан ссылаться на конкретную реплику диалога.</p></div></div>
   <div class="cols ww flush-cols">
     <div class="col-pane" style="padding:0">
       <div class="cl-list">
         ${c.criteria.map(x => {
           const secIdx = x.type === "flag" ? 3 : (x.sec ?? 0);
           const h = secIdx !== last ? `<div class="ox-sec"><span>${SECS[secIdx] ?? ""}</span></div>` : "";
           last = secIdx;
           return h + `<div class="cl-item">
             <div class="cl-row">
               <span class="num muted" style="width:24px">${String(x.id.slice(1)).padStart(2, "0")}</span>
               <b class="grow" style="font-weight:600">${esc(x.name)}</b>
               ${x.type === "flag" ? pill("bad", "Флаг риска · без веса") : `<span class="num sm">Вес ${x.weight}%</span>`}
             </div>
             <div class="cl-preview fg2 sm" style="white-space:normal;line-height:1.5">${esc(x.rule)}</div>
             <div class="cl-preview muted sm" style="padding-top:2px">Варианты оценки: ${x.answers.map(o => ansLabel(x, o)).join(" · ")}</div>
           </div>`;
         }).join("")}
       </div>
     </div>
     <div class="col-pane">
       <div class="sec">
         <h2>Правила расчёта балла</h2>
         <ul class="sm fg2" style="margin:10px 0 0;padding-left:18px;display:grid;gap:8px;line-height:1.5">
           <li>Сумма весов критериев 1–7 равна <b>100 баллам</b>.</li>
           <li>При ответе <b>N/A</b> критерий исключается из знаменателя, а его вес пропорционально распределяется между применимыми критериями (<code>k = 100 / W_app</code>).</li>
           <li>Реплики бота и IVR до перевода на оператора служат контекстом и не штрафуют оператора.</li>
           ${flag ? `<li><b>«${esc(flag.name)}» (п.8)</b> — отдельный флаг комплаенс-риска. Он <b>не обнуляет</b> арифметический балл диалога, но направляет обращение на проверку.</li>` : ""}
         </ul>
       </div>
       <div class="sec" style="border-top:1px solid var(--line);padding-top:16px">
         <h2>Порядок апелляции</h2>
         <p class="sm fg2" style="margin-top:6px;line-height:1.5">Откройте диалог, кликните по спорному критерию, укажите верный вариант ответа и сошлитесь на номер реплики (например, <code>#12</code>). После решения QA балл пересчитается автоматически.</p>
       </div>
     </div>
   </div>`;
}
