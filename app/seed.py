"""Начальное наполнение: пользователи, чек-лист v1, диалоги DEV, реальные оценки модели на 15 эталонных диалогах, эталон.

  python -m app.seed          — наполнить, если база пустая
  python -m app.seed --reset  — удалить всё и наполнить заново
"""
import argparse, json, os, re, sys
from datetime import datetime, timedelta, timezone

from .auth import hash_pw
from .db import ROOT, J, all_, init_schema, one, run, tx
from . import engine

SECTION = {"c1": 0, "c2": 0, "c3": 1, "c4": 1, "c5": 2, "c6": 2, "c7": 2, "c8": 3}
TEAMS = ["Брокерские счета", "Пополнение и вывод", "Тарифы и комиссии", "Международные рынки"]
STAFF = [("qa", "Дана Кудайберген", "qa", None), ("head", "Салтанат Ахметова", "head", None),
         ("lead", "Айжан Нурланова", "lead", TEAMS[1]), ("dir", "Ерлан Касымов", "dir", None),
         ("comp", "Гульнара Омарова", "comp", None), ("admin", "Тимур Сейтказы", "adm", None)]
NAME_PAT = [r"зовут\s+([А-ЯЁ][а-яё]+)", r"\bя\s+([А-ЯЁ][а-яё]+)", r"атым\s+([А-ЯЁӘҒҚҢӨҰҮҺІ][а-яёәғқңөұүһі]+)",
            r"([А-ЯЁӘҒҚҢӨҰҮҺІ][а-яёәғқңөұүһі]+)\s+(?:болам|бойынша|есімім)", r"(?:name is|I am|I'm|this is)\s+([A-Z][a-z]+)"]
FALLBACK = ["Алия", "Нурлан", "Динара", "Арман", "Сауле", "Ерлан", "Мадина"]
EVAL_RUN = ROOT / "runs" / "eval_1794055372.json"


def operator_name(rec, i):
    ops = [t["text"] for t in rec["transcript"] if t["speaker"] == "operator"]
    for p in NAME_PAT:
        for t in ops[:2]:
            m = re.search(p, t)
            if m and m.group(1) not in ("Вас", "вас", "Здравствуйте", "Сізге"):
                return m.group(1)
    return FALLBACK[i % len(FALLBACK)]


def reset():
    with engine.tx() as c:
        c.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")


