import { useEffect, useState } from "react";
import { api, type CsvTable, type Project, type Run } from "./api";
import CsvTableView from "./CsvTableView";

const when = (t: number | null) => (t ? new Date(t * 1000).toLocaleString() : "");

// Prefer the cross-case means table when a run is opened.
const PREFERRED = ["batch_summary_means.csv", "stats_summary_means.csv"];

export default function ResultsView({ project, runName, onRunChange }: {
  project: Project;
  runName: string | null;
  onRunChange: (name: string | null) => void;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [table, setTable] = useState<CsvTable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = runs.find((r) => r.name === runName) ?? null;

  const reload = () => api.runs(project.id).then((rs) => {
    setRuns(rs);
    if (!runName && rs.length) onRunChange(rs[0].name);
  }).catch((e) => setError(e.message));
  useEffect(() => { reload(); }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!run) { setFile(null); return; }
    const pick = PREFERRED.find((p) => run.csvs.includes(p)) ?? run.csvs[0] ?? run.htmls[0] ?? null;
    setFile(pick);
  }, [run?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setTable(null);
    setError(null);
    if (!run || !file?.endsWith(".csv")) return;
    api.csv(project.id, `${run.path}/${file}`).then(setTable).catch((e) => setError(e.message));
  }, [run?.path, file]); // eslint-disable-line react-hooks/exhaustive-deps

  const del = async () => {
    if (!run || !confirm(`Delete run ${run.name} and its outputs?`)) return;
    await api.deleteRun(project.id, run.name);
    onRunChange(null);
    reload();
  };

  const group = (files: string[]) => {
    const g = new Map<string, string[]>();
    files.forEach((f) => {
      const d = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "(run)";
      g.set(d, [...(g.get(d) ?? []), f]);
    });
    return g;
  };

  return (
    <div className="split">
      <div className="side">
        <div className="row"><h3 className="grow">Runs</h3><button onClick={reload}>Refresh</button></div>
        {runs.map((r) => (
          <div key={r.name} className={`taskcard${r.name === runName ? " active" : ""}`} onClick={() => onRunChange(r.name)}>
            <span className={`status ${r.status}`}>{r.status}</span> <b>{r.label ?? r.task}</b>
            <div className="small muted">{when(r.created_at)}</div>
          </div>
        ))}
        {!runs.length && <div className="muted">No runs yet.</div>}
        {run && (
          <>
            <h3>Files</h3>
            {[...group([...run.csvs, ...run.htmls, ...run.images])].map(([d, fs]) => (
              <details key={d} open={d === "(run)"}>
                <summary className="small mono">{d}</summary>
                <ul className="filelist">
                  {fs.map((f) => (
                    <li key={f} className={f === file ? "active" : ""} onClick={() => setFile(f)}>
                      {f.slice(f.lastIndexOf("/") + 1)}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </>
        )}
      </div>
      <div className="main panel">
        {run ? (
          <>
            <div className="row">
              <h2 className="grow">{file ?? run.name}</h2>
              {file && <a className="button" href={api.fileUrl(project.id, `${run.path}/${file}`, true)}>Download file</a>}
              <a className="button" href={api.zipUrl(project.id, run.path)}>Download run (.zip)</a>
              <button onClick={del}>Delete run</button>
            </div>
            <details>
              <summary className="small">Run parameters</summary>
              <pre className="log small">{JSON.stringify(run.params, null, 2)}</pre>
            </details>
            {error && <div className="error">{error}</div>}
            {table && file && <CsvTableView table={table} name={file} refCase={project.ref_case} />}
            {file?.endsWith(".html") && (
              <iframe className="htmlframe" src={api.fileUrl(project.id, `${run.path}/${file}`)} />
            )}
            {file?.endsWith(".png") && <img className="result-img" src={api.fileUrl(project.id, `${run.path}/${file}`)} />}
            {!file && <div className="muted">This run has no CSV/HTML/PNG outputs (yet). Check the job log.</div>}
          </>
        ) : <div className="muted">Select a run.</div>}
      </div>
    </div>
  );
}
