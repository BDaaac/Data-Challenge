"""Dataverse Web API pull adapter. No AI calls; mappings must be configured explicitly."""
import json, os, re, time, uuid
from datetime import datetime
from urllib.parse import urlparse
import httpx
from fastapi import APIRouter, Depends, HTTPException
from .auth import roles
from .db import all_, one, run, J, atomic_workflow

router=APIRouter(prefix="/api/integrations/dynamics")

def configuration():
    origin=os.environ.get("DYNAMICS_URL","").rstrip("/")
    parsed=urlparse(origin)
    if parsed.scheme!="https" or not parsed.hostname or parsed.username or parsed.path or parsed.query or parsed.fragment:
        raise ValueError("DYNAMICS_URL must be an HTTPS origin")
    entity=os.environ.get("DYNAMICS_ENTITY","")
    if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]*",entity):
        raise ValueError("DYNAMICS_ENTITY is required")
    fields=json.loads(os.environ.get("DYNAMICS_FIELDS","{}"))
    required={"id","operator","team","transcript","occurred_at","channel","language"}
    if set(fields)!=required or any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*",v) for v in fields.values()):
        raise ValueError("DYNAMICS_FIELDS must map all seven contract fields")
    operators=json.loads(os.environ.get("DYNAMICS_OPERATORS","{}"))
    teams=json.loads(os.environ.get("DYNAMICS_TEAMS","{}"))
    if not isinstance(operators,dict) or not isinstance(teams,dict) or not operators or not teams:
        raise ValueError("Employee and team mappings are required")
    token=os.environ.get("DYNAMICS_ACCESS_TOKEN")
    if not token: raise ValueError("DYNAMICS_ACCESS_TOKEN is required")
    return origin,entity,fields,operators,teams,token

def records(config,transport=None,sleep=time.sleep):
    origin,entity,fields,_,_,token=config
    url=origin+"/api/data/v9.2/"+entity+"?$select="+",".join(fields.values())
    with httpx.Client(headers={"Authorization":"Bearer "+token,"Accept":"application/json","OData-Version":"4.0"},timeout=20,follow_redirects=False,transport=transport) as client:
        for page in range(100):
            if not url.startswith(origin+"/api/data/v9.2/"):
                raise ValueError("Unsafe Dataverse pagination URL")
            for attempt in range(3):
                response=client.get(url)
                if response.status_code not in (429,502,503,504): break
                if attempt<2:
                    delay=response.headers.get("Retry-After","1")
                    sleep(min(float(delay) if delay.isdigit() else 1,10))
            if response.status_code!=200:
                # Never persist response bodies, tokens or URLs with query data.
                raise ValueError(f"Dataverse HTTP {response.status_code}")
            data=response.json()
            if not isinstance(data.get("value"),list): raise ValueError("Invalid Dataverse page")
            for item in data["value"]:
                yield {name:item.get(field) for name,field in fields.items()}
            url=data.get("@odata.nextLink")
            if not url: return
        raise ValueError("Pagination limit reached; narrow the source view")

@atomic_workflow
def import_record(record,config):
    origin,entity,_,operators,teams,_=config
    external=str(uuid.UUID(str(record["id"])))
    login=operators.get(str(record["operator"]))
    team=teams.get(str(record["team"]))
    user=one("SELECT * FROM users WHERE login=%s AND role='op' AND active",login)
    if not user or not team or user["team"]!=team: raise ValueError("Employee/team mapping mismatch")
    transcript=record["transcript"]
    if isinstance(transcript,str): transcript=json.loads(transcript)
    if not isinstance(transcript,list) or not transcript or len(transcript)>10000:
        raise ValueError("Invalid transcript")
    normalized=[]
    for turn in transcript:
        if not isinstance(turn,dict) or turn.get("speaker") not in ("operator","client","bot","system") or not isinstance(turn.get("text"),str) or not turn["text"].strip():
            raise ValueError("Invalid transcript turn")
        normalized.append({**turn,"text":turn["text"].strip()})
    if not any(t["speaker"]=="operator" for t in normalized): raise ValueError("No operator turn")
    if record["channel"] not in ("agent chat","voice call") or record["language"] not in ("RU","KZ","EN"):
        raise ValueError("Unsupported channel/language")
    at=datetime.fromisoformat(record["occurred_at"].replace("Z","+00:00"))
    if at.tzinfo is None: raise ValueError("Timestamp must include timezone")
    source=origin+"/"+entity
    old=one("""SELECT d.* FROM external_dialogs x JOIN dialogs d ON d.id=x.dialog_id
               WHERE x.source=%s AND x.external_id=%s""",source,external)
    if old:
        if old["transcript"]!=normalized or old["operator"]!=user["name"] or old["team"]!=team or old["channel"]!=record["channel"] or old["language"]!=record["language"] or old["occurred_at"]!=at:
            raise ValueError("External dialog changed; manual reconciliation required")
        return False
    did="d365-"+uuid.uuid5(uuid.NAMESPACE_URL,source+"/"+external).hex
    run("""INSERT INTO dialogs(id,channel,language,transcript,operator,team,source,occurred_at)
           VALUES (%s,%s,%s,%s,%s,%s,'dynamics',%s)""",did,record["channel"],record["language"],J(normalized),user["name"],team,at)
    run("INSERT INTO external_dialogs VALUES (%s,%s,%s)",source,external,did)
    return True

@router.get("")
def status(u=Depends(roles("adm"))):
    return all_("SELECT * FROM dynamics_sync ORDER BY id DESC LIMIT 30")

@router.post("/sync")
def sync(u=Depends(roles("adm"))):
    try: config=configuration()
    except (ValueError,TypeError) as exc: raise HTTPException(422,str(exc))
    jid=run("INSERT INTO dynamics_sync DEFAULT VALUES RETURNING id")["id"]
    added=skipped=0
    try:
        for record in records(config):
            if import_record(record,config): added+=1
            else: skipped+=1
            run("UPDATE dynamics_sync SET imported=%s,skipped=%s WHERE id=%s",added,skipped,jid)
    except Exception:
        run("UPDATE dynamics_sync SET status='error',finished_at=now(),error=%s WHERE id=%s",
            "Синхронизация прервана: проверьте доступ, контракт и сопоставления. Повтор безопасен.",jid)
        raise HTTPException(502,{"sync_id":jid,"error":"Синхронизация прервана; проверьте журнал"})
    run("UPDATE dynamics_sync SET status='done',finished_at=now() WHERE id=%s",jid)
    return {"id":jid,"imported":added,"skipped":skipped}
