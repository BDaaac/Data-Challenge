"""Вход: пароль (PBKDF2), сессия в httpOnly cookie, тайм-аут бездействия, блокировка после 5 ошибок."""
import hashlib, hmac, os, secrets, time

from fastapi import Depends, HTTPException, Request

from .db import one, run

COOKIE = "cqa_session"
IDLE_MIN = int(os.environ.get("SESSION_IDLE_MIN", "720"))  # демо: сессия не истекает во время защиты
DEMO = os.environ.get("DEMO_LOGIN", "1") == "1"
_fails = {}  # login -> [время неудачных попыток]


def hash_pw(pw, salt=None):
    salt = salt or secrets.token_hex(8)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 120_000).hex()
    return f"{salt}${h}"


def check_pw(pw, stored):
    salt, _ = stored.split("$", 1)
    return hmac.compare_digest(hash_pw(pw, salt), stored)


def locked(login):
    now = time.time()
    _fails[login] = [t for t in _fails.get(login, []) if now - t < 600]
    return len(_fails[login]) >= 5


def fail(login):
    _fails.setdefault(login, []).append(time.time())


def create_session(user_id):
    tok = secrets.token_urlsafe(32)
    run("INSERT INTO sessions(token,user_id) VALUES (%s,%s)", tok, user_id)
    return tok


def current_user(request: Request):
    tok = request.cookies.get(COOKIE)
    if not tok:
        raise HTTPException(401, "Войдите в систему")
    s = one(f"""SELECT u.*, s.last_seen < now() - interval '{IDLE_MIN} minutes' AS expired
               FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=%s""", tok)
    if not s or s["expired"] or not s["active"]:
        if s:
            run("DELETE FROM sessions WHERE token=%s", tok)
        raise HTTPException(401, "Сессия истекла. Войдите снова")
    run("UPDATE sessions SET last_seen=now() WHERE token=%s", tok)
    s.pop("pw_hash", None)
    return s


def roles(*allowed):
    def dep(u=Depends(current_user)):
        if u["role"] not in allowed:
            raise HTTPException(403, "Недостаточно прав для этого действия")
        return u
    return dep
