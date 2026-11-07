"""Ядро оценки: чек-лист из конфигурации, вызов модели по критериям, дерево условий, расчёт итога, переоценка."""
import hashlib, json, os, re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic

ROOT = Path(__file__).resolve().parent.parent
for _line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
    if "=" in _line and not _line.startswith("#"):
        _k, _v = _line.split("=", 1)
        os.environ.setdefault(_k.strip(), _v.strip())

SONNET, HAIKU = "claude-sonnet-5-5", "claude-haiku-5-5"
PRICES = {HAIKU: (0.10, 0.50, 0.01, 0.125), SONNET: (2.00, 10.00, 0.20, 2.50)}  # in, out, cache_r, cache_w за 1M

SYSTEM = """Ты — QA-специалист контакт-центра Freedom Broker. Оцениваешь работу ОПЕРАТОРА (speaker=operator) по чек-листу.
Общие правила:
- Реплики bot и system — только контекст. Ошибки бота оператору не засчитываются, но то, что клиент уже сообщил боту, оператор должен учитывать.
- В чате работа оператора начинается после системного события эскалации («Эскалация на оператора», «Чат операторға жіберілді», «Chat transferred to an agent»).
- В звонке шум распознавания, маски [Имя скрыто]/[Персональные данные скрыты] и дубли реплик НЕ считаются ошибкой оператора; маска имени в приветствии = оператор представился. Внутренние переговоры оператора с коллегами во время удержания клиент не слышит — оценивай только общение с клиентом.
- «Нет» — действие было нужно, но пропущено или выполнено неправильно. N/A — только если он разрешён для критерия и выполнено условие неприменимости.
- Оценивай только свой критерий. Нарушения, которые относятся к другим критериям, здесь не учитывай.
- Шаблонная фраза без связи с ситуацией клиента не засчитывается как выполнение.
- Доказательство — номера реплик [N]. Для пропущенного действия укажи реплики, где оно ожидалось.
- Отвечай ТОЛЬКО JSON без markdown. Объяснение — кратко, на русском."""

ITEM = '{"answer": "<одно из допустимых>", "confidence": <0..1>, "evidence": [номера реплик], "explanation": "<1-2 предложения>"}'

# ---------- чек-лист как данные ----------
CHECKLISTS = ROOT / "config" / "checklists"


def validate_checklist(cl):
    """Ошибки чек-листа (пустой список = ок). Сумма весов оцениваемых критериев должна быть 100."""
    errs, ids = [], set()
    codes = set()
    for c in cl["criteria"]:
        if c["id"] in ids:
            errs.append(f"повтор id {c['id']}")
        ids.add(c["id"])
        if not c.get("code"):
            errs.append(f"{c['id']}: нет кода критерия для сдачи (code)")
        elif c["code"] in codes:
            errs.append(f"{c['id']}: повтор кода {c['code']}")
        codes.add(c.get("code"))
        if not c.get("rule", "").strip():
            errs.append(f"{c['id']}: пустое правило")
        if c["type"] == "flag" and c["weight"]:
            errs.append(f"{c['id']}: у флага вес должен быть 0")
        if c["type"] == "scale" and len([a for a in c["answers"] if a.isdigit()]) < 2:
            errs.append(f"{c['id']}: у шкалы нужно минимум 2 ступени")
        if c.get("na_allowed") != ("na" in c["answers"]):
            errs.append(f"{c['id']}: na_allowed не совпадает со списком ответов")
        for r in c.get("decision", []):
            if r["then"] not in c["answers"]:
                errs.append(f"{c['id']}: правило решения даёт недопустимый ответ {r['then']}")
    total = sum(c["weight"] for c in cl["criteria"] if c["type"] != "flag")
    if total != 100:
        errs.append(f"сумма весов {total}, нужно 100")
    return errs


def load_checklist(name="chat", version=None):
    files = sorted(CHECKLISTS.glob(f"{name}.v*.json"), key=lambda p: int(p.stem.split(".v")[1]))
    path = CHECKLISTS / f"{name}.v{version}.json" if version else files[-1]
    cl = json.loads(path.read_text(encoding="utf-8"))
    errs = validate_checklist(cl)
    if errs:
        raise ValueError(f"{path.name}: " + "; ".join(errs))
    return cl


