import { useEffect, useState } from "react";
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

  useEffect(() => {
    api.roots().then((r) => {
      const ok = r.filter((x) => x.exists).map((x) => x.path);
      setRoots(ok);
      if (!path && ok.length) setPath(ok[0]);
    }).catch((e) => setError(String(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!path) return;
    setError(null);
    setLoading(true);
    api.listDir(path).then((l) => { setListing(l); setTyped(l.path); })
      .catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [path]);

  return (
    <div className="dirbrowser">
      <div className="row">
        <select value={roots.find((r) => path.startsWith(r)) ?? ""}
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
