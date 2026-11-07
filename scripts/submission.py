"""Формат сдачи результатов (JSON 1.0 из приложения к гайду): сборка записи и проверка файла.

Проверка файла:  python scripts/submission.py results/prod/results.json --input data/prod.json --set prod
"""
import argparse, json, sys
from pathlib import Path

from cqa import ROOT, norm, total_score

OFFICIAL_CODES = ["contact", "discovery", "identification", "consultation", "empathy", "dialogue", "closure", "critical"]
MODES = {"local", "external_api", "hybrid"}
PROD_SIZE = 10


def load_records(src):
    """Записи диалогов из ответа API или файла: ищем объекты с conversation_id и transcript на любой глубине."""
    data = json.loads(Path(src).read_text(encoding="utf-8")) if isinstance(src, (str, Path)) else src
    out = []

    def walk(o):
        if isinstance(o, dict):
            if "conversation_id" in o and "transcript" in o:
                out.append(o)
                return
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(data)
    return out


def to_value(c, answer):
    """Наш ответ → значение формата сдачи: yes/no/na → true/false/null, ступень шкалы → число."""
    a = norm(c, answer)
    if a is None:
        raise ValueError(f"{c['id']}: недопустимый ответ {answer!r}")
    if a == "na":
        return None
    if a.isdigit():
        return int(a)
    return a == "yes"


def clean_turns(ev, n):
    """Номера реплик с 1; выбрасываем всё, чего нет в транскрипте, — не придумываем доказательства."""
    res = set()
    for e in ev if isinstance(ev, list) else [ev]:
        try:
            i = int(str(e).strip("[] "))
        except (TypeError, ValueError):
            continue
        if 1 <= i <= n:
            res.add(i)
    return sorted(res)


def to_result(rec, items, criteria):
    n = len(rec["transcript"])
    crits, ans = [], {}
    for c in criteria:
        it = items.get(c["id"], {})
        ans[c["id"]] = norm(c, it.get("answer"))
        crits.append({"criterion_id": c["code"], "value": to_value(c, it.get("answer")),
                      "rationale": str(it.get("explanation") or "").strip(),
                      "evidence_turns": clean_turns(it.get("evidence", []), n)})
    flag = next(x["value"] for x in crits if x["criterion_id"] == "critical")
    return {"conversation_id": rec["conversation_id"], "status": "ok", "criteria": crits,
            "score": {"final_score": total_score(ans, criteria), "critical_flag": flag}}


def error_result(cid, reason):
    return {"conversation_id": cid, "status": "error", "criteria": [], "score": None, "error": reason}


def _is_int(v):
    return type(v) is int  # bool — тоже int в Python, его не пускаем


def allowed_values(c):
    vals = set()
    for a in c["answers"]:
        vals.add(None if a == "na" else int(a) if a.isdigit() else ("yes" == a))
    return vals


