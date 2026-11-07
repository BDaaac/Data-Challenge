"""Integration checks in an isolated PostgreSQL schema, never the app's data."""
import uuid
from unittest.mock import patch

import psycopg2
from psycopg2 import sql
from psycopg2.pool import ThreadedConnectionPool
from fastapi.testclient import TestClient
from app import db, auth, main


def check():
    schema = "test_lead_" + uuid.uuid4().hex
    admin = psycopg2.connect(db.DSN)
    admin.autocommit = True
    pool = None
    try:
        with admin.cursor() as c:
            c.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        pool = ThreadedConnectionPool(1, 4, db.DSN, options="-c search_path=" + schema)
        with patch.object(db, "_pool", pool):
            db.init_schema()
            lead = db.run("INSERT INTO users(login,name,role,team,pw_hash) VALUES('lead','Lead','lead','A','unused') RETURNING *")
            db.run("INSERT INTO users(login,name,role,team,pw_hash) VALUES('op','Agent','op','A','unused'),('other','Other','op','B','unused')")
            db.run("INSERT INTO dialogs(id,channel,language,transcript,operator,team,source) VALUES('a','agent chat','RU','[]','Agent','A','test'),('b','agent chat','RU','[]','Other','B','test')")
            main.app.dependency_overrides[auth.current_user] = lambda: lead
            client = TestClient(main.app)  # no lifespan, no evaluation recovery
            result = client.get('/api/lead/workspace')
            assert result.status_code == 200, result.text
            assert [d['id'] for d in result.json()['rows']] == ['a']
            assert [m['name'] for m in result.json()['members']] == ['Agent']
            db.run("INSERT INTO checklists(slug,name,channel,version,status,criteria) VALUES('test','Test','all',1,'published',%s)", db.J([{'id':'c2','name':'Discovery'}]))
            body = dict(title='Improve discovery', note='Ask clarifying questions', operator='Agent', kind='feedback', dialog_id='a', due='2026-12-01', expected_result='Five dialogues with clarifying questions', priority='high', criterion='c2')
            created = client.post('/api/lead/plans', json=body)
            assert created.status_code == 200, created.text
            pid = created.json()['id']
            assert created.json()['expected_result'] == body['expected_result']
            assert created.json()['priority'] == 'high'
            assert created.json()['criterion_name'] == 'Discovery'
            assert client.patch(f'/api/lead/plans/{pid}', json={'status':'work'}).status_code == 200
            assert client.get('/api/lead/workspace').json()['plans'][0]['status'] == 'work'
            for changes in ({'operator':'Other'}, {'dialog_id':'b'}, {'due':'invalid'}, {'title':'x'}, {'kind':'invalid'}, {'priority':'urgent'}, {'criterion':'missing'}, {'expected_result':'x'*4001}):
                assert client.post('/api/lead/plans', json=body | changes).status_code in (404,422)
            other = db.run("INSERT INTO coaching_plans(team,kind,title,created_by) VALUES('B','plan','Other plan',%s) RETURNING id", lead['id'])
            assert client.patch(f"/api/lead/plans/{other['id']}",json={'status':'done'}).status_code == 404
            assert client.patch(f'/api/lead/plans/{pid}',json={'status':'invalid'}).status_code == 422
            for role in ('op','qa','adm'):
                main.app.dependency_overrides[auth.current_user] = lambda role=role: dict(lead,role=role)
                assert client.get('/api/lead/workspace').status_code == 403
                assert client.post('/api/lead/plans',json=body).status_code == 403
            main.app.dependency_overrides[auth.current_user] = lambda: dict(lead,team=None)
            assert client.get('/api/lead/workspace').status_code == 403
            assert db.one('SELECT count(*) AS n FROM coaching_plans')['n'] == 2
        print('PASS: team isolation, persisted plans/status, validation, role restrictions; isolated schema only')
    finally:
        main.app.dependency_overrides.clear()
        if pool:
            pool.closeall()
        with admin.cursor() as c:
            assert schema.startswith('test_lead_') and len(schema) == 42
            c.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))
        admin.close()


if __name__ == '__main__':
    check()
