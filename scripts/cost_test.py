"""Короткий тест: цена и поведение Haiku 5.5 vs Sonnet 5.5 на 3 диалогах.

Запуск:  python scripts/cost_test.py
Режимы:  per_criterion (8 запросов на диалог, общий префикс кешируется)
         single        (1 запрос на весь чек-лист)
"""
import json, os, re, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic

ROOT = Path(__file__).resolve().parent.parent
for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

DIALOGS = ["p1-ru-002", "p1-kz-001", "p4-ru-001"]
MODELS = {"haiku": "claude-haiku-5-5", "sonnet": "claude-sonnet-5-5"}
EFFORT = "low"
BUDGET_USD = 3.0

# $ за 1M токенов: вход, выход, чтение кеша, запись кеша (5 мин)
PRICES = {
    "claude-haiku-5-5": (0.10, 0.50, 0.01, 0.125),
    "claude-sonnet-5-5": (2.00, 10.00, 0.20, 2.50),
}

SYSTEM = """Ты — QA-специалист контакт-центра Freedom Broker. Оцениваешь работу ОПЕРАТОРА (speaker=operator) по чек-листу.
Правила:
- Реплики bot и system — только контекст. Ошибки бота оператору не засчитываются.
- В чате работа оператора начинается после системного события эскалации.
- В звонке шум распознавания, маски [Имя скрыто] и дубли реплик НЕ считаются ошибкой оператора; маска имени в приветствии = оператор представился.
- «Нет» — действие было нужно, но пропущено или выполнено неправильно. N/A — только если разрешён и выполнено условие неприменимости.
- Шаблонная фраза без связи с проблемой клиента не засчитывается как выполнение.
- Доказательство — номера реплик [N] из транскрипта. Для пропущенного действия укажи реплики, где оно ожидалось.
- Отвечай ТОЛЬКО JSON без markdown. Объяснение — кратко, на русском."""

CRITERIA = [
    {"id": "c1", "name": "Установление контакта", "answers": ["yes", "no"], "weight": 10,
     "rule": "Да — в ПЕРВОМ ответе оператор поздоровался на языке клиента и представился (имя). Приветствие бота не считается."},
    {"id": "c2", "name": "Выявление потребности", "answers": ["yes", "no", "na"], "weight": 15,
     "rule": "Да — оператор учёл известные детали (в т.ч. сказанные боту) и уточнил недостающее до ответа. Нет — данных не хватало, а оператор ответил без уточнения, или переспросил уже известное. N/A — данных для ответа хватало с самого начала."},
    {"id": "c3", "name": "Идентификация", "answers": ["yes", "no", "na"], "weight": 20,
     "rule": "Да — личность подтверждена ДО раскрытия персональных данных или защищённого действия. Нет — проверка требовалась, но не подтверждена, или данные раскрыты до неё. N/A — запрос не требовал идентификации (общий вопрос, навигация), либо клиент отказался и данные не раскрывались."},
    {"id": "c4", "name": "Корректная и полная консультация", "answers": ["20", "15", "10", "5", "0", "na"], "weight": 20,
     "rule": "20 — все существенные вопросы закрыты или дан корректный следующий шаг; 15 — основной вопрос решён, пропущена второстепенная деталь; 10 — часть запроса закрыта, существенный вопрос открыт; 5 — общая подсказка, клиенту непонятно, как действовать; 0 — ответа по существу нет или ключевая рекомендация ошибочна. N/A — чат закончился до того, как клиент сформулировал запрос."},
    {"id": "c5", "name": "Эмпатия и клиентоориентированность", "answers": ["yes", "no"], "weight": 15,
     "rule": "Да — оператор вежлив и, если клиент выразил недовольство или описал неудобство, отреагировал на конкретную проблему."},
    {"id": "c6", "name": "Управление диалогом, скорость и грамотность", "answers": ["10", "7", "4", "0"], "weight": 15,
     "rule": "10 — ответы ясные и связные, при явном ожидании оператор предупредил; 7 — один заметный сбой, но клиент может понять и продолжить; 4 — клиенту приходится переспрашивать из-за формулировок или порядка; 0 — бессвязные или противоречивые реплики. Для звонков: логичность, понятность, отсутствие неуместных выражений, корректность речи, управление паузами."},
    {"id": "c7", "name": "Завершение", "answers": ["yes", "no", "na"], "weight": 5,
     "rule": "Да — оператор подвёл итог или предложил дальнейшую помощь И попрощался. Нет — закрыл без прощания или без итога/предложения помощи. N/A — чат оборвался до возможности завершить (обрыв связи, клиент ушёл). «Оператор закрыл чат» — не обрыв."},
    {"id": "c8", "name": "Грубые ошибки (флаг, без баллов)", "answers": ["yes", "no"], "weight": 0,
     "rule": "Да — есть оскорбление клиента, ИЛИ предложение платной услуги в обход компании (перевести деньги оператору лично, личный номер для платной консультации; достаточно самого предложения), ИЛИ раскрытие конфиденциальной информации. Иначе Нет."},
]

ONE_SCHEMA = '{"answer": "<одно из допустимых>", "evidence": [номера реплик], "explanation": "<1-2 предложения>"}'


