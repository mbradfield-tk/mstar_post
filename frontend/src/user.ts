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
// a 401 from the API means the session expired or a guest tried to edit: let the header offer a login
export const LOGIN_NEEDED = "mstar_post:login-needed";
// the account of the last answered whoami, kept across page loads (undefined = never answered in this browser)
const LAST_USER = "mstar_post.lastuser";
let verified: string | null | undefined;
let unverified = false;  // the server did not answer the last whoami
let seq = 0, retryTimer = 0;
let prompt: { reason: string; until: number } | null = null;

// Everything the app remembers in this browser is per user, except the theme.
export function wipeLocalState(): void {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith("mstar_post.") && k !== "mstar_post.theme" && k !== LAST_USER) localStorage.removeItem(k);
  }
}

const lastUser = (): string | null | undefined => {
  try {
    const v = localStorage.getItem(LAST_USER);
    return v === null ? undefined : v || null;
  } catch { return undefined; }
};

// expired = asked because the API answered 401: a login that is gone re-opens the login dialog
export function refreshUser(expired = false): Promise<WhoAmI> {
  const my = ++seq;
  const p: Promise<WhoAmI> = api.whoami().then((w): WhoAmI | null => w, () => null).then((w) => {
    if (my !== seq) return pending ?? current ?? GUEST;  // a newer request decides
    pending = null;
    if (!w) {
      // no answer (server restarting, network down): keep the identity, this is not a logout
      unverified = true;
      current = current ?? GUEST;
      window.dispatchEvent(new Event(EVENT));
      clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => { if (unverified && !pending) void refreshUser(); }, 5000);
      return current;
    }
    unverified = false;
    // an unchanged answer keeps the same object, so the components using useUser do not re-render
    if (!current || JSON.stringify(current) !== JSON.stringify(w)) current = w;
    window.dispatchEvent(new Event(EVENT));
    // on the first answer of a page load the account of the previous page load counts as "before"
    const before = verified !== undefined ? verified : lastUser();
    verified = w.user;
    try { localStorage.setItem(LAST_USER, w.user ?? ""); } catch { /* storage blocked */ }
    if (before !== undefined && before !== w.user) {
      wipeLocalState();
      if (expired && before && !w.user) prompt = { reason: `The login of ${before} expired: log in again to continue.`, until: Date.now() + 5000 };
      window.dispatchEvent(new CustomEvent(USER_CHANGED, { detail: { from: before, to: w.user } }));
    }
    return w;
  });
  pending = p;
  return p;
}

// why the session that starts after an account change should open the login dialog (null = it should not)
export const loginPrompt = (): string | null => (prompt && Date.now() < prompt.until ? prompt.reason : null);

// the identity may have changed behind our back (expired session): ask again instead of trusting the store
window.addEventListener(LOGIN_NEEDED, () => { void refreshUser(true); });

export function useUser(): WhoAmI & { loading: boolean; canManage: (...owners: (string | null | undefined)[]) => boolean } {
  const [w, setW] = useState<WhoAmI | null>(current);
  useEffect(() => {
    const on = () => setW(current);
    window.addEventListener(EVENT, on);
    if ((!current || unverified) && !pending) void refreshUser();
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