def seed():
    init_schema()
    if one("SELECT count(*) AS n FROM users")["n"]:
        print("база уже наполнена; для повторного наполнения: python -m app.seed --reset")
        return
    pw = hash_pw(os.environ.get("DEMO_PASSWORD", "freedom2026"))
    ids = {}
    for login, name, role, team in STAFF:
        ids[login] = run("INSERT INTO users(login,name,role,team,pw_hash) VALUES (%s,%s,%s,%s,%s) RETURNING id", login, name, role, team, pw)["id"]

    cl_src = json.loads((ROOT / "config/checklists/chat.v1.json").read_text(encoding="utf-8"))
    crit = [{**c, "sec": SECTION.get(c["id"], 2)} for c in cl_src["criteria"]]
    cl_id = run("""INSERT INTO checklists(slug,name,channel,version,status,criteria,note,created_by,published_by,published_at,created_at)
                   VALUES ('chat','Чаты и звонки','all',1,'published',%s,'Исходная версия по спецификации Freedom',%s,%s,now()-interval '7 days',now()-interval '7 days') RETURNING id""",
                J(crit), ids["head"], ids["head"])["id"]
    engine.audit(ids["head"], "Опубликовал чек-лист", "Чаты и звонки v1")
    cl = engine.checklist(cl_id)

    recs = json.loads((ROOT / "data/dev.json").read_text(encoding="utf-8"))["data"]["records"]
    names = [operator_name(r, i) for i, r in enumerate(recs)]
    ops = sorted(set(names))
    team_of = {n: TEAMS[i % len(TEAMS)] for i, n in enumerate(ops)}
    for i, n in enumerate(ops, 1):
        run("INSERT INTO users(login,name,role,team,pw_hash) VALUES (%s,%s,'op',%s,%s)", f"op{i}", n, team_of[n], pw)
    now = datetime.now(timezone.utc)
    for i, (r, n) in enumerate(zip(recs, names)):
        at = now - timedelta(days=7 - (i % 7), hours=(i * 5) % 9, minutes=(i * 13) % 60)
        run("""INSERT INTO dialogs(id,channel,language,transcript,audio_url,operator,team,source,occurred_at,created_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,'dev',%s,%s)""",
            r["conversation_id"], r["channel"], r["language"], J(r["transcript"]), r.get("audio_url"), n, team_of[n], at, at)

    gold = json.loads((ROOT / "eval/gold.json").read_text(encoding="utf-8"))["dialogs"]
    for did, g in gold.items():
        for k, v in g.items():
            if k.startswith("c"):
                run("INSERT INTO gold VALUES (%s,%s,%s,%s)", did, k, v, k in g.get("unsure", []))

    # реальные ответы модели (Sonnet 5.5) на 15 эталонных диалогах — последний прогон
    ev = json.loads(EVAL_RUN.read_text(encoding="utf-8"))
    row = ev["rows"]["criterion_1"]
    for i, (did, r) in enumerate(ev["results"].items()):
        items = r["criterion_1"]["items"]
        d = one("SELECT transcript, occurred_at FROM dialogs WHERE id=%s", did)
        eid = run("""INSERT INTO evaluations(dialog_id,checklist_id,model,prompt_hash,trigger,status,calls,cost,seconds,created_by,created_at)
                     VALUES (%s,%s,%s,%s,'import','running',%s,%s,%s,%s,%s) RETURNING id""",
                  did, cl_id, engine.cqa.SONNET, engine.PROMPT_HASH, len(crit), round(row["cost"], 5), round(row["sec"], 2),
                  ids["qa"], d["occurred_at"] + timedelta(minutes=3))["id"]
        conf_min = float(engine.setting("conf"))
        for c in crit:
            it = items.get(c["id"], {})
            if "error" in it:
                run("INSERT INTO eval_items(eval_id,crit_id,status,error,sem_hash) VALUES (%s,%s,'error',%s,%s)", eid, c["id"], it["error"], engine.sem_hash(c))
                continue
            it["answer"] = engine.cqa.norm(c, it.get("answer")) if it.get("answer") is not None else None
            evd, conf, flags = engine.check_item(c, it, d["transcript"], conf_min)
            run("""INSERT INTO eval_items(eval_id,crit_id,status,source,answer,ai_answer,confidence,evidence,explanation,conditions,sem_hash,flags)
                   VALUES (%s,%s,'ok','model',%s,%s,%s,%s,%s,%s,%s,%s)""",
                eid, c["id"], it["answer"], it["answer"], conf, J(evd), it.get("explanation", ""),
                J(it["conditions"]) if it.get("conditions") else None, engine.sem_hash(c), J(flags))
        engine.finalize(eid)
        engine.after_evaluation(eid)
        st = one("SELECT wf_status FROM dialogs WHERE id=%s", did)["wf_status"]
        if st == "published" and i % 2 == 0:
            run("UPDATE dialogs SET wf_status='acknowledged' WHERE id=%s", did)
            engine.event(did, engine.operator_user(one("SELECT operator FROM dialogs WHERE id=%s", did)["operator"]), "Оператор ознакомился с оценкой")
        engine.event(did, None, f"Оценено моделью {engine.cqa.SONNET} по «{cl['name']}» v1")

    # заранее поданная апелляция, чтобы очередь QA не была пустой
    d = one("SELECT * FROM dialogs WHERE id='p1-ru-018'")
    if d:
        e = engine.current_eval(d["id"])
        op = engine.operator_user(d["operator"])
        cur = engine.items_of(e["id"])["c6"]["answer"]
        run("""INSERT INTO appeals(dialog_id,eval_id,operator_id,text,items,score_before,created_at)
               VALUES (%s,%s,%s,%s,%s,%s,now()-interval '1 day')""", d["id"], e["id"], op,
            "Клиент писал короткими фразами, я дважды уточнил вопрос. Это не бессвязность, прошу пересмотреть до 4.",
            J([{"crit": "c6", "from": cur, "want": "4"}]), e["total"])
        run("UPDATE dialogs SET wf_status='appeal' WHERE id=%s", d["id"])
        engine.event(d["id"], op, "Оператор подал апелляцию по критерию 6")
    print(f"готово: {len(recs)} диалогов, {len(ev['results'])} с оценками модели, {len(ops)} операторов")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true")
    a = ap.parse_args()
    if a.reset:
        reset()
    seed()