def transcript_text(rec):
    lines = [f"Диалог {rec['conversation_id']} · канал: {rec['channel']} · язык: {rec['language']}"]
    for i, t in enumerate(rec["transcript"]):
        lines.append(f"[{i}][{t['speaker']} {t['timestamp']}] {t['text']}")
    return "\n".join(lines)


def crit_block(c):
    return f"Критерий {c['id']} «{c['name']}». Допустимые ответы: {', '.join(c['answers'])}.\nПравило: {c['rule']}"


def parse_json(text):
    m = re.search(r"\{.*\}", text, re.S)
    try:
        return json.loads(m.group(0)) if m else {"error": "no json", "raw": text[:300]}
    except json.JSONDecodeError:
        return {"error": "bad json", "raw": text[:300]}


def cost(model, u):
    i, o, r, w = PRICES[model]
    return (u.input_tokens * i + u.output_tokens * o
            + (u.cache_read_input_tokens or 0) * r
            + (u.cache_creation_input_tokens or 0) * w) / 1e6


client = anthropic.Anthropic(max_retries=3)
spent = 0.0


def call(model, user_blocks, max_tokens):
    global spent
    if spent > BUDGET_USD:
        raise SystemExit(f"Стоп: превышен бюджет теста ${BUDGET_USD}")
    t0 = time.time()
    r = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=[{"type": "text", "text": SYSTEM}],
        messages=[{"role": "user", "content": user_blocks}],
        output_config={"effort": EFFORT},
    )
    text = "".join(b.text for b in r.content if b.type == "text")
    c = cost(model, r.usage)
    spent += c
    return {"text": text, "usage": r.usage.model_dump(), "cost": c, "sec": round(time.time() - t0, 1),
            "stop": r.stop_reason}


def run_per_criterion(model, rec):
    prefix = {"type": "text", "text": "ТРАНСКРИПТ:\n" + transcript_text(rec),
              "cache_control": {"type": "ephemeral"}}

    def one(c):
        tail = {"type": "text", "text": crit_block(c) + f"\n\nВерни JSON: {ONE_SCHEMA}"}
        res = call(model, [prefix, tail], 4000)
        res["parsed"] = parse_json(res["text"])
        return c["id"], res

    first = one(CRITERIA[0])  # первый запрос пишет кеш
    with ThreadPoolExecutor(7) as ex:
        rest = list(ex.map(one, CRITERIA[1:]))
    return dict([first] + rest)


def run_single(model, rec):
    crits = "\n\n".join(crit_block(c) for c in CRITERIA)
    schema = '{"c1": ' + ONE_SCHEMA + ', ..., "c8": ...}'
    blocks = [{"type": "text", "text": "ТРАНСКРИПТ:\n" + transcript_text(rec)},
              {"type": "text", "text": f"ЧЕК-ЛИСТ:\n{crits}\n\nВерни JSON по всем критериям: {schema}"}]
    res = call(model, blocks, 12000)
    parsed = parse_json(res["text"])
    return {"_call": res, **{c["id"]: {"parsed": parsed.get(c["id"], parsed)} for c in CRITERIA}}


def total_score(answers):
    raw = w_app = 0.0
    for c in CRITERIA:
        if not c["weight"]:
            continue
        a = str(answers.get(c["id"], "")).lower()
        if a == "na":
            continue
        w_app += c["weight"]
        if a == "yes":
            raw += c["weight"]
        elif a.isdigit():
            raw += c["weight"] * int(a) / max(int(x) for x in c["answers"] if x.isdigit())
    return round(raw * 100 / w_app, 2) if w_app else None


def main():
    data = json.loads((ROOT / "data/dev.json").read_text(encoding="utf-8"))["data"]["records"]
    recs = {r["conversation_id"]: r for r in data}
    out, rows = {}, []
    for mode, fn in [("per_criterion", run_per_criterion), ("single", run_single)]:
        for mname, model in MODELS.items():
            for did in DIALOGS:
                res = fn(model, recs[did])
                calls = [v for k, v in res.items() if k == "_call"] or [v for v in res.values() if "usage" in v]
                usage = {k: sum((c["usage"].get(k) or 0) for c in calls)
                         for k in ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]}
                answers = {c["id"]: res[c["id"]]["parsed"].get("answer") for c in CRITERIA}
                row = {"mode": mode, "model": mname, "dialog": did, "cost": sum(c["cost"] for c in calls),
                       "sec": max(c["sec"] for c in calls), **usage, "answers": answers, "total": total_score(answers)}
                rows.append(row)
                out[f"{mode}|{mname}|{did}"] = res
                print(f"{mode:13} {mname:6} {did:10} ${row['cost']:.4f}  in={usage['input_tokens']} "
                      f"out={usage['output_tokens']} cache_r={usage['cache_read_input_tokens']} "
                      f"cache_w={usage['cache_creation_input_tokens']}  total={row['total']}  {answers}", flush=True)
    (ROOT / "runs").mkdir(exist_ok=True)
    path = ROOT / "runs" / f"cost_test_{int(time.time())}.json"
    path.write_text(json.dumps({"rows": rows, "raw": out}, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(f"\nИтого потрачено: ${spent:.4f}\nСохранено: {path}")


if __name__ == "__main__":
    main()
