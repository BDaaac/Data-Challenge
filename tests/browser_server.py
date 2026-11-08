"""Disposable seeded server for browser checks. Ctrl-C drops its database."""
import os, uuid
import psycopg2
from psycopg2 import sql
from psycopg2.extensions import parse_dsn, make_dsn
from unittest.mock import patch
import uvicorn
dsn=os.getenv("TEST_PG_ADMIN","postgresql://cqa@127.0.0.1:5433/postgres")
name="cqa_browser_"+uuid.uuid4().hex
admin=psycopg2.connect(dsn); admin.autocommit=True
with admin.cursor() as cur: cur.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
params=parse_dsn(dsn); params["dbname"]=name
os.environ["DATABASE_URL"]=make_dsn(**params)
os.environ["DEMO_LOGIN"]="1"
from app import db, seed
try:
    with patch("anthropic.Anthropic",side_effect=AssertionError("AI disabled in browser tests")):
        seed.seed()
        uvicorn.run("app.main:app",host="127.0.0.1",port=int(os.getenv("TEST_HTTP_PORT","18001")))
finally:
    if db._pool: db._pool.closeall()
    with admin.cursor() as cur: cur.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
    admin.close()