def crit_hash(c):
    """Отпечаток определения критерия: меняется — критерий надо переоценить."""
    return hashlib.sha1(json.dumps(c, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]


CHECKLIST = load_checklist()
CRITERIA = CHECKLIST["criteria"]
CRIT = {c["id"]: c for c in CRITERIA}

# ---------- факты, которые считает код, а не модель ----------
ID_EVENTS = ("Личность клиента подтверждена", "Клиенттің жеке басы расталды", "Customer identity verified")


def facts_of(rec):
    t = rec["transcript"]
    ev = next((i for i, x in enumerate(t, 1) if x["speaker"] == "system" and any(e in x["text"] for e in ID_EVENTS)), None)
    return {"identity_event": ev}


FACT_TEXT = {"identity_event": lambda v: f"Системное событие подтверждения личности: {'реплика [' + str(v) + ']' if v is not None else 'отсутствует'}."}


def derived(conds, facts):
    """Производные условия из ответов модели и фактов кода."""
    def clean(v):
        if isinstance(v, str):
            s = v.strip().lower()
            if s in ("true", "false"):
                return s == "true"
            if s in ("null", "none", ""):
                return None
            return int(s.strip("[]")) if s.strip("[]").isdigit() else v
        return v
    d = {k: clean(v) for k, v in conds.items()}
    if "identity_event" in facts:
        ev, disc = facts["identity_event"], d.get("disclosure_turn")
        disc = disc if isinstance(disc, int) else None
        d["verified_before_disclosure"] = ev is not None and (disc is None or ev < disc)
    return d


def decide(c, conds):
    """Первое сработавшее правило дерева; правило без «if» — по умолчанию."""
    for r in c["decision"]:
        if all(conds.get(k) == v for k, v in r.get("if", {}).items()):
            return r["then"]
    return None


# ---------- промпты ----------
def transcript_text(rec):
    lines = [f"Диалог {rec['conversation_id']} · канал: {rec['channel']} · язык: {rec['language']}"]
    for i, t in enumerate(rec["transcript"], 1):  # нумерация с 1, как в формате сдачи
        lines.append(f"[{i}][{t['speaker']} {t['timestamp']}] {t['text']}")
    return "\n".join(lines)


def crit_block(c):
    return f"Критерий {c['id']} «{c['name']}». Допустимые ответы: {', '.join(c['answers'])}.\nПравило: {c['rule']}"


def crit_prompt(c, facts):
    if not c.get("conditions"):
        return crit_block(c) + f"\n\nВерни JSON: {ITEM}"
    fx = "\n".join(FACT_TEXT[f](facts[f]) for f in c.get("facts", []))
    qs = "\n".join(f"- {q['id']} ({'true/false' if q['type'] == 'bool' else 'номер реплики или null'}): {q['question']}" for q in c["conditions"])
    schema = '{"conditions": {' + ", ".join(f'"{q["id"]}": ...' for q in c["conditions"]) + '}, "confidence": <0..1>, "evidence": [номера реплик], "explanation": "<1-2 предложения>"}'
    return (f"Критерий {c['id']} «{c['name']}».\nПравило: {c['rule']}\n" + (f"\nФакты системы (достоверны):\n{fx}\n" if fx else "")
            + f"\nИтоговый ответ посчитает система. Ответь только на условия:\n{qs}\n\nВерни JSON: {schema}")


def parse_json(text):
    m = re.search(r"\{.*\}", text, re.S)
    try:
        return json.loads(m.group(0)) if m else {}
    except json.JSONDecodeError:
        return {}


def norm(c, a):
    a = str(a).strip().lower().replace("n/a", "na")
    return a if a in c["answers"] else None


class Runner:
    def __init__(self, model=SONNET, effort="low", budget=30.0):
        self.client = anthropic.Anthropic(max_retries=4, timeout=90)
        self.model, self.effort, self.budget, self.spent = model, effort, budget, 0.0

    def cost(self, u):
        i, o, r, w = PRICES[self.model]
        return (u.input_tokens * i + u.output_tokens * o + (u.cache_read_input_tokens or 0) * r
                + (u.cache_creation_input_tokens or 0) * w) / 1e6

    def call(self, blocks, max_tokens):
        if self.spent > self.budget:
            raise RuntimeError(f"Бюджет ${self.budget} исчерпан")
        r = self.client.messages.create(model=self.model, max_tokens=max_tokens,
                                        system=[{"type": "text", "text": SYSTEM}],
                                        messages=[{"role": "user", "content": blocks}],
                                        output_config={"effort": self.effort})
        c = self.cost(r.usage)
        self.spent += c
        return parse_json("".join(b.text for b in r.content if b.type == "text")), c

    # --- режимы ---
    def single(self, rec, criteria=None):
        criteria = criteria or CRITERIA
        crits = "\n\n".join(crit_block(c) for c in criteria)
        schema = "{" + ", ".join(f'"{c["id"]}": {ITEM if i == 0 else "{...}"}' for i, c in enumerate(criteria)) + "}"
        out, cost = self.call([{"type": "text", "text": "ТРАНСКРИПТ:\n" + transcript_text(rec)},
                               {"type": "text", "text": f"ЧЕК-ЛИСТ:\n{crits}\n\nОцени ВСЕ критерии. Верни JSON: {schema}"}], 12000)
        return {c["id"]: out.get(c["id"], {}) for c in criteria}, cost

    def criterion(self, rec, ids=None, warm=True, criteria=None):
        """По одному запросу на критерий; транскрипт — общий кешируемый префикс."""
        crit = {c["id"]: c for c in (criteria or CRITERIA)}
        ids = ids or list(crit)
        facts = facts_of(rec)
        prefix = {"type": "text", "text": "ТРАНСКРИПТ:\n" + transcript_text(rec), "cache_control": {"type": "ephemeral"}}

        def one(cid):
            c = crit[cid]
            try:
                out, cost = self.call([prefix, {"type": "text", "text": crit_prompt(c, facts)}], 4000)
            except Exception as e:  # сбой одного критерия не роняет остальные
                return cid, ({"error": f"{type(e).__name__}: {str(e)[:200]}", "criterion_hash": crit_hash(c)}, 0.0)
            if c.get("decision"):
                conds = derived(out.get("conditions", {}), {k: facts[k] for k in c.get("facts", [])})
                out["answer"] = decide(c, conds)
                out["conditions"] = conds
            out["criterion_hash"] = crit_hash(c)
            return cid, (out, cost)

        res, todo = {}, list(ids)
        if warm and len(todo) > 1:  # первый запрос пишет кеш
            cid, v = one(todo.pop(0)); res[cid] = v
        with ThreadPoolExecutor(8) as ex:
            res.update(dict(ex.map(one, todo)))
        return {k: v[0] for k, v in res.items()}, sum(v[1] for v in res.values())

    def reevaluate(self, rec, prev_items, criteria):
        """Переоценка по новой версии чек-листа: модель вызывается только для новых/изменённых критериев."""
        changed = [c["id"] for c in criteria
                   if prev_items.get(c["id"], {}).get("criterion_hash") != crit_hash(c)]
        items = {c["id"]: prev_items[c["id"]] for c in criteria if c["id"] not in changed}
        cost = 0.0
        if changed:
            new, cost = self.criterion(rec, changed, warm=len(changed) > 1, criteria=criteria)
            items.update(new)
        return items, changed, cost


def answers_of(items, criteria=None):
    return {c["id"]: norm(c, items.get(c["id"], {}).get("answer")) for c in (criteria or CRITERIA)}


def total_score(ans, criteria=None):
    raw = w_app = 0.0
    for c in criteria or CRITERIA:
        if not c["weight"]:
            continue
        a = ans.get(c["id"])
        if a in (None, "na"):
            continue
        w_app += c["weight"]
        if a == "yes":
            raw += c["weight"]
        elif a.isdigit():
            raw += c["weight"] * int(a) / max(int(x) for x in c["answers"] if x.isdigit())
    return round(raw * 100 / w_app + 1e-9, 2) if w_app else None
