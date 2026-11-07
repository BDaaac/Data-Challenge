#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
CQA_SETUP="$PWD/.venv/cloud"
python -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
. /etc/os-release
[ "$ID" = debian ] && [ "$VERSION_ID" = 13 ] || { echo "Requires Debian 13"; exit 1; }
mkdir -p ${CQA_SETUP}/apt/lists/partial ${CQA_SETUP}/debs ${CQA_SETUP}/pg
printf '%s\n' 'deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie main' > ${CQA_SETUP}/apt/sources.list
/usr/bin/apt-get -o Dir::Etc::sourcelist=${CQA_SETUP}/apt/sources.list -o Dir::Etc::sourceparts=- -o Dir::State::lists=${CQA_SETUP}/apt/lists update
(cd ${CQA_SETUP}/debs && /usr/bin/apt-get -o Dir::Etc::sourcelist=${CQA_SETUP}/apt/sources.list -o Dir::Etc::sourceparts=- -o Dir::State::lists=${CQA_SETUP}/apt/lists download postgresql-17 postgresql-client-17 liburing2)
for f in ${CQA_SETUP}/debs/*.deb; do dpkg-deb -x "$f" ${CQA_SETUP}/pg; done
[ -e .env ] || printf '# Local development; no API credentials.\nDATABASE_URL=postgresql://cqa@127.0.0.1:5433/cqa\n' > .env
.venv/bin/python -m pip check
