"""Подключение к PostgreSQL: пул соединений и короткие помощники для запросов."""
import json, os
from contextvars import ContextVar
from functools import wraps
from contextlib import contextmanager
from pathlib import Path

import psycopg2
import psycopg2.extras
from psycopg2.pool import ThreadedConnectionPool

ROOT = Path(__file__).resolve().parent.parent
for _line in (ROOT / ".env").read_text(encoding="utf-8").splitlines() if (ROOT / ".env").exists() else []:
    if "=" in _line and not _line.lstrip().startswith("#"):
        _k, _v = _line.split("=", 1)
        os.environ.setdefault(_k.strip(), _v.strip())

DSN = os.environ.get("DATABASE_URL", "postgresql://cqa@localhost:5433/cqa")
psycopg2.extras.register_default_jsonb(loads=json.loads, globally=True)
_pool = None
_connection = ContextVar("transaction_connection", default=None)


def pool():
    global _pool
    if _pool is None:
        _pool = ThreadedConnectionPool(1, 20, DSN)
    return _pool


@contextmanager
def tx():
    """Транзакция: commit при успехе, rollback при исключении."""
    existing = _connection.get()
    if existing is not None:
        with existing.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            yield cur
        return
    conn = pool().getconn()
    token = _connection.set(conn)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        _connection.reset(token)
        pool().putconn(conn)


def J(v):
    return psycopg2.extras.Json(v)


def all_(sql, *a):
    with tx() as c:
        c.execute(sql, a)
        return c.fetchall()


def one(sql, *a):
    with tx() as c:
        c.execute(sql, a)
        return c.fetchone()


def run(sql, *a):
    with tx() as c:
        c.execute(sql, a)
        return c.fetchone() if c.description else None


def init_schema():
    with tx() as c:
        c.execute((Path(__file__).parent / "schema.sql").read_text(encoding="utf-8"))


def atomic_workflow(fn):
    """One commit for a workflow and its audit/notifications; serialize writers.

    The transaction-scoped lock also serializes concurrent actions in other workers.
    Nested helpers use the same connection. Never submit background work here.
    """
    @wraps(fn)
    def wrapped(*args, **kwargs):
        with tx() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(724197)")
            return fn(*args, **kwargs)
    return wrapped
