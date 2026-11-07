import os
import httpx
with httpx.Client(base_url="http://127.0.0.1:"+os.getenv("CQA_HTTP_PORT","8000")) as c:
    def get(path):
        r=c.get(path); r.raise_for_status(); return r
    assert "html" in get("/").headers["content-type"]
    get("/api/openapi.json")
    qa=next(u for u in get("/api/auth/demo").json()["users"] if u["role"]=="qa")
    c.post("/api/auth/demo/"+str(qa["id"])).raise_for_status()
    assert get("/api/auth/me").json()["role"]=="qa"
    rows=get("/api/dialogs").json()
    assert rows
    row=next(d for d in rows if d["eval_id"])
    assert get("/api/dialogs/"+row["id"]).json()["evaluation"]
    get("/api/queue")
    c.post("/api/auth/logout").raise_for_status()
    assert c.get("/api/auth/me").status_code==401
    print("PASS: HTML, schema, login, dialogs, evaluation, queue, logout")
