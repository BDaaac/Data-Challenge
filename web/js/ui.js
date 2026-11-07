// Общие помощники интерфейса: запросы к API, форматирование, статусы, уведомления.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- API ----------
export class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
export async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body !== undefined ? "POST" : "GET"), headers: {}, credentials: "same-origin" };
  if (opts.body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  let r;
  try { r = await fetch("/api" + path, init); }
  catch { throw new ApiError("Нет связи с сервером. Проверьте, что он запущен, и повторите.", 0); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith("/auth/")) { window.dispatchEvent(new CustomEvent("cqa:logout", { detail: data.error })); }
  if (!r.ok) throw new ApiError(data.error || `Ошибка ${r.status}`, r.status);
  return data;
}

// ---------- формат ----------
export const fmt = n => n == null ? "—" : Number(n).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmt0 = n => n == null ? "—" : Number(n).toLocaleString("ru-RU", { maximumFractionDigits: 0 });
export const money = (n, d = 4) => "$" + Number(n || 0).toFixed(d).replace(".", ",");
export const scls = n => n == null ? "" : n >= 85 ? "hi" : n >= 65 ? "mid" : "lo";
export const dt = s => { if (!s) return "—"; const d = new Date(s); return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); };
export const ago = s => { const m = Math.round((Date.now() - new Date(s)) / 60000); return m < 1 ? "только что" : m < 60 ? `${m} мин назад` : m < 1440 ? `${Math.round(m / 60)} ч назад` : dt(s); };
export const initials = n => String(n || "?").split(/\s+/).map(x => x[0]).join("").slice(0, 2).toUpperCase();
export const plural = (n, a, b, c) => { const m = Math.abs(n) % 100, k = m % 10; return m > 10 && m < 20 ? c : k > 1 && k < 5 ? b : k === 1 ? a : c; };

export const LANG = { RU: "Русский", KZ: "Казахский", EN: "Английский" };
export const CH = { "agent chat": "Чат", "voice call": "Звонок" };
export const SECS = ["Начало и понимание запроса", "Безопасность и решение", "Ведение и завершение", "Грубые нарушения"];
export const ROLE = { qa: "QA-специалист", op: "Оператор", lead: "Руководитель группы", head: "Руководитель QA", dir: "Директор", comp: "Комплаенс", adm: "Администратор" };
export const ST = {
  new: ["na", "Не оценён"], evaluating: ["info", "Оценивается"], error: ["bad", "Оценка неполная"], review: ["warn", "Ждёт проверки"],
  published: ["acc", "Опубликовано"], acknowledged: ["na", "Ознакомлен"], appeal: ["info", "Апелляция"], revised: ["ok", "Пересмотрено"]
};
export const REASON = { critical: ["bad", "Грубая ошибка"], error: ["bad", "Сбой оценки"], invalid: ["warn", "Недопустимый ответ"], no_evidence: ["warn", "Нет доказательства"], low_conf: ["warn", "Модель сомневается"], sample: ["na", "Случайная выборка"] };
export const AP_ST = { open: ["info", "На рассмотрении"], accepted: ["ok", "Принята"], partial: ["warn", "Принята частично"], rejected: ["na", "Отклонена"], withdrawn: ["na", "Отозвана"] };
export const VIOL = { new: ["bad", "Новое"], work: ["warn", "В работе"], closed: ["ok", "Закрыто"] };
export const TRIGGER = { import: "Оценка моделью", initial: "Оценка моделью", rescore: "Переоценка", recalc: "Пересчёт весов", override: "Правка QA", appeal: "Решение по апелляции" };

export const pill = (cls, text, extra = "") => `<span class="pill ${cls} ${extra}">${extra.includes("pulse") ? '<span class="dot"></span>' : ""}${esc(text)}</span>`;
export const stPill = s => pill(ST[s][0] + (s === "evaluating" ? " pulse" : ""), ST[s][1], s === "evaluating" ? "pulse" : "");
// Короткие названия критериев для меток «почему здесь»: имя понятнее, чем номер
const SHORT = { contact: "контакт", discovery: "потребность", identification: "идентификация", consultation: "консультация", empathy: "эмпатия", dialogue: "ведение диалога", closure: "завершение", critical: "грубая ошибка" };
let CRIT_NAMES = {};
export function setCritNames(criteria) { CRIT_NAMES = Object.fromEntries((criteria || []).map(c => [c.id, SHORT[c.code] || c.name])); }
const critName = id => CRIT_NAMES[id] || "критерий " + id.slice(1);
export const reasonPills = rv => (rv || []).map(r => pill(REASON[r.code][0], REASON[r.code][1] + (r.crits?.length && r.code !== "critical" ? ": " + r.crits.map(critName).join(", ") : ""))).join(" ");

