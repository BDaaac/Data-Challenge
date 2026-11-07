"""Persistent coaching workflow; permissions follow current team membership."""
from uuid import UUID
from fastapi import APIRouter, Body, Depends, HTTPException
from .auth import roles
from .db import all_, one, run, atomic_workflow
from . import engine

router = APIRouter(prefix="/api/development")

def scope(u):
    if u["role"] == "op":
        return "t.operator_id=%s", [u["id"]]
    return "d.team=%s", [u["team"]]

def task_for(u, tid):
    where,args=scope(u)
    t=one(f"""SELECT t.*, d.team FROM development_tasks t JOIN dialogs d ON d.id=t.dialog_id
              WHERE t.id=%s AND {where}""",tid,*args)
    if not t: raise HTTPException(404,"Задача недоступна")
    return t

@router.get("")
def listing(u=Depends(roles("op","lead"))):
    where,args=scope(u)
    tasks=all_(f"""SELECT t.*, o.name AS operator_name FROM development_tasks t
                    JOIN dialogs d ON d.id=t.dialog_id JOIN users o ON o.id=t.operator_id
                    WHERE {where} ORDER BY t.created_at DESC""",*args)
    for task in tasks:
        task["history"]=all_("SELECT action,text,at FROM development_events WHERE task_id=%s ORDER BY id",task["id"])
    return tasks

@router.post("")
@atomic_workflow
def create(body:dict=Body(...),u=Depends(roles("lead"))):
    try: key=str(UUID(str(body.get("request_key",""))))
    except ValueError: raise HTTPException(422,"Нужен идентификатор запроса")
    text=str(body.get("instruction","")).strip()
    if len(text)<10: raise HTTPException(422,"Опишите обратную связь и ожидаемый результат")
    d=one("SELECT * FROM dialogs WHERE id=%s AND team=%s",body.get("dialog_id"),u["team"])
    if not d or d["wf_status"] not in ("published","acknowledged","revised","appeal"):
        raise HTTPException(404,"Опубликованный диалог группы не найден")
    op=one("SELECT id FROM users WHERE name=%s AND role='op' AND active",d["operator"])
    if not op: raise HTTPException(409,"Нет активной учётной записи оператора")
    old=one("SELECT * FROM development_tasks WHERE created_by=%s AND request_key=%s",u["id"],key)
    if old:
        if old["dialog_id"]!=d["id"] or old["instruction"]!=text:
            raise HTTPException(409,"Идентификатор уже использован с другими данными")
        return {"id":old["id"]}
    t=run("""INSERT INTO development_tasks(dialog_id,operator_id,created_by,request_key,instruction)
             VALUES (%s,%s,%s,%s,%s) RETURNING id""",d["id"],op["id"],u["id"],key,text)
    run("INSERT INTO development_events(task_id,user_id,action,text) VALUES (%s,%s,'assigned',%s)",t["id"],u["id"],text)
    engine.notify("Новая задача развития",f"development/{t['id']}",user_ids=[op["id"]])
    engine.event(d["id"],u["id"],f"Назначена задача развития №{t['id']}")
    return t

@router.post("/{tid}/submit")
@atomic_workflow
def submit(tid:int,body:dict=Body(...),u=Depends(roles("op"))):
    t=task_for(u,tid)
    response=str(body.get("response","")).strip()
    if len(response)<5: raise HTTPException(422,"Опишите выполненную работу")
    if t["status"]=="submitted" and t["response"]==response: return {"ok":True}
    if t["status"]!="assigned": raise HTTPException(409,"Задача уже отправлена")
    run("UPDATE development_tasks SET status='submitted',response=%s,submitted_at=now() WHERE id=%s",response,tid)
    run("INSERT INTO development_events(task_id,user_id,action,text) VALUES (%s,%s,'submitted',%s)",tid,u["id"],response)
    engine.notify("Задача развития ожидает проверки",f"development/{tid}",roles=["lead"],team=t["team"])
    return {"ok":True}

@router.post("/{tid}/review")
@atomic_workflow
def review(tid:int,body:dict=Body(...),u=Depends(roles("lead"))):
    t=task_for(u,tid)
    text=str(body.get("feedback","")).strip()
    accepted=body.get("accepted")
    if type(accepted) is not bool or len(text)<5: raise HTTPException(422,"Укажите решение и обратную связь")
    status="completed" if accepted else "assigned"
    if t["status"]==status and t["feedback"]==text: return {"ok":True}
    if t["status"]!="submitted": raise HTTPException(409,"Задача не ожидает проверки")
    run("UPDATE development_tasks SET status=%s,feedback=%s,reviewed_at=now() WHERE id=%s",status,text,tid)
    run("INSERT INTO development_events(task_id,user_id,action,text) VALUES (%s,%s,%s,%s)",tid,u["id"],status,text)
    engine.notify("Руководитель проверил задачу развития",f"development/{tid}",user_ids=[t["operator_id"]])
    engine.event(t["dialog_id"],u["id"],f"Задача развития №{tid}: "+("выполнена" if accepted else "возвращена"))
    return {"ok":True}
