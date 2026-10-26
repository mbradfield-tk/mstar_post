"""Login, logout and whoami."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from app import auth, config
from app.auth import Identity, current_user

router = APIRouter(prefix="/api", tags=["auth"])


class LoginRequest(BaseModel):
    user: str
    password: str


@router.get("/whoami")
def whoami(me: Identity | None = Depends(current_user)) -> dict:
    """{user, method: ssh|password|none, admin, password_login: whether the login
    page can work on this server}."""
    return {"user": me.user if me else None, "method": me.method if me else "none",
            "admin": bool(me and me.admin), "password_login": config.HELPER_MODE == "sudo",
            "server_account": auth.server_account()}


@router.post("/login")
def login(body: LoginRequest, request: Request, response: Response) -> dict:
    ip = request.client.host if request.client else "?"
    auth.throttle(ip)
    user = body.user.strip()
    if not user or "/" in user or len(user) > 64:
        raise HTTPException(422, "invalid user name")
    ok, why = auth.verify_password(user, body.password)
    if not ok:
        auth.record_failure(ip)
        raise HTTPException(401, why or "unknown user or wrong password")
    response.set_cookie(auth.COOKIE, auth.make_token(user), httponly=True, samesite="strict",
                        max_age=int(3600 * config.SESSION_HOURS), path="/")
    ident = Identity(user, "password")
    return {"user": user, "method": "password", "admin": ident.admin}


@router.post("/logout")
def logout(response: Response) -> dict:
    response.delete_cookie(auth.COOKIE, path="/")
    return {"user": None}
