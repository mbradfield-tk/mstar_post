import { useMemo, useState } from "react";
import { copyText, download, fmt, toCsv, type CsvTable } from "./api";

type Cell = string | number | null;
const MAX_ROWS = 5000;  // rows (transposed: columns) drawn at once

// Sortable/filterable table; for one-row-per-case tables (first column "case")
// it can show % difference from a reference case and transpose.
export default function CsvTableView({ table, name, refCase, caseLabel }: {
  table: CsvTable;
  name: string;
  refCase?: string | null;
  caseLabel?: (id: string) => string;
}) {
  const [sort, setSort] = useState<{ col: number; asc: boolean } | null>(null);
  const [rowFilter, setRowFilter] = useState("");
  const [colFilter, setColFilter] = useState("");
  const [mode, setMode] = useState<"value" | "pct">("value");
  const [transpose, setTranspose] = useState(false);
  const caseTable = table.columns[0] === "case";
  const refRow = caseTable && refCase ? table.rows.find((r) => r[0] === refCase) : undefined;
  // display names of the case column, resolved once per table: callers pass a new caseLabel function
  // on every render, so the memos below depend on the names (labelKey), not on the function
  const names = caseTable && caseLabel ? table.rows.map((r) => (r[0] === null ? "" : caseLabel(String(r[0])))) : null;
  const labelKey = names ? names.join("\u0001") : "";
  const labels = useMemo(() => {
    const m = new Map<string, string>();
    if (names) table.rows.forEach((r, i) => { if (r[0] !== null) m.set(String(r[0]), names[i]); });
    return m;
  }, [table, labelKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const label = (v: Cell): Cell => (v === null ? v : labels.get(String(v)) ?? v);

  const colIdx = useMemo(() => table.columns.map((_, i) => i).filter((i) =>
    i === 0 || table.columns[i].toLowerCase().includes(colFilter.toLowerCase())), [table, colFilter]);

  const rows = useMemo(() => {
    const q = rowFilter.toLowerCase();
    let rs = table.rows.filter((r) => !q || r.some((v) => String(v ?? "").toLowerCase().includes(q))
      || String(label(r[0]) ?? "").toLowerCase().includes(q));
    if (mode === "pct" && refRow) {
      rs = rs.map((r) => r.map((v, i) => {
        const ref = refRow[i];
        return i > 0 && typeof v === "number" && typeof ref === "number" && ref !== 0
          ? ((v - ref) / ref) * 100 : (i === 0 ? v : null);  // same definition as results.pct
      }));
    }
    if (sort) {
      const { col, asc } = sort;
      rs = [...rs].sort((a, b) => {
        const x = a[col], y = b[col];
        const c = typeof x === "number" && typeof y === "number" ? x - y
          : String(x ?? "").localeCompare(String(y ?? ""));
        return asc ? c : -c;
      });
    }
    return rs;
  }, [table, rowFilter, sort, mode, refRow, labels]); // eslint-disable-line react-hooks/exhaustive-deps

  const cols = useMemo(() => colIdx.map((i) => table.columns[i]), [colIdx, table]);
  const view: Cell[][] = useMemo(() => rows.map((r) => colIdx.map((i) => (i === 0 ? label(r[i]) : r[i]))),
    [rows, colIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  // column-wise ranges for heat shading of numeric cells (a loop: spreading a long column into Math.min overflows the stack)
  const ranges = useMemo(() => colIdx.map((_, j) => {
    let lo = Infinity, hi = -Infinity;
    for (const r of view) {
      const x = r[j];
      if (typeof x === "number") { if (x < lo) lo = x; if (x > hi) hi = x; }
    }
    return lo <= hi ? [lo, hi] : null;
  }), [view, colIdx]);
  const drawn = view.length > MAX_ROWS ? view.slice(0, MAX_ROWS) : view;

  const exportView = () => download(name.replace(/\.csv$/, "") + (mode === "pct" ? "_pct_diff" : "") + "_view.csv",
    transpose ? toCsv(["variable", ...view.map((r) => String(r[0]))],
                      cols.slice(1).map((c, j) => [c, ...view.map((r) => r[j + 1])]))
              : toCsv(cols, view));
  const copyTsv = () => copyText(
    [cols, ...view].map((r) => r.map((v) => (v === null ? "" : String(v))).join("\t")).join("\n"));

  const shade = (j: number, v: Cell) => {
    if (typeof v !== "number" || j === 0) return undefined;
    if (mode === "pct") {
      const a = Math.min(1, Math.abs(v) / 50);
      return v >= 0 ? `rgba(70,130,220,${a * 0.45})` : `rgba(220,90,70,${a * 0.45})`;
    }
    const r = ranges[j];
    if (!r || r[1] === r[0] || view.length < 2) return undefined;
    return `rgba(70,130,220,${((v - r[0]) / (r[1] - r[0])) * 0.3})`;
  };

  return (
    <div>
      <div className="row small">
        <input placeholder="filter rows" value={rowFilter} onChange={(e) => setRowFilter(e.target.value)} />
        <input placeholder="filter columns" value={colFilter} onChange={(e) => setColFilter(e.target.value)} />
        {caseTable && (
          <>
            <select value={mode} onChange={(e) => setMode(e.target.value as "value" | "pct")}>
              <option value="value">values</option>
              <option value="pct" disabled={!refRow}>% diff vs reference</option>
            </select>
            <label><input type="checkbox" checked={transpose} onChange={(e) => setTranspose(e.target.checked)} /> transpose</label>
          </>
        )}
        <button onClick={exportView}>Export view CSV</button>
        <button onClick={copyTsv}>Copy (Excel)</button>
        <span className="muted">{view.length} rows x {cols.length} cols{table.truncated && " (truncated)"}</span>
        {view.length > MAX_ROWS && <span className="muted" title="filter or sort to bring other rows into view; Export and Copy take all rows">
          showing the first {MAX_ROWS.toLocaleString()}</span>}
        {mode === "pct" && refRow && <span className="muted">reference: <span className="mono">{String(label(refRow[0]))}</span></span>}
      </div>
      <div className="tablewrap">
        {transpose ? (
          <table className="grid">
            <thead><tr><th>variable</th>{drawn.map((r, i) => <th key={i} className="mono" title={String(rows[i][0])}>{String(r[0])}</th>)}</tr></thead>
            <tbody>
              {cols.slice(1).map((c, j) => (
                <tr key={colIdx[j + 1]}><td>{c}</td>
                  {drawn.map((r, i) => <td key={i} className="num" style={{ background: shade(j + 1, r[j + 1]) }}>
                    {fmt(r[j + 1])}{mode === "pct" && typeof r[j + 1] === "number" ? "%" : ""}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="grid">
            <thead>
              <tr>{cols.map((c, j) => (
                <th key={colIdx[j]} className="sortable" onClick={() => setSort({ col: colIdx[j], asc: sort?.col === colIdx[j] ? !sort.asc : true })}>
                  {c}{sort?.col === colIdx[j] ? (sort.asc ? " \u25b2" : " \u25bc") : ""}
                </th>))}
              </tr>
            </thead>
            <tbody>
              {drawn.map((r, i) => (
                <tr key={i} className={caseTable && rows[i][0] === refCase ? "refrow" : ""}>
                  {r.map((v, j) => <td key={j} className={typeof v === "number" ? "num" : ""}
                                      title={j === 0 && caseTable ? String(rows[i][0]) : undefined}
                                      style={{ background: shade(j, v) }}>
                    {fmt(v)}{mode === "pct" && j > 0 && typeof v === "number" ? "%" : ""}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
