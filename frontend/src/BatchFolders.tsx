import { useMemo, useState } from "react";
import { api } from "./api";

const DEFAULT_PATTERN = "{no}_{reactor_name}_{volume}L_{stir_speed}rpm_{note}";
const PATTERN_KEY = "mstar_post.files.pattern";
type Row = Record<string, string>;

// Placeholder names of a pattern in order of appearance; {no} is the auto number.
const fieldsOf = (pattern: string) =>
  [...new Set([...pattern.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].filter((f) => f !== "no");

function build(pattern: string, row: Row, no: string, tidy: boolean): string {
  let s = pattern.replace(/\{(\w+)\}/g, (_, f: string) => (f === "no" ? no : (row[f] ?? "").trim()));
  // an empty field leaves its separators behind: collapse them and trim the ends
  if (tidy) s = s.replace(/([_\- .])[_\- .]+/g, "$1").replace(/^[_\- .]+|[_\- .]+$/g, "");
  return s;
}

const invalid = (n: string) => !n || n === "." || n === ".." || n.includes("/") || new TextEncoder().encode(n).length > 255;

// Table-driven creation of many folders from a name pattern.
export default function BatchFolders({ parent, existing, onDone }: {
  parent: string; existing: string[]; onDone: () => void;
}) {
  const [pattern, setPattern] = useState(() => localStorage.getItem(PATTERN_KEY) ?? DEFAULT_PATTERN);
  const [start, setStart] = useState(1);
  const [step, setStep] = useState(1);
  const [pad, setPad] = useState(0);
  const [tidy, setTidy] = useState(true);
  const [rows, setRows] = useState<Row[]>([{}]);
  const [paste, setPaste] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fields = useMemo(() => fieldsOf(pattern), [pattern]);

  const names = rows.map((r, i) => build(pattern, r, String(start + i * step).padStart(pad, "0"), tidy));
  const status = names.map((n, i) => invalid(n) ? "invalid name"
    : names.indexOf(n) !== i ? "duplicate" : existing.includes(n) ? "exists" : "");
  const ok = names.filter((_, i) => !status[i]);

  const setCell = (i: number, f: string, v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [f]: v } : r)));
  const applyPaste = () => {
    const lines = (paste ?? "").split(/\r?\n/).filter((l) => l.trim());
    const add = lines.map((l) => Object.fromEntries(l.split("\t").map((v, j) => [fields[j], v]).filter(([f]) => f)));
    const keep = rows.filter((r) => fields.some((f) => (r[f] ?? "").trim()));
    setRows([...keep, ...add].length ? [...keep, ...add] : [{}]);
    setPaste(null);
  };
  const create = async () => {
    if (!ok.length || !confirm(`Create ${ok.length} folder(s) in\n${parent}?`)) return;
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem(PATTERN_KEY, pattern);
      const r = await api.mkdirs(parent, ok);
      setResult(`created ${r.created.length}` + (r.skipped.length
        ? `, skipped ${r.skipped.length}: ${r.skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}` : ""));
      onDone();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="card batch">
      <div className="row small">
        <b>Create folders from a pattern</b>
        <span className="muted">placeholders in braces; {"{no}"} is numbered automatically</span>
      </div>
      <div className="row small">
        <label className="grow">Pattern <input className="wide mono" value={pattern} onChange={(e) => setPattern(e.target.value)} /></label>
        <button onClick={() => setPattern(DEFAULT_PATTERN)}>Default</button>
      </div>
      <div className="row small">
        <label>{"{no}"} start <input type="number" className="short" value={start} onChange={(e) => setStart(Number(e.target.value) || 0)} /></label>
        <label>step <input type="number" className="short" value={step} onChange={(e) => setStep(Number(e.target.value) || 1)} /></label>
        <label title="zero padding, e.g. 2 gives 01, 02, ...">digits <input type="number" className="short" min={0} max={6} value={pad}
          onChange={(e) => setPad(Math.max(0, Math.min(6, Number(e.target.value) || 0)))} /></label>
        <label title="remove the separators left by empty fields"><input type="checkbox" checked={tidy} onChange={(e) => setTidy(e.target.checked)} /> tidy empty fields</label>
      </div>
      <div className="tablewrap">
        <table className="grid">
          <thead><tr><th>no</th>{fields.map((f) => <th key={f}>{f}</th>)}<th>folder name</th><th /></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}>
              <td className="num">{String(start + i * step).padStart(pad, "0")}</td>
              {fields.map((f) => <td key={f}><input value={r[f] ?? ""} onChange={(e) => setCell(i, f, e.target.value)} /></td>)}
              <td className="mono">{names[i]}{status[i] && <span className="error"> ({status[i]})</span>}</td>
              <td className="nowrap">
                <button title="duplicate row" onClick={() => setRows([...rows.slice(0, i + 1), { ...r }, ...rows.slice(i + 1)])}>+</button>
                <button title="remove row" disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, j) => j !== i))}>&times;</button>
              </td>
            </tr>))}
          </tbody>
        </table>
      </div>
      <div className="row small">
        <button onClick={() => setRows([...rows, {}])}>+ Row</button>
        <button onClick={() => setPaste(paste === null ? "" : null)}>Paste from Excel</button>
        <button onClick={() => setRows([{}])}>Clear</button>
        <span className="grow" />
        <span className="muted">{ok.length} of {rows.length} ready</span>
        <button className="primary" disabled={busy || !ok.length} onClick={create}>Create {ok.length} folder(s)</button>
      </div>
      {paste !== null && (
        <div>
          <div className="small muted">One row per line, tab-separated columns in the order {fields.join(", ") || "(no fields)"}.</div>
          <textarea className="paste mono" value={paste} onChange={(e) => setPaste(e.target.value)} rows={6} />
          <div className="row small"><button onClick={applyPaste}>Add rows</button><button onClick={() => setPaste(null)}>Cancel</button></div>
        </div>
      )}
      {result && <div className="small">{result}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
