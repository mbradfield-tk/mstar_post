import { useEffect, useRef, useState, type DragEvent } from "react";
import { api, type Browse, type BrowseEntry, type DirUsage } from "./api";
import BatchFolders from "./BatchFolders";
import FileViewer from "./FileViewer";

export const fmtBytes = (b: number | null | undefined): string => {
  if (b === null || b === undefined || !Number.isFinite(b)) return "";
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
};
const when = (t: number) => new Date(t * 1000).toLocaleString();
type SortKey = "name" | "size" | "mtime";
// the only folders where M-Star models are stored: quick locations and the default path
export const MODEL_DIRS = ["/data/mstar", "/data2/mstar"];

// Read-only server file browser with file sizes, recursive folder sizes and disk usage.
export default function FilesView() {
  const [roots, setRoots] = useState<string[]>([]);
  const [path, setPath] = useState(() => localStorage.getItem("mstar_post.files.path") ?? MODEL_DIRS[0]);
  const [typed, setTyped] = useState(path);
  const [hidden, setHidden] = useState(false);
  const [listing, setListing] = useState<Browse | null>(null);
  const [usage, setUsage] = useState<Record<string, DirUsage | "busy">>({});
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "name", asc: true });
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const stop = useRef(false);
  const [scanning, setScanning] = useState(false);
  const [tool, setTool] = useState<"" | "folder" | "file" | "batch">("");
  const [newName, setNewName] = useState("");
  const [newText, setNewText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  // delete confirmation: "confirm" first, "typed" when a non-empty folder needs its name typed
  const [pending, setPending] = useState<{ e: BrowseEntry; step: "confirm" | "typed"; typed: string; busy: boolean } | null>(null);
  const [renaming, setRenaming] = useState<{ e: BrowseEntry; name: string; busy: boolean; error: string | null } | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  // multi-selection for moves (paths of the current listing); drag source and hovered drop target
  const [selected, setSelected] = useState<string[]>([]);
  const [subName, setSubName] = useState("");
  const [dragging, setDragging] = useState<string[] | null>(null);
  const [dropAt, setDropAt] = useState<string | null>(null);
  // move confirmation (drag-and-drop or "Move to"): paths -> destination folder
  const [moving, setMoving] = useState<{ paths: string[]; dest: string; busy: boolean; error: string | null } | null>(null);
  const reload = () => setTick((x) => x + 1);
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(id);
  }, [note]);

  const doRename = async () => {
    if (!renaming) return;
    const { e, name } = renaming;
    if (!name.trim() || name.trim() === e.name) { setRenaming(null); return; }
    setRenaming({ ...renaming, busy: true, error: null });
    try {
      await api.renamePath(e.path, name.trim());
    } catch (err) {
      setRenaming({ ...renaming, busy: false, error: (err as Error).message });
      return;
    }
    setRenaming(null);
    setUsage((u) => { const { [e.path]: _, ...rest } = u; return rest; });
    setNote(`renamed ${e.name} to ${name.trim()}`);
    reload();
  };

  const doMove = async (paths: string[], dest: string) => {
    const r = await api.movePaths(paths, dest);
    setUsage((u) => { const rest = { ...u }; for (const p of paths) delete rest[p]; delete rest[dest]; return rest; });
    setSelected((s) => s.filter((p) => !r.moved.some((m) => m.endsWith(`/${p.split("/").pop()}`))));
    const where = dest === listing?.path ? "here" : `to ${dest.split("/").pop()}`;
    setNote(`moved ${r.moved.length} item${r.moved.length === 1 ? "" : "s"} ${where}`
      + (r.skipped.length ? `; skipped: ${r.skipped.map((s) => `${s.path.split("/").pop()} (${s.reason})`).join(", ")}` : ""));
    reload();
    return r;
  };
  const confirmMove = async () => {
    if (!moving) return;
    setMoving({ ...moving, busy: true, error: null });
    try { await doMove(moving.paths, moving.dest); } catch (err) { setMoving({ ...moving, busy: false, error: (err as Error).message }); return; }
    setMoving(null);
  };
  // "Combine in a sub-folder": create it in the current folder, then move the selection into it
  const combine = async () => {
    if (!listing || !subName.trim() || !selected.length) return;
    setError(null);
    try {
      const name = subName.trim();
      const dest = `${listing.path}/${name}`;
      if (!listing.entries.some((e) => e.name === name && e.dir)) {
        const r = await api.mkdirs(listing.path, [name]);
        if (r.skipped.length) throw new Error(`${r.skipped[0].name}: ${r.skipped[0].reason}`);
      }
      await doMove(selected.filter((p) => p !== dest), dest);
      setSubName("");
    } catch (e) { setError((e as Error).message); }
  };
  // drag-and-drop: dragging a selected row moves the whole selection, any other row only itself
  const dragStart = (e: BrowseEntry) => (ev: DragEvent) => {
    const paths = selected.includes(e.path) ? selected : [e.path];
    setDragging(paths);
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", paths.join("\n"));
  };
  const dropProps = (dest: string | null | undefined, ok = true) => dest && ok && dragging && !dragging.includes(dest) ? {
    onDragOver: (ev: DragEvent) => { ev.preventDefault(); ev.dataTransfer.dropEffect = "move"; if (dropAt !== dest) setDropAt(dest); },
    onDragLeave: () => setDropAt((d) => (d === dest ? null : d)),
    onDrop: (ev: DragEvent) => {
      ev.preventDefault();
      const paths = dragging;
      setDragging(null); setDropAt(null);
      if (paths?.length) setMoving({ paths, dest, busy: false, error: null });
    },
    className: dropAt === dest ? "droptarget" : undefined,
  } : {};

  const createOne = async () => {
    if (!listing || !newName.trim()) return;
    setError(null);
    try {
      if (tool === "folder") {
        const r = await api.mkdirs(listing.path, [newName]);
        if (r.skipped.length) throw new Error(`${r.skipped[0].name}: ${r.skipped[0].reason}`);
      } else await api.newFile(listing.path, newName, newText);
      setNote(`created ${newName.trim()}`);
      setNewName("");
      setNewText("");
      reload();
    } catch (e) { setError((e as Error).message); }
  };
  const remove = async () => {
    if (!pending) return;
    const { e, step } = pending;
    setError(null);
    setPending({ ...pending, busy: true });
    try {
      await api.deletePath(e.path, step === "typed");
    } catch (err) {
      const msg = (err as Error).message;
      if (step === "confirm" && /not empty/.test(msg)) { setPending({ e, step: "typed", typed: "", busy: false }); return; }
      setError(msg);
      setPending(null);
      return;
    }
    setPending(null);
    setUsage((u) => { const { [e.path]: _, ...rest } = u; return rest; });
    setNote(`deleted ${e.name}`);
    reload();
  };

  useEffect(() => {
    api.roots().then((r) => {
      const ok = r.filter((x) => x.exists).map((x) => x.path);
      setRoots(ok);
      if (!path) setPath(MODEL_DIRS.find((d) => ok.some((r) => d === r || d.startsWith(`${r}/`))) ?? ok[0] ?? "");
    }).catch((e) => setError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!path) return;
    setError(null);
    stop.current = true;
    api.browse(path, hidden).then((l) => {
      setListing(l);
      setTyped(l.path);
      setSelected((s) => s.filter((p) => l.entries.some((e) => e.path === p)));
      localStorage.setItem("mstar_post.files.path", l.path);
    }).catch((e) => setError(e.message));
  }, [path, hidden, tick]);

  const measure = async (p: string, refresh = false) => {
    setUsage((u) => ({ ...u, [p]: "busy" }));
    try {
      const r = await api.du(p, refresh);
      setUsage((u) => ({ ...u, [p]: r }));
    } catch (e) {
      setUsage((u) => { const { [p]: _, ...rest } = u; return rest; });
      setError((e as Error).message);
    }
  };
  const measureAll = async () => {
    if (!listing) return;
    stop.current = false;
    setScanning(true);
    for (const e of listing.entries.filter((x) => x.dir && !x.link)) {
      if (stop.current) break;
      const u = usage[e.path];
      if (!u || u === "busy") await measure(e.path);
    }
    if (!stop.current) await measure(listing.path);
    setScanning(false);
  };

  const sizeOf = (e: Browse["entries"][number]) => {
    if (!e.dir) return e.size;
    const u = usage[e.path];
    return u && u !== "busy" ? u.bytes : null;
  };
  const entries = listing ? [...listing.entries].sort((a, b) => {
    const k = sort.key;
    const c = k === "name" ? Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)
      : k === "size" ? (sizeOf(a) ?? -1) - (sizeOf(b) ?? -1) : a.mtime - b.mtime;
    return sort.asc ? c : -c;
  }) : [];
  const known = entries.reduce((s, e) => s + (sizeOf(e) ?? 0), 0);
  const here = listing ? usage[listing.path] : undefined;
  const disk = listing?.disk;
  const usedPct = disk ? (100 * disk.used) / disk.total : 0;
  const root = roots.find((r) => listing?.path === r || listing?.path.startsWith(`${r}/`)) ?? "";
  // breadcrumbs start at the model folder when inside one, else at the root
  const base = MODEL_DIRS.find((d) => listing?.path === d || listing?.path.startsWith(`${d}/`)) ?? root;
  const crumbs = listing && base ? [base, ...listing.path.slice(base.length).split("/").filter(Boolean)] : [];
  const location = MODEL_DIRS.find((d) => listing?.path === d || listing?.path.startsWith(`${d}/`)) ?? "";
  const head = (k: SortKey, label: string) => (
    <th className="sortable" onClick={() => setSort({ key: k, asc: sort.key === k ? !sort.asc : k === "name" })}>
      {label}{sort.key === k ? (sort.asc ? " \u25b2" : " \u25bc") : ""}</th>
  );
  const folders = entries.filter((e) => e.dir && !e.link);
  const allSelected = entries.length > 0 && selected.length === entries.length;
  const subExists = !!subName.trim() && listing?.entries.some((e) => e.name === subName.trim());
  const destName = (d: string) => (d === listing?.parent ? `parent folder (${d.split("/").pop() || d})` : d.split("/").pop() || d);

  return (
    <div className="panel files">
      <div className="row">
        <h2 className="grow">Files</h2>
        <select value={location} onChange={(e) => e.target.value && setPath(e.target.value)} title="M-Star model locations">
          {!location && <option value="">other location</option>}
          {MODEL_DIRS.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <input className="wide mono" value={typed} onChange={(e) => setTyped(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && setPath(typed)} />
        <button onClick={() => setPath(typed)}>Go</button>
        <button disabled={!listing?.parent} onClick={() => listing?.parent && setPath(listing.parent)}
                title={dragging ? "drop here to move into the parent folder" : undefined}
                {...dropProps(listing?.parent, !!listing?.writable)}>Up</button>
        <button onClick={reload}>Refresh</button>
        <label className="small"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> hidden</label>
      </div>
      {listing && (
        <div className="row small mono crumbs">
          {crumbs.map((c, i) => {
            const p = i === 0 ? base : `${base}/${crumbs.slice(1, i + 1).join("/")}`;
            return <span key={p}>{i > 0 && " / "}<a onClick={() => setPath(p)} {...dropProps(p !== listing.path ? p : null, listing.writable)}>{c}</a></span>;
          })}
          {listing.is_case && <span className="tag">case</span>}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {note && <div className="note small" onClick={() => setNote(null)}>{note}</div>}
      {listing && (listing.writable ? (
        <div className="row small">
          {(["folder", "file", "batch"] as const).map((k) => (
            <button key={k} className={tool === k ? "primary" : ""} onClick={() => setTool(tool === k ? "" : k)}>
              {{ folder: "New folder", file: "New file", batch: "Folders from pattern" }[k]}</button>))}
          {(tool === "folder" || tool === "file") && (
            <>
              <input className="mono" placeholder={`${tool} name`} value={newName} autoFocus
                     onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createOne()} />
              <button className="primary" disabled={!newName.trim()} onClick={createOne}>Create</button>
            </>
          )}
        </div>
      ) : <div className="small muted">Read-only here (create and delete only inside the writable roots).</div>)}
      {listing?.writable && selected.length > 0 && (
        <div className="row small card">
          <b>{selected.length} selected</b>
          <label title="create this sub-folder in the current folder (if needed) and move the selection into it">Combine in sub-folder{" "}
            <input className="mono" placeholder="new sub-folder name" value={subName}
                   onChange={(e) => setSubName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && combine()} /></label>
          <button className="primary" disabled={!subName.trim() || subName.includes("/")} onClick={combine}>
            {subExists ? "Move into existing" : "Create and move"}</button>
          {folders.some((f) => !selected.includes(f.path)) && (
            <label>Move to{" "}
              <select value="" onChange={(e) => e.target.value && setMoving({ paths: selected, dest: e.target.value, busy: false, error: null })}>
                <option value="">folder...</option>
                {listing.parent && <option value={listing.parent}>.. (parent folder)</option>}
                {folders.filter((f) => !selected.includes(f.path)).map((f) => <option key={f.path} value={f.path}>{f.name}/</option>)}
              </select></label>)}
          <button onClick={() => setSelected([])}>Clear selection</button>
          <span className="muted">or drag rows onto a folder, a breadcrumb or Up</span>
        </div>
      )}
      {listing?.writable && tool === "file" && (
        <textarea className="paste mono" rows={5} placeholder="optional text content" value={newText}
                  onChange={(e) => setNewText(e.target.value)} />
      )}
      {listing?.writable && tool === "batch" && (
        <BatchFolders parent={listing.path} existing={listing.entries.map((e) => e.name)} onDone={reload} />
      )}
      {disk && (
        <div className="card">
          <div className="row small">
            <b>File system</b>
            <span>{fmtBytes(disk.used)} used of {fmtBytes(disk.total)} ({usedPct.toFixed(1)}%), {fmtBytes(disk.free)} free</span>
            {usedPct > 95 && <span className="error">nearly full: avoid writing here</span>}
          </div>
          <div className="usagebar"><div style={{ width: `${usedPct}%` }}
            className={usedPct > 95 ? "bad" : usedPct > 85 ? "warn" : ""} /></div>
          <div className="row small">
            <b>This folder</b>
            {here === "busy" ? <span className="muted">measuring...</span>
              : here ? <span>{fmtBytes(here.bytes)} on disk ({fmtBytes(here.apparent)} apparent), {here.files.toLocaleString()} files,{" "}
                  {here.dirs.toLocaleString()} folders{here.truncated && " (incomplete: time limit reached)"}
                  {here.cached ? " (cached)" : ` (${here.seconds} s)`}</span>
              : <span className="muted">not measured</span>}
            <button disabled={scanning} onClick={measureAll} title="recursive size of every sub-folder and of this folder">Measure folder sizes</button>
            {scanning && <button onClick={() => { stop.current = true; }}>Stop</button>}
            {here && here !== "busy" && <button onClick={() => listing && measure(listing.path, true)}>Re-measure</button>}
          </div>
        </div>
      )}
      {listing && (
        <div className="tablewrap">
          <table className="grid">
            <thead><tr>{listing.writable && <th><input type="checkbox" checked={allSelected} title="select all"
                onChange={(e) => setSelected(e.target.checked ? entries.map((x) => x.path) : [])} /></th>}
              {head("name", "name")}{head("size", "size")}<th>share</th>{head("mtime", "modified")}
              {listing.writable && <th>actions</th>}</tr></thead>
            <tbody>
              {entries.map((e) => {
                const s = sizeOf(e), u = usage[e.path];
                const drop = dropProps(e.dir && !e.link ? e.path : null, listing.writable);
                return (
                  <tr key={e.path} draggable={listing.writable} onDragStart={dragStart(e)} onDragEnd={() => { setDragging(null); setDropAt(null); }}
                      {...drop} className={[viewing === e.path ? "selected" : "", selected.includes(e.path) ? "checked" : "", drop.className ?? ""].join(" ").trim()}>
                    {listing.writable && <td><input type="checkbox" checked={selected.includes(e.path)}
                      onChange={(ev) => setSelected(ev.target.checked ? [...selected, e.path] : selected.filter((p) => p !== e.path))} /></td>}
                    <td className="mono">{e.dir
                      ? <a onClick={() => !e.link && setPath(e.path)}>{e.name}/</a>
                      : <a title="view contents" onClick={() => setViewing(e.path)}>{e.name}</a>}
                      {e.link && <span className="muted"> (link)</span>}
                      {e.is_case && <span className="tag">case</span>}</td>
                    <td className="num">{e.dir && !e.link && u === undefined
                      ? <button className="small" onClick={() => measure(e.path)}>measure</button>
                      : u === "busy" ? <span className="muted">...</span>
                      : <>{fmtBytes(s)}{u && u.truncated ? "+" : ""}</>}</td>
                    <td>{s !== null && known > 0 && (
                      <div className="sharebar" title={`${((100 * s) / known).toFixed(1)}% of the measured entries`}>
                        <div style={{ width: `${(100 * s) / known}%` }} /></div>)}</td>
                    <td className="small">{when(e.mtime)}</td>
                    {listing.writable && <td className="nowrap">
                      {!e.dir && <><button className="small" onClick={() => setViewing(e.path)}>View</button>{" "}</>}
                      <button className="small" title={`rename ${e.name}`}
                        onClick={() => setRenaming({ e, name: e.name, busy: false, error: null })}>Rename</button>{" "}
                      <button className="danger small" title={`delete ${e.name}`}
                      onClick={() => setPending({ e, step: "confirm", typed: "", busy: false })}>Delete</button></td>}
                  </tr>
                );
              })}
              {!entries.length && <tr><td colSpan={listing.writable ? 6 : 4} className="muted">(empty folder)</td></tr>}
            </tbody>
          </table>
          {listing.truncated && <div className="muted small">Only the first 5000 entries are listed.</div>}
        </div>
      )}
      {viewing && <FileViewer path={viewing} onClose={() => setViewing(null)} />}
      {moving && (
        <div className="modal-bg" onClick={() => !moving.busy && setMoving(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(ev) => ev.stopPropagation()}
               onKeyDown={(ev) => ev.key === "Escape" && !moving.busy && setMoving(null)}>
            <h3>Move {moving.paths.length} item{moving.paths.length === 1 ? "" : "s"} to {destName(moving.dest)}?</h3>
            <div className="mono small">{moving.dest}</div>
            <ul className="small mono">{moving.paths.slice(0, 12).map((p) => <li key={p}>{p.split("/").pop()}</li>)}
              {moving.paths.length > 12 && <li className="muted">... and {moving.paths.length - 12} more</li>}</ul>
            {moving.paths.some((p) => listing?.entries.find((e) => e.path === p)?.is_case) &&
              <p className="small muted">Case folders are among them: projects that include them will no longer find them at the old location (use Relocate or Rediscover on the Cases tab).</p>}
            {moving.error && <div className="error">{moving.error}</div>}
            <div className="row">
              <span className="grow" />
              <button disabled={moving.busy} onClick={() => setMoving(null)}>Cancel</button>
              <button className="primary" autoFocus disabled={moving.busy} onClick={confirmMove}>{moving.busy ? "Moving..." : "Move"}</button>
            </div>
          </div>
        </div>
      )}
      {renaming && (
        <div className="modal-bg" onClick={() => !renaming.busy && setRenaming(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(ev) => ev.stopPropagation()}
               onKeyDown={(ev) => ev.key === "Escape" && !renaming.busy && setRenaming(null)}>
            <h3>Rename {renaming.e.link ? "link" : renaming.e.dir ? "folder" : "file"}</h3>
            <div className="mono small">{renaming.e.path}</div>
            <label>New name
              <input className="wide mono" autoFocus value={renaming.name}
                     onFocus={(ev) => ev.target.select()}
                     onChange={(ev) => setRenaming({ ...renaming, name: ev.target.value, error: null })}
                     onKeyDown={(ev) => ev.key === "Enter" && doRename()} /></label>
            {renaming.e.is_case && <p className="small muted">This is a case folder: projects that include it will no longer find it under the old name (use Rediscover on the Cases tab).</p>}
            {renaming.error && <div className="error">{renaming.error}</div>}
            <div className="row">
              <span className="grow" />
              <button disabled={renaming.busy} onClick={() => setRenaming(null)}>Cancel</button>
              <button className="primary" disabled={renaming.busy || !renaming.name.trim() || renaming.name.includes("/")}
                      onClick={doRename}>{renaming.busy ? "Renaming..." : "Rename"}</button>
            </div>
          </div>
        </div>
      )}
      {pending && (
        <div className="modal-bg" onClick={() => !pending.busy && setPending(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(ev) => ev.stopPropagation()}
               onKeyDown={(ev) => ev.key === "Escape" && !pending.busy && setPending(null)}>
            <h3>Delete {pending.e.link ? "link" : pending.e.dir ? "folder" : "file"}?</h3>
            <div className="mono small">{pending.e.path}</div>
            {pending.step === "confirm" ? (
              <p>Are you sure you want to delete <b>{pending.e.name}</b>? This cannot be undone.</p>
            ) : (
              <>
                <p className="error">This folder is not empty. Everything inside it will be deleted permanently.</p>
                <label>Type the folder name <b className="mono">{pending.e.name}</b> to confirm
                  <input className="wide mono" autoFocus value={pending.typed}
                         onChange={(ev) => setPending({ ...pending, typed: ev.target.value })}
                         onKeyDown={(ev) => ev.key === "Enter" && pending.typed === pending.e.name && remove()} /></label>
              </>
            )}
            <div className="row">
              <span className="grow" />
              <button autoFocus={pending.step === "confirm"} disabled={pending.busy} onClick={() => setPending(null)}>Cancel</button>
              <button className="danger" disabled={pending.busy || (pending.step === "typed" && pending.typed !== pending.e.name)}
                      onClick={remove}>{pending.busy ? "Deleting..." : pending.step === "typed" ? "Delete everything" : "Delete"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
