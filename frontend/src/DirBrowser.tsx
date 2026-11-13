import { useEffect, useRef, useState } from "react";
import { api } from "./api";

// Folder browser over the server's allowed roots; folders that are M-Star
// cases are tagged.
export default function DirBrowser({ onSelect, initial }: {
  onSelect: (path: string) => void;
  initial?: string;
}) {
  const [path, setPath] = useState(initial ?? "");
  const [listing, setListing] = useState<Awaited<ReturnType<typeof api.listDir>> | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState(initial ?? "");
  const [loading, setLoading] = useState(false);
  // the roots as a promise: the listing of the initial folder may fail before they have arrived
  const rootsP = useRef<Promise<string[]> | null>(null);
  const seq = useRef(0);
  // the root a path lies in ("/data2/x" is not inside "/data")
  const rootOf = (p: string, rs = roots) => rs.find((r) => p === r || p.startsWith(`${r}/`));

  useEffect(() => {
    rootsP.current = api.roots().then((r) => r.filter((x) => x.exists).map((x) => x.path));
    rootsP.current.then((ok) => {
      setRoots(ok);
      // fall back to the first root when the initial folder is outside the roots
      if (!path || !rootOf(path, ok)) setPath(ok[0] ?? "");
    }).catch((e) => setError(String(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!path) return;
    const my = ++seq.current;  // only the reply of the newest request is shown
    setError(null);
    setLoading(true);
    api.listDir(path).then((l) => { if (my === seq.current) { setListing(l); setTyped(l.path); } })
      .catch(async (e) => {
        // a missing initial folder falls back to its root instead of showing an error
        const ok = path === initial ? await (rootsP.current ?? Promise.resolve([])).catch(() => [] as string[]) : [];
        if (my !== seq.current) return;
        const root = rootOf(path, ok);
        if (root && root !== path) setPath(root); else setError(e.message);
      }).finally(() => { if (my === seq.current) setLoading(false); });
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="dirbrowser">
      <div className="row">
        <select value={rootOf(path) ?? ""}
                onChange={(e) => setPath(e.target.value)}>
          {roots.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <input className="grow mono" value={typed} onChange={(e) => setTyped(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && setPath(typed)} placeholder="folder path" />
        <button onClick={() => setPath(typed)}>Go</button>
      </div>
      {error && <div className="error">{error}</div>}
      {loading && !listing && <div className="muted">Loading...</div>}
      {listing && (
        <>
          <div className="row muted">
            <span className="grow mono">{listing.path}{listing.is_case && <span className="tag">case</span>}</span>
            <button className="primary" onClick={() => onSelect(listing.path)}>
              Use this folder
            </button>
          </div>
          <ul className="dirlist">
            {listing.parent && (
              <li><a onClick={() => setPath(listing.parent!)}>..</a></li>
            )}
            {listing.entries.map((e) => (
              <li key={e.path}>
                <a onClick={() => setPath(e.path)}>{e.name}/</a>
                {e.is_case && <span className="tag">case</span>}
              </li>
            ))}
            {!listing.entries.length && <li className="muted">(no sub-folders)</li>}
          </ul>
        </>
      )}
    </div>
  );
}
