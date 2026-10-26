import { useEffect, useState } from "react";
import { api, type Project, type ProjectMeta, type ProjectSummary } from "./api";

export const META_FIELDS: { key: keyof ProjectMeta; label: string; hint: string }[] = [
  { key: "owner", label: "Owner", hint: "the account creating the project (fixed afterwards)" },
  { key: "program", label: "Associated project", hint: "e.g. TAK-360" },
  { key: "purpose", label: "Purpose", hint: "e.g. pipeline, development, reactor characterization" },
];

// distinct existing values of a metadata field, for filters and suggestions
export const metaValues = (ps: ProjectSummary[], k: keyof ProjectMeta): string[] =>
  [...new Set(ps.map((p) => (p[k] ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

// Owner (fixed at creation, shown read-only) and editable associated project / purpose; saved on blur or Enter.
export default function ProjectMetaEditor({ project, onChange, suggestions }: {
  project: Project; onChange: (p: Project) => void; suggestions?: Partial<Record<keyof ProjectMeta, string[]>>;
}) {
  const [vals, setVals] = useState<ProjectMeta>({ owner: project.owner ?? "", program: project.program ?? "", purpose: project.purpose ?? "" });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setVals({ owner: project.owner ?? "", program: project.program ?? "", purpose: project.purpose ?? "" });
  }, [project.owner, project.program, project.purpose]);

  const save = async (k: keyof ProjectMeta) => {
    const v = vals[k].trim();
    if (v === (project[k] ?? "")) return;
    setError(null);
    try {
      const p = await api.patchProject(project.id, { [k]: v });
      onChange({ ...p, cases: p.cases.map((c) => ({ ...c, info: project.cases.find((o) => o.id === c.id)?.info })) });
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <div className="row small meta-row">
      <span title="the account that created the project; cannot be changed"><span className="muted">Owner</span> <b>{project.owner || "\u2014"}</b></span>
      {META_FIELDS.filter(({ key }) => key !== "owner").map(({ key, label, hint }) => (
        <label key={key} title={hint}>{label}{" "}
          <input value={vals[key]} placeholder={hint} list={suggestions?.[key]?.length ? `meta-${key}` : undefined}
                 onChange={(e) => setVals({ ...vals, [key]: e.target.value })}
                 onBlur={() => save(key)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
          {suggestions?.[key]?.length ? <datalist id={`meta-${key}`}>{suggestions[key]!.map((s) => <option key={s} value={s} />)}</datalist> : null}
        </label>))}
      {error && <span className="error">{error}</span>}
    </div>
  );
}
