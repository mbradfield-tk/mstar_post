import { useEffect, useMemo, useState } from "react";
import { api, type Job, type Param, type Project, type TaskDef } from "./api";

type Values = Record<string, unknown>;

const initial = (t: TaskDef): Values =>
  Object.fromEntries(t.params.map((p) => [p.name, p.type === "list" && Array.isArray(p.default)
    ? (p.default as string[]).join(" ") : p.default ?? ""]));

export default function RunView({ project, onSubmitted }: {
  project: Project;
  onSubmitted: (j: Job) => void;
}) {
  const [tasks, setTasks] = useState<TaskDef[]>([]);
  const [sel, setSel] = useState<string>("stats_summary");
  const [values, setValues] = useState<Values>({});
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const task = tasks.find((t) => t.id === sel);
  const included = project.cases.filter((c) => c.included);

  useEffect(() => { api.tasks().then(setTasks).catch((e) => setError(e.message)); }, []);
  useEffect(() => { if (task) setValues(initial(task)); }, [task]);

  const groups = useMemo(() => {
    const g = new Map<string, Param[]>();
    task?.params.forEach((p) => g.set(p.group, [...(g.get(p.group) ?? []), p]));
    return g;
  }, [task]);

  const submit = async () => {
    if (!task) return;
    setBusy(true);
    setError(null);
    try {
      onSubmitted(await api.run(project.id, task.id, values, undefined, name.trim() || undefined));
      setName("");
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="split">
      <div className="side">
        <h3>Calculations</h3>
        {!tasks.length && !error && <div className="muted">Loading...</div>}
        {tasks.map((t) => (
          <div key={t.id} className={`taskcard${t.id === sel ? " active" : ""}`} onClick={() => setSel(t.id)}>
            <b>{t.label}</b>
            <div className="small muted">{t.description}</div>
          </div>
        ))}
        <div className="taskcard disabled">
          <b>kLa from scalar dissolution</b>
          <div className="small muted">planned</div>
        </div>
      </div>
      <div className="main panel">
        {task && (
          <>
            <h2>{task.label}</h2>
            <p className="muted">{task.description}</p>
            {!!task.presets.length && (
              <div className="row">
                <span className="muted">Presets:</span>
                {task.presets.map((p) => (
                  <button key={p.label} title={Object.entries(p.params).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("\n") || "defaults"}
                          onClick={() => setValues({ ...initial(task), ...p.params })}>{p.label}</button>
                ))}
              </div>
            )}
            {[...groups].map(([g, ps]) => (
              <fieldset key={g}>
                {g && <legend>{g}</legend>}
                <div className="form">
                  {ps.map((p) => <Field key={p.name} p={p} value={values[p.name]}
                                        onChange={(v) => setValues({ ...values, [p.name]: v })} />)}
                </div>
              </fieldset>
            ))}
            <div className="card">
              <b>{included.length}</b> included {included.length === 1 ? "case" : "cases"}{task.per_case ? ", run one after another" : ""}:
              <div className="small mono muted">{included.map((c) => c.id).join(", ") || "none: include cases on the Cases tab first"}</div>
              {project.ref_case && <div className="small">reference case: <span className="mono">{project.ref_case}</span></div>}
              <div className="small muted">Outputs go to the project folder; case folders are only read.</div>
            </div>
            {error && <div className="error">{error}</div>}
            <div className="row">
              <label>Job name <input className="wide" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="default: task + options + case count" /></label>
            </div>
            <button className="primary big" disabled={busy || !included.length} onClick={submit}
                    title={included.length ? undefined : "include at least one case on the Cases tab"}>
              {busy ? "Submitting..." : "Run"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ p, value, onChange }: { p: Param; value: unknown; onChange: (v: unknown) => void }) {
  const input = (() => {
    switch (p.type) {
      case "bool":
        return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
      case "select":
        return (
          <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
            {p.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        );
      case "number": case "integer":
        return <input type="number" step="any" value={value === null || value === undefined ? "" : String(value)}
                      placeholder="auto" onChange={(e) => onChange(e.target.value)} />;
      default:
        return <input className="wide" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}
                      placeholder={p.type === "list" ? "space-separated" : ""} />;
    }
  })();
  return (
    <label className="field">
      <span>{p.label}</span>
      {input}
      {p.help && <span className="small muted">{p.help}</span>}
    </label>
  );
}
