"""Team-lead workspace and persistent coaching plans, scoped to the lead's team."""
from datetime import date

from fastapi import APIRouter, Body, Depends, HTTPException
from .auth import roles
from .db import all_, one, tx

router = APIRouter(prefix="/api/lead")


def require_team(u):
    if not u.get("team"):
        raise HTTPException(403, "Для руководителя не назначена группа")
    return u["team"]


@router.get("/workspace")
def workspace(u=Depends(roles("lead"))):
    team = require_team(u)
    rows = all_("""SELECT d.id,d.operator,d.team,d.channel,d.language,d.wf_status,d.occurred_at,
        e.id AS eval_id,e.total,e.critical,e.status AS eval_status,e.created_at AS evaluated_at,e.finished_at AS evaluation_finished_at,
        c.criteria FROM dialogs d LEFT JOIN evaluations e ON e.dialog_id=d.id AND e.is_current
        LEFT JOIN checklists c ON c.id=e.checklist_id WHERE d.team=%s ORDER BY d.occurred_at DESC""", team)
    ids = [r["eval_id"] for r in rows if r["eval_id"]]
    items = all_("SELECT eval_id,crit_id,answer,ai_answer,source,status,explanation FROM eval_items WHERE eval_id=ANY(%s)", ids) if ids else []
    by = {}
    for it in items:
        by.setdefault(it["eval_id"], {})[it["crit_id"]] = it
    for r in rows:
        r["items"] = by.get(r["eval_id"], {})
        r["criteria"] = r["criteria"] or []
    return {"rows": rows,
            "members": all_("SELECT id,name FROM users WHERE role='op' AND active AND team=%s ORDER BY name", team),
            "plans": all_("SELECT * FROM coaching_plans WHERE team=%s ORDER BY created_at DESC,id DESC", team),
            "events": all_("""SELECT ev.at,ev.text,d.id AS dialog_id,d.operator FROM events ev
                JOIN dialogs d ON d.id=ev.dialog_id WHERE d.team=%s ORDER BY ev.at DESC,ev.id DESC LIMIT 30""", team)}


def plan_fields(body, team):
    title = str(body.get("title", "")).strip()
    note = str(body.get("note", "")).strip()
    operator = str(body.get("operator", "")).strip() or None
    dialog_id = str(body.get("dialog_id", "")).strip() or None
    kind = body.get("kind", "plan")
    if not 3 <= len(title) <= 240 or len(note) > 4000 or kind not in ("plan", "task", "feedback"):
        raise HTTPException(422, "Укажите название от 3 до 240 символов и корректный тип записи")
    if operator and not one("SELECT id FROM users WHERE role='op' AND team=%s AND name=%s", team, operator):
        raise HTTPException(404, "Сотрудник не найден в вашей группе")
    if dialog_id:
        d = one("SELECT operator FROM dialogs WHERE id=%s AND team=%s", dialog_id, team)
        if not d or (operator and d["operator"] != operator):
            raise HTTPException(404, "Диалог не найден у выбранного сотрудника")
        operator = d["operator"]
    due = body.get("due") or None
    try:
        due = date.fromisoformat(due) if due else None
    except (ValueError, TypeError):
        raise HTTPException(422, "Укажите корректную дату")
    if kind == "feedback" and not operator:
        raise HTTPException(422, "Выберите сотрудника для обратной связи")
    return title, note, operator, dialog_id, kind, due


@router.post("/plans")
def create_plan(body: dict = Body(...), u=Depends(roles("lead"))):
    team = require_team(u)
    title, note, operator, dialog_id, kind, due = plan_fields(body, team)
    criterion = str(body.get("criterion") or "").strip() or None
    expected = str(body.get("expected_result") or "").strip()
    priority = body.get("priority", "medium")
    if priority not in ("low", "medium", "high") or len(expected) > 4000:
        raise HTTPException(422, "Проверьте приоритет и ожидаемый результат (до 4000 символов)")
    criterion_name = None
    if criterion:
        match = one("""SELECT c->>'name' AS name FROM checklists,
            jsonb_array_elements(criteria) c WHERE c->>'id'=%s ORDER BY version DESC LIMIT 1""", criterion)
        if not match:
            raise HTTPException(422, "Критерий не найден")
        criterion_name = match["name"]
    with tx() as c:
        c.execute("""INSERT INTO coaching_plans(team,operator,dialog_id,kind,title,note,due,created_by,criterion,criterion_name,expected_result,priority)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""", (team, operator, dialog_id, kind, title, note, due, u["id"], criterion, criterion_name, expected, priority))
        row = dict(c.fetchone())
        c.execute("INSERT INTO audit(user_id,action,object) VALUES(%s,%s,%s)", (u["id"], "Добавил запись для развития сотрудника", str(row["id"])))
    return row


@router.patch("/plans/{pid}")
def update_plan(pid: int, body: dict = Body(...), u=Depends(roles("lead"))):
    team = require_team(u)
    status = body.get("status")
    if status not in ("planned", "work", "done"):
        raise HTTPException(422, "Неизвестный статус")
    with tx() as c:
        c.execute("UPDATE coaching_plans SET status=%s,updated_at=now() WHERE id=%s AND team=%s RETURNING *", (status, pid, team))
        row = c.fetchone()
        if not row:
            raise HTTPException(404, "Запись не найдена")
        c.execute("INSERT INTO audit(user_id,action,object) VALUES(%s,%s,%s)", (u["id"], "Изменил статус плана: " + status, str(pid)))
    return dict(row)
