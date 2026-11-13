import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { api, fmtBytes, type CsvTable, type FileChunk } from "./api";
import CsvTableView from "./CsvTableView";
import ErrorBoundary from "./ErrorBoundary";

// Three.js is only needed for CAD previews: its chunk is fetched when the first one is opened
const MeshPreview = lazy(() => import("./MeshPreview"));

const CHUNK = 256 << 10;
const CAD_EXT = ["stl", "step", "stp", "iges", "igs", "brep", "brp"];

// Records of delimited text (RFC 4180): fields may be quoted, quoted fields may hold the separator,
// line breaks and "" for a quote; lines end with LF or CRLF; a BOM and blank lines are skipped.
// maxRows stops early (delimiter sniffing only needs the first lines).
export function parseDelimited(text: string, sep: string, maxRows = Infinity): string[][] {
  const out: string[][] = [];
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let row: string[] = [];
  let blank = true;  // the line has no field content so far
  const endRow = () => {
    if (!blank) out.push(row);
    row = [];
    blank = true;
  };
  while (i < n && out.length < maxRows) {
    let field = "";
    // leading blanks before a quote belong to the padding, not to the value
    let j = i;
    while (j < n && (text[j] === " " || (text[j] === "\t" && sep !== "\t"))) j++;
    if (text[j] === '"') {
      i = j + 1;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q < 0) { field += text.slice(i); i = n; break; }  // unterminated: take the rest
        field += text.slice(i, q);
        if (text[q + 1] === '"') { field += '"'; i = q + 2; } else { i = q + 1; break; }
      }
      // anything between the closing quote and the next separator is kept as written
      const start = i;
      while (i < n && text[i] !== sep && text[i] !== "\n" && text[i] !== "\r") i++;
      field += text.slice(start, i).trim();
      blank = false;
    } else {
      const start = i;
      while (i < n && text[i] !== sep && text[i] !== "\n" && text[i] !== "\r") i++;
      field = text.slice(start, i).trim();
      if (field) blank = false;
    }
    row.push(field);
    if (i >= n) break;
    if (text[i] === sep) { i++; if (i >= n) row.push(""); continue; }
    if (text[i] === "\r" && text[i + 1] === "\n") i++;
    i++;
    endRow();
  }
  if (out.length < maxRows) endRow();
  return out;
}

// plain decimal numbers only: 0x10, 1_000, Infinity and identifiers with leading zeros (001) stay text
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const LEADING_ZERO = /^[+-]?0\d/;
const cell = (v: string): string | number | null =>
  v === "" ? null : NUMBER.test(v) && !LEADING_ZERO.test(v) ? Number(v) : v;

const parseCsv = (text: string, sep: string): CsvTable => {
  const [head = [], ...rest] = parseDelimited(text, sep);
  return { columns: head, rows: rest.map((r) => r.map(cell)), truncated: false };
};

// Delimiter of delimited text: header and most of the first lines split into the same number (>= 2) of fields.
const sniffSep = (text: string): string | null => {
  for (const sep of ["\t", ",", ";", "|"]) {
    const lines = parseDelimited(text, sep, 51);
    if (lines.length < 2) continue;
    const n = lines[0].length;
    if (n < 2) continue;
    const same = lines.slice(1).filter((l) => l.length === n).length;
    if (same >= 0.9 * (lines.length - 1)) return sep;
  }
  return null;
};

