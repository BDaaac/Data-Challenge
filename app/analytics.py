"""Version-aware measurements; no active-checklist reinterpretation of history."""
from . import engine

def criterion_losses(rows, items, checklists):
    by_eval={}
    for item in items: by_eval.setdefault(item["eval_id"],{})[item["crit_id"]]=item
    groups={}
    for row in rows:
        cl=checklists[row["checklist_id"]]
        answers={k:v["answer"] for k,v in by_eval.get(row["eval_id"],{}).items()}
        scored=engine.score(cl["criteria"],answers)
        for c in cl["criteria"]:
            if c["type"]=="flag": continue
            key=(cl["id"],c["id"])
            g=groups.setdefault(key,{"crit":c["id"],"name":f"{c['name']} · v{cl['version']}","checklist_id":cl["id"],"applicable":0,"failed":0,"points":0,"examples":[]})
            item=by_eval.get(row["eval_id"],{}).get(c["id"])
            if not item or item["answer"] in (None,"na"): continue
            g["applicable"]+=1
            g["points"]+=scored["max"].get(c["id"],0)-scored["pts"].get(c["id"],0)
            if engine.is_failed(c,item["answer"]):
                g["failed"]+=1
                if len(g["examples"])<3:
                    g["examples"].append({"dialog":row["id"],"text":item.get("explanation","")})
    for g in groups.values():
        g["rate"]=round(g["failed"]/g["applicable"]*100) if g["applicable"] else 0
        g["points"]=round(g["points"]/max(len(rows),1),2)
    return sorted(groups.values(),key=lambda g:-g["points"])
