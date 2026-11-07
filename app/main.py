"""HTTP API и раздача интерфейса.  Запуск: python -m uvicorn app.main:app --port 8000"""
import csv, io, json, re, uuid
from contextlib import asynccontextmanager
from typing import Optional

from . import compat  # noqa: F401  до fastapi

from fastapi import Body, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import auth, engine
from .auth import COOKIE, current_user, roles
from .db import ROOT, J, all_, init_schema, one, run, tx
from .seed import TEAMS, operator_name

@asynccontextmanager
async def lifespan(_app):
    startup()
    yield


app = FastAPI(title="CQA Freedom", docs_url="/api/docs", openapi_url="/api/openapi.json", lifespan=lifespan)
WEB = ROOT / "web"
STAFF_ALL = ("qa", "head", "lead", "dir", "comp", "adm")
REVIEWERS = ("qa", "head")
SPEAKERS = {"клиент": "client", "client": "client", "customer": "client", "клиент:": "client", "оператор": "operator",
            "operator": "operator", "agent": "operator", "агент": "operator", "бот": "bot", "bot": "bot", "aim": "bot",
            "система": "system", "system": "system"}


def startup():
    init_schema()
    # оценки, прерванные падением сервера: недосчитанные критерии помечаем ошибкой, «Повторить» перезапустит только их
    for e in all_("SELECT id FROM evaluations WHERE status='running'"):
        run("UPDATE eval_items SET status='error', error='Оценка прервана перезапуском сервера' WHERE eval_id=%s AND status='pending'", e["id"])
        engine.finalize(e["id"])
        engine.after_evaluation(e["id"])


@app.exception_handler(HTTPException)
def http_err(request, exc):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


@app.exception_handler(Exception)
def any_err(request, exc):
    import traceback; traceback.print_exc()
    return JSONResponse({"error": "Внутренняя ошибка сервера. Действие не выполнено, данные не изменены."}, status_code=500)


def bad(msg, code=400):
    raise HTTPException(code, msg)


# ======================= авторизация =======================
@app.post("/api/auth/login")
def login(response: Response, body: dict = Body(...)):
    lg, pw = str(body.get("login", "")).strip().lower(), str(body.get("password", ""))
    if auth.locked(lg):
        bad("Слишком много попыток. Вход заблокирован на 10 минут.", 429)
    u = one("SELECT * FROM users WHERE lower(login)=%s", lg)
    if not u or not auth.check_pw(pw, u["pw_hash"]):
        auth.fail(lg)
        bad("Неверный логин или пароль", 401)
    if not u["active"]:
        bad("Учётная запись заблокирована. Обратитесь к администратору.", 403)
    return _start(response, u)


def _start(response, u):
    tok = auth.create_session(u["id"])
    response.set_cookie(COOKIE, tok, httponly=True, samesite="lax", max_age=12 * 3600)
    engine.audit(u["id"], "Вход в систему")
    return {"ok": True}


@app.get("/api/auth/demo")
def demo_users():
    if not auth.DEMO:
        return {"enabled": False, "users": []}
    # Для оператора берём того, у кого есть опубликованная неидеальная оценка — на ней жюри покажет апелляцию
    rows = all_("""SELECT DISTINCT ON (role) id, name, role, team FROM users WHERE active
                   ORDER BY role,
                     (SELECT count(*) FROM dialogs d JOIN evaluations e ON e.dialog_id=d.id AND e.is_current
                       WHERE d.operator=users.name AND d.wf_status IN ('published','acknowledged','revised') AND e.total < 100) DESC,
                     (SELECT count(*) FROM dialogs d WHERE d.operator=users.name
                       AND d.wf_status IN ('published','acknowledged','revised','appeal')) DESC, id""")
    return {"enabled": True, "users": rows}


@app.post("/api/auth/demo/{uid}")
def demo_login(uid: int, response: Response):
    if not auth.DEMO:
        bad("Демо-доступ выключен", 403)
    u = one("SELECT * FROM users WHERE id=%s AND active", uid)
    if not u:
        bad("Пользователь не найден", 404)
    return _start(response, u)


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    tok = request.cookies.get(COOKIE)
    if tok:
        run("DELETE FROM sessions WHERE token=%s", tok)
    response.delete_cookie(COOKIE)
    return {"ok": True}


@app.get("/api/auth/me")
def me(u=Depends(current_user)):
    n = one("SELECT count(*) AS n FROM notifications WHERE user_id=%s AND NOT read", u["id"])["n"]
    cl = engine.active_checklist()
    return {**{k: u[k] for k in ("id", "login", "name", "role", "team")}, "unread": n, "demo": auth.DEMO,
            "checklist": {"id": cl["id"], "version": cl["version"], "name": cl["name"]}, "model": engine.setting("model"),
            "counts": counts(u)}


def counts(u):
    w, a = vis(u)
    r = one(f"""SELECT count(*) FILTER (WHERE d.wf_status IN ('review','appeal','error')) AS queue,
                       count(*) FILTER (WHERE e.critical AND d.viol_status<>'closed') AS violations,
                       count(*) FILTER (WHERE d.wf_status='published') AS unread
                FROM dialogs d LEFT JOIN evaluations e ON e.dialog_id=d.id AND e.is_current WHERE {w}""", *a)
    ap = one(f"SELECT count(*) AS n FROM appeals ap JOIN dialogs d ON d.id=ap.dialog_id WHERE ap.status='open' AND {w}", *a)["n"]
    return {**r, "appeals": ap}


def vis(u, alias="d"):
    """Ограничение строк по роли: оператор — свои диалоги, руководитель группы — своя группа."""
    if u["role"] == "op":
        return f"{alias}.operator=%s", [u["name"]]
    if u["role"] == "lead":
        return f"{alias}.team=%s", [u["team"]]
    return "true", []


def visible_dialog(u, did):
    w, a = vis(u)
    d = one(f"SELECT d.* FROM dialogs d WHERE d.id=%s AND {w}", did, *a)
    if not d:
        bad("Диалог не найден или недоступен для вашей роли", 404)
    return d


# ======================= диалоги =======================
LIST_SQL = """SELECT d.id, d.channel, d.language, d.operator, d.team, d.wf_status, d.viol_status, d.occurred_at, d.source,
       jsonb_array_length(d.transcript) AS turns,
       e.id AS eval_id, e.total, e.critical, e.review, e.status AS eval_status, e.created_at AS evaluated_at, c.version AS cl_version
FROM dialogs d LEFT JOIN evaluations e ON e.dialog_id=d.id AND e.is_current LEFT JOIN checklists c ON c.id=e.checklist_id"""


@app.get("/api/dialogs")
def list_dialogs(q: str = "", status: str = "", lang: str = "", channel: str = "", critical: bool = False,
                 failed: str = "", operator: str = "", team: str = "", reason: str = "", u=Depends(current_user)):
    w, a = vis(u)
    cond, args = [w], list(a)
    if q:
        cond.append("(d.id ILIKE %s OR d.operator ILIKE %s)"); args += [f"%{q}%", f"%{q}%"]
    if status:
        cond.append("d.wf_status=%s"); args.append(status)
    if lang:
        cond.append("d.language=%s"); args.append(lang)
    if channel:
        cond.append("d.channel=%s"); args.append(channel)
    if critical:
        cond.append("e.critical")
    if operator:
        cond.append("d.operator=%s"); args.append(operator)
    if team:
        cond.append("d.team=%s"); args.append(team)
    if reason:
        cond.append("e.review @> %s::jsonb"); args.append(json.dumps([{"code": reason}]))
    if u["role"] == "op":
        cond.append("d.wf_status NOT IN ('new','evaluating','review','error')")
    rows = all_(LIST_SQL + " WHERE " + " AND ".join(cond) + " ORDER BY d.occurred_at DESC", *args)
    if failed:
        cl = {c["id"]: c for c in engine.active_checklist()["criteria"]}
        if failed in cl:
            ids = [r["eval_id"] for r in rows if r["eval_id"]]
            bad_ids = set()
            if ids:
                for it in all_("SELECT eval_id, answer FROM eval_items WHERE crit_id=%s AND eval_id = ANY(%s)", failed, ids):
                    if engine.is_failed(cl[failed], it["answer"]):
                        bad_ids.add(it["eval_id"])
            rows = [r for r in rows if r["eval_id"] in bad_ids]
    return rows