def validate(doc, criteria, records=None, set_name=None):
    """(ошибки, предупреждения). Ошибки блокируют сдачу."""
    E, W = [], []
    if doc.get("schema_version") != "1.0":
        E.append('schema_version должен быть "1.0"')
    if not isinstance(doc.get("team_name"), str) or not doc["team_name"].strip():
        E.append("team_name пустой — укажи название команды в config/submission.json")
    m = doc.get("model") or {}
    if m.get("mode") not in MODES:
        E.append(f"model.mode должен быть одним из {sorted(MODES)}")
    if not isinstance(m.get("name"), str) or not m["name"].strip():
        E.append("model.name пустой")
    res = doc.get("results")
    if not isinstance(res, list):
        return E + ["results должен быть массивом"], W

    by_code = {c["code"]: c for c in criteria}
    if sorted(by_code) != sorted(OFFICIAL_CODES):
        W.append(f"коды критериев отличаются от официальных: {sorted(set(by_code) ^ set(OFFICIAL_CODES))}")
    lens = {r["conversation_id"]: len(r["transcript"]) for r in records} if records else {}

    ids = [r.get("conversation_id") for r in res]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        E.append(f"повторяются ID: {dup}")
    if records is not None:
        miss, extra = set(lens) - set(ids), set(ids) - set(lens)
        if miss:
            E.append(f"нет записей для {len(miss)} диалогов: {sorted(miss)[:10]}")
        if extra:
            E.append(f"ID, которых нет во входных данных: {sorted(extra)[:10]}")
    if set_name == "prod" and len(res) != PROD_SIZE:
        E.append(f"в prod должно быть ровно {PROD_SIZE} записей, сейчас {len(res)}")

    for r in res:
        cid = r.get("conversation_id")
        p = f"{cid}:"
        if not isinstance(cid, str) or not cid:
            E.append("запись без conversation_id")
            continue
        st = r.get("status")
        if st == "error":
            if r.get("criteria") != [] or r.get("score") is not None:
                E.append(f"{p} при status=error нужны criteria=[] и score=null")
            if not isinstance(r.get("error"), str) or not r["error"].strip():
                E.append(f"{p} при status=error нужна причина в error")
            continue
        if st != "ok":
            E.append(f"{p} status должен быть ok или error")
            continue
        crits = r.get("criteria") or []
        codes = [x.get("criterion_id") for x in crits]
        if sorted(codes) != sorted(by_code):
            E.append(f"{p} критерии {codes}, нужны ровно {list(by_code)} по одному разу")
            continue
        vals = {}
        for x in crits:
            c, v = by_code[x["criterion_id"]], x.get("value")
            ok_vals = allowed_values(c)
            if c["type"] == "scale":
                good = v is None and None in ok_vals or _is_int(v) and v in ok_vals
            else:
                good = v is None and None in ok_vals or type(v) is bool
            if not good:
                E.append(f"{p} {c['code']}={v!r} — недопустимое значение")
            if not isinstance(x.get("rationale"), str):
                E.append(f"{p} {c['code']}: rationale должен быть строкой")
            elif not x["rationale"].strip():
                W.append(f"{p} {c['code']}: пустое объяснение")
            ev = x.get("evidence_turns")
            if not isinstance(ev, list) or not all(_is_int(i) and i >= 1 for i in ev):
                E.append(f"{p} {c['code']}: evidence_turns — список номеров реплик с 1")
            elif cid in lens and any(i > lens[cid] for i in ev):
                E.append(f"{p} {c['code']}: реплика вне транскрипта ({lens[cid]} реплик)")
            elif not ev:
                W.append(f"{p} {c['code']}: нет номеров реплик")
            vals[c["id"]] = None if v is None else ("yes" if v is True else "no" if v is False else str(v))
        sc = r.get("score") or {}
        fs = sc.get("final_score")
        if not isinstance(fs, (int, float)) or isinstance(fs, bool) or not 0 <= fs <= 100:
            E.append(f"{p} final_score должен быть числом 0..100")
        else:
            exp = total_score({k: ("na" if v is None else v) for k, v in vals.items()}, criteria)
            if exp is not None and abs(exp - fs) > 0.005:
                E.append(f"{p} final_score {fs} не совпадает с расчётом {exp}")
            if round(fs, 2) != fs:
                E.append(f"{p} final_score не округлён до 2 знаков")
        crit_v = next((x.get("value") for x in crits if x.get("criterion_id") == "critical"), None)
        if sc.get("critical_flag") is not crit_v:
            E.append(f"{p} critical_flag должен совпадать с value критерия critical")
    return E, W


def read_strict(path):
    raw = Path(path).read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raise ValueError("файл начинается с BOM — нужен UTF-8 без BOM")
    def bad_const(x):
        raise ValueError(f"недопустимое значение {x} в JSON")
    return json.loads(raw.decode("utf-8"), parse_constant=bad_const)


def dump(doc, path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def report(E, W, doc):
    res = doc.get("results") or []
    ok = sum(r.get("status") == "ok" for r in res)
    print(f"записей: {len(res)} · ok: {ok} · error: {len(res) - ok}")
    for w in W[:20]:
        print("  предупреждение:", w)
    if len(W) > 20:
        print(f"  … ещё предупреждений: {len(W) - 20}")
    for e in E:
        print("  ОШИБКА:", e)
    print("ФАЙЛ ГОТОВ К СДАЧЕ" if not E else f"НЕ СДАВАТЬ: ошибок {len(E)}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    from cqa import load_checklist
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--input", help="входные диалоги: сверить ID и длину транскриптов")
    ap.add_argument("--set", choices=["dev", "prod"])
    ap.add_argument("--checklist-version", type=int)
    a = ap.parse_args()
    crit = load_checklist("chat", a.checklist_version)["criteria"]
    try:
        doc = read_strict(a.file)
    except Exception as e:
        print("ОШИБКА чтения:", e); print("НЕ СДАВАТЬ"); sys.exit(1)
    recs = load_records(a.input) if a.input else None
    E, W = validate(doc, crit, recs, a.set or (Path(a.file).parent.name if Path(a.file).parent.name in ("dev", "prod") else None))
    report(E, W, doc)
    sys.exit(1 if E else 0)
