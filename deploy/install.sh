#!/usr/bin/env bash
# One-time server setup for hosting M-Star Post as a service (run as root).
#
#   sudo deploy/install.sh [--service-user mstar_user] [--group mstar] [--data /data/mstar/mstar_post_data]
#
# Installs the root-owned helpers that let the service act as the logged-in user,
# the matching sudoers rule, /etc/mstar_post/helper.conf, the systemd unit, and
# gives the data folder to the service account with a shared group. Idempotent.
set -euo pipefail

SERVICE_USER=mstar_user
GROUP=mstar
DATA=/data/mstar/mstar_post_data
APP=$(cd "$(dirname "$0")/.." && pwd)
LIBEXEC=/usr/local/libexec/mstar_post
CONF_DIR=/etc/mstar_post
while [[ $# -gt 0 ]]; do
  case "$1" in
    --service-user) SERVICE_USER=$2; shift 2 ;;
    --group) GROUP=$2; shift 2 ;;
    --data) DATA=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[[ $(id -u) -eq 0 ]] || { echo "run as root (sudo $0)" >&2; exit 1; }
id "$SERVICE_USER" >/dev/null 2>&1 || { echo "service account $SERVICE_USER does not exist" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

echo "== group $GROUP (service account + everyone who may run jobs)"
getent group "$GROUP" >/dev/null || groupadd "$GROUP"
usermod -aG "$GROUP" "$SERVICE_USER"
echo "   add users with: usermod -aG $GROUP <account>   (they must log in again)"

echo "== helpers in $LIBEXEC (root-owned, not writable by the service)"
install -d -m 755 "$LIBEXEC"
install -o root -g root -m 755 "$APP/deploy/helpers/fs_helper.py" "$LIBEXEC/fs"
install -o root -g root -m 755 "$APP/deploy/helpers/run_helper.py" "$LIBEXEC/run"
install -o root -g root -m 755 "$APP/deploy/helpers/auth_helper.py" "$LIBEXEC/auth"

echo "== $CONF_DIR/helper.conf (roots and the whitelisted task commands)"
install -d -m 755 "$CONF_DIR"
( cd "$APP/backend" && MSTAR_POST_DATA="$DATA" python3 - <<'EOF'
import json, sys
from app import config
print(json.dumps({
    "roots": [str(r) for r in config.ROOTS],
    "write_roots": [str(r) for r in config.WRITE_ROOTS],
    "min_uid": config.MIN_UID,
    "tasks": {
        "stats_summary": [config.STATS_SUMMARY_PY, str(config.STATS_SUMMARY)],
        "cfd_zoner": [config.ZONER_PY, str(config.ZONER)],
        "calc_ua": [config.CALC_UA_PY, str(config.CALC_UA)],
    },
    "interpreters": sorted({sys.executable, config.STATS_SUMMARY_PY, config.ZONER_PY, config.CALC_UA_PY}),
}, indent=2))
EOF
) > "$CONF_DIR/helper.conf.tmp"
mv "$CONF_DIR/helper.conf.tmp" "$CONF_DIR/helper.conf"
chmod 644 "$CONF_DIR/helper.conf"

echo "== sudoers rule"
sed "s/^mstar_user /$SERVICE_USER /" "$APP/deploy/sudoers.d/mstar_post" > /etc/sudoers.d/mstar_post.tmp
chmod 440 /etc/sudoers.d/mstar_post.tmp
visudo -cf /etc/sudoers.d/mstar_post.tmp
mv /etc/sudoers.d/mstar_post.tmp /etc/sudoers.d/mstar_post

echo "== data folder $DATA (service account, group $GROUP, setgid so job outputs stay shared)"
install -d "$DATA" "$DATA/projects" "$DATA/cache" /data/mstar/.tmp
chown -R "$SERVICE_USER:$GROUP" "$DATA"
chmod 2775 "$DATA" "$DATA/projects" "$DATA/cache"
find "$DATA/projects" -type d -exec chmod 2775 {} +
chmod 1777 /data/mstar/.tmp
[[ -f "$DATA/secret.key" ]] && chmod 600 "$DATA/secret.key" || true

echo "== systemd unit"
sed -e "s|^User=.*|User=$SERVICE_USER|" -e "s|^Group=.*|Group=$GROUP|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$APP|" -e "s|^ExecStart=.*|ExecStart=$APP/run.sh|" \
    -e "s|^Environment=MSTAR_POST_DATA=.*|Environment=MSTAR_POST_DATA=$DATA|" \
    -e "s|^StandardOutput=append:.*|StandardOutput=append:$DATA/service.log|" \
    -e "s|^StandardError=append:.*|StandardError=append:$DATA/service.log|" \
    "$APP/deploy/mstar-post.service" > /etc/systemd/system/mstar-post.service
systemctl daemon-reload
systemctl enable mstar-post.service

if ss -ltn 2>/dev/null | grep -q ':5045 '; then
  echo
  echo "WARNING: something already listens on port 5045 (a personal ./run.sh?). Stop it before"
  echo "         starting the service, e.g.: pkill -f 'uvicorn app.main:app'"
fi

echo
echo "Done. Check the service account can use the helpers:"
echo "  sudo -u $SERVICE_USER sudo -n -u <some account> $LIBEXEC/fs <<< '{\"op\":\"whoami\"}'"
echo "Build the UI once as a user who can write $APP/frontend (npm), then:"
echo "  systemctl start mstar-post && systemctl status mstar-post"
echo "Logs: $DATA/service.log (or journalctl -u mstar-post)."
echo "The app listens on http://<server>:5045 (guests view; accounts log in or tunnel)."
