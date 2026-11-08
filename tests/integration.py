"""Creates and drops its own database; never uses the application's DATABASE_URL."""
import os, uuid, unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import psycopg2
from psycopg2 import sql
from psycopg2.extensions import parse_dsn, make_dsn

admin_dsn = os.environ.get("TEST_PG_ADMIN", "postgresql://cqa@127.0.0.1:5433/postgres")
name = "cqa_test_" + uuid.uuid4().hex
admin = psycopg2.connect(admin_dsn); admin.autocommit = True
with admin.cursor() as c:
    c.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
params = parse_dsn(admin_dsn); params["dbname"] = name
os.environ["DATABASE_URL"] = make_dsn(**params)
os.environ["DEMO_LOGIN"] = "1"
from app import db, engine, main, seed
from fastapi.testclient import TestClient

class Workflows(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        seed.seed()
        cls.client = TestClient(main.app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None,None,None)

    def login(self, role, name=None):
        u=db.one("SELECT * FROM users WHERE role=%s AND (%s::text IS NULL OR name=%s) LIMIT 1",role,name,name)
        c=TestClient(main.app)
        self.assertEqual(c.post(f"/api/auth/demo/{u['id']}").status_code,200)
        self.addCleanup(c.close)
        return c,u

    def test_access(self):
        op,u=self.login("op")
        foreign=db.one("SELECT id FROM dialogs WHERE operator<>%s LIMIT 1",u["name"])["id"]
        self.assertEqual(op.get("/api/dialogs/"+foreign).status_code,404)
        own=db.one("SELECT id FROM dialogs WHERE operator=%s LIMIT 1",u["name"])["id"]
        db.run("UPDATE dialogs SET wf_status='review' WHERE id=%s",own)
        self.assertEqual(op.get("/api/dialogs/"+own).status_code,404)
        admin,_=self.login("adm")
        duplicate=admin.post("/api/users",json={"login":"duplicate_identity","name":u["name"],"role":"qa"})
        self.assertEqual(duplicate.status_code,200)
        uid=db.one("SELECT id FROM users WHERE login='duplicate_identity'")["id"]
        self.assertEqual(admin.patch(f"/api/users/{uid}",json={"role":"op"}).status_code,409)
        lead,manager=self.login("lead")
        foreign_group=db.one("SELECT id FROM dialogs WHERE team<>%s LIMIT 1",manager["team"])["id"]
        self.assertEqual(lead.get("/api/dialogs/"+foreign_group).status_code,404)
        self.assertTrue(all(d["team"]==manager["team"] for d in lead.get("/api/dialogs").json()))
        self.assertEqual(lead.post("/api/appeals/1/withdraw",json={}).status_code,403)
        self.assertEqual(lead.post("/api/appeals/1/decide",json={}).status_code,403)

    def test_z_checklist_publication_preserves_history(self):
        qa,_=self.login("qa")
        before=db.all_("SELECT id,total,checklist_id FROM evaluations ORDER BY id")
        calibration=qa.get("/api/calibration").json()
        r=qa.post("/api/checklists/draft")
        self.assertEqual(r.status_code,200,r.text)
        cid=r.json()["id"]
        criteria=engine.checklist(cid)["criteria"]
        criteria[0]["id"]="c99"
        r=qa.put(f"/api/checklists/{cid}",json={"criteria":criteria})
        self.assertEqual(r.status_code,200,r.text)
        r=qa.post(f"/api/checklists/{cid}/publish",json={})
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(db.all_("SELECT id,total,checklist_id FROM evaluations ORDER BY id"),before)
        self.assertEqual(qa.get("/api/calibration").json()["answers"],calibration["answers"])
        self.assertEqual(qa.get("/api/stats/overview").status_code,200)

    def test_offline_reuse_without_ai_client(self):
        qa,u=self.login("qa")
        e=db.one("""SELECT e.* FROM evaluations e JOIN dialogs d ON d.id=e.dialog_id
                    WHERE e.is_current AND e.status='done' AND e.job_id IS NULL AND d.wf_status<>'appeal' LIMIT 1""")
        result,plan=engine._plan_job("Offline reuse","rescore",[e["dialog_id"]],u["id"])
        self.assertEqual(plan[0][1],[])
        # The suite already forbids constructing a real AI client.
        engine.run_evaluation(plan[0][0])
        self.assertEqual(engine.current_eval(e["dialog_id"])["total"],e["total"])

    def test_retry_is_serialized(self):
        e=db.one("SELECT * FROM evaluations WHERE is_current LIMIT 1")
        db.run("UPDATE evaluations SET status='partial' WHERE id=%s",e["id"])
        db.run("UPDATE eval_items SET status='error' WHERE eval_id=%s AND crit_id='c1'",e["id"])
        db.run("UPDATE appeals SET status='withdrawn' WHERE dialog_id=%s AND status='open'",e["dialog_id"])
        engine._prepare_retry(e["id"])
        with self.assertRaises(main.HTTPException) as error: engine._prepare_retry(e["id"])
        self.assertEqual(error.exception.status_code,409)

    def test_legacy_migration(self):
        db.run("ALTER TABLE users DROP CONSTRAINT users_role_check")
        uid=db.run("INSERT INTO users(login,name,role,pw_hash) VALUES ('legacy_test','Legacy test','head','unused') RETURNING id")["id"]
        db.init_schema()
        user=db.one("SELECT * FROM users WHERE id=%s",uid)
        self.assertEqual(user["role"],"qa")
        self.assertFalse(user["active"])
        self.assertEqual(user["login"],"legacy_test")
        self.assertEqual(self.client.post(f"/api/auth/demo/{uid}").status_code,404)

    def test_full_review_cycle_with_fake_model(self):
        qa,u=self.login("qa")
        did="synthetic-"+uuid.uuid4().hex
        body={"records":[{"conversation_id":did,"channel":"agent chat","language":"RU","transcript":[{"speaker":"client","text":"Здравствуйте"},{"speaker":"operator","text":"Здравствуйте, меня зовут Тестовый"}]}],"evaluate":False}
        r=qa.post("/api/dialogs",json=body)
        self.assertEqual(r.status_code,200,r.text)
        result,plan=engine._plan_job("Test","evaluate",[did],u["id"])
        duplicate,empty=engine._plan_job("Test","evaluate",[did],u["id"])
        self.assertEqual(result["id"],duplicate["id"])
        self.assertEqual(empty,[])
        def fake(runner,rec,c,facts,prefix):
            answer="yes" if c["type"]=="flag" else ("yes" if "yes" in c["answers"] else str(engine.scale_max(c)))
            return {"answer":answer,"confidence":1,"evidence":[2],"explanation":"Synthetic test answer"},0,0
        with patch.object(engine.cqa,"Runner",return_value=object()), patch.object(engine,"evaluate_criterion",side_effect=fake):
            engine.run_evaluation(plan[0][0])
        self.assertEqual(db.one("SELECT wf_status FROM dialogs WHERE id=%s",did)["wf_status"],"review")
        self.assertEqual(qa.post("/api/dialogs/"+did+"/confirm").status_code,200)
        d=db.one("SELECT * FROM dialogs WHERE id=%s",did)
        op,_=self.login("op",d["operator"])
        self.assertEqual(op.get("/api/dialogs/"+did).status_code,200)
        self.assertEqual(op.post("/api/dialogs/"+did+"/acknowledge").status_code,200)
        self.assertEqual(qa.get("/api/stats/overview?start=2100-01-01").json()["done"],0)
        self.assertEqual(qa.get("/api/stats/overview?start=invalid").status_code,422)

    def test_dynamics_import(self):
        from app.dynamics import import_record
        user=db.one("SELECT * FROM users WHERE role='op' LIMIT 1")
        config=("https://example.crm.dynamics.com","fq_dialogs",{},{"external-op":user["login"]},{"external-team":user["team"]},"unused")
        record={"id":str(uuid.uuid4()),"operator":"external-op","team":"external-team","transcript":[{"speaker":"operator","text":"Здравствуйте"}],"channel":"agent chat","language":"RU","occurred_at":"2026-01-01T00:00:00Z"}
        self.assertTrue(import_record(record,config))
        self.assertFalse(import_record(record,config))
        op,_=self.login("op",user["name"])
        with patch.dict(os.environ,{"DYNAMICS_URL":config[0],"DYNAMICS_ENTITY":config[1]}):
            # Imported dialog is not yet published: context does not grant access.
            self.assertEqual(op.get("/api/integrations/dynamics/dialog/"+record["id"]).status_code,404)
            qa,_=self.login("qa")
            self.assertEqual(qa.get("/api/integrations/dynamics/dialog/"+record["id"]).status_code,200)
        record["transcript"][0]["text"]="Изменённый текст"
        with self.assertRaises(ValueError): import_record(record,config)
        self.assertEqual(db.one("SELECT count(*) n FROM external_dialogs")["n"],1)

    def test_coaching_form_to_operator_and_review(self):
        lead,manager=self.login("lead")
        member=db.one("SELECT * FROM users WHERE role='op' AND active AND team=%s LIMIT 1",manager["team"])
        op,_=self.login("op",member["name"])
        created=lead.post("/api/lead/plans",json={"kind":"task","operator":member["name"],"title":"Improve consultation","expected_result":"Ask a clarifying question in the next five dialogues"})
        self.assertEqual(created.status_code,200,created.text)
        pid=created.json()["id"]; tid=created.json()["task_id"]
        self.assertTrue(any(t["id"]==tid for t in op.get("/api/development").json()))
        self.assertEqual(lead.patch(f"/api/lead/plans/{pid}",json={"status":"done"}).status_code,409)
        self.assertEqual(op.post(f"/api/development/{tid}/submit",json={"response":"Practised in five dialogues"}).status_code,200)
        self.assertEqual(lead.post(f"/api/development/{tid}/review",json={"accepted":False,"feedback":"Please include specific examples"}).status_code,200)
        self.assertEqual(op.post(f"/api/development/{tid}/submit",json={"response":"Added examples and completed the practice"}).status_code,200)
        self.assertEqual(lead.post(f"/api/development/{tid}/review",json={"accepted":True,"feedback":"Examples checked and accepted"}).status_code,200)
        plan=next(p for p in lead.get('/api/lead/workspace').json()['plans'] if p['id']==pid)
        self.assertEqual(plan['status'],'done'); self.assertEqual(plan['task_status'],'completed')
        task=next(t for t in op.get('/api/development').json() if t['id']==tid)
        self.assertEqual(len(task['history']),5)
        foreign=db.one("SELECT * FROM users WHERE role='op' AND id<>%s LIMIT 1",member['id'])
        other,_=self.login('op',foreign['name'])
        self.assertFalse(any(t['id']==tid for t in other.get('/api/development').json()))
        self.assertEqual(other.post(f'/api/development/{tid}/submit',json={'response':'Not my task'}).status_code,404)

    def test_development(self):
        lead,u=self.login("lead")
        d=db.one("SELECT * FROM dialogs WHERE team=%s LIMIT 1",u["team"])
        db.run("UPDATE dialogs SET wf_status='published' WHERE id=%s",d["id"])
        op,_=self.login("op",d["operator"])
        body={"request_key":str(uuid.uuid4()),"dialog_id":d["id"],"instruction":"Разобрать ошибку и описать исправление"}
        r=lead.post("/api/development",json=body)
        self.assertEqual(r.status_code,200,r.text)
        tid=r.json()["id"]
        self.assertEqual(lead.post("/api/development",json=body).json()["id"],tid)
        self.assertEqual(op.post(f"/api/development/{tid}/review",json={}).status_code,403)
        self.assertEqual(op.post(f"/api/development/{tid}/submit",json={"response":"Разбор выполнен"}).status_code,200)
        self.assertEqual(lead.post(f"/api/development/{tid}/review",json={"accepted":True,"feedback":"Результат подтверждён"}).status_code,200)
        self.assertEqual(op.get("/api/development").json()[0]["status"],"completed")
        other=db.one("SELECT id FROM users WHERE role='op' AND name<>%s LIMIT 1",d["operator"])
        foreign=TestClient(main.app); self.addCleanup(foreign.close)
        foreign.post(f"/api/auth/demo/{other['id']}")
        self.assertEqual(foreign.get("/api/development").json(),[])
        self.assertEqual(foreign.post(f"/api/development/{tid}/submit",json={"response":"Подмена ответа"}).status_code,404)
        self.assertEqual({r["role"] for r in db.all_("SELECT DISTINCT role FROM users")},{"qa","op","lead","adm"})

    def test_atomic_appeal(self):
        d=db.one("SELECT d.* FROM dialogs d JOIN evaluations e ON e.dialog_id=d.id AND e.is_current WHERE d.wf_status IN ('published','acknowledged') AND e.status='done' LIMIT 1")
        self.assertIsNotNone(d)
        op,u=self.login("op",d["operator"])
        e=engine.current_eval(d["id"])
        criterion=engine.checklist(e["checklist_id"])["criteria"][0]
        answer=engine.items_of(e["id"])[criterion["id"]]["answer"]
        want=next(a for a in criterion["answers"] if a!=answer)
        body={"text":"Проверка аргумента апелляции #1","items":[{"crit":criterion["id"],"want":want}]}
        path="/api/dialogs/"+d["id"]+"/appeal"
        # Fault after insert must roll back status, appeal and notification together.
        with patch.object(engine,"notify",side_effect=RuntimeError("injected")):
            with self.assertRaises(RuntimeError):
                op.post(path,json=body)
        self.assertEqual(db.one("SELECT count(*) n FROM appeals WHERE dialog_id=%s",d["id"])["n"],0)
        self.assertEqual(db.one("SELECT wf_status FROM dialogs WHERE id=%s",d["id"])["wf_status"],d["wf_status"])
        with ThreadPoolExecutor(2) as pool:
            results=list(pool.map(lambda _: op.post(path,json=body),range(2)))
        self.assertEqual(sorted(r.status_code for r in results),[200,409])
        aid=next(r.json()["id"] for r in results if r.status_code==200)
        qa,_=self.login("qa")
        r=qa.post(f"/api/appeals/{aid}/decide",json={"decisions":{criterion["id"]:True},"comment":"Подтверждено проверкой"})
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(engine.items_of(e["id"])[criterion["id"]]["answer"],answer)
        self.assertEqual(engine.items_of(engine.current_eval(d["id"])["id"])[criterion["id"]]["answer"],want)
        self.assertEqual(op.get("/api/evaluations/"+str(e["id"])).status_code,200)
        self.assertEqual(op.post("/api/dialogs/"+d["id"]+"/acknowledge").status_code,200)

try:
    with patch("anthropic.Anthropic", side_effect=AssertionError("Paid AI forbidden")):
        suite=unittest.defaultTestLoader.loadTestsFromTestCase(Workflows)
        result=unittest.TextTestRunner(verbosity=2).run(suite)
finally:
    if db._pool: db._pool.closeall()
    with admin.cursor() as c:
        c.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
    admin.close()
if not result.wasSuccessful(): raise SystemExit(1)