@app.get("/api/queue")
def queue(u=Depends(roles(*REVIEWERS))):
    rows = all_(LIST_SQL + " WHERE d.wf_status IN ('review','appeal','error')")
    rank = lambda r: (0 if r["critical"] else 1 if r["wf_status"] == "appeal" else 2 if r["wf_status"] == "error" else 3, r["occurred_at"])
    return sorted(rows, key=rank)


@app.get("/api/dialogs/{did}")
def dialog(did: str, u=Depends(current_user)):
    d = visible_dialog(u, did)
    e = engine.current_eval(did)
    out = {"dialog": d, "evaluation": None, "events": [], "appeals": [], "history": []}
    out["events"] = all_("SELECT ev.at, ev.text, us.name AS who FROM events ev LEFT JOIN users us ON us.id=ev.user_id WHERE dialog_id=%s ORDER BY ev.at DESC, ev.id DESC", did)
    out["appeals"] = all_("""SELECT ap.*, o.name AS operator_name, dcd.name AS decided_name FROM appeals ap
                             JOIN users o ON o.id=ap.operator_id LEFT JOIN users dcd ON dcd.id=ap.decided_by
                             WHERE dialog_id=%s ORDER BY ap.created_at DESC""", did)
    out["history"] = all_("""SELECT e.id, e.trigger, e.total, e.created_at, e.calls, e.cost, e.model, c.version, us.name AS who
                             FROM evaluations e JOIN checklists c ON c.id=e.checklist_id LEFT JOIN users us ON us.id=e.created_by
                             WHERE dialog_id=%s ORDER BY e.id DESC""", did)
    if e and not (u["role"] == "op" and d["wf_status"] in ("review", "evaluating", "error", "new")):
        out["evaluation"] = eval_view(e, u)
    if u["role"] in REVIEWERS:
        out["gold"] = {r["crit_id"]: r["answer"] for r in all_("SELECT * FROM gold WHERE dialog_id=%s", did)}
    out["active_version"] = engine.active_checklist()["version"]
    return out


def eval_view(e, u=None):
    cl = engine.checklist(e["checklist_id"])
    items = engine.items_of(e["id"])
    names = {r["id"]: r["name"] for r in all_("SELECT id, name FROM users")}
    ans = {k: v["answer"] for k, v in items.items() if v["status"] == "ok"}
    ai = {k: v["ai_answer"] for k, v in items.items() if v["status"] == "ok"}
    s, s_ai = engine.score(cl["criteria"], ans), engine.score(cl["criteria"], ai)
    secs = []
    for si in range(3):
        cs = [c for c in cl["criteria"] if c.get("sec") == si and c["type"] != "flag" and c["id"] in s["pts"]]
        secs.append({"got": sum(s["pts"][c["id"]] for c in cs), "max": sum(s["max"][c["id"]] for c in cs)} if cs else None)
    for it in items.values():
        it["override_name"] = names.get(it["override_by"])
    return {**e, "checklist": {"id": cl["id"], "version": cl["version"], "name": cl["name"], "criteria": cl["criteria"]},
            "items": items, "score": s, "ai_total": s_ai["total"], "sections": secs}


@app.get("/api/evaluations/{eid}")
def evaluation(eid: int, u=Depends(current_user)):
    e = one("SELECT * FROM evaluations WHERE id=%s", eid) or bad("Оценка не найдена", 404)
    visible_dialog(u, e["dialog_id"])
    return eval_view(e, u)


# ---------- загрузка ----------
def parse_text(text):
    out, errs = [], []
    for i, line in enumerate(text.splitlines(), 1):
        s = line.strip()
        if not s:
            continue
        m = re.match(r"^(?:\[?(\d{1,2}:\d{2})\]?\s*)?([^:]{2,24}):\s*(.+)$", s)
        sp = SPEAKERS.get(m.group(2).strip().lower()) if m else None
        if not m:
            errs.append(f"Строка {i}: не указан говорящий. Начните строку с «Клиент:» или «Оператор:»")
            continue
        if not sp:
            errs.append(f"Строка {i}: неизвестный говорящий «{m.group(2).strip()}». Допустимо: Клиент, Оператор, Бот, Система")
            continue
        ts = m.group(1) or f"{len(out) // 2:02d}:{(len(out) * 17) % 60:02d}"
        out.append({"timestamp": ts, "speaker": sp, "text": m.group(3).strip()})
    return out, errs


def detect_lang(t):
    return "KZ" if re.search(r"[әғқңөұүһі]", t, re.I) else "RU" if re.search(r"[а-яё]", t, re.I) else "EN"


def check_record(r, n):
    errs = []
    tr = r.get("transcript")
    if not isinstance(tr, list) or not tr:
        return [f"Диалог {n}: нет реплик (transcript)"]
    for j, t in enumerate(tr, 1):
        if not isinstance(t, dict) or not str(t.get("text", "")).strip():
            errs.append(f"Диалог {n}, реплика {j}: пустой текст")
        elif t.get("speaker") not in ("client", "operator", "bot", "system"):
            errs.append(f"Диалог {n}, реплика {j}: speaker должен быть client, operator, bot или system")
    if not errs and not any(t["speaker"] == "operator" for t in tr):
        errs.append(f"Диалог {n}: нет реплик оператора — оценивать нечего")
    return errs


