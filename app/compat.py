"""Совместимость FastAPI 0.112 со Starlette 1.x: в Starlette 1.0 убраны on_startup/on_shutdown у Router и Starlette.
Импортируется до fastapi. Со связкой из requirements.txt (fastapi 0.115 + starlette 0.46) ничего не меняет."""
import functools
import inspect

import starlette.applications as _apps
import starlette.routing as _routing


def _drop(cls, names=("on_startup", "on_shutdown")):
    init = cls.__init__
    params = inspect.signature(init).parameters
    gone = [n for n in names if n not in params]
    if not gone:
        return

    @functools.wraps(init)
    def wrapped(self, *a, **kw):
        for n in gone:
            kw.pop(n, None)
        return init(self, *a, **kw)
    cls.__init__ = wrapped


_drop(_routing.Router)
_drop(_apps.Starlette)
