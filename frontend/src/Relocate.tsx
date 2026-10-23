import { useState } from "react";
import { api, caseName, type Project } from "./api";
import DirBrowser from "./DirBrowser";

// Shown when the project root or case folders no longer exist (moved or renamed):
// lets the user point the project at the new locations.
export default function Relocate({ project, onChange }: { project: Project; onChange: (p: Project) => void }) {
  const missing = project.cases.filter((c) => c.missing && c.included);
  const [root, setRoot] = useState(project.root);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [browse, setBrowse] = useState<string | null>(null);  // "root" or a case id
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!project.root_missing && !missing.length) return null;

  const apply = async (body: { root?: string; cases?: Record<string, string> }) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await api.relocate(project.id, body));
      setPaths({});
      setBrowse(null);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const picker = (key: string, set: (p: string) => void) => browse === key && (
    <DirBrowser onSelect={(p) => { set(p); setBrowse(null); }} />
  );
  const filled = Object.fromEntries(Object.entries(paths).filter(([, v]) => v.trim()));

  return (
    <div className="card relocate">
      <b className="error">Data not found</b>
      <span className="small muted"> Folders of this project were moved or renamed. Enter the new locations; case ids are kept,
        so results, case names and the reference case stay linked.</span>
      {project.root_missing && (
        <>
          <div className="row small">
            <span>Project folder <span className="mono">{project.root}</span> is missing. New folder:</span>
            <input className="wide mono grow" value={root} onChange={(e) => setRoot(e.target.value)} />
            <button onClick={() => setBrowse(browse === "root" ? null : "root")}>Browse</button>
            <button className="primary" disabled={busy || !root.trim() || root === project.root}
                    onClick={() => apply({ root })}>Apply</button>
          </div>
          {picker("root", setRoot)}
          <div className="small muted">Cases inside the old project folder move with it.</div>
        </>
      )}
      {!project.root_missing && missing.length > 0 && (
        <>
          <div className="small">{missing.length} case folder(s) missing:</div>
          <table className="grid narrow">
            <thead><tr><th>case</th><th>old folder</th><th>new folder</th><th /></tr></thead>
            <tbody>{missing.map((c) => (
              <tr key={c.id}>
                <td className="mono" title={c.id}>{caseName(project, c.id)}</td>
                <td className="mono small">{c.path}</td>
                <td><input className="wide mono" value={paths[c.id] ?? ""} placeholder="new case folder"
                           onChange={(e) => setPaths({ ...paths, [c.id]: e.target.value })} />
                  {picker(c.id, (p) => setPaths({ ...paths, [c.id]: p }))}</td>
                <td><button onClick={() => setBrowse(browse === c.id ? null : c.id)}>Browse</button></td>
              </tr>))}
            </tbody>
          </table>
          <div className="row small">
            <button className="primary" disabled={busy || !Object.keys(filled).length}
                    onClick={() => apply({ cases: filled })}>Apply {Object.keys(filled).length || ""}</button>
            <span className="muted">or exclude the cases on the Cases tab</span>
          </div>
        </>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
