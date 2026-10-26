#!/usr/bin/env bash
# Re-install only the root-owned helpers after a code update (run as root).
# Same as the helper step of install.sh; the service picks the new helpers up at once.
set -euo pipefail
APP=$(cd "$(dirname "$0")/.." && pwd)
LIBEXEC=/usr/local/libexec/mstar_post
[[ $(id -u) -eq 0 ]] || { echo "run as root (sudo $0)" >&2; exit 1; }
install -d -m 755 "$LIBEXEC"
install -o root -g root -m 755 "$APP/deploy/helpers/fs_helper.py" "$LIBEXEC/fs"
install -o root -g root -m 755 "$APP/deploy/helpers/run_helper.py" "$LIBEXEC/run"
install -o root -g root -m 755 "$APP/deploy/helpers/auth_helper.py" "$LIBEXEC/auth"
echo "helpers updated in $LIBEXEC"
