import { useEffect, useState } from "react";
import { api, type WhoAmI } from "./api";

// Who is using the app: the server account behind the SSH tunnel, the account that
// logged in with its password, or nobody (guest: read-only). Fetched once from
// /api/whoami and shared by every component through a tiny store.
const EVENT = "mstar_post:user";
// fired when the account differs from the previous one (login, logout, expired session, other tunnel user)
export const USER_CHANGED = "mstar_post:user-changed";
const GUEST: WhoAmI = { user: null, method: "none", admin: false, password_login: false, server_account: "" };
let current: WhoAmI | null = null;
let pending: Promise<WhoAmI> | null = null;

// Everything the app remembers in this browser is per user, except the theme.
export function wipeLocalState(): void {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith("mstar_post.") && k !== "mstar_post.theme") localStorage.removeItem(k);
  }
}

export function refreshUser(): Promise<WhoAmI> {
  pending = api.whoami().catch(() => GUEST).then((w) => {
    const before = current;
    current = w;
    pending = null;
    window.dispatchEvent(new Event(EVENT));
    if (before !== null && before.user !== w.user) {
      wipeLocalState();
      window.dispatchEvent(new CustomEvent(USER_CHANGED, { detail: { from: before.user, to: w.user } }));
    }
    return w;
  });
  return pending;
}

export function useUser(): WhoAmI & { loading: boolean; canManage: (...owners: (string | null | undefined)[]) => boolean } {
  const [w, setW] = useState<WhoAmI | null>(current);
  useEffect(() => {
    const on = () => setW(current);
    window.addEventListener(EVENT, on);
    if (!current && !pending) refreshUser();
    return () => window.removeEventListener(EVENT, on);
  }, []);
  const me = w ?? GUEST;
  return {
    ...me, loading: w === null,
    canManage: (...owners) => !!me.user && (me.admin || owners.some((o) => o && o === me.user)),
  };
}

export async function login(user: string, password: string): Promise<void> {
  await api.login(user, password);
  await refreshUser();
}

export async function logout(): Promise<void> {
  await api.logout();
  wipeLocalState();
  const before = current?.user ?? null;
  const after = (await refreshUser()).user;
  // same account afterwards (SSH tunnel): refreshUser did not fire the change, so reset anyway
  if (before === after) window.dispatchEvent(new CustomEvent(USER_CHANGED, { detail: { from: before, to: after } }));
}

// a 401 from the API means the session expired or a guest tried to edit: let the header offer a login
export const LOGIN_NEEDED = "mstar_post:login-needed";