export const smax = c => Math.max(...c.answers.filter(a => /^\d+$/.test(a)).map(Number));
export function ansLabel(c, a) {
  if (a == null) return "нет ответа"; if (a === "na") return "N/A";
  if (c.type === "flag") return a === "yes" ? "Есть" : "Нет";
  if (/^\d+$/.test(a)) return `${a} из ${smax(c)}`;
  return a === "yes" ? "Да" : "Нет";
}
export const optLabel = (c, o) => o === "na" ? "N/A" : o === "yes" ? (c.type === "flag" ? "Есть" : "Да") : o === "no" ? "Нет" : o;
export function ansPill(c, a) {
  if (a == null) return pill("na", "Нет ответа"); if (a === "na") return pill("na", "N/A");
  if (c.type === "flag") return a === "yes" ? pill("bad", "Грубая ошибка") : pill("ok", "Нет");
  if (/^\d+$/.test(a)) { const v = +a, m = smax(c); return pill(v === m ? "ok" : v === 0 ? "bad" : "warn", `${v} из ${m}`); }
  return a === "yes" ? pill("ok", "Да") : pill("bad", "Нет");
}
export const failed = (c, a) => a != null && a !== "na" && (c.type === "flag" ? a === "yes" : c.type === "scale" ? +a < smax(c) : a === "no");
export const linkify = t => esc(t).replace(/\[(\d+)(?:\s*[-–]\s*(\d+))?\]/g, (m, a, b) => b ? `<button class="evc" data-ev="${a}">#${a}–${b}</button>` : `<button class="evc" data-ev="${a}">#${a}</button>`);

// ---------- уведомления ----------
export function toast(t, bad = false) {
  const e = $("#toast"); e.textContent = t; e.classList.toggle("bad", bad); e.classList.add("show");
  clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove("show"), bad ? 5200 : 3000);
}
export const fail = e => toast(e.message || String(e), true);

// Кнопка в состоянии загрузки на время асинхронного действия
export async function busy(btn, fn) {
  if (!btn || btn.disabled) return;
  const html = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin"></span>${html}`;
  try { return await fn(); } catch (e) { fail(e); } finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = html; } }
}

export const emptyBox = (title, text, acts = "") => `<div class="tw"><div class="empty"><h3>${title}</h3><p>${text}</p>${acts ? `<div class="acts">${acts}</div>` : ""}</div></div>`;
export const errorBox = e => `<div class="note bad">${esc(e.message || e)} <button class="btn sm" onclick="location.reload()">Обновить страницу</button></div>`;

export function dialogTable(list, o = {}) {
  if (!list.length) return emptyBox(o.emptyT || "Ничего не найдено", o.emptyP || "Измените фильтры.", o.emptyActs);
  return `<div class="tw"><table class="t"><thead><tr>${o.check ? '<th><input type="checkbox" data-all aria-label="Выбрать все"></th>' : ""}<th>Диалог</th>${o.reason ? "<th>Почему здесь</th>" : ""}<th>Оператор</th><th>Канал · язык</th><th class="r">Балл</th><th>Флаг</th><th>Статус</th><th>Дата</th></tr></thead><tbody>
  ${list.map(d => `<tr class="go" data-open="${esc(d.id)}">${o.check ? `<td><input type="checkbox" data-pick="${esc(d.id)}" aria-label="Выбрать ${esc(d.id)}" ${d.wf_status === "evaluating" ? "disabled" : ""}></td>` : ""}<td class="id">${esc(d.id)}${d.cl_version && o.active && d.cl_version !== o.active ? `<span class="sub">по v${d.cl_version}</span>` : ""}</td>
    ${o.reason ? `<td><div class="chips">${d.wf_status === "appeal" ? pill("info", "Апелляция") : ""}${reasonPills(d.review)}</div></td>` : ""}
    <td>${esc(d.operator)}<span class="sub">${esc(d.team)}</span></td><td>${CH[d.channel] || esc(d.channel)} · ${esc(d.language)}</td>
    <td class="r">${d.total != null ? `<span class="score ${scls(d.total)}">${fmt(d.total)}</span>` : '<span class="muted">—</span>'}</td>
    <td>${d.critical ? pill("bad", "Грубая ошибка") : '<span class="muted">—</span>'}</td>
    <td>${stPill(d.wf_status)}</td><td class="muted num" style="white-space:nowrap">${dt(d.occurred_at)}</td></tr>`).join("")}</tbody></table></div>`;
}
export function bindOpen(el, go) {
  $$("[data-open]", el).forEach(r => r.addEventListener("click", e => { if (e.target.closest("input,button,a")) return; go("dialog/" + r.dataset.open); }));
}
