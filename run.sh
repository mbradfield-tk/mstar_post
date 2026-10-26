#!/usr/bin/env bash
# Start M-Star Post (serves the built UI from frontend/dist).
# Personal use: HOST=127.0.0.1 (default) behind an SSH tunnel, `ssh -L 5045:localhost:5045 <server>`.
# Hosted service: deploy/install.sh + systemd runs this as mstar_user with HOST=0.0.0.0;
# guests may view, server accounts log in (tunnel or password). See LAUNCH.md.
# UI development: also run `npm run dev` in frontend/ (http://localhost:5180).
# Settings (env): MSTAR_POST_ROOTS=/data:/data2  MSTAR_POST_DATA=/data/mstar/mstar_post_data
#                 MSTAR_POST_MAX_JOBS=1  MSTAR_POST_ADMINS=  MSTAR_POST_HELPER_DIR=/usr/local/libexec/mstar_post
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -f frontend/dist/index.html ]]; then
  (cd frontend && npm install --no-audit --no-fund && npm run build)
fi
cd backend
exec "${PYTHON:-python3}" -m uvicorn app.main:app --host "${HOST:-127.0.0.1}" --port "${PORT:-5045}" "$@"
