import { useEffect, useState } from "react";
import { api, type Project } from "./api";

// Drop the leading and trailing name parts (split at / _ - . space) shared by all ids.
export function shortenIds(ids: string[]): Record<string, string> {
  if (ids.length < 2) return {};
  const parts = ids.map((id) => id.split(/([/_\-. ]+)/));
  const same = (f: (p: string[]) => string) => parts.every((p) => f(p) === f(parts[0]));
  let lead = 0;
  while (parts.every((p) => p.length > lead + 2) && same((p) => p[lead]) && same((p) => p[lead + 1])) lead += 2;
  let trail = 0;
  while (parts.every((p) => p.length - trail - 2 > lead)
         && same((p) => p[p.length - 1 - trail]) && same((p) => p[p.length - 2 - trail])) trail += 2;
  const out: Record<string, string> = {};
  ids.forEach((id, i) => {
    const s = parts[i].slice(lead, parts[i].length - trail).join("");
    if (s && s !== id) out[id] = s;
  });
  return new Set(Object.values(out)).size === Object.keys(out).length ? out : {};
}

// Editable display names for the project's cases (stored in project.json, shown in Results and Plots).
export default function CaseNames({ project, onChange }: {
  project: Project;
  onChange: (p: Project) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(project.aliases ?? {});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(project.aliases ?? {}), [project.id, project.aliases]);
  const ids = project.cases.map((c) => c.id);
  const n = Object.keys(project.aliases ?? {}).length;
  const dirty = JSON.stringify(draft) !== JSON.stringify(project.aliases ?? {});

  const save = async (aliases: Record<string, string>) => {
    setError(null);
    try {
      const p = await api.patchProject(project.id, { aliases });
      onChange({ ...p, cases: p.cases.map((c) => ({ ...c, info: project.cases.find((o) => o.id === c.id)?.info })) });
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <details className="casenames">
      <summary className="small">Case names{n ? ` (${n} renamed)` : ""}</summary>
      <div className="row small">
        <button onClick={() => setDraft({ ...draft, ...shortenIds(ids) })}
                title="remove the name parts shared by all cases">Auto-shorten</button>
        <button onClick={() => setDraft({})}>Clear all</button>
        <button className="primary" disabled={!dirty} onClick={() => save(draft)}>Save</button>
        {dirty && <button onClick={() => setDraft(project.aliases ?? {})}>Discard</button>}
      </div>
      {error && <div className="error">{error}</div>}
      <table className="grid narrow">
        <thead><tr><th>case</th><th>display name</th></tr></thead>
        <tbody>{ids.map((id) => (
          <tr key={id}><td className="mono small">{id}</td>
            <td><input className="wide" value={draft[id] ?? ""} placeholder={id} maxLength={80}
                       onChange={(e) => setDraft({ ...draft, [id]: e.target.value })} /></td></tr>))}
        </tbody>
      </table>
    </details>
  );
}
