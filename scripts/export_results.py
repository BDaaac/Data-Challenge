"""Оценка набора и выгрузка results.json в формате сдачи.

  python scripts/export_results.py --set prod --url "<ссылка API организаторов>"
  python scripts/export_results.py --set prod --input data/prod.json
  python scripts/export_results.py --set dev  --input data/dev.json

Каждый оценённый диалог сразу кешируется (runs/export/<set>/). Повторный запуск дооценивает
только упавшие или новые диалоги, поэтому после сбоя просто запусти ту же команду ещё раз.
"""
import argparse, hashlib, json, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from cqa import ROOT, SONNET, SYSTEM, Runner, load_checklist, norm
from submission import dump, error_result, load_records, report, to_result, validate

sys.stdout.reconfigure(encoding="utf-8")


def fetch(url, headers, save_to):
    req = urllib.request.Request(url, headers={"Accept": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
    data = json.loads(body.decode("utf-8"))
    save_to.parent.mkdir(parents=True, exist_ok=True)
    save_to.write_bytes(body)  # исходный ответ API сохраняем как есть — ID берём только оттуда
    return data


def key_of(rec, criteria):
    s = json.dumps([criteria, rec["transcript"], SYSTEM, SONNET], ensure_ascii=False, sort_keys=True)
    return hashlib.sha1(s.encode()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", required=True, choices=["dev", "prod"])
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--input", help="файл с диалогами (ответ API)")
    src.add_argument("--url", help="адрес API организаторов")
    ap.add_argument("--header", action="append", default=[], help='"Имя: значение", если API требует')
    ap.add_argument("--workers", type=int, default=3, help="диалогов одновременно")
    ap.add_argument("--fresh", action="store_true", help="не брать из кеша, оценить заново")
    ap.add_argument("--budget", type=float, default=10.0)
    ap.add_argument("--checklist-version", type=int)
    a = ap.parse_args()

    cfg = json.loads((ROOT / "config/submission.json").read_text(encoding="utf-8"))
    checklist = load_checklist("chat", a.checklist_version)
    criteria = checklist["criteria"]

    if a.url:
        raw_path = ROOT / f"data/{a.set}.json"
        headers = dict(h.split(":", 1) for h in a.header)
        data = fetch(a.url, {k.strip(): v.strip() for k, v in headers.items()}, raw_path)
        print(f"набор получен и сохранён: {raw_path.relative_to(ROOT)}")
    else:
        data = json.loads(Path(a.input).read_text(encoding="utf-8"))
    recs, seen = [], set()
    for r in load_records(data):
        if r["conversation_id"] in seen:
            print(f"  предупреждение: повтор ID во входных данных {r['conversation_id']} — беру первый")
            continue
        seen.add(r["conversation_id"]); recs.append(r)
    print(f"диалогов: {len(recs)} · чек-лист «{checklist['name']}» v{checklist['version']} · модель {SONNET}")

    cache_dir = ROOT / f"runs/export/{a.set}"
    cache_dir.mkdir(parents=True, exist_ok=True)
    R = Runner(SONNET, effort="low", budget=a.budget)

    def one(rec):
        cid = rec["conversation_id"]
        k = key_of(rec, criteria)
        cf = cache_dir / f"{hashlib.sha1(cid.encode()).hexdigest()[:16]}.json"
        if not a.fresh and cf.exists():
            c = json.loads(cf.read_text(encoding="utf-8"))
            if c.get("key") == k and c["result"]["status"] == "ok":
                return c["result"], 0.0, "кеш"
        t = time.time()
        try:
            items, cost = R.criterion(rec, criteria=criteria)
            bad = [c["id"] for c in criteria if norm(c, items.get(c["id"], {}).get("answer")) is None]
            if bad:  # один повтор только для упавших критериев
                more, c2 = R.criterion(rec, bad, warm=False, criteria=criteria)
                items.update(more); cost += c2
                bad = [c["id"] for c in criteria if norm(c, items.get(c["id"], {}).get("answer")) is None]
            if bad:
                codes = [c["code"] for c in criteria if c["id"] in bad]
                why = "; ".join(sorted({items.get(b, {}).get("error", "недопустимый ответ модели") for b in bad}))
                res = error_result(cid, f"Не удалось оценить критерии {codes}: {why}")
            else:
                res = to_result(rec, items, criteria)
        except Exception as e:
            res, cost = error_result(cid, f"Ошибка оценки: {type(e).__name__}: {str(e)[:200]}"), 0.0
        cf.write_text(json.dumps({"key": k, "result": res, "items": locals().get("items")}, ensure_ascii=False),
                      encoding="utf-8")
        return res, cost, f"{time.time() - t:.1f} с"

    t0, results, total = time.time(), {}, 0.0
    with ThreadPoolExecutor(a.workers) as ex:
        for rec, (res, cost, how) in zip(recs, ex.map(one, recs)):
            results[rec["conversation_id"]] = res
            total += cost
            mark = res["score"]["final_score"] if res["status"] == "ok" else "ОШИБКА: " + res["error"]
            print(f"  {rec['conversation_id']:<14} {how:>7}  ${cost:.3f}  {mark}", flush=True)

    doc = {"schema_version": "1.0", "team_name": cfg["team_name"], "model": cfg["model"],
           "results": [results[r["conversation_id"]] for r in recs]}  # порядок как во входных данных
    out = ROOT / f"results/{a.set}/results.json"
    dump(doc, out)
    print(f"\nзаписано: {out.relative_to(ROOT)} · ${total:.3f} · {time.time() - t0:.0f} с")
    E, W = validate(doc, criteria, recs, a.set)
    report(E, W, doc)
    if any(r["status"] == "error" for r in doc["results"]):
        print("Есть диалоги с ошибкой: запусти ту же команду ещё раз — оценятся только они.")
    if not E:
        print(f'Дальше: git add results/{a.set}/results.json && git commit -m "results {a.set}" && git push')
    sys.exit(1 if E else 0)


if __name__ == "__main__":
    main()
