#!/usr/bin/python3
"""M-Star Post auth helper: verify a server account's password with PAM.

Installed root-owned as /usr/local/libexec/mstar_post/auth and run by the service
account through `sudo -n auth` (the only root grant; see deploy/sudoers.d/mstar_post).
Reads {"user": ..., "password": ...} on stdin, prints {"ok": true/false, "error": ...}.
Only ordinary accounts (uid >= min_uid from /etc/mstar_post/helper.conf, default 1000,
with a login shell) are accepted. Self-contained: ctypes against libpam.
"""
from __future__ import annotations

import ctypes
import ctypes.util
import json
import os
import pwd
import sys
from pathlib import Path

CONF = Path("/etc/mstar_post/helper.conf")
PAM_SERVICE = "login"
PAM_SUCCESS = 0
PAM_PROMPT_ECHO_OFF = 1


class PamMessage(ctypes.Structure):
    _fields_ = [("msg_style", ctypes.c_int), ("msg", ctypes.c_char_p)]


class PamResponse(ctypes.Structure):
    _fields_ = [("resp", ctypes.c_char_p), ("resp_retcode", ctypes.c_int)]


CONV_FUNC = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.POINTER(PamMessage)),
                             ctypes.POINTER(ctypes.POINTER(PamResponse)), ctypes.c_void_p)


class PamConv(ctypes.Structure):
    _fields_ = [("conv", CONV_FUNC), ("appdata_ptr", ctypes.c_void_p)]


def pam_check(user: str, password: str) -> tuple[bool, str]:
    libpam = ctypes.CDLL(ctypes.util.find_library("pam") or "libpam.so.0")
    libc = ctypes.CDLL(ctypes.util.find_library("c"))
    calloc = libc.calloc
    calloc.restype = ctypes.c_void_p
    calloc.argtypes = [ctypes.c_size_t, ctypes.c_size_t]
    strdup = libc.strdup
    strdup.restype = ctypes.c_void_p
    strdup.argtypes = [ctypes.c_char_p]
    pw = password.encode()

    @CONV_FUNC
    def conv(n, msgs, resp, _data):
        arr = calloc(n, ctypes.sizeof(PamResponse))
        if not arr:
            return 5  # PAM_BUF_ERR
        out = ctypes.cast(arr, ctypes.POINTER(PamResponse))
        for i in range(n):
            if msgs[i].contents.msg_style == PAM_PROMPT_ECHO_OFF:
                out[i].resp = ctypes.cast(strdup(pw), ctypes.c_char_p)
        resp[0] = out
        return PAM_SUCCESS

    handle = ctypes.c_void_p()
    pconv = PamConv(conv, None)
    libpam.pam_start.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.POINTER(PamConv),
                                 ctypes.POINTER(ctypes.c_void_p)]
    libpam.pam_strerror.restype = ctypes.c_char_p
    libpam.pam_strerror.argtypes = [ctypes.c_void_p, ctypes.c_int]
    rc = libpam.pam_start(PAM_SERVICE.encode(), user.encode(), ctypes.byref(pconv), ctypes.byref(handle))
    if rc != PAM_SUCCESS:
        return False, "pam_start failed"
    try:
        rc = libpam.pam_authenticate(handle, 0)
        if rc == PAM_SUCCESS:
            rc = libpam.pam_acct_mgmt(handle, 0)
        return rc == PAM_SUCCESS, libpam.pam_strerror(handle, rc).decode(errors="replace")
    finally:
        libpam.pam_end(handle, rc)


def main() -> int:
    try:
        req = json.loads(sys.stdin.read() or "{}")
        user, password = str(req.get("user", "")), str(req.get("password", ""))
    except ValueError:
        print(json.dumps({"ok": False, "error": "invalid request"}))
        return 2
    min_uid = 1000
    if CONF.is_file():
        try:
            min_uid = int(json.loads(CONF.read_text()).get("min_uid", min_uid))
        except (ValueError, TypeError):
            pass
    try:
        pwent = pwd.getpwnam(user)
    except KeyError:
        print(json.dumps({"ok": False, "error": "unknown user or wrong password"}))
        return 0
    shell = os.path.basename(pwent.pw_shell or "")
    if pwent.pw_uid < min_uid or shell in ("nologin", "false", ""):
        print(json.dumps({"ok": False, "error": "unknown user or wrong password"}))
        return 0
    if not password:
        print(json.dumps({"ok": False, "error": "unknown user or wrong password"}))
        return 0
    ok, why = pam_check(user, password)
    print(json.dumps({"ok": ok, "error": None if ok else "unknown user or wrong password",
                      "detail": None if ok else why}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
