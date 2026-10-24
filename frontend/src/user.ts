import { useEffect, useState } from "react";

// Name of the person using this browser; sent as X-User with every request and
// recorded on the jobs they start. Stored per browser (the app has no login).
export const USER_KEY = "mstar_post.user";
const EVENT = "mstar_post:user";

export const getUser = (): string => localStorage.getItem(USER_KEY) ?? "";
export function setUser(name: string): void {
  const n = name.trim().slice(0, 64);
  if (n) localStorage.setItem(USER_KEY, n);
  else localStorage.removeItem(USER_KEY);
  window.dispatchEvent(new Event(EVENT));
}
export function useUser(): string {
  const [u, setU] = useState(getUser);
  useEffect(() => {
    const on = () => setU(getUser());
    window.addEventListener(EVENT, on);
    window.addEventListener("storage", on);
    return () => { window.removeEventListener(EVENT, on); window.removeEventListener("storage", on); };
  }, []);
  return u;
}
