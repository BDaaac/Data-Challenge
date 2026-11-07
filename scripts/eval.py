"""Сравнение подходов на мини-эталоне (Sonnet 5.5):
  single      — 1 запрос на весь чек-лист (2 прогона, для стабильности)
  criterion   — 8 запросов, по одному на критерий (2 прогона)
  recheck     — single + выборочная перепроверка неуверенных критериев (confidence < порога):
                отдельный запрос по критерию; при несогласии — ещё один, ответ большинством.
Запуск: python scripts/eval.py
"""
import json, statistics as st, sys, time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

from cqa import CRIT, CRITERIA, ROOT, SONNET, Runner, answers_of, norm, total_score

THRESH = 0.8
sys.stdout.reconfigure(encoding="utf-8")

gold = json.loads((ROOT / "eval/gold.json").read_text(encoding="utf-8"))["dialogs"]
recs = {r["conversation_id"]: r for r in
        json.loads((ROOT / "data/dev.json").read_text(encoding="utf-8"))["data"]["records"]}
R = Runner(SONNET, effort="low", budget=5.0)


def timed(fn, *a, **kw):
    t = time.time(); res = fn(*a, **kw); return res, round(time.time() - t, 1)


def recheck(rec, items):
    """Выборочная перепроверка: только критерии с низкой уверенностью."""
    final = answers_of(items)
    flagged = [cid for cid in CRIT if float(items.get(cid, {}).get("confidence", 0) or 0) < THRESH]
    cost = 0.0
    if not flagged:
        return final, flagged, cost
    r1, c1 = R.criterion(rec, flagged, warm=len(flagged) > 1); cost += c1
    second = [cid for cid in flagged if norm(CRIT[cid], r1[cid].get("answer")) != final[cid]]
    r2 = {}
    if second:
        r2, c2 = R.criterion(rec, second, warm=False); cost += c2
    for cid in flagged:
        votes = [final[cid], norm(CRIT[cid], r1[cid].get("answer"))]
        if cid in r2:
            votes.append(norm(CRIT[cid], r2[cid].get("answer")))
        top, n = Counter(votes).most_common(1)[0]
        final[cid] = top if n > 1 else votes[1]  # нет большинства → доверяем отдельному запросу
    return final, flagged, cost


ONLY_CRITERION = "--criterion" in sys.argv  # только criterion-wise, 1 прогон — дешёвая проверка промпта


def run_dialog(did):
    rec, out = recs[did], {}
    if ONLY_CRITERION:
        (items, cost), sec = timed(R.criterion, rec)
        out["criterion_1"] = {"ans": answers_of(items), "items": items, "cost": cost, "sec": sec}
        print(f"готово {did}  ${cost:.3f}", flush=True)
        return did, out
    for k in ["single_1", "single_2"]:
        (items, cost), sec = timed(R.single, rec)
        out[k] = {"ans": answers_of(items), "items": items, "cost": cost, "sec": sec}
    for k in ["criterion_1", "criterion_2"]:
        (items, cost), sec = timed(R.criterion, rec)
        out[k] = {"ans": answers_of(items), "items": items, "cost": cost, "sec": sec}
    s1 = out["single_1"]
    (ans, flagged, cost), sec = timed(recheck, rec, s1["items"])
    out["recheck"] = {"ans": ans, "flagged": flagged, "cost": s1["cost"] + cost, "sec": s1["sec"] + sec}
    print(f"готово {did}  ${sum(v['cost'] for v in out.values()) - s1['cost']:.3f}", flush=True)
    return did, out


def metrics(results, key):
    agree = agree_sure = n_sure = 0; per = Counter(); mae = []; costs = []; secs = []; n = 0
    for did, out in results.items():
        g, a = gold[did], out[key]["ans"]
        costs.append(out[key]["cost"]); secs.append(out[key]["sec"])
        for cid in CRIT:
            ok = a[cid] == g[cid]; n += 1; agree += ok; per[cid] += ok
            if cid not in g["unsure"]:
                n_sure += 1; agree_sure += ok
        gt, pt = total_score(g), total_score(a)
        if gt is not None and pt is not None:
            mae.append(abs(gt - pt))
    k = len(results)
    return {"acc": agree / n, "acc_sure": agree_sure / n_sure, "per": {c: per[c] / k for c in CRIT},
            "mae": st.mean(mae), "cost": st.mean(costs), "sec": st.mean(secs), "sec_max": max(secs)}


def stability(results, a, b):
    same = sum(out[a]["ans"][c] == out[b]["ans"][c] for out in results.values() for c in CRIT)
    return same / (len(results) * len(CRIT))


def main():
    with ThreadPoolExecutor(5) as ex:
        results = dict(ex.map(run_dialog, list(gold)))
    keys = ["criterion_1"] if ONLY_CRITERION else ["single_1", "single_2", "criterion_1", "criterion_2", "recheck"]
    rows = {k: metrics(results, k) for k in keys}
    print("\nрежим          точн.  точн.(без спорн.)  MAE итога  $/диалог  сек/диалог (макс)")
    for k, m in rows.items():
        print(f"{k:13} {m['acc']:.1%}   {m['acc_sure']:.1%}            {m['mae']:5.2f}     ${m['cost']:.4f}   {m['sec']:.1f} ({m['sec_max']})")
    print("\nточность по критериям:")
    print("режим        " + "  ".join(CRIT))
    for k, m in rows.items():
        print(f"{k:12} " + " ".join(f"{m['per'][c]:.0%}".rjust(4) for c in CRIT))
    if ONLY_CRITERION:
        print("\nрасхождения с эталоном (criterion_1):")
        for did, out in results.items():
            a = out["criterion_1"]
            diffs = [f"{c}: gold={gold[did][c]} c={a['ans'][c]} — {a['items'].get(c, {}).get('explanation', '')}"
                     + (" *спорн." if c in gold[did]["unsure"] else "") for c in CRIT if a["ans"][c] != gold[did][c]]
            if diffs:
                print(f"  {did}:\n    " + "\n    ".join(diffs))
        save(rows, results); return
    print(f"\nстабильность single 1↔2: {stability(results, 'single_1', 'single_2'):.1%}"
          f" · criterion 1↔2: {stability(results, 'criterion_1', 'criterion_2'):.1%}")
    fl = [len(o["recheck"]["flagged"]) for o in results.values()]
    print(f"перепроверка: в среднем {st.mean(fl):.1f} критериев из 8 на диалог (порог conf<{THRESH})")
    print("\nрасхождения с эталоном (single_1 / criterion_1 / recheck):")
    for did, out in results.items():
        diffs = [f"{c}: gold={gold[did][c]} s={out['single_1']['ans'][c]} c={out['criterion_1']['ans'][c]} r={out['recheck']['ans'][c]}"
                 + (" *спорн." if c in gold[did]["unsure"] else "")
                 for c in CRIT if len({gold[did][c], out['single_1']['ans'][c], out['criterion_1']['ans'][c], out['recheck']['ans'][c]}) > 1]
        if diffs:
            print(f"  {did}: " + " | ".join(diffs))
    save(rows, results)


def save(rows, results):
    (ROOT / "runs").mkdir(exist_ok=True)
    p = ROOT / "runs" / f"eval_{int(time.time())}.json"
    p.write_text(json.dumps({"rows": rows, "results": results}, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(f"\nпотрачено ${R.spent:.3f} · {p}")


if __name__ == "__main__":
    main()
