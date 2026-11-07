#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/.venv/cloud/pg/usr/lib/postgresql/17/bin:$PATH"
export LD_LIBRARY_PATH="$PWD/.venv/cloud/pg/usr/lib/x86_64-linux-gnu"
port="${CQA_DB_PORT:-5433}"
export DATABASE_URL="postgresql://cqa@127.0.0.1:$port/cqa"
test -e .pgdata/PG_VERSION || initdb -D "$PWD/.pgdata" -U cqa --auth-local=trust --auth-host=trust
pg_ctl -D "$PWD/.pgdata" status || pg_ctl -D "$PWD/.pgdata" -l "$PWD/.venv/cloud/postgres.log" -o "-h 127.0.0.1 -p $port -k $PWD/.venv/cloud" -w start
if ! psql -h 127.0.0.1 -p "$port" -U cqa -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='cqa'" | grep -q 1; then
 createdb -h 127.0.0.1 -p "$port" -U cqa cqa
fi
.venv/bin/python -m app.seed
exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port "${CQA_HTTP_PORT:-8000}"