@app.post("/api/dialogs")
def upload(body: dict = Body(...), u=Depends(roles("qa", "head", "adm"))):
    """Загрузка: {records:[...]} в формате выгрузки, либо {text, channel?, language?}."""
    if body.get("text") is not None:
        tr, errs = parse_text(body["text"])
        if errs:
            bad("; ".join(errs[:5]), 422)
        recs = [{"conversation_id": body.get("id") or f"new-{uuid.uuid4().hex[:6]}", "channel": body.get("channel") or "agent chat",
                 "language": body.get("language") or detect_lang(" ".join(t["text"] for t in tr)), "transcript": tr}]
        src = "text"
    else:
        sys_path_scripts()
        from submission import load_records
        recs = load_records(body)
        src = "upload"
    if not recs:
        bad("В файле не найдено ни одного диалога: нужны объекты с conversation_id и transcript", 422)
    errs = [e for i, r in enumerate(recs, 1) for e in check_record(r, r.get("conversation_id") or i)]
    if errs:
        bad("; ".join(errs[:6]) + (f" и ещё {len(errs) - 6}" if len(errs) > 6 else ""), 422)
    # Тот же ID с другим текстом — ошибка, а не тихое переименование: иначе результат не сопоставится с ID при сдаче
    clash = [str(r["conversation_id"]) for r in recs if r.get("conversation_id")
             and (ex := one("SELECT transcript FROM dialogs WHERE id=%s", str(r["conversation_id"]))) and ex["transcript"] != r["transcript"]]
    if clash:
        bad("Диалог с таким ID уже есть, но с другим текстом: " + ", ".join(clash[:5]) + ". Дайте новый ID или удалите старый диалог", 409)
    added, skipped = [], []
    for r in recs:
        did = str(r.get("conversation_id") or f"new-{uuid.uuid4().hex[:6]}")
        ex = one("SELECT transcript FROM dialogs WHERE id=%s", did)
        if ex:
            skipped.append(did)
            continue
        name = operator_name(r, len(added))
        op = one("SELECT * FROM users WHERE role='op' AND name=%s", name)
        team = op["team"] if op else TEAMS[len(added) % len(TEAMS)]
        if not op:
            n = one("SELECT count(*) AS n FROM users WHERE role='op'")["n"] + 1
            run("INSERT INTO users(login,name,role,team,pw_hash) VALUES (%s,%s,'op',%s,%s)", f"op{n}", name, team,
                auth.hash_pw(auth.secrets.token_hex(8)))
        run("""INSERT INTO dialogs(id,channel,language,transcript,audio_url,operator,team,source) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
            did, r.get("channel") or "agent chat", (r.get("language") or "RU").upper(), J(r["transcript"]), r.get("audio_url"), name, team, src)
        engine.event(did, u["id"], f"Загружен ({'ввод текстом' if src == 'text' else 'файл'})")
        added.append(did)
    engine.audit(u["id"], f"Загрузил диалоги: {len(added)}", ", ".join(added[:20]))
    job = None
    if added and body.get("evaluate", True):
        job = engine.start_job(f"Оценка {len(added)} новых диалогов", "evaluate", added, u["id"])
    return {"added": added, "skipped": skipped, "job": job}


@app.post("/api/evaluate")
def evaluate(body: dict = Body(...), u=Depends(roles("qa", "head", "adm"))):
    ids = [i for i in body.get("dialog_ids", []) if one("SELECT 1 AS x FROM dialogs WHERE id=%s", i)]
    if not ids:
        bad("Не выбрано ни одного диалога", 422)
    engine.audit(u["id"], f"Запустил оценку: {len(ids)}", ", ".join(ids[:20]))
    return {"job": engine.start_job(body.get("title") or f"Оценка {len(ids)} диалогов", "evaluate", ids, u["id"])}


@app.get("/api/jobs")
def jobs(u=Depends(roles("qa", "head", "adm"))):
    return all_("SELECT j.*, us.name AS who FROM jobs j LEFT JOIN users us ON us.id=j.created_by ORDER BY id DESC LIMIT 30")


@app.get("/api/jobs/{jid}")
def job(jid: int, u=Depends(roles("qa", "head", "adm"))):
    j = one("SELECT * FROM jobs WHERE id=%s", jid) or bad("Пакет не найден", 404)
    rows = all_("""SELECT e.id, e.dialog_id, e.status, e.total, e.critical, e.review, e.calls, e.cost, e.seconds, e.trigger, d.wf_status,
                     (SELECT jsonb_agg(jsonb_build_object('crit', crit_id, 'status', status, 'source', source, 'low', flags ? 'low_conf') ORDER BY crit_id)
                        FROM eval_items WHERE eval_id=e.id) AS items
                   FROM evaluations e JOIN dialogs d ON d.id=e.dialog_id WHERE e.job_id=%s ORDER BY e.id""", jid)
    return {**j, "evaluations": rows}


@app.post("/api/evaluations/{eid}/retry")
def retry(eid: int, u=Depends(roles(*REVIEWERS))):
    e = one("SELECT * FROM evaluations WHERE id=%s", eid) or bad("Оценка не найдена", 404)
    if e["status"] != "partial":
        bad("Повторять нечего: все критерии оценены", 409)
    engine.retry_failed(eid, u["id"])
    engine.audit(u["id"], "Повторил оценку упавших критериев", e["dialog_id"])
    return {"ok": True}


# ---------- решения QA ----------
@app.post("/api/dialogs/{did}/override")
def override(did: str, body: dict = Body(...), u=Depends(roles(*REVIEWERS))):
    d = visible_dialog(u, did)
    e = engine.current_eval(did) or bad("Диалог ещё не оценён", 409)
    if e["status"] == "running":
        bad("Оценка ещё идёт. Дождитесь завершения", 409)
    cl = engine.checklist(e["checklist_id"])
    c = next((x for x in cl["criteria"] if x["id"] == body.get("crit")), None) or bad("Нет такого критерия", 422)
    ans, reason = str(body.get("answer")), str(body.get("reason", "")).strip()
    if ans not in c["answers"]:
        bad(f"Недопустимый ответ. Возможны: {', '.join(c['answers'])}", 422)
    if len(reason) < 5:
        bad("Укажите причину изменения: она попадёт в историю и в отчёт о расхождениях с моделью", 422)
    old = engine.items_of(e["id"])[c["id"]]["answer"]
    eid = engine.override(did, c["id"], ans, reason, u["id"])
    new = one("SELECT total FROM evaluations WHERE id=%s", eid)["total"]
    engine.event(did, u["id"], f"Критерий {c['id'][1:]} «{c['name']}»: {lbl(c, old)} → {lbl(c, ans)}. {reason}")
    engine.audit(u["id"], f"Изменил ответ по критерию {c['id'][1:]}", did, {"from": old, "to": ans, "reason": reason})
    if d["wf_status"] in ("published", "acknowledged", "revised"):
        engine.notify(f"Оценка {did} изменена QA: {fmt(e['total'])} → {fmt(new)}", f"dialog/{did}", user_ids=[engine.operator_user(d["operator"])])
    return {"total": new}


def fmt(v):
    return "—" if v is None else f"{float(v):.2f}".replace(".", ",")


def lbl(c, a):
    if a is None:
        return "нет ответа"
    if a == "na":
        return "N/A"
    if c["type"] == "flag":
        return "есть" if a == "yes" else "нет"
    if a.isdigit():
        return f"{a} из {engine.scale_max(c)}"
    return "Да" if a == "yes" else "Нет"


@app.post("/api/dialogs/{did}/confirm")
def confirm(did: str, u=Depends(roles(*REVIEWERS))):
    d = visible_dialog(u, did)
    e = engine.current_eval(did) or bad("Диалог ещё не оценён", 409)
    if d["wf_status"] not in ("review",):
        bad("Подтверждать нечего: оценка не ждёт проверки", 409)
    run("UPDATE dialogs SET wf_status='published' WHERE id=%s", did)
    engine.event(did, u["id"], "Оценка проверена и опубликована оператору")
    engine.audit(u["id"], "Подтвердил оценку", did, {"total": float(e["total"]) if e["total"] is not None else None})
    engine.notify(f"Новая оценка {did}: {fmt(e['total'])}", f"dialog/{did}", user_ids=[engine.operator_user(d["operator"])])
    if e["critical"]:
        engine.notify(f"Подтверждена грубая ошибка: {did} ({d['operator']})", f"dialog/{did}", roles=("comp", "lead"), team=d["team"])
    nxt = one("SELECT id FROM dialogs WHERE wf_status='review' AND id<>%s ORDER BY occurred_at LIMIT 1", did)
    return {"next": nxt["id"] if nxt else None}


# ---------- оператор и апелляции ----------
@app.post("/api/dialogs/{did}/acknowledge")
def acknowledge(did: str, u=Depends(roles("op"))):
    d = visible_dialog(u, did)
    if d["wf_status"] != "published":
        bad("Ознакомиться можно только с новой опубликованной оценкой", 409)
    run("UPDATE dialogs SET wf_status='acknowledged' WHERE id=%s", did)
    engine.event(did, u["id"], "Оператор ознакомился с оценкой")
    engine.audit(u["id"], "Ознакомился с оценкой", did)
    return {"ok": True}


@app.post("/api/dialogs/{did}/appeal")
def appeal(did: str, body: dict = Body(...), u=Depends(roles("op"))):
    d = visible_dialog(u, did)
    if d["wf_status"] not in ("published", "acknowledged", "revised"):
        bad("Апелляцию можно подать на опубликованную оценку, по которой нет открытой апелляции", 409)
    e = engine.current_eval(did)
    cl = {c["id"]: c for c in engine.checklist(e["checklist_id"])["criteria"]}
    items = engine.items_of(e["id"])
    want = body.get("items") or []
    text = str(body.get("text", "")).strip()
    if not want:
        bad("Выберите хотя бы один критерий и ответ, который считаете верным", 422)
    if len(text) < 10:
        bad("Опишите довод: без него QA не сможет рассмотреть апелляцию", 422)
    out = []
    for w in want:
        c = cl.get(w.get("crit")) or bad("Нет такого критерия", 422)
        if w.get("want") not in c["answers"] or w["want"] == items[c["id"]]["answer"]:
            bad(f"Критерий {c['id'][1:]}: выберите ответ, отличный от текущего", 422)
        out.append({"crit": c["id"], "from": items[c["id"]]["answer"], "want": w["want"]})
    a = run("""INSERT INTO appeals(dialog_id,eval_id,operator_id,text,items,score_before) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id""",
            did, e["id"], u["id"], text, J(out), e["total"])["id"]
    run("UPDATE dialogs SET wf_status='appeal' WHERE id=%s", did)
    crits = ", ".join(x["crit"][1:] for x in out)
    engine.event(did, u["id"], f"Апелляция А-{a} по критериям {crits}: «{text}»")
    engine.audit(u["id"], f"Подал апелляцию А-{a}", did, {"items": out})
    engine.notify(f"Апелляция А-{a} от {u['name']} по {did}", f"appeals/{a}", roles=("qa",))
    engine.notify(f"Апелляция А-{a} в вашей группе: {u['name']}", f"appeals/{a}", roles=("lead",), team=d["team"])
    return {"id": a}


@app.get("/api/appeals")
def appeals(status: str = "", u=Depends(current_user)):
    w, a = vis(u)
    cond = [w] + (["ap.status=%s"] if status else [])
    return all_(f"""SELECT ap.*, o.name AS operator_name, dcd.name AS decided_name, d.team, e.total AS current_total
                    FROM appeals ap JOIN dialogs d ON d.id=ap.dialog_id JOIN users o ON o.id=ap.operator_id
                    LEFT JOIN users dcd ON dcd.id=ap.decided_by LEFT JOIN evaluations e ON e.dialog_id=d.id AND e.is_current
                    WHERE {' AND '.join(cond)} ORDER BY (ap.status='open') DESC, ap.created_at DESC""", *a, *([status] if status else []))


@app.get("/api/appeals/{aid}")
def appeal_one(aid: int, u=Depends(current_user)):
    ap = one("""SELECT ap.*, o.name AS operator_name, dcd.name AS decided_name FROM appeals ap JOIN users o ON o.id=ap.operator_id
                LEFT JOIN users dcd ON dcd.id=ap.decided_by WHERE ap.id=%s""", aid) or bad("Апелляция не найдена", 404)
    visible_dialog(u, ap["dialog_id"])
    e = one("SELECT * FROM evaluations WHERE id=%s", ap["eval_id"])
    ap["evaluation"] = eval_view(e, u)
    ap["dialog"] = one("SELECT id, transcript, operator, team, channel, language FROM dialogs WHERE id=%s", ap["dialog_id"])
    return ap


@app.post("/api/appeals/{aid}/decide")
def decide(aid: int, body: dict = Body(...), u=Depends(roles(*REVIEWERS))):
    ap = one("SELECT * FROM appeals WHERE id=%s", aid) or bad("Апелляция не найдена", 404)
    if ap["status"] != "open":
        bad("Апелляция уже рассмотрена", 409)
    dec, comment = body.get("decisions") or {}, str(body.get("comment", "")).strip()
    if any(it["crit"] not in dec for it in ap["items"]):
        bad("Примите решение по каждому критерию", 422)
    if len(comment) < 5:
        bad("Добавьте комментарий: оператор увидит его вместе с решением", 422)
    d = one("SELECT * FROM dialogs WHERE id=%s", ap["dialog_id"])
    cur = engine.current_eval(d["id"])
    cl = {c["id"]: c for c in engine.checklist(cur["checklist_id"])["criteria"]}
    before = cur["total"]
    accepted = [it for it in ap["items"] if dec[it["crit"]] and it["crit"] in cl]
    for it in accepted:
        engine.override(d["id"], it["crit"], it["want"], f"Апелляция А-{aid}: {comment}", u["id"], source="appeal")
    after = engine.current_eval(d["id"])["total"]
    status = "accepted" if len(accepted) == len(ap["items"]) else "partial" if accepted else "rejected"
    items = [{**it, "accepted": bool(dec[it["crit"]])} for it in ap["items"]]
    run("""UPDATE appeals SET status=%s, items=%s, decided_by=%s, decided_at=now(), comment=%s, score_after=%s WHERE id=%s""",
        status, J(items), u["id"], comment, after, aid)
    run("UPDATE dialogs SET wf_status=%s WHERE id=%s", "revised" if accepted else "acknowledged", d["id"])
    word = {"accepted": "принята", "partial": "принята частично", "rejected": "отклонена"}[status]
    engine.event(d["id"], u["id"], f"Апелляция А-{aid} {word}" + (f": {fmt(before)} → {fmt(after)}" if accepted else "") + f". {comment}")
    engine.audit(u["id"], f"Решение по апелляции А-{aid}: {word}", d["id"], {"before": float(before) if before is not None else None, "after": float(after) if after is not None else None})
    engine.notify(f"Апелляция А-{aid} {word}" + (f": балл {fmt(before)} → {fmt(after)}" if accepted else ""), f"dialog/{d['id']}", user_ids=[ap["operator_id"]])
    engine.notify(f"Апелляция А-{aid} ({d['operator']}) {word}", f"appeals/{aid}", roles=("lead",), team=d["team"])
    return {"status": status, "before": before, "after": after}


@app.post("/api/appeals/{aid}/withdraw")
def withdraw(aid: int, body: dict = Body(...), u=Depends(roles("lead", "op"))):
    ap = one("SELECT * FROM appeals WHERE id=%s", aid) or bad("Апелляция не найдена", 404)
    d = visible_dialog(u, ap["dialog_id"])
    if ap["status"] != "open":
        bad("Апелляция уже рассмотрена", 409)
    comment = str(body.get("comment", "")).strip() or ("Отозвана оператором" if u["role"] == "op" else "")
    if len(comment) < 5:
        bad("Укажите причину отзыва", 422)
    run("UPDATE appeals SET status='withdrawn', decided_by=%s, decided_at=now(), comment=%s WHERE id=%s", u["id"], comment, aid)
    run("UPDATE dialogs SET wf_status='acknowledged' WHERE id=%s", d["id"])
    engine.event(d["id"], u["id"], f"Апелляция А-{aid} отозвана: {comment}")
    engine.audit(u["id"], f"Отозвал апелляцию А-{aid}", d["id"])
    if u["role"] == "lead":
        engine.notify(f"Апелляция А-{aid} отозвана руководителем: {comment}", f"dialog/{d['id']}", user_ids=[ap["operator_id"]])
    return {"ok": True}


# ---------- грубые ошибки ----------
@app.get("/api/violations")
def violations(status: str = "open", u=Depends(roles(*STAFF_ALL))):
    w, a = vis(u)
    rows = all_(f"""SELECT d.id, d.operator, d.team, d.channel, d.language, d.occurred_at, d.viol_status, d.viol_note, d.wf_status,
                           d.transcript, e.id AS eval_id, e.total
                    FROM dialogs d JOIN evaluations e ON e.dialog_id=d.id AND e.is_current
                    WHERE e.critical AND {w} ORDER BY d.occurred_at DESC""", *a)
    counts_ = {k: 0 for k in ("new", "work", "closed")}
    out = []
    for r in rows:
        counts_[r["viol_status"]] += 1
        if status == "all" or (status == "open" and r["viol_status"] != "closed") or r["viol_status"] == status:
            crit = next(c for c in engine.checklist(engine.current_eval(r["id"])["checklist_id"])["criteria"] if c["type"] == "flag")
            it = one("SELECT * FROM eval_items WHERE eval_id=%s AND crit_id=%s", r["eval_id"], crit["id"])
            tr = r.pop("transcript")
            ev = [i for i in (it["evidence"] or []) if tr[i - 1]["speaker"] == "operator"] or it["evidence"] or []
            r["reason"] = it["explanation"]
            r["quote"] = {"turn": ev[0], "text": tr[ev[0] - 1]["text"]} if ev else None
            r["source"] = it["source"]
            out.append(r)
    return {"rows": out, "counts": {**counts_, "open": counts_["new"] + counts_["work"], "all": sum(counts_.values())}}


@app.patch("/api/violations/{did}")
def set_violation(did: str, body: dict = Body(...), u=Depends(roles("comp", "head"))):
    st = body.get("status")
    if st not in ("new", "work", "closed"):
        bad("Статус: new, work или closed", 422)
    note = str(body.get("note", "")).strip()
    if st == "closed" and len(note) < 5:
        bad("Чтобы закрыть нарушение, опишите принятые меры", 422)
    run("UPDATE dialogs SET viol_status=%s, viol_note=%s WHERE id=%s", st, note or None, did)
    word = {"new": "новое", "work": "в работе", "closed": "закрыто"}[st]
    engine.event(did, u["id"], f"Нарушение: {word}" + (f". {note}" if note else ""))
    engine.audit(u["id"], f"Статус нарушения: {word}", did, {"note": note})
    return {"ok": True}


# ======================= чек-листы =======================
@app.get("/api/checklists")
def checklists(u=Depends(current_user)):
    return all_("""SELECT c.id, c.slug, c.name, c.version, c.status, c.note, c.created_at, c.published_at,
                          a.name AS created_name, p.name AS published_name, jsonb_array_length(c.criteria) AS n
                   FROM checklists c LEFT JOIN users a ON a.id=c.created_by LEFT JOIN users p ON p.id=c.published_by
                   ORDER BY c.version DESC""")


@app.get("/api/checklists/{cid}")
def checklist_one(cid: int, u=Depends(current_user)):
    c = engine.checklist(cid) or bad("Версия не найдена", 404)
    c["diff"] = diff(c) if c["status"] == "draft" else None
    c["errors"] = validate_cl(c["criteria"])
    # сколько текущих оценок сделано по другой версии — от этого зависит, показывать ли «Применить к старым оценкам»
    c["stale"] = one("SELECT count(*) AS n FROM evaluations WHERE is_current AND checklist_id<>%s AND status<>'running'", cid)["n"] \
        if c["status"] == "published" else 0
    return c


def validate_cl(crit):
    errs = []
    ids, codes = set(), set()
    for c in crit:
        n = f"{c['id'][1:]}. {c.get('name', '')}"
        if c["id"] in ids:
            errs.append(f"{n}: повтор номера")
        ids.add(c["id"])
        if not c.get("code") or not re.fullmatch(r"[a-z_][a-z0-9_]*", c["code"]):
            errs.append(f"{n}: код для выгрузки — латиница в нижнем регистре")
        elif c["code"] in codes:
            errs.append(f"{n}: повтор кода {c['code']}")
        codes.add(c.get("code"))
        if not str(c.get("name", "")).strip():
            errs.append(f"Критерий {c['id'][1:]}: пустое название")
        if len(str(c.get("rule", "")).strip()) < 20:
            errs.append(f"{n}: правило слишком короткое — опишите, когда Да, Нет и N/A")
        if c["type"] == "flag" and c["weight"]:
            errs.append(f"{n}: у флага вес должен быть 0")
        if c["type"] != "flag" and not (0 < c["weight"] <= 100):
            errs.append(f"{n}: вес от 1 до 100")
        if c["type"] == "scale" and len([a for a in c["answers"] if a.isdigit()]) < 2:
            errs.append(f"{n}: у шкалы нужно минимум 2 ступени")
    total = sum(c["weight"] for c in crit if c["type"] != "flag")
    if total != 100:
        errs.append(f"Сумма весов {total}, нужно 100")
    if sum(1 for c in crit if c["type"] == "flag") > 1:
        errs.append("Флаг грубой ошибки может быть только один")
    return errs


def diff(draft):
    act = engine.active_checklist()
    base = {c["id"]: c for c in act["criteria"]}
    new = {c["id"]: c for c in draft["criteria"]}
    out = []
    for cid, c in new.items():
        b = base.get(cid)
        if not b:
            out.append({"crit": cid, "kind": "added", "name": c["name"]})
            continue
        ch = [f for f in ("name", "rule", "answers", "type", "na_allowed", "code") if b.get(f) != c.get(f)]
        if engine.sem_hash(b) != engine.sem_hash(c):
            out.append({"crit": cid, "kind": "semantic", "name": c["name"], "fields": ch,
                        "before": {f: b.get(f) for f in ch}, "after": {f: c.get(f) for f in ch}})
        if b["weight"] != c["weight"]:
            out.append({"crit": cid, "kind": "weight", "name": c["name"], "before": b["weight"], "after": c["weight"]})
        if b.get("sec") != c.get("sec"):
            out.append({"crit": cid, "kind": "section", "name": c["name"], "before": b.get("sec"), "after": c.get("sec")})
    for cid, b in base.items():
        if cid not in new:
            out.append({"crit": cid, "kind": "removed", "name": b["name"]})
    model_crits = sorted({x["crit"] for x in out if x["kind"] in ("added", "semantic")})
    n = one("SELECT count(*) AS n FROM evaluations WHERE is_current")["n"]
    avg = one("SELECT coalesce(avg(cost/nullif(calls,0)),0.0028) AS c FROM evaluations WHERE calls>0 AND trigger IN ('initial','import')")["c"]
    return {"base_version": act["version"], "changes": out, "model_crits": model_crits, "dialogs": n,
            "calls": n * len(model_crits), "cost": round(float(avg) * n * len(model_crits), 3)}


@app.post("/api/checklists/draft")
def new_draft(u=Depends(roles("head", "qa"))):
    if one("SELECT id FROM checklists WHERE status='draft'"):
        bad("Черновик уже есть. Продолжите его или удалите", 409)
    act = engine.active_checklist()
    r = run("""INSERT INTO checklists(slug,name,channel,version,status,criteria,created_by)
               VALUES (%s,%s,%s,%s,'draft',%s,%s) RETURNING id""", act["slug"], act["name"], act["channel"],
            one("SELECT max(version) AS v FROM checklists")["v"] + 1, J(act["criteria"]), u["id"])
    engine.audit(u["id"], "Создал черновик чек-листа", f"v{act['version'] + 1}")
    return {"id": r["id"]}


@app.put("/api/checklists/{cid}")
def save_draft(cid: int, body: dict = Body(...), u=Depends(roles("head", "qa"))):
    c = engine.checklist(cid) or bad("Версия не найдена", 404)
    if c["status"] != "draft":
        bad("Опубликованную версию менять нельзя: создайте черновик", 409)
    crit = body.get("criteria")
    if not isinstance(crit, list) or not crit:
        bad("Пустой список критериев", 422)
    clean = []
    for x in crit:
        t = x.get("type")
        if t not in ("binary", "scale", "flag"):
            bad("Тип ответа: binary, scale или flag", 422)
        answers = [str(a) for a in x.get("answers", [])]
        if t == "binary" or t == "flag":
            answers = ["yes", "no"]
        else:
            answers = sorted({a for a in answers if a.isdigit()}, key=int, reverse=True) or ["10", "5", "0"]
        na = bool(x.get("na_allowed")) and t != "flag"
        if na:
            answers.append("na")
        item = {"id": x["id"], "code": str(x.get("code", "")).strip(), "name": str(x.get("name", "")).strip(),
                "answers": answers, "weight": 0 if t == "flag" else int(x.get("weight") or 0), "rule": str(x.get("rule", "")).strip(),
                "type": t, "na_allowed": na, "sec": int(x.get("sec", 2))}
        old = next((o for o in c["criteria"] if o["id"] == x["id"]), None)
        for k in ("facts", "conditions", "decision"):  # дерево условий сохраняем, пока правило не переписали
            if old and k in old and old.get("rule") == item["rule"] and old.get("answers") == item["answers"]:
                item[k] = old[k]
        clean.append(item)
    run("UPDATE checklists SET criteria=%s, note=%s WHERE id=%s", J(clean), body.get("note"), cid)
    return checklist_one(cid, u)


@app.delete("/api/checklists/{cid}")
def drop_draft(cid: int, u=Depends(roles("head", "qa"))):
    c = engine.checklist(cid) or bad("Версия не найдена", 404)
    if c["status"] != "draft":
        bad("Удалить можно только черновик", 409)
    run("DELETE FROM checklists WHERE id=%s", cid)
    engine.audit(u["id"], "Удалил черновик чек-листа", f"v{c['version']}")
    return {"ok": True}


@app.post("/api/checklists/{cid}/trial")
def trial(cid: int, body: dict = Body(...), u=Depends(roles("head", "qa"))):
    """Пробный прогон изменённых критериев черновика на нескольких диалогах. В оценки не сохраняется."""
    c = engine.checklist(cid) or bad("Версия не найдена", 404)
    crits = [x for x in c["criteria"] if x["id"] in (body.get("crits") or [])]
    ids = body.get("dialog_ids") or [r["id"] for r in all_("SELECT dialog_id AS id FROM evaluations WHERE is_current ORDER BY random() LIMIT 3")]
    if not crits:
        bad("Выберите критерии для пробного прогона", 422)
    if len(ids) * len(crits) > 12:
        bad("Пробный прогон ограничен 12 запросами к модели", 422)
    runner = engine.cqa.Runner(model=engine.MODELS.get(engine.setting("model")), budget=float(engine.setting("budget")))
    out = []
    from concurrent.futures import ThreadPoolExecutor

    def go(pair):
        did, cr = pair
        d = one("SELECT * FROM dialogs WHERE id=%s", did)
        rec = {"conversation_id": d["id"], "channel": d["channel"], "language": d["language"], "transcript": d["transcript"]}
        prefix = {"type": "text", "text": "ТРАНСКРИПТ:\n" + engine.cqa.transcript_text(rec), "cache_control": {"type": "ephemeral"}}
        cur = engine.current_eval(did)
        before = engine.items_of(cur["id"]).get(cr["id"], {}).get("answer") if cur else None
        try:
            it, cost, _ = engine.evaluate_criterion(runner, rec, cr, engine.cqa.facts_of(rec), prefix)
            ev, conf, flags = engine.check_item(cr, it, d["transcript"], float(engine.setting("conf")))
            return {"dialog": did, "crit": cr["id"], "before": before, "answer": it.get("answer"), "confidence": conf,
                    "evidence": ev, "explanation": it.get("explanation"), "flags": flags, "cost": cost}
        except Exception as e:
            return {"dialog": did, "crit": cr["id"], "before": before, "error": str(e)[:200]}
    with ThreadPoolExecutor(6) as ex:
        out = list(ex.map(go, [(d, cr) for d in ids for cr in crits]))
    engine.audit(u["id"], "Пробный прогон черновика", f"v{c['version']}", {"crits": [x["id"] for x in crits], "dialogs": ids})
    return {"results": out, "cost": round(sum(x.get("cost", 0) for x in out), 4)}


@app.post("/api/checklists/{cid}/publish")
def publish(cid: int, body: dict = Body(default={}), u=Depends(roles("head"))):
    c = engine.checklist(cid) or bad("Версия не найдена", 404)
    if c["status"] != "draft":
        bad("Публикуется только черновик", 409)
    errs = validate_cl(c["criteria"])
    if errs:
        bad("Публикация невозможна: " + "; ".join(errs), 422)
    df = diff(c)
    if not df["changes"]:
        bad("В черновике нет изменений относительно активной версии", 422)
    run("UPDATE checklists SET status='archived' WHERE status='published'")
    run("UPDATE checklists SET status='published', published_by=%s, published_at=now(), note=coalesce(%s, note) WHERE id=%s", u["id"], body.get("note"), cid)
    engine.audit(u["id"], f"Опубликовал чек-лист v{c['version']}", c["name"], {"changes": df["changes"]})
    engine.notify(f"Опубликован чек-лист «{c['name']}» v{c['version']}", "rules", roles=("op", "qa", "lead"))
    return {"ok": True, "diff": df}


@app.post("/api/checklists/{cid}/apply")
def apply(cid: int, u=Depends(roles("head", "qa"))):
    """Применить активную версию к уже оценённым диалогам: веса — пересчёт, изменённый смысл — модель только для этих критериев."""
    c = engine.checklist(cid)
    if not c or c["status"] != "published":
        bad("Применить можно только активную версию", 409)
    ids = [r["dialog_id"] for r in all_("""SELECT e.dialog_id FROM evaluations e WHERE e.is_current AND e.checklist_id<>%s AND e.status<>'running'""", cid)]
    if not ids:
        bad("Все оценки уже по этой версии", 409)
    job = engine.start_job(f"Переоценка по v{c['version']}: {len(ids)} диалогов", "rescore", ids, u["id"], cl=c)
    engine.audit(u["id"], f"Применил чек-лист v{c['version']} к оценкам", f"{len(ids)} диалогов")
    return {"job": job}


# ======================= аналитика =======================
def current_rows(u, extra="true"):
    w, a = vis(u)
    return all_(f"""SELECT d.id, d.operator, d.team, d.language, d.channel, d.wf_status, e.id AS eval_id, e.total, e.critical, e.checklist_id
                    FROM dialogs d JOIN evaluations e ON e.dialog_id=d.id AND e.is_current
                    WHERE e.status='done' AND {w} AND {extra}""", *a)


def avg(xs):
    xs = [float(x) for x in xs if x is not None]
    return round(sum(xs) / len(xs), 2) if xs else None


@app.get("/api/stats/overview")
def overview(u=Depends(roles("head", "dir", "lead", "qa", "comp"))):
    rows = current_rows(u)
    crit = engine.active_checklist()["criteria"]
    ids = [r["eval_id"] for r in rows]
    items = all_("SELECT eval_id, crit_id, answer, explanation, evidence FROM eval_items WHERE eval_id = ANY(%s)", ids) if ids else []
    by = {}
    for it in items:
        by.setdefault(it["crit_id"], []).append(it)
    did_of = {r["eval_id"]: r["id"] for r in rows}
    loss = []
    for c in crit:
        if c["type"] == "flag":
            continue
        its = by.get(c["id"], [])
        app_ = [i for i in its if i["answer"] not in (None, "na")]
        fl = [i for i in app_ if engine.is_failed(c, i["answer"])]
        lost = sum((1 - (int(i["answer"]) / engine.scale_max(c) if i["answer"].isdigit() else 1 if i["answer"] == "no" else 0)) * c["weight"] for i in app_)
        loss.append({"crit": c["id"], "name": c["name"], "applicable": len(app_), "failed": len(fl),
                     "rate": round(len(fl) / len(app_) * 100) if app_ else 0, "points": round(lost / max(len(rows), 1), 2),
                     "examples": [{"dialog": did_of[i["eval_id"]], "text": i["explanation"]} for i in fl[:3]]})
    loss.sort(key=lambda x: -x["points"])
    seg = {}
    for r in rows:
        k = "Звонки" if r["channel"] == "voice call" else {"RU": "Чаты · русский", "KZ": "Чаты · казахский", "EN": "Чаты · английский"}.get(r["language"], r["language"])
        seg.setdefault(k, []).append(r["total"])
    teams = {}
    for r in rows:
        teams.setdefault(r["team"], []).append(r)
    w, a = vis(u)
    allc = one(f"SELECT count(*) AS n, count(e.id) AS ev FROM dialogs d LEFT JOIN evaluations e ON e.dialog_id=d.id AND e.is_current WHERE {w}", *a)
    cost = one(f"""SELECT coalesce(sum(e.cost),0) AS cost, coalesce(avg(e.cost) FILTER (WHERE e.trigger IN ('initial','import')),0) AS per,
                          coalesce(avg(e.seconds) FILTER (WHERE e.trigger IN ('initial','import')),0) AS sec
                   FROM evaluations e JOIN dialogs d ON d.id=e.dialog_id WHERE {w}""", *a)
    proc = one(f"""SELECT count(*) FILTER (WHERE d.wf_status='review') AS review, count(*) FILTER (WHERE d.wf_status='appeal') AS appeal,
                          count(*) FILTER (WHERE d.wf_status='new') AS new, count(*) FILTER (WHERE d.wf_status='error') AS error
                   FROM dialogs d WHERE {w}""", *a)
    ap = one(f"""SELECT count(*) FILTER (WHERE ap.status IN ('accepted','partial')) AS won, count(*) FILTER (WHERE ap.status='rejected') AS lost
                 FROM appeals ap JOIN dialogs d ON d.id=ap.dialog_id WHERE {w}""", *a)
    ov = one(f"""SELECT count(*) AS n FROM eval_items i JOIN evaluations e ON e.id=i.eval_id AND e.is_current JOIN dialogs d ON d.id=e.dialog_id
                 WHERE i.source='qa' AND {w}""", *a)["n"]
    return {"dialogs": allc["n"], "evaluated": allc["ev"], "done": len(rows), "avg": avg(r["total"] for r in rows),
            "critical": sum(1 for r in rows if r["critical"]), "loss": loss,
            "segments": [{"name": k, "n": len(v), "avg": avg(v)} for k, v in sorted(seg.items())],
            "teams": [{"name": k, "n": len(v), "avg": avg(x["total"] for x in v), "critical": sum(1 for x in v if x["critical"])} for k, v in sorted(teams.items())],
            "cost": float(cost["cost"]), "cost_per": float(cost["per"]), "sec": float(cost["sec"]), "process": {**proc, **ap, "overrides": ov}}


@app.get("/api/stats/team")
def team_stats(u=Depends(roles("lead", "head", "qa"))):
    rows = current_rows(u)
    crit = [c for c in engine.active_checklist()["criteria"] if c["type"] != "flag"]
    ids = [r["eval_id"] for r in rows]
    items = all_("SELECT eval_id, crit_id, answer FROM eval_items WHERE eval_id = ANY(%s)", ids) if ids else []
    ans = {}
    for it in items:
        ans.setdefault(it["eval_id"], {})[it["crit_id"]] = it["answer"]
    ops = {}
    for r in rows:
        ops.setdefault(r["operator"], []).append(r)
    out = []
    for name, rs in ops.items():
        fails = sorted(((sum(1 for r in rs if engine.is_failed(c, ans.get(r["eval_id"], {}).get(c["id"]))), c) for c in crit), key=lambda x: -x[0])
        w = fails[0] if fails and fails[0][0] else None
        out.append({"operator": name, "team": rs[0]["team"], "n": len(rs), "avg": avg(r["total"] for r in rs),
                    "critical": sum(1 for r in rs if r["critical"]), "weak": {"crit": w[1]["id"], "name": w[1]["name"], "n": w[0]} if w else None,
                    "appeals": one("SELECT count(*) AS n FROM appeals ap JOIN dialogs d ON d.id=ap.dialog_id WHERE d.operator=%s AND ap.status='open'", name)["n"]})
    out.sort(key=lambda x: (x["avg"] if x["avg"] is not None else 999))
    return {"team": u.get("team"), "operators": out}


@app.get("/api/stats/me")
def my_stats(u=Depends(roles("op"))):
    rows = current_rows(u, "d.wf_status NOT IN ('review','new','evaluating','error')")
    crit = [c for c in engine.active_checklist()["criteria"] if c["type"] != "flag"]
    ids = [r["eval_id"] for r in rows]
    items = all_("SELECT eval_id, crit_id, answer FROM eval_items WHERE eval_id = ANY(%s)", ids) if ids else []
    fails = {}
    for it in items:
        c = next((x for x in crit if x["id"] == it["crit_id"]), None)
        if c and engine.is_failed(c, it["answer"]):
            fails[c["id"]] = fails.get(c["id"], 0) + 1
    weak = max(fails.items(), key=lambda x: x[1]) if fails else None
    ap = one("SELECT count(*) AS n, count(*) FILTER (WHERE status='open') AS open FROM appeals WHERE operator_id=%s", u["id"])
    return {"n": len(rows), "avg": avg(r["total"] for r in rows), "new": sum(1 for r in rows if r["wf_status"] == "published"),
            "weak": {"crit": weak[0], "name": next(c["name"] for c in crit if c["id"] == weak[0]), "n": weak[1]} if weak else None,
            "appeals": ap}


@app.get("/api/calibration")
def calibration(u=Depends(roles("qa", "head"))):
    """Ответы модели (первая оценка) против эталонной разметки."""
    gold = all_("SELECT * FROM gold")
    crit = {c["id"]: c for c in engine.active_checklist()["criteria"]}
    g_by = {}
    for g in gold:
        g_by.setdefault(g["dialog_id"], {})[g["crit_id"]] = g
    per, dis, maes = {}, [], []
    for did, gs in g_by.items():
        first = one("SELECT * FROM evaluations WHERE dialog_id=%s AND trigger IN ('import','initial') ORDER BY id LIMIT 1", did)
        if not first:
            continue
        cl = engine.checklist(first["checklist_id"])
        items = engine.items_of(first["id"])
        for cid, g in gs.items():
            it = items.get(cid)
            if not it or it["status"] != "ok" or cid not in crit:
                continue
            ok = it["ai_answer"] == g["answer"]
            p = per.setdefault(cid, [0, 0]); p[0] += 1; p[1] += ok
            if not ok:
                dis.append({"dialog": did, "crit": cid, "ai": it["ai_answer"], "gold": g["answer"], "unsure": g["unsure"],
                            "explanation": it["explanation"], "confidence": it["confidence"]})
        ga = engine.score(cl["criteria"], {k: v["answer"] for k, v in gs.items()})["total"]
        aa = engine.score(cl["criteria"], {k: v["ai_answer"] for k, v in items.items()})["total"]
        if ga is not None and aa is not None:
            maes.append(abs(ga - aa))
    n = sum(p[0] for p in per.values())
    return {"agreement": round(sum(p[1] for p in per.values()) / n * 100, 1) if n else None, "answers": n,
            "per": [{"crit": k, "name": crit[k]["name"], "n": v[0], "ok": v[1], "rate": round(v[1] / v[0] * 100)} for k, v in sorted(per.items())],
            "disagreements": dis, "mae": round(sum(maes) / len(maes), 2) if maes else None, "dialogs": len(maes)}


# ======================= администрирование =======================
@app.get("/api/users")
def users(u=Depends(roles("adm"))):
    return all_("SELECT id, login, name, role, team, active, created_at FROM users ORDER BY role, name")


@app.patch("/api/users/{uid}")
def user_upd(uid: int, body: dict = Body(...), u=Depends(roles("adm"))):
    t = one("SELECT * FROM users WHERE id=%s", uid) or bad("Пользователь не найден", 404)
    if uid == u["id"] and (body.get("active") is False or body.get("role", "adm") != "adm"):
        bad("Нельзя заблокировать себя или снять с себя роль администратора", 409)
    role, active, team = body.get("role", t["role"]), body.get("active", t["active"]), body.get("team", t["team"])
    if role not in ("qa", "op", "lead", "head", "dir", "comp", "adm"):
        bad("Неизвестная роль", 422)
    run("UPDATE users SET role=%s, active=%s, team=%s WHERE id=%s", role, active, team, uid)
    if not active:
        run("DELETE FROM sessions WHERE user_id=%s", uid)
    engine.audit(u["id"], f"Изменил пользователя {t['name']}", t["login"], {"role": role, "active": active, "team": team})
    return {"ok": True}


@app.post("/api/users")
def user_add(body: dict = Body(...), u=Depends(roles("adm"))):
    lg, name, role = str(body.get("login", "")).strip().lower(), str(body.get("name", "")).strip(), body.get("role")
    if not re.fullmatch(r"[a-z0-9._-]{2,32}", lg):
        bad("Логин: латиница, цифры, точка, дефис", 422)
    if not name or role not in ("qa", "op", "lead", "head", "dir", "comp", "adm"):
        bad("Укажите имя и роль", 422)
    if one("SELECT 1 AS x FROM users WHERE login=%s", lg):
        bad("Такой логин уже есть", 409)
    pw = auth.secrets.token_urlsafe(9)
    run("INSERT INTO users(login,name,role,team,pw_hash) VALUES (%s,%s,%s,%s,%s)", lg, name, role, body.get("team") or None, auth.hash_pw(pw))
    engine.audit(u["id"], f"Добавил пользователя {name}", lg, {"role": role})
    return {"password": pw}


@app.get("/api/settings")
def settings_get(u=Depends(roles("adm", "head"))):
    spent = one("SELECT coalesce(sum(cost),0) AS s FROM evaluations")["s"]
    return {k: engine.setting(k) for k in engine.DEFAULTS} | {"spent": float(spent), "models": engine.MODELS, "prompt_hash": engine.PROMPT_HASH}


@app.put("/api/settings")
def settings_put(body: dict = Body(...), u=Depends(roles("adm"))):
    vals = {}
    if "model" in body:
        if body["model"] not in engine.MODELS:
            bad("Неизвестная модель", 422)
        vals["model"] = body["model"]
    if "conf" in body:
        vals["conf"] = max(0.5, min(0.95, float(body["conf"])))
    if "sample" in body:
        vals["sample"] = max(0, min(20, int(body["sample"])))
    if "budget" in body:
        vals["budget"] = max(1.0, min(100.0, float(body["budget"])))
    for k, v in vals.items():
        run("INSERT INTO settings VALUES (%s,%s) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", k, J(v))
    engine.audit(u["id"], "Изменил настройки оценки", None, vals)
    return settings_get(u)


@app.get("/api/audit")
def audit_log(q: str = "", u=Depends(roles("adm", "head", "comp"))):
    return all_("""SELECT a.at, a.action, a.object, a.details, us.name AS who, us.role FROM audit a LEFT JOIN users us ON us.id=a.user_id
                   WHERE (%s='' OR a.action ILIKE %s OR a.object ILIKE %s OR us.name ILIKE %s) ORDER BY a.id DESC LIMIT 300""",
                q, f"%{q}%", f"%{q}%", f"%{q}%")


@app.get("/api/notifications")
def notes(u=Depends(current_user)):
    return all_("SELECT * FROM notifications WHERE user_id=%s ORDER BY id DESC LIMIT 30", u["id"])


@app.post("/api/notifications/read")
def notes_read(u=Depends(current_user)):
    run("UPDATE notifications SET read=true WHERE user_id=%s", u["id"])
    return {"ok": True}


@app.get("/api/teams")
def teams(u=Depends(current_user)):
    return TEAMS


# ---------- выгрузка ----------
@app.get("/api/export/results.json")
def export_json(source: str = "", ids: str = "", u=Depends(roles("qa", "head", "adm"))):
    """Файл сдачи (JSON 1.0). Фильтр: source=dev|upload|text или ids=a,b,c. Ответы — модели (ai_answer), без правок людей.
    Перед отдачей файл проверяется тем же валидатором, что и при сдаче; с ошибками не отдаётся."""
    sys_path_scripts()
    from submission import to_result, error_result, validate
    cfg = json.loads((ROOT / "config/submission.json").read_text(encoding="utf-8"))
    want = [x.strip() for x in ids.split(",") if x.strip()]
    q, a = "SELECT * FROM dialogs", []
    if want:
        q += " WHERE id = ANY(%s)"; a.append(want)
    elif source:
        q += " WHERE source=%s"; a.append(source)
    res, recs, crit = [], [], None
    for d in all_(q + " ORDER BY id", *a):
        e = engine.current_eval(d["id"])
        if not e:
            continue
        rec = {"conversation_id": d["id"], "transcript": d["transcript"]}
        recs.append(rec)
        cl = engine.checklist(e["checklist_id"])["criteria"]
        crit = crit or cl
        items = {k: {**v, "answer": v["ai_answer"] if v.get("ai_answer") is not None else v["answer"]}
                 for k, v in engine.items_of(e["id"]).items()}
        if e["status"] != "done":
            res.append(error_result(d["id"], "Оценка неполная: сбой части критериев"))
            continue
        try:
            res.append(to_result(rec, items, cl))
        except Exception as ex:
            res.append(error_result(d["id"], str(ex)))
    if not res:
        bad("Нет оценённых диалогов под этот фильтр", 404)
    doc = {"schema_version": "1.0", "team_name": cfg.get("team_name", ""), "model": cfg.get("model"), "results": res}
    errs, _warn = validate(doc, crit, recs)
    if errs:
        bad("Файл не прошёл проверку формата: " + "; ".join(errs[:5]) + (f" и ещё {len(errs) - 5}" if len(errs) > 5 else ""), 422)
    engine.audit(u["id"], "Выгрузил результаты JSON", f"{len(res)} диалогов")
    return Response(json.dumps(doc, ensure_ascii=False, indent=1), media_type="application/json",
                    headers={"Content-Disposition": "attachment; filename=results.json"})


@app.get("/api/export/dialogs.csv")
def export_csv(u=Depends(current_user)):
    rows = list_dialogs(u=u)
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["Диалог", "Оператор", "Группа", "Канал", "Язык", "Итог", "Грубая ошибка", "Статус", "Версия чек-листа", "Дата"])
    for r in rows:
        w.writerow([r["id"], r["operator"], r["team"], r["channel"], r["language"], fmt(r["total"]), "да" if r["critical"] else "",
                    r["wf_status"], r["cl_version"] or "", r["occurred_at"].strftime("%d.%m.%Y %H:%M")])
    engine.audit(u["id"], "Выгрузил реестр CSV", f"{len(rows)} строк")
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": "attachment; filename=dialogs.csv"})


def sys_path_scripts():
    import sys
    p = str(ROOT / "scripts")
    if p not in sys.path:
        sys.path.insert(0, p)


# ======================= интерфейс =======================
class NoCacheStatic(StaticFiles):
    """Браузер перепроверяет файлы интерфейса по ETag: после обновления не останется старый JS."""
    def file_response(self, *a, **kw):
        r = super().file_response(*a, **kw)
        r.headers["Cache-Control"] = "no-cache"
        return r


app.mount("/static", NoCacheStatic(directory=WEB), name="static")


@app.get("/")
def index():
    return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-cache"})
