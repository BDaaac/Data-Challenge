"""Оценка диалогов: задача на каждый критерий, сохранение по готовности, переиспользование, балл по формуле."""
import threading
import hashlib, json, sys, time, traceback
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal, ROUND_HALF_UP

from .db import atomic_workflow, ROOT, J, all_, one, run, tx

sys.path.insert(0, str(ROOT / "scripts"))
import cqa  # noqa: E402  ядро промптов и вызова модели

PROMPT_HASH = hashlib.sha1((cqa.SYSTEM + cqa.ITEM).encode()).hexdigest()[:8]
MODELS = {"sonnet": cqa.SONNET, "haiku": cqa.HAIKU}
DIALOG_POOL = ThreadPoolExecutor(3, thread_name_prefix="dialog")


# ---------- настройки ----------
DEFAULTS = {"model": "sonnet", "conf": 0.7, "sample": 3, "budget": 20.0}


def setting(key):
    r = one("SELECT value FROM settings WHERE key=%s", key)
    return r["value"] if r else DEFAULTS[key]


# ---------- критерии и балл ----------
def sem_hash(c):
    """Отпечаток смысла критерия. Вес не входит: смена веса не требует вызова модели."""
    d = {k: v for k, v in c.items() if k not in ("weight", "sec")}
    return hashlib.sha1(json.dumps(d, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]


def scale_max(c):
    return max(int(a) for a in c["answers"] if a.isdigit())


def score(criteria, answers):
    """Итог по формуле: N/A исключается, вес перераспределяется, округление половины вверх до 2 знаков."""
    raw, w_app, pts = {}, 0, {}
    for c in criteria:
        if c["type"] == "flag" or not c["weight"]:
            continue
        a = answers.get(c["id"])
        if a in (None, "na"):
            continue
        w_app += c["weight"]
        raw[c["id"]] = c["weight"] if a == "yes" else c["weight"] * int(a) / scale_max(c) if a.isdigit() else 0
    if not w_app:
        return {"total": None, "w_app": 0, "k": None, "pts": {}, "max": {}}
    k = 100 / w_app
    pts = {cid: v * k for cid, v in raw.items()}
    total = float(Decimal(str(sum(pts.values()) + 1e-9)).quantize(Decimal("0.01"), ROUND_HALF_UP))
    mx = {c["id"]: c["weight"] * k for c in criteria if c["id"] in raw}
    return {"total": total, "w_app": w_app, "k": k, "pts": pts, "max": mx}


def is_failed(c, a):
    if a in (None, "na"):
        return False
    if c["type"] == "flag":
        return a == "yes"
    if c["type"] == "scale":
        return int(a) < scale_max(c)
    return a == "no"


# ---------- проверка ответа модели ----------
def check_item(c, item, transcript, conf_min):
    """Доказательства должны существовать и подтверждать ответ; иначе — флаг «нужна проверка», а не факт."""
    flags, n = [], len(transcript)
    ev = []
    for e in item.get("evidence") or []:
        try:
            i = int(str(e).strip("[] "))
        except (TypeError, ValueError):
            flags.append("bad_evidence")
            continue
        if 1 <= i <= n:
            ev.append(i)
        else:
            flags.append("bad_evidence")
    ev = sorted(set(ev))
    a = item.get("answer")
    op_cited = any(transcript[i - 1]["speaker"] == "operator" for i in ev)
    if a is None:
        flags.append("invalid")
    elif a == "na" or (c["type"] == "flag" and a == "no"):
        pass
    elif not ev:
        flags.append("no_evidence")
    elif (a == "yes" or c["type"] == "flag") and not op_cited:
        flags.append("no_evidence")
    try:
        conf = float(item.get("confidence"))
    except (TypeError, ValueError):
        conf = None
    if conf is not None and conf < conf_min:
        flags.append("low_conf")
    return ev, conf, sorted(set(flags))


REASON_TEXT = {"critical": "Грубая ошибка", "low_conf": "Модель не уверена", "no_evidence": "Нет доказательства",
               "invalid": "Недопустимый ответ модели", "error": "Сбой оценки", "sample": "Случайная выборка"}


def review_reasons(dialog_id, criteria, items):
    reasons = {}
    for c in criteria:
        it = items.get(c["id"])
        if not it:
            continue
        if it["status"] == "error":
            reasons.setdefault("error", []).append(c["id"])
            continue
        if it.get("source") in ("qa", "appeal"):
            continue  # решение человека не требует повторной проверки
        if c["type"] == "flag" and it["answer"] == "yes":
            reasons.setdefault("critical", []).append(c["id"])
        for f in it.get("flags") or []:
            key = "no_evidence" if f == "bad_evidence" else f
            reasons.setdefault(key, []).append(c["id"])
    sample = int(setting("sample"))
    if sample and int(hashlib.md5(dialog_id.encode()).hexdigest(), 16) % 100 < sample:
        reasons.setdefault("sample", [])
    order = ["critical", "error", "invalid", "no_evidence", "low_conf", "sample"]
    return [{"code": k, "crits": sorted(set(reasons[k]))} for k in order if k in reasons]


# ---------- журнал, события, уведомления ----------
def audit(user_id, action, obj=None, details=None):
    run("INSERT INTO audit(user_id, action, object, details) VALUES (%s,%s,%s,%s)", user_id, action, obj, J(details) if details is not None else None)


def event(dialog_id, user_id, text):
    run("INSERT INTO events(dialog_id, user_id, text) VALUES (%s,%s,%s)", dialog_id, user_id, text)


def notify(text, link, user_ids=(), roles=(), team=None):
    ids = set(user_ids)
    for r in roles:
        rows = all_("SELECT id FROM users WHERE role=%s AND active AND (%s::text IS NULL OR team=%s OR role<>'lead')", r, team, team)
        ids.update(x["id"] for x in rows)
    for uid in ids:
        if uid:
            run("INSERT INTO notifications(user_id, text, link) VALUES (%s,%s,%s)", uid, text, link)


def operator_user(name):
    r = one("SELECT id FROM users WHERE role='op' AND name=%s", name)
    return r["id"] if r else None


# ---------- чтение оценки ----------
def current_eval(dialog_id):
    return one("SELECT * FROM evaluations WHERE dialog_id=%s AND is_current", dialog_id)


def items_of(eval_id):
    return {r["crit_id"]: r for r in all_("SELECT * FROM eval_items WHERE eval_id=%s", eval_id)}


def checklist(cid):
    return one("SELECT * FROM checklists WHERE id=%s", cid)


def active_checklist(slug="chat"):
    return one("SELECT * FROM checklists WHERE slug=%s AND status='published' ORDER BY version DESC LIMIT 1", slug)


def finalize(eval_id, user_id=None):
    """Пересчитать итог, флаг и причины проверки по сохранённым ответам."""
    ev = one("SELECT * FROM evaluations WHERE id=%s", eval_id)
    crit = checklist(ev["checklist_id"])["criteria"]
    items = items_of(eval_id)
    answers = {k: v["answer"] for k, v in items.items() if v["status"] == "ok"}
    s = score(crit, answers)
    critical = any(c["type"] == "flag" and answers.get(c["id"]) == "yes" for c in crit)
    pending = any(v["status"] == "pending" for v in items.values()) or len(items) < len(crit)
    errors = any(v["status"] == "error" for v in items.values())
    status = "running" if pending else "partial" if errors else "done"
    reasons = review_reasons(ev["dialog_id"], crit, items)
    run("""UPDATE evaluations SET total=%s, critical=%s, review=%s, status=%s,
           finished_at = CASE WHEN %s<>'running' THEN coalesce(finished_at, now()) END,
           seconds = CASE WHEN %s<>'running' THEN coalesce(seconds, extract(epoch FROM now()-created_at)) END
           WHERE id=%s""", s["total"] if not errors else None, critical, J(reasons), status, status, status, eval_id)
    return status, reasons, s["total"], critical


# ---------- вызов модели по одному критерию ----------
def evaluate_criterion(runner, rec, c, facts, prefix):
    """Ответ по одному критерию; один повтор при недопустимом ответе. Возвращает (item, cost, calls)."""
    prompt = cqa.crit_prompt(c, facts)
    cost = calls = 0
    for attempt in range(2):
        text = prompt if attempt == 0 else prompt + f"\n\nВНИМАНИЕ: предыдущий ответ не прошёл проверку. Поле answer строго одно из: {', '.join(c['answers'])}. Только JSON."
        out, cst = runner.call([prefix, {"type": "text", "text": text}], 4000)
        cost += cst
        calls += 1
        if c.get("decision"):
            conds = cqa.derived(out.get("conditions", {}), {k: facts[k] for k in c.get("facts", [])})
            out["answer"] = cqa.decide(c, conds)
            out["conditions"] = conds
        out["answer"] = cqa.norm(c, out.get("answer")) if out.get("answer") is not None else None
        if out["answer"] is not None:
            break
    return out, cost, calls


def _save_item(eval_id, c, item, transcript, source):
    conf_min = float(setting("conf"))
    ev, conf, flags = check_item(c, item, transcript, conf_min)
    run("""UPDATE eval_items SET status='ok', source=%s, answer=%s, ai_answer=%s, confidence=%s, evidence=%s,
           explanation=%s, conditions=%s, sem_hash=%s, flags=%s, error=NULL WHERE eval_id=%s AND crit_id=%s""",
        source, item.get("answer"), item.get("answer"), conf, J(ev), item.get("explanation") or "",
        J(item.get("conditions")) if item.get("conditions") else None, sem_hash(c), J(flags), eval_id, c["id"])


def run_evaluation(eval_id, only=None):
    """Выполнить оценку: критерии из only (или все pending) — моделью, по 8 одновременно."""
    ev = one("SELECT * FROM evaluations WHERE id=%s", eval_id)
    d = one("SELECT * FROM dialogs WHERE id=%s", ev["dialog_id"])
    crit = {c["id"]: c for c in checklist(ev["checklist_id"])["criteria"]}
    todo = [r["crit_id"] for r in all_("SELECT crit_id FROM eval_items WHERE eval_id=%s AND status='pending'", eval_id)]
    if only:
        todo = [t for t in todo if t in only]
    # Общий потолок расходов на модель (по всем оценкам), а не на один запуск
    spent = float(one("SELECT coalesce(sum(cost),0) AS s FROM evaluations")["s"])
    if todo and spent >= float(setting("budget")):
        run("UPDATE eval_items SET status='error', error=%s WHERE eval_id=%s AND crit_id = ANY(%s)",
            f"Исчерпан бюджет на модель (${spent:.2f}). Поднимите лимит в настройках", eval_id, todo)
        todo = []
    rec ={"conversation_id": d["id"], "channel": d["channel"], "language": d["language"], "transcript": d["transcript"]}
    facts = cqa.facts_of(rec)
    prefix = {"type": "text", "text": "ТРАНСКРИПТ:\n" + cqa.transcript_text(rec), "cache_control": {"type": "ephemeral"}}
    runner = cqa.Runner(model=ev["model"], budget=float(setting("budget")))
    t0 = time.time()

    def one_crit(cid):
        c = crit[cid]
        try:
            out, cost, calls = evaluate_criterion(runner, rec, c, facts, prefix)
            _save_item(eval_id, c, out, d["transcript"], "model")
        except Exception as e:  # сбой одного критерия не роняет остальные
            cost = calls = 0
            run("UPDATE eval_items SET status='error', error=%s, sem_hash=%s WHERE eval_id=%s AND crit_id=%s",
                f"{type(e).__name__}: {str(e)[:300]}", sem_hash(c), eval_id, cid)
        run("UPDATE evaluations SET cost=cost+%s, calls=calls+%s WHERE id=%s", cost, calls, eval_id)

    if todo:
        first, rest = todo[0], todo[1:]
        one_crit(first)  # первый запрос записывает кеш транскрипта
        with ThreadPoolExecutor(8) as ex:
            list(ex.map(one_crit, rest))
    complete_evaluation(eval_id, round(time.time() - t0, 2))


@atomic_workflow
def complete_evaluation(eval_id, seconds=None):
    finalize(eval_id)
    if seconds is not None:
        run("UPDATE evaluations SET seconds=%s WHERE id=%s",seconds,eval_id)
    after_evaluation(eval_id)


@atomic_workflow
def after_evaluation(eval_id):
    """Сделать оценку текущей, выставить статус диалога, разослать уведомления."""
    ev = one("SELECT * FROM evaluations WHERE id=%s", eval_id)
    d = one("SELECT * FROM dialogs WHERE id=%s", ev["dialog_id"])
    with tx() as c:
        c.execute("UPDATE evaluations SET is_current=false WHERE dialog_id=%s", (d["id"],))
        c.execute("UPDATE evaluations SET is_current=true WHERE id=%s", (eval_id,))
    reasons = ev["review"] or []
    prev = d["wf_status"]
    if ev["status"] == "partial":
        wf = "error"
    elif ev["trigger"] in ("initial", "import") or prev in ("new", "evaluating", "error"):
        wf = "review" if reasons else "published"
    else:
        wf = prev if prev != "evaluating" else "published"
        if ev["critical"] and ev["calls"] and prev in ("published", "acknowledged", "revised"):  # новый ответ модели — ещё раз человеку
            wf = "review"
    if wf in ("published","acknowledged","revised","appeal"):
        run("UPDATE evaluations SET published=true WHERE id=%s",eval_id)
    run("UPDATE dialogs SET wf_status=%s WHERE id=%s", wf, d["id"])
    cl = checklist(ev["checklist_id"])
    total = "—" if ev["total"] is None else f"{float(ev['total']):.2f}".replace(".", ",")
    if ev["trigger"] != "import":
        event(d["id"], ev["created_by"], {
            "initial": f"Оценено моделью по «{cl['name']}» v{cl['version']}: {total}, вызовов {ev['calls']}, ${float(ev['cost']):.4f}",
            "rescore": f"Переоценено по v{cl['version']}: {total}, вызовов модели {ev['calls']}",
            "recalc": f"Пересчитано по v{cl['version']} без вызова модели: {total}",
        }.get(ev["trigger"], f"Оценка обновлена: {total}"))
    if wf == "published" and prev != "published" and ev["trigger"] == "initial":
        notify(f"Новая оценка {d['id']}: {total}", f"dialog/{d['id']}", user_ids=[operator_user(d["operator"])])
    if ev["critical"] and ev["calls"] and ev["trigger"] in ("initial", "rescore"):
        notify(f"Грубая ошибка в {d['id']} ({d['operator']})", f"dialog/{d['id']}", roles=("qa", "lead"), team=d["team"])
    if wf == "error":
        notify(f"Оценка {d['id']} неполная: сбой части критериев", f"dialog/{d['id']}", user_ids=[ev["created_by"]])


# ---------- создание оценок ----------
COPY = ("recalc", "override", "appeal")


def new_evaluation(dialog_id, cl, user_id, trigger, job_id=None, base=None, force=()):
    """Создать оценку. Ответы базовой оценки переиспользуются, если смысл критерия, транскрипт и модель те же."""
    model = MODELS.get(setting("model"), cqa.SONNET)
    base_items = items_of(base["id"]) if base else {}
    reuse_ok = base is not None and base["model"] == model and base["prompt_hash"] == PROMPT_HASH
    with tx() as c:
        c.execute("""INSERT INTO evaluations(dialog_id, checklist_id, model, prompt_hash, trigger, status, created_by, job_id)
                     VALUES (%s,%s,%s,%s,%s,'running',%s,%s) RETURNING id""",
                  (dialog_id, cl["id"], base["model"] if base and trigger in COPY else model, PROMPT_HASH, trigger, user_id, job_id))
        eid = c.fetchone()["id"]
        pending = []
        for cr in cl["criteria"]:
            b = base_items.get(cr["id"])
            same = b and b["status"] == "ok" and b["sem_hash"] == sem_hash(cr) and cr["id"] not in force
            if same and (reuse_ok or trigger in COPY):
                c.execute("""INSERT INTO eval_items(eval_id, crit_id, status, source, answer, ai_answer, confidence, evidence,
                             explanation, conditions, sem_hash, flags, override_by, override_reason, override_at)
                             VALUES (%s,%s,'ok',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                          (eid, cr["id"], b["source"] if b["source"] in ("qa", "appeal") else "reused", b["answer"], b["ai_answer"],
                           b["confidence"], J(b["evidence"]), b["explanation"], J(b["conditions"]) if b["conditions"] else None,
                           b["sem_hash"], J(b["flags"]), b["override_by"], b["override_reason"], b["override_at"]))
            else:
                c.execute("INSERT INTO eval_items(eval_id, crit_id, status) VALUES (%s,%s,'pending')", (eid, cr["id"]))
                pending.append(cr["id"])
    return eid, pending


def start_job(title, kind, dialog_ids, user_id, cl=None, only_crit=None):
    result,plan = _plan_job(title,kind,dialog_ids,user_id,cl,only_crit)
    if plan:
        for eid,pending in plan:
            DIALOG_POOL.submit(_safe_run,eid)
        threading.Thread(target=_finish_job,args=(result["id"],user_id,title),daemon=True).start()
    return result


@atomic_workflow
def _plan_job(title, kind, dialog_ids, user_id, cl=None, only_crit=None):
    from fastapi import HTTPException
    dialog_ids=list(dict.fromkeys(dialog_ids))
    if not dialog_ids: raise HTTPException(422,"Выберите диалоги")
    for did in dialog_ids:
        d=one("SELECT wf_status FROM dialogs WHERE id=%s",did)
        if not d: raise HTTPException(404,"Диалог не найден")
        if d["wf_status"]=="appeal": raise HTTPException(409,"Сначала завершите апелляцию")
    cl = cl or active_checklist()
    existing=one("SELECT * FROM jobs WHERE dialog_ids=%s AND finished_at IS NULL ORDER BY id DESC LIMIT 1",J(dialog_ids))
    if existing:
        if existing["only_crit"] != (only_crit or None) or one("SELECT id FROM evaluations WHERE job_id=%s AND checklist_id<>%s",existing["id"],cl["id"]):
            raise HTTPException(409,"Другой вариант оценки уже выполняется")
        return {"id":existing["id"],"title":existing["title"],"dialogs":len(dialog_ids)}, []
    cl = cl or active_checklist()
    job = run("INSERT INTO jobs(title, kind, dialog_ids, only_crit, created_by) VALUES (%s,%s,%s,%s,%s) RETURNING id",
              title, kind, J(dialog_ids), J(only_crit) if only_crit else None, user_id)["id"]
    plan = []
    for did in dialog_ids:
        base = current_eval(did)
        running = one("SELECT id FROM evaluations WHERE dialog_id=%s AND checklist_id=%s AND status='running'", did, cl["id"])
        if running:  # повторное «Оценить» не создаёт вторую оценку
            raise HTTPException(409,"Диалог уже оценивается в другом пакете")
        trigger = "initial" if not base else "rescore"
        eid, pending = new_evaluation(did, cl, user_id, trigger, job, base, force=only_crit or ())
        if not base:
            run("UPDATE dialogs SET wf_status='evaluating' WHERE id=%s", did)
        plan.append((eid, pending))
    return {"id":job,"title":title,"dialogs":len(dialog_ids)},plan


def _safe_run(eid):
    try:
        run_evaluation(eid)
    except Exception:
        traceback.print_exc()
        try:
            run("UPDATE eval_items SET status='error', error='Внутренняя ошибка сервера' WHERE eval_id=%s AND status='pending'", eid)
            complete_evaluation(eid)
        except Exception:
            traceback.print_exc()


def _finish_job(job_id, user_id, title):
    # ждём, пока все оценки пакета завершатся (они в том же пуле, поэтому проверяем периодически)
    for _ in range(3600):
        r = one("SELECT count(*) FILTER (WHERE status='running') AS n FROM evaluations WHERE job_id=%s", job_id)
        if not r["n"]:
            break
        time.sleep(1)
    run("UPDATE jobs SET finished_at=now() WHERE id=%s", job_id)
    notify(f"Готово: {title}", f"jobs/{job_id}", user_ids=[user_id])


def retry_failed(eval_id, user_id):
    _prepare_retry(eval_id)
    DIALOG_POOL.submit(_safe_run, eval_id)


@atomic_workflow
def _prepare_retry(eval_id):
    from fastapi import HTTPException
    ev=one("SELECT * FROM evaluations WHERE id=%s",eval_id)
    if not ev or ev["status"]!="partial" or not ev["is_current"]:
        raise HTTPException(409,"Оценка уже запущена или не требует повтора")
    if one("SELECT id FROM evaluations WHERE dialog_id=%s AND status='running'",ev["dialog_id"]):
        raise HTTPException(409,"Диалог уже оценивается")
    if one("SELECT id FROM appeals WHERE dialog_id=%s AND status='open'",ev["dialog_id"]):
        raise HTTPException(409,"Сначала завершите апелляцию")
    run("UPDATE eval_items SET status='pending', error=NULL WHERE eval_id=%s AND status='error'", eval_id)
    run("UPDATE evaluations SET status='running', finished_at=NULL, seconds=NULL WHERE id=%s", eval_id)
    d = one("SELECT dialog_id FROM evaluations WHERE id=%s", eval_id)["dialog_id"]
    run("UPDATE dialogs SET wf_status='evaluating' WHERE id=%s", d)


def recalc_all(cl, user_id):
    """Только веса: пересчёт итога по новой версии без вызова модели."""
    changed = 0
    for d in all_("SELECT d.id, e.total, e.id AS eid FROM dialogs d JOIN evaluations e ON e.dialog_id=d.id AND e.is_current WHERE e.status<>'running'"):
        base = one("SELECT * FROM evaluations WHERE id=%s", d["eid"])
        eid, pending = new_evaluation(d["id"], cl, user_id, "recalc", base=base)
        if pending:  # у критерия поменялся смысл — пересчётом не обойтись, удаляем черновую оценку
            run("DELETE FROM evaluations WHERE id=%s", eid)
            continue
        finalize(eid)
        after_evaluation(eid)
        new = one("SELECT total FROM evaluations WHERE id=%s", eid)["total"]
        changed += (new != d["total"])
    return changed


@atomic_workflow
def override(dialog_id, crit_id, answer, reason, user_id, source="qa"):
    """Решение человека: новая версия оценки с изменённым ответом, история сохраняется."""
    base = current_eval(dialog_id)
    cl = checklist(base["checklist_id"])
    eid, _ = new_evaluation(dialog_id, cl, user_id, "override" if source == "qa" else "appeal", base=base)
    run("UPDATE evaluations SET prompt_hash=%s WHERE id=%s", base["prompt_hash"], eid)
    run("""UPDATE eval_items SET answer=%s, source=%s, override_by=%s, override_reason=%s, override_at=now(), status='ok'
           WHERE eval_id=%s AND crit_id=%s""", answer, source, user_id, reason, eid, crit_id)
    finalize(eid)
    if base["published"]:
        run("UPDATE evaluations SET published=true WHERE id=%s",eid)
    with tx() as c:
        c.execute("UPDATE evaluations SET is_current=false WHERE dialog_id=%s", (dialog_id,))
        c.execute("UPDATE evaluations SET is_current=true WHERE id=%s", (eid,))
    return eid
