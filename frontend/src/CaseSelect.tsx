import { useState } from "react";
import { api, caseName, type Project } from "./api";
import { useUser } from "./user";

// The project's case selection (same as the Cases tab), editable where results are viewed.
export default function CaseSelect({ project, onChange }: { project: Project; onChange: (p: Project) => void }) {
  const me = useUser();
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sel = project.cases.filter((c) => c.included);
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = project.cases.filter((c) => words.every((w) => `${c.id} ${caseName(project, c.id)}`.toLowerCase().includes(w)));
  const ro = !me.user || busy;
  const set = async (ids: string[], v: boolean) => {
    setError(null);
    setBusy(true);
    try {
      const p = await api.patchProject(project.id, { included: Object.fromEntries(ids.map((id) => [id, v])) });
      onChange({ ...p, cases: p.cases.map((c) => ({ ...c, info: project.cases.find((o) => o.id === c.id)?.info })) });
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const names = sel.slice(0, 4).map((c) => caseName(project, c.id)).join(", ") + (sel.length > 4 ? ", ..." : "");
  return (
    <details className="card caseselect">
      <summary className="small"><b>Cases</b> {sel.length} of {project.cases.length} selected
        {sel.length ? <span className="muted">: {names}</span> : <span className="muted"> (none: all cases are used)</span>}</summary>
      <div className="row small">
        <input placeholder="filter cases" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button disabled={ro} onClick={() => set(shown.map((c) => c.id), true)}>select shown</button>
        <button disabled={ro} onClick={() => set(shown.map((c) => c.id), false)}>clear shown</button>
        <span className="muted">{me.user ? "same selection as the Cases tab: results, files and plots follow it" : "log in to change the selection"}</span>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="checklist">
        {shown.map((c) => (
          <label key={c.id} className="small" title={c.id}><input type="checkbox" checked={c.included} disabled={ro}
            onChange={(e) => set([c.id], e.target.checked)} />{caseName(project, c.id)}</label>))}
      </div>
    </details>
  );
}
