#!/usr/bin/python3
"""M-Star Post job launcher: run one whitelisted post-processing tool as the calling user.

Installed root-owned as /usr/local/libexec/mstar_post/run and invoked by the service
account through `sudo -n -u <user> run --task <id> -- <args...>`. The interpreter and
script of every task come from the root-owned /etc/mstar_post/helper.conf
("tasks": {"stats_summary": ["<python>", "<script>"], ...}); the caller only supplies
the arguments, so the sudo grant cannot be turned into "run anything as <user>".
custom_script: the script must be owned by the user and the interpreter listed in
conf "interpreters".
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

CONF = Path("/etc/mstar_post/helper.conf")


def conf_path() -> Path:
    # an override is honoured only outside sudo (sudo's env_reset drops it anyway)
    alt = os.environ.get("MSTAR_POST_HELPER_CONF")
    return Path(alt) if alt and os.environ.get("SUDO_USER") is None else CONF


def fail(msg: str) -> int:
    print(f"[mstar_post run] {msg}", file=sys.stderr)
    return 2


def main(argv: list[str]) -> int:
    if os.geteuid() == 0:
        return fail("refusing to run as root")
    if len(argv) < 3 or argv[0] != "--task" or "--" not in argv:
        return fail("usage: run --task <id> -- <args...>")
    task = argv[1]
    args = argv[argv.index("--") + 1:]
    try:
        conf = json.loads(conf_path().read_text())
    except (OSError, ValueError) as e:
        return fail(f"cannot read {conf_path()}: {e}")
    os.umask(0o002)  # outputs stay deletable by the service group
    if task == "custom_script":
        if len(args) < 2:
            return fail("custom_script needs <interpreter> <script> [args]")
        interp, script = args[0], Path(args[1])
        if interp not in (conf.get("interpreters") or []):
            return fail(f"interpreter not allowed: {interp}")
        try:
            if script.stat().st_uid != os.getuid():
                return fail(f"script must be owned by you: {script}")
        except OSError as e:
            return fail(str(e))
        cmd = [interp, str(script), *args[2:]]
    else:
        spec = (conf.get("tasks") or {}).get(task)
        if not spec:
            return fail(f"task not allowed: {task}")
        cmd = [*spec, *args]
    env = {k: v for k, v in os.environ.items() if k in ("HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "TMPDIR")}
    env.update(PYTHONUNBUFFERED="1", MPLBACKEND="Agg")
    try:
        os.execve(cmd[0], cmd, env)
    except OSError as e:
        return fail(f"cannot start {cmd[0]}: {e}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
