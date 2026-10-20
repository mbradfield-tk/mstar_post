#!/usr/bin/env bash
# Start M-Star Post on http://127.0.0.1:8010 (serves the built UI from frontend/dist).
# No authentication: keep HOST=127.0.0.1 and reach it through an SSH tunnel
#   ssh -L 8010:localhost:8010 <server>
# UI development: also run `npm run dev` in frontend/ (http://localhost:5180).
# Settings (env): MSTAR_POST_ROOTS=/data:/data2  MSTAR_POST_DATA=/data/mstar/mstar_post_data
#                 MSTAR_POST_MAX_JOBS=1
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -f frontend/dist/index.html ]]; then
  (cd frontend && npm install --no-audit --no-fund && npm run build)
fi
cd backend
exec "${PYTHON:-python3}" -m uvicorn app.main:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8010}" "$@"
