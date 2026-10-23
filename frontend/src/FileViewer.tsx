import { useEffect, useState } from "react";
import { api, type CsvTable, type FileChunk } from "./api";
import CsvTableView from "./CsvTableView";
import { fmtBytes } from "./FilesView";

const CHUNK = 256 << 10;

const parseCsv = (text: string, sep: string): CsvTable => {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const cell = (s: string) => {
    const v = s.trim().replace(/^"(.*)"$/, "$1");
    const n = Number(v);
    return v === "" ? null : Number.isFinite(n) ? n : v;
  };
  const [head = "", ...rest] = lines;
  return { columns: head.split(sep).map((s) => s.trim().replace(/^"(.*)"$/, "$1")),
    rows: rest.map((l) => l.split(sep).map(cell)), truncated: false };
};

// Delimiter of delimited text: header and most of the first lines split into the same number (>= 2) of fields.
const sniffSep = (text: string): string | null => {
  const lines = text.split(/\r?\n/, 52).slice(0, 51).filter((l) => l.trim());
  if (lines.length < 2) return null;
  for (const sep of ["\t", ",", ";", "|"]) {
    const n = lines[0].split(sep).length;
    if (n < 2) continue;
    const same = lines.slice(1).filter((l) => l.split(sep).length === n).length;
    if (same >= 0.9 * (lines.length - 1)) return sep;
  }
  return null;
};

// Read-only viewer of one file: text in chunks (head or tail), CSV as a table, images, hex dump of binaries.
export default function FileViewer({ path, onClose }: { path: string; onClose: () => void }) {
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
  const sep = extSep ?? sniffed;
  const [asTable, setAsTable] = useState(extSep !== null);

  useEffect(() => {
    setBusy(true);
    setError(null);
    api.readFile(path, 0, tail, CHUNK).then((c) => {
      setChunk(c);
      setText(c.text);
      if (!extSep && !c.binary && c.offset === 0 && ["txt", "dat", "out"].includes(ext)) {
        const s = sniffSep(c.text);
        setSniffed(s);
        if (s) setAsTable(true);
      }
    }).catch((e) => setError(e.message)).finally(() => setBusy(false));
  }, [path, tail]); // eslint-disable-line react-hooks/exhaustive-deps

  const more = () => {
    if (!chunk) return;
    setBusy(true);
    api.readFile(path, chunk.end, false, CHUNK).then((c) => {
      setChunk({ ...c, offset: chunk.offset });
      setText((t) => t + c.text);
    }).catch((e) => setError(e.message)).finally(() => setBusy(false));
  };

  const partial = chunk && (chunk.offset > 0 || chunk.end < chunk.size);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal viewer" role="dialog" aria-modal="true" tabIndex={-1}
           onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => ev.key === "Escape" && onClose()}>
        <div className="row">
          <h3 className="grow">{name}</h3>
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
        {chunk?.image ? (
          <div className="viewer-body"><img src={api.imageUrl(path)} alt={name} /></div>
        ) : chunk && sep && asTable && !tail && !chunk.binary ? (
          <div className="viewer-body"><CsvTableView table={parseCsv(text, sep)} name={name} /></div>
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
}