// Read-only viewer of one file: text in chunks (head or tail), CSV as a table, images, hex dump of binaries.
export default memo(function FileViewer({ path, onClose }: { path: string; onClose: () => void }) {
  const [chunk, setChunk] = useState<FileChunk | null>(null);
  const [text, setText] = useState("");
  const [tail, setTail] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = path.split("/").pop() ?? path;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const extSep = ext === "csv" ? "," : ext === "tsv" ? "\t" : null;
  const [sniffed, setSniffed] = useState<string | null>(null);
  const sep = sniffed ?? extSep;
  const [asTable, setAsTable] = useState(extSep !== null);
  const isCad = CAD_EXT.includes(ext);
  const [as3d, setAs3d] = useState(isCad);
  // keyboard focus goes to the viewer when it opens, so Escape closes it without a click first
  const modal = useRef<HTMLDivElement>(null);
  useEffect(() => { modal.current?.focus(); }, []);

  useEffect(() => {
    if (isCad && as3d) { setChunk(null); setBusy(false); return; }  // the mesh endpoint reads the file
    let live = true;  // Start / End pressed quickly: only the newest request is shown
    setBusy(true);
    setError(null);
    api.readFile(path, 0, tail, CHUNK).then((c) => {
      if (!live) return;
      setChunk(c);
      setText(c.text);
      if (!c.binary && c.offset === 0 && ["csv", "tsv", "txt", "dat", "out"].includes(ext)) {
        // .csv / .tsv keep their own separator unless the content clearly uses another one (e.g. ";")
        const s = sniffSep(c.text);
        setSniffed(s);
        if (s) setAsTable(true);
      }
    }).catch((e) => { if (live) setError(e.message); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [path, tail, isCad && as3d]); // eslint-disable-line react-hooks/exhaustive-deps

  const more = () => {
    if (!chunk || busy) return;
    setBusy(true);
    api.readFile(path, chunk.end, false, CHUNK).then((c) => {
      setChunk({ ...c, offset: chunk.offset });
      setText((t) => t + c.text);
    }).catch((e) => setError(e.message)).finally(() => setBusy(false));
  };

  const partial = chunk && (chunk.offset > 0 || chunk.end < chunk.size);
  const showTable = !!(chunk && sep && asTable && !tail && !chunk.binary && !chunk.image && !(isCad && as3d));
  // the chunk usually ends in the middle of a line: the table takes complete lines only
  const cut = !!chunk && chunk.end < chunk.size;
  const table = useMemo(() => {
    if (!showTable || !sep) return null;
    return parseCsv(cut ? text.slice(0, text.lastIndexOf("\n") + 1) : text, sep);
  }, [showTable, text, sep, cut]);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal viewer" role="dialog" aria-modal="true" tabIndex={-1} ref={modal} style={{ outline: "none" }}
           onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => ev.key === "Escape" && onClose()}>
        <div className="row">
          <h3 className="grow">{name}</h3>
          {isCad && <span className="seg">
            <button className={as3d ? "primary" : ""} onClick={() => setAs3d(true)}>3D</button>
            <button className={!as3d ? "primary" : ""} onClick={() => setAs3d(false)} title="raw file contents">Text</button>
          </span>}
          {chunk && !chunk.image && !chunk.binary && (
            <>
              <span className="seg">
                <button className={!tail ? "primary" : ""} onClick={() => setTail(false)}>Start</button>
                <button className={tail ? "primary" : ""} onClick={() => setTail(true)} title="last 256 KB">End</button>
              </span>
              {sep && !tail && <label className="small" title={sniffed ? `detected ${sep === "\t" ? "tab" : `"${sep}"`}-separated content` : undefined}>
                <input type="checkbox" checked={asTable}
                onChange={(e) => setAsTable(e.target.checked)} /> table</label>}
              {!(sep && asTable && !tail) && <label className="small"><input type="checkbox" checked={wrap}
                onChange={(e) => setWrap(e.target.checked)} /> wrap</label>}
            </>
          )}
          <button onClick={onClose}>Close</button>
        </div>
        <div className="mono small muted">{path}</div>
        {chunk && <div className="small muted">
          {fmtBytes(chunk.size)}, modified {new Date(chunk.mtime * 1000).toLocaleString()}
          {chunk.binary ? " (binary: hex dump of the first 4 KB)"
            : partial ? ` (showing bytes ${chunk.offset.toLocaleString()} to ${chunk.end.toLocaleString()})` : ""}
        </div>}
        {error && <div className="error">{error}</div>}
        {busy && !chunk && <div className="muted">loading...</div>}
        {isCad && as3d ? (
          <div className="viewer-body mesh">
            <ErrorBoundary label="The 3D preview">
              <Suspense fallback={<div className="muted">loading the 3D preview...</div>}><MeshPreview url={api.meshUrl(path)} name={name} /></Suspense>
            </ErrorBoundary>
          </div>
        ) : chunk?.image ? (
          <div className="viewer-body"><img src={api.imageUrl(path)} alt={name} /></div>
        ) : table ? (
          <div className="viewer-body">
            {cut && <div className="small muted">Table of the complete lines loaded so far; the file goes on (Load more).</div>}
            <CsvTableView table={table} name={name} />
          </div>
        ) : chunk && (
          <pre className={`viewer-body mono${wrap ? " wrap" : ""}`}>{text}</pre>
        )}
        {chunk && !chunk.binary && !chunk.image && !tail && chunk.end < chunk.size && (
          <div className="row small">
            <button disabled={busy} onClick={more}>Load more</button>
            <span className="muted">{fmtBytes(chunk.size - chunk.end)} not shown</span>
          </div>
        )}
      </div>
    </div>
  );
});
