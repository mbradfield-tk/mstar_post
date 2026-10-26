"""Who is making the request.

Identity comes from, in order:
1. the SSH tunnel: for a loopback peer, the owner (uid) of the client socket in
   /proc/net/tcp is the account that ran `ssh -L ... user@server`;
2. a session cookie set by POST /api/login after a PAM password check (auth helper);
3. nobody: a guest, who may only read.
"""
from __future__ import annotations

import base64
import getpass
import hashlib
import hmac
import ipaddress
import json
import os
import pwd
import secrets
import time
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException, Request

from app import config

COOKIE = "mstar_post_session"
_SOCK_TTL = 5.0
_sock_cache: dict[tuple[str, int], tuple[float, int | None]] = {}
_fail_log: dict[str, list[float]] = {}
_FAILS, _FAIL_WINDOW = 5, 60.0


@dataclass(frozen=True)
class Identity:
    user: str
    method: str  # "ssh" | "password"

    @property
    def admin(self) -> bool:
        return self.user in admins()


def server_account() -> str:
    try:
        return getpass.getuser()
    except Exception:
        return pwd.getpwuid(os.getuid()).pw_name


def admins() -> set[str]:
    return {server_account(), *config.ADMINS}


# ------------------------------------------------------------------ ssh tunnel (socket owner)

def _hex_addr(ip: str, port: int) -> set[str]:
    """/proc/net/tcp{,6} spellings of ip:port (little-endian 32-bit words)."""
    a = ipaddress.ip_address(ip)
    out = set()
    if a.version == 4:
        out.add(f"{int.from_bytes(a.packed, 'little'):08X}:{port:04X}")
        v6 = ipaddress.IPv6Address(f"::ffff:{ip}").packed  # v4-mapped in tcp6
        out.add("".join(f"{int.from_bytes(v6[i:i + 4], 'little'):08X}" for i in range(0, 16, 4)) + f":{port:04X}")
    else:
        out.add("".join(f"{int.from_bytes(a.packed[i:i + 4], 'little'):08X}" for i in range(0, 16, 4)) + f":{port:04X}")
    return out


def _socket_uid(client_ip: str, client_port: int, server_port: int) -> int | None:
    """uid owning the local socket client_ip:client_port connected to the server port."""
    try:
        local = _hex_addr(client_ip, client_port)
    except ValueError:
        return None
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            lines = Path(table).read_text().splitlines()[1:]
        except OSError:
            continue
        for ln in lines:
            f = ln.split()
            if len(f) > 7 and f[1] in local and f[2].endswith(f":{server_port:04X}") and f[3] == "01":
                return int(f[7])
    return None


def tunnel_user(request: Request) -> str | None:
    c = request.client
    if not c:
        return None
    ip, port = c.host, c.port
    try:
        if not ipaddress.ip_address(ip).is_loopback:
            return None
    except ValueError:
        return None
    key = (ip, port)
    hit = _sock_cache.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < _SOCK_TTL:
        uid = hit[1]
    else:
        server_port = request.scope.get("server", (None, 0))[1] or 0
        uid = _socket_uid(ip, port, int(server_port))
        _sock_cache[key] = (now, uid)
        if len(_sock_cache) > 2048:
            _sock_cache.clear()
    if uid is None:
        return None
    try:
        pw = pwd.getpwuid(uid)
    except KeyError:
        return None
    if uid < config.MIN_UID and pw.pw_name != server_account():
        return None
    return pw.pw_name


# ------------------------------------------------------------------ password sessions

def _secret() -> bytes:
    p = config.SECRET_PATH
    try:
        s = p.read_bytes()
        if len(s) >= 32:
            return s
    except OSError:
        pass
    s = secrets.token_bytes(32)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(s)
    return s


def make_token(user: str) -> str:
    body = base64.urlsafe_b64encode(json.dumps(
        {"u": user, "exp": time.time() + 3600 * config.SESSION_HOURS}).encode()).decode().rstrip("=")
    sig = hmac.new(_secret(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def read_token(token: str | None) -> str | None:
    if not token or "." not in token:
        return None
    body, sig = token.rsplit(".", 1)
    if not hmac.compare_digest(hmac.new(_secret(), body.encode(), hashlib.sha256).hexdigest(), sig):
        return None
    try:
        d = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except ValueError:
        return None
    return d.get("u") if d.get("exp", 0) > time.time() else None


def verify_password(user: str, password: str) -> tuple[bool, str]:
    """PAM check through the root-installed auth helper (sudo mode only)."""
    if config.HELPER_MODE != "sudo":
        return False, "password login is not set up on this server (helpers not installed); use an SSH tunnel"
    import subprocess
    try:
        r = subprocess.run([*config.SUDO, str(config.HELPER_DIR / "auth")],
                           input=json.dumps({"user": user, "password": password}),
                           capture_output=True, text=True, timeout=20)
        d = json.loads(r.stdout or "{}")
    except (subprocess.TimeoutExpired, ValueError, OSError) as e:
        return False, f"login check failed: {e}"
    if r.returncode != 0 and not d:
        return False, f"login check failed: {(r.stderr or '').strip()[-300:]}"
    return bool(d.get("ok")), d.get("error") or ""


def throttle(ip: str) -> None:
    now = time.monotonic()
    fails = [t for t in _fail_log.get(ip, []) if now - t < _FAIL_WINDOW]
    _fail_log[ip] = fails
    if len(fails) >= _FAILS:
        raise HTTPException(429, "too many failed logins; wait a minute")


def record_failure(ip: str) -> None:
    _fail_log.setdefault(ip, []).append(time.monotonic())


# ------------------------------------------------------------------ dependencies

def current_user(request: Request) -> Identity | None:
    u = tunnel_user(request)
    if u:
        return Identity(u, "ssh")
    u = read_token(request.cookies.get(COOKIE))
    if u:
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            site = request.headers.get("sec-fetch-site")
            if site and site not in ("same-origin", "none"):
                raise HTTPException(403, "cross-site request refused")
        return Identity(u, "password")
    return None


def require_user(request: Request) -> Identity:
    ident = current_user(request)
    if ident is None:
        raise HTTPException(401, "log in to do this (guests can only view)")
    return ident


def can_manage(ident: Identity | None, *owners: str | None) -> bool:
    """True if ident is an admin or one of the owners (job starter, project owner)."""
    return ident is not None and (ident.admin or ident.user in {o for o in owners if o})


def require_manage(ident: Identity | None, what: str, *owners: str | None) -> None:
    if ident is None:
        raise HTTPException(401, "log in to do this (guests can only view)")
    if not can_manage(ident, *owners):
        who = ", ".join(sorted({o for o in owners if o})) or "nobody"
        raise HTTPException(403, f"only the owner ({who}) or an admin may change this {what}")
