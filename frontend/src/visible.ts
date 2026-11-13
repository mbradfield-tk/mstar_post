import { useCallback, useRef, useSyncExternalStore } from "react";

const subscribe = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};

// true while the browser tab is in the foreground: timers and polling pause in background tabs
export const usePageVisible = (): boolean => useSyncExternalStore(subscribe, () => !document.hidden);

// a function whose identity never changes but which always calls the latest version:
// for handlers passed to memoised components
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}
