import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { api, fmtBytes, type Browse, type BrowseEntry, type DirUsage } from "./api";
import BatchFolders from "./BatchFolders";
import FileViewer from "./FileViewer";
import { useEvent } from "./visible";


// one formatter for the whole listing (same output as Date.toLocaleString, which builds one per call)
const dateFmt = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "numeric", day: "numeric",
  hour: "numeric", minute: "numeric", second: "numeric" });
const when = (t: number) => dateFmt.format(t * 1000);
type SortKey = "name" | "size" | "mtime";
type Usage = Record<string, DirUsage | "busy">;
// the only folders where M-Star models are stored: quick locations and the default path
export const MODEL_DIRS = ["/data/mstar", "/data2/mstar"];
const PATH_KEY = "mstar_post.files.path";
const ROW_STEP = 500;    // rows drawn at once; more on request (a folder may hold thousands of files)
const MAX_UPLOAD = 200;  // files per upload accepted by the server
const inside = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
const base = (p: string) => p.split("/").pop() || p;

// What the rows may do: one object whose identity never changes, so the memoised rows are not
// re-rendered because their parent was (the functions read the current state through refs).
type RowActions = {
  open: (path: string) => void;
  view: (path: string) => void;
  toggle: (path: string, on: boolean) => void;
  measure: (path: string) => void;
  download: (path: string) => void;
  rename: (e: BrowseEntry) => void;
  remove: (e: BrowseEntry) => void;
  dragStart: (e: BrowseEntry, ev: DragEvent) => void;
  dragEnd: () => void;
  dragOver: (dest: string, ev: DragEvent) => void;
  dragLeave: (ev: DragEvent) => void;
  drop: (dest: string, ev: DragEvent) => void;
};

// One line of the listing. The drop highlight is a class set on the element while a row is dragged
// over it (RowActions.dragOver / dragLeave), not React state: hovering re-renders nothing.
const Row = memo(function Row({ e, checked, viewing, u, share, writable, act }: {
  e: BrowseEntry; checked: boolean; viewing: boolean; u: DirUsage | "busy" | undefined;
  share: number | null; writable: boolean; act: RowActions;
}) {
  const folder = e.dir && !e.link;
  const s = e.dir ? (u && u !== "busy" ? u.bytes : null) : e.size;
  return (
    <tr draggable={writable} onDragStart={(ev) => act.dragStart(e, ev)} onDragEnd={act.dragEnd}
        onDragOver={folder ? (ev) => act.dragOver(e.path, ev) : undefined} onDragLeave={folder ? act.dragLeave : undefined}
        onDrop={folder ? (ev) => act.drop(e.path, ev) : undefined}
        className={[viewing ? "selected" : "", checked ? "checked" : ""].join(" ").trim()}>
      <td><input type="checkbox" checked={checked} onChange={(ev) => act.toggle(e.path, ev.target.checked)} /></td>
      <td className="mono">{e.dir
        ? <a onClick={() => !e.link && act.open(e.path)}>{e.name}/</a>
        : <a title="view contents" onClick={() => act.view(e.path)}>{e.name}</a>}
        {e.link && <span className="muted"> (link)</span>}
        {e.is_case && <span className="tag">case</span>}</td>
      <td className="num">{folder && u === undefined
        ? <button className="small" onClick={() => act.measure(e.path)}>measure</button>
        : u === "busy" ? <span className="muted">...</span>
        : folder && u ? <a title={`measured ${u.seconds} s scan; click to re-measure`} onClick={() => act.measure(e.path)}>
            {fmtBytes(s)}{u.truncated ? "+" : ""}</a>
        : <>{fmtBytes(s)}</>}</td>
      <td>{share !== null && (
        <div className="sharebar" title={`${share.toFixed(1)}% of the measured entries`}>
          <div style={{ width: `${share}%` }} /></div>)}</td>
      <td className="small">{when(e.mtime)}</td>
      <td className="nowrap">
        {!e.dir && <><button className="small" onClick={() => act.view(e.path)}>View</button>{" "}
          <button className="small" title={`download ${e.name}`} onClick={() => act.download(e.path)}>Download</button>{" "}</>}
        {writable && <>
        <button className="small" title={`rename ${e.name}`} onClick={() => act.rename(e)}>Rename</button>{" "}
        <button className="danger small" title={`delete ${e.name}`} onClick={() => act.remove(e)}>Delete</button></>}</td>
    </tr>
  );
});

// Path box: what is typed lives here, so typing does not re-render the listing.
const PathBar = memo(function PathBar({ path, onGo }: { path: string; onGo: (p: string) => void }) {
  const [typed, setTyped] = useState(path);
  useEffect(() => setTyped(path), [path]);
  return (
    <>
      <input className="wide mono" value={typed} onChange={(e) => setTyped(e.target.value)}
             onKeyDown={(e) => e.key === "Enter" && onGo(typed)} />
      <button onClick={() => onGo(typed)}>Go</button>
    </>
  );
});

// Rename one entry. The request is sent once (Enter held down or pressed twice does not send it again).
function RenameDialog({ e, onClose, onDone }: { e: BrowseEntry; onClose: () => void; onDone: (e: BrowseEntry, name: string) => void }) {
  const [name, setName] = useState(e.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const bad = !name.trim() || name.includes("/");
  const submit = async () => {
    if (sending.current || bad) return;
    const n = name.trim();
    if (n === e.name) { onClose(); return; }
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.renamePath(e.path, n);
    } catch (err) {
      sending.current = false;
      setBusy(false);
      setError((err as Error).message);
      return;
    }
    onDone(e, n);
  };
  return (
    <div className="modal-bg" onClick={() => !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(ev) => ev.stopPropagation()}
           onKeyDown={(ev) => ev.key === "Escape" && !busy && onClose()}>
        <h3>Rename {e.link ? "link" : e.dir ? "folder" : "file"}</h3>
        <div className="mono small">{e.path}</div>
        <label>New name
          <input className="wide mono" autoFocus value={name} onFocus={(ev) => ev.target.select()}
                 onChange={(ev) => { setName(ev.target.value); setError(null); }}
                 onKeyDown={(ev) => ev.key === "Enter" && submit()} /></label>
        {name.includes("/") && <div className="small muted">A name cannot contain "/" (use Move to change the folder).</div>}
        {e.is_case && <p className="small muted">This is a case folder: projects that include it will no longer find it under the old name (use Rediscover on the Cases tab).</p>}
        {error && <div className="error">{error}</div>}
        <div className="row">
          <span className="grow" />
          <button disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || bad} onClick={submit}>{busy ? "Renaming..." : "Rename"}</button>
        </div>
      </div>
    </div>
  );
}

// Delete one entry: a plain confirmation first; a non-empty folder then needs its name typed.
function DeleteDialog({ e, onClose, onDone }: { e: BrowseEntry; onClose: () => void; onDone: (e: BrowseEntry) => void }) {
  const [step, setStep] = useState<"confirm" | "typed">("confirm");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const submit = async () => {
    if (sending.current || (step === "typed" && typed !== e.name)) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.deletePath(e.path, step === "typed");
    } catch (err) {
      const msg = (err as Error).message;
      sending.current = false;
      setBusy(false);
      if (step === "confirm" && /not empty/.test(msg)) setStep("typed"); else setError(msg);
      return;
    }
    onDone(e);
  };
  return (
    <div className="modal-bg" onClick={() => !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(ev) => ev.stopPropagation()}
           onKeyDown={(ev) => ev.key === "Escape" && !busy && onClose()}>
        <h3>Delete {e.link ? "link" : e.dir ? "folder" : "file"}?</h3>
        <div className="mono small">{e.path}</div>
        {step === "confirm" ? (
          <p>Are you sure you want to delete <b>{e.name}</b>? This cannot be undone.</p>
        ) : (
          <>
            <p className="error">This folder is not empty. Everything inside it will be deleted permanently.</p>
            <label>Type the folder name <b className="mono">{e.name}</b> to confirm
              <input className="wide mono" autoFocus value={typed} onChange={(ev) => setTyped(ev.target.value)}
                     onKeyDown={(ev) => ev.key === "Enter" && submit()} /></label>
          </>
        )}
        {error && <div className="error">{error}</div>}
        <div className="row">
          <span className="grow" />
          <button autoFocus={step === "confirm"} disabled={busy} onClick={onClose}>Cancel</button>
          <button className="danger" disabled={busy || (step === "typed" && typed !== e.name)}
                  onClick={submit}>{busy ? "Deleting..." : step === "typed" ? "Delete everything" : "Delete"}</button>
        </div>
      </div>
    </div>
  );
}

// Confirm a move (drag-and-drop or "Move to"): paths -> destination folder.
function MoveDialog({ paths, dest, title, cases, onClose, onMove }: {
  paths: string[]; dest: string; title: string; cases: boolean; onClose: () => void;
  onMove: (paths: string[], dest: string) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const submit = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await onMove(paths, dest);
    } catch (err) {
      sending.current = false;
      setBusy(false);
      setError((err as Error).message);
      return;
    }
    onClose();
  };
  return (
    <div className="modal-bg" onClick={() => !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(ev) => ev.stopPropagation()}
           onKeyDown={(ev) => ev.key === "Escape" && !busy && onClose()}>
        <h3>Move {paths.length} item{paths.length === 1 ? "" : "s"} to {title}?</h3>
        <div className="mono small">{dest}</div>
        <ul className="small mono">{paths.slice(0, 12).map((p) => <li key={p}>{base(p)}</li>)}
          {paths.length > 12 && <li className="muted">... and {paths.length - 12} more</li>}</ul>
        {cases && <p className="small muted">Case folders are among them: projects that include them will no longer find them at the old location (use Relocate or Rediscover on the Cases tab).</p>}
        {error && <div className="error">{error}</div>}
        <div className="row">
          <span className="grow" />
          <button disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primary" autoFocus disabled={busy} onClick={submit}>{busy ? "Moving..." : "Move"}</button>
        </div>
      </div>
    </div>
  );
}

// Server file browser with file sizes, recursive folder sizes and disk usage; create, rename,
// move, delete, upload and download inside the writable roots.
export default memo(function FilesView() {
  const [roots, setRoots] = useState<string[]>([]);
  const [hidden, setHidden] = useState(false);
  // `listing` is the folder on screen. A folder is asked for with load(); only the reply of the newest
  // request is shown, and a failed request changes nothing but the error line, so the path the page
  // reloads (after create / rename / delete / upload, Refresh) is always the folder the user sees.
  const [listing, setListing] = useState<Browse | null>(null);
  const [loading, setLoading] = useState(false);
  const [usage, setUsage] = useState<Usage>({});
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "name", asc: true });
  const [limit, setLimit] = useState(ROW_STEP);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const stop = useRef(false);
  const [scanning, setScanning] = useState(false);
  const [tool, setTool] = useState<"" | "folder" | "file" | "batch">("");
  const [newName, setNewName] = useState("");
  const [newText, setNewText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState<BrowseEntry | null>(null);    // delete dialog
  const [renaming, setRenaming] = useState<BrowseEntry | null>(null);  // rename dialog
  const [viewing, setViewing] = useState<string | null>(null);
  // multi-selection for moves and downloads (paths of the current listing)
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [subName, setSubName] = useState("");
  // paths of the rows being dragged: a ref, the drop targets read it when something is dragged over them
  const dragging = useRef<string[] | null>(null);
  // move confirmation (drag-and-drop or "Move to"): paths -> destination folder
  const [moving, setMoving] = useState<{ paths: string[]; dest: string } | null>(null);
  // upload from the browser into the current folder (button or files dropped from the desktop)
  const [overwrite, setOverwrite] = useState(false);
  const [uploading, setUploading] = useState<{ n: number; bytes: number } | null>(null);
  const [osDrop, setOsDrop] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const working = useRef(false);  // a create / combine request is on its way (Enter pressed twice)
  const now = useRef({ listing, hidden, selected });
  now.current = { listing, hidden, selected };

  // Browse a folder. Resolves to null when it is shown, "" when a newer request replaced this one,
  // else the error message (which is also displayed).
  const load = useCallback((p: string, showHidden = now.current.hidden): Promise<string | null> => {
    const my = ++seq.current;
    stop.current = true;
    setError(null);
    setLoading(true);
    return api.browse(p, showHidden).then((l): string | null => {
      if (my !== seq.current) return "";
      if (l.path !== now.current.listing?.path) setLimit(ROW_STEP);
      setListing(l);
      const names = new Set(l.entries.map((e) => e.path));
      setSelected((s) => ([...s].every((x) => names.has(x)) ? s : new Set([...s].filter((x) => names.has(x)))));
      localStorage.setItem(PATH_KEY, l.path);
      return null;
    }, (e): string => {
      if (my !== seq.current) return "";
      const msg = (e as Error).message;
      setError(msg);
      return msg;
    }).finally(() => { if (my === seq.current) setLoading(false); });
  }, []);
  const reload = useCallback(() => { const l = now.current.listing; if (l) void load(l.path); }, [load]);
  // a change inside a folder changes its size and that of every folder above it
  const stale = (...paths: string[]) => setUsage((u) => Object.fromEntries(Object.entries(u).filter(([k]) =>
    !paths.some((p) => inside(k, p) || p.startsWith(`${k}/`)))));
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(id);
  }, [note]);

  const doMove = async (paths: string[], dest: string) => {
    const r = await api.movePaths(paths, dest);
    stale(...paths, dest);
    const gone = new Set(r.moved.map(base));
    setSelected((s) => new Set([...s].filter((p) => !gone.has(base(p)))));
    const where = dest === now.current.listing?.path ? "here" : `to ${base(dest)}`;
    setNote(`moved ${r.moved.length} item${r.moved.length === 1 ? "" : "s"} ${where}`
      + (r.skipped.length ? `; skipped: ${r.skipped.map((s) => `${base(s.path)} (${s.reason})`).join(", ")}` : ""));
    reload();
    return r;
  };
  // "Combine in a sub-folder": create it in the current folder, then move the selection into it
  const combine = async () => {
    const name = subName.trim();
    if (!listing || !name || name.includes("/") || !selected.size || working.current) return;
    const dest = `${listing.path}/${name}`;
    const paths = [...selected].filter((p) => p !== dest);
    if (!paths.length) { setError(`${name} is the only selected entry: it cannot be moved into itself`); return; }
    working.current = true;
    setError(null);
    try {
      if (!listing.entries.some((e) => e.name === name && e.dir)) {
        const r = await api.mkdirs(listing.path, [name]);
        if (r.skipped.length) throw new Error(`${r.skipped[0].name}: ${r.skipped[0].reason}`);
      }
      await doMove(paths, dest);
      setSubName("");
    } catch (e) { setError((e as Error).message); }
    working.current = false;
  };
  // Row drag-and-drop: dragging a selected row moves the whole selection, any other row only itself.
  // Drop targets are folder rows, breadcrumbs and Up; the highlight is a class on the hovered element.
  const clearDropMarks = () => document.querySelectorAll(".files tr.droptarget, .files a.droptarget, .files button.droptarget")
    .forEach((n) => n.classList.remove("droptarget"));
  const canDrop = (dest: string) => {
    const d = dragging.current;
    return !!d && !!now.current.listing?.writable && !d.includes(dest);
  };
  const dragOver = useEvent((dest: string, ev: DragEvent) => {
    if (!canDrop(dest)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    ev.currentTarget.classList.add("droptarget");
  });
  const dragLeave = useEvent((ev: DragEvent) => {
    if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) ev.currentTarget.classList.remove("droptarget");
  });
  const dropOn = useEvent((dest: string, ev: DragEvent) => {
    if (!canDrop(dest)) return;
    ev.preventDefault();
    const paths = dragging.current;
    dragging.current = null;
    clearDropMarks();
    if (paths?.length) setMoving({ paths, dest });
  });
  // the same for the elements outside the table (breadcrumbs, Up)
  const dropProps = (dest: string | null | undefined) => (dest ? {
    onDragOver: (ev: DragEvent) => dragOver(dest, ev), onDragLeave: dragLeave, onDrop: (ev: DragEvent) => dropOn(dest, ev),
  } : {});

  const createOne = async () => {
    if (!listing || !newName.trim() || working.current) return;
    working.current = true;
    setError(null);
    try {
      if (tool === "folder") {
        const r = await api.mkdirs(listing.path, [newName]);
        if (r.skipped.length) throw new Error(`${r.skipped[0].name}: ${r.skipped[0].reason}`);
      } else await api.newFile(listing.path, newName, newText);
      stale(listing.path);
      setNote(`created ${newName.trim()}`);
      setNewName("");
      setNewText("");
      reload();
    } catch (e) { setError((e as Error).message); }
    working.current = false;
  };
  // folders = names of dropped folders: the browser cannot upload them, the note says so
  const upload = async (files: File[], folders: string[] = []) => {
    const skippedFolders = folders.length
      ? `${folders.length} folder${folders.length === 1 ? "" : "s"} not uploaded (${folders.join(", ")}): select the files inside` : "";
    if (!listing?.writable || uploading) return;
    if (!files.length) { if (skippedFolders) setError(skippedFolders); return; }
    if (files.length > MAX_UPLOAD) { setError(`at most ${MAX_UPLOAD} files per upload (${files.length} chosen)`); return; }
    setError(null);
    setUploading({ n: files.length, bytes: files.reduce((s, f) => s + f.size, 0) });
    try {
      const r = await api.uploadFiles(listing.path, files, overwrite);
      const total = r.saved.reduce((s, f) => s + f.bytes, 0);
      setNote(`uploaded ${r.saved.length} file${r.saved.length === 1 ? "" : "s"} (${fmtBytes(total)})`
        + (r.skipped.length ? `; skipped: ${r.skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}` : "")
        + (skippedFolders ? `; ${skippedFolders}` : ""));
      stale(listing.path);
      reload();
    } catch (e) { setError((e as Error).message + (skippedFolders ? `; ${skippedFolders}` : "")); }
    setUploading(null);
  };
  // files dragged in from the desktop (not a row move): drop anywhere on the listing
  const osDragProps = listing?.writable ? {
    onDragOver: (ev: DragEvent) => {
      if (dragging.current || !ev.dataTransfer.types.includes("Files")) return;
      ev.preventDefault(); ev.dataTransfer.dropEffect = "copy";
      if (!osDrop) setOsDrop(true);
    },
    onDragLeave: (ev: DragEvent) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setOsDrop(false); },
    onDrop: (ev: DragEvent) => {
      if (dragging.current || !ev.dataTransfer.types.includes("Files")) return;
      ev.preventDefault(); setOsDrop(false);
      // a dropped folder is a directory entry (its File has an arbitrary size, 0 only on some systems):
      // ask the entry; without that API fall back to "no size and no type"
      const files: File[] = [], folders: string[] = [];
      const items = Array.from(ev.dataTransfer.items ?? []).filter((it) => it.kind === "file");
      if (items.length && typeof items[0].webkitGetAsEntry === "function") {
        for (const it of items) {
          const entry = it.webkitGetAsEntry(), f = it.getAsFile();
          if (entry?.isDirectory) folders.push(entry.name);
          else if (f) files.push(f);
        }
      } else {
        for (const f of Array.from(ev.dataTransfer.files)) if (f.size > 0 || f.type) files.push(f); else folders.push(f.name);
      }
      void upload(files, folders);
    },
  } : {};
  const download = (paths: string[]) => {
    const files = paths.filter((p) => listing?.entries.some((e) => e.path === p && !e.dir));
    if (files.length < paths.length) setNote(`${paths.length - files.length} folder${paths.length - files.length === 1 ? "" : "s"} skipped: only files can be downloaded`);
    if (files.length) api.download(files, files.length > 1 ? listing?.path.split("/").pop() || "files" : undefined, setError);
  };

  // First folder: the remembered one; when it is gone or not readable any more, a model folder, then a root.
  useEffect(() => {
    let alive = true;
    const rootsP = api.roots().then((r) => r.filter((x) => x.exists).map((x) => x.path));
    rootsP.then((ok) => { if (alive) setRoots(ok); }).catch((e) => { if (alive) setError((e as Error).message); });
    (async () => {
      const start = localStorage.getItem(PATH_KEY) ?? MODEL_DIRS[0];
      const why = await load(start);
      if (!why || !alive) return;  // shown, or the user already went somewhere else
      const ok = await rootsP.catch(() => [] as string[]);
      for (const p of [...MODEL_DIRS.filter((d) => ok.some((r) => inside(d, r))), ...ok]) {
        if (p === start) continue;
        const w = await load(p);
        if (w === null) setNote(`${start} could not be opened (${why}): showing ${p}`);
        if (!w || !alive) return;
      }
      setError(why);
    })();
    return () => { alive = false; };
  }, [load]);

  // always a fresh scan: files change outside the app (solves, shells), which no cache can notice
  const measure = async (p: string) => {
    setUsage((u) => ({ ...u, [p]: "busy" }));
    try {
      const r = await api.du(p, true);
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
      await measure(e.path);
    }
    if (!stop.current) await measure(listing.path);
    setScanning(false);
  };

  const entries = useMemo(() => {
    if (!listing) return [];
    const size = (e: BrowseEntry) => {
      if (!e.dir) return e.size ?? -1;
      const u = usage[e.path];
      return u && u !== "busy" ? u.bytes : -1;
    };
    const k = sort.key;
    return [...listing.entries].sort((a, b) => {
      const c = k === "name" ? Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)
        : k === "size" ? size(a) - size(b) : a.mtime - b.mtime;
      return sort.asc ? c : -c;
    });
  }, [listing, sort, sort.key === "size" ? usage : null]); // eslint-disable-line react-hooks/exhaustive-deps
  // bytes of the files and of the measured folders: the share bars are relative to it
  const known = useMemo(() => (listing?.entries ?? []).reduce((s, e) => {
    const u = usage[e.path];
    return s + (e.dir ? (u && u !== "busy" ? u.bytes : 0) : e.size ?? 0);
  }, 0), [listing, usage]);
  const here = listing ? usage[listing.path] : undefined;
  const disk = listing?.disk;
  const usedPct = disk ? (100 * disk.used) / disk.total : 0;
  const root = roots.find((r) => listing && inside(listing.path, r)) ?? "";
  // breadcrumbs start at the model folder when inside one (and it can be browsed), else at the root
  const location = MODEL_DIRS.find((d) => listing && inside(listing.path, d)) ?? "";
  const crumbBase = location && (!root || inside(location, root)) ? location : root;
  const crumbs = listing && crumbBase ? [crumbBase, ...listing.path.slice(crumbBase.length).split("/").filter(Boolean)] : [];
  const head = (k: SortKey, label: string) => (
    <th className="sortable" onClick={() => setSort({ key: k, asc: sort.key === k ? !sort.asc : k === "name" })}>
      {label}{sort.key === k ? (sort.asc ? " \u25b2" : " \u25bc") : ""}</th>
  );
  const folders = useMemo(() => entries.filter((e) => e.dir && !e.link), [entries]);
  const allSelected = entries.length > 0 && selected.size === entries.length;
  const subExists = !!subName.trim() && listing?.entries.some((e) => e.name === subName.trim());
  const destName = (d: string) => (d === listing?.parent ? `parent folder (${base(d)})` : base(d));
  const existingNames = useMemo(() => (listing?.entries ?? []).map((e) => e.name), [listing]);
  const batchDone = useCallback(() => { const l = now.current.listing; if (l) stale(l.path); reload(); }, [reload]);
  const closeViewer = useCallback(() => setViewing(null), []);

  // what the rows call (see RowActions): fixed identity, current state
  const toggle = useEvent((p: string, on: boolean) => setSelected((s) => {
    const n = new Set(s);
    if (on) n.add(p); else n.delete(p);
    return n;
  }));
  const measureRow = useEvent((p: string) => { void measure(p); });
  const downloadRow = useEvent((p: string) => download([p]));
  const dragStart = useEvent((e: BrowseEntry, ev: DragEvent) => {
    const sel = now.current.selected;
    const paths = sel.has(e.path) ? [...sel] : [e.path];
    dragging.current = paths;
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", paths.join("\n"));
  });
  const dragEnd = useEvent(() => { dragging.current = null; clearDropMarks(); });
  const act = useMemo<RowActions>(() => ({
    open: (p) => { void load(p); }, view: setViewing, toggle, measure: measureRow, download: downloadRow,
    rename: setRenaming, remove: setPending, dragStart, dragEnd, dragOver, dragLeave, drop: dropOn,
  }), [load, toggle, measureRow, downloadRow, dragStart, dragEnd, dragOver, dragLeave, dropOn]);
  // the rows drawn: an element per entry, rebuilt only when something a row shows has changed
  const writable = !!listing?.writable;
  const rows = useMemo(() => entries.slice(0, limit).map((e) => {
    const u = usage[e.path];
    const s = e.dir ? (u && u !== "busy" ? u.bytes : null) : e.size;
    return <Row key={e.path} e={e} checked={selected.has(e.path)} viewing={viewing === e.path} u={u}
                share={s !== null && known > 0 ? (100 * s) / known : null} writable={writable} act={act} />;
  }), [entries, limit, usage, selected, viewing, known, writable, act]);

  return (
    <div className="panel files">
      <div className="row">
        <h2 className="grow">Files</h2>
        <select value={location} onChange={(e) => e.target.value && load(e.target.value)} title="M-Star model locations">
          {!location && <option value="">other location</option>}
          {MODEL_DIRS.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <PathBar path={listing?.path ?? ""} onGo={load} />
        <button disabled={!listing?.parent} onClick={() => listing?.parent && load(listing.parent)}
                title="go to the parent folder; drag rows here to move them into it"
                {...dropProps(listing?.parent)}>Up</button>
        <button onClick={() => { if (listing) stale(listing.path); reload(); }}
                title="reload the listing; measured sizes of this folder, its sub-folders and the folders above it are dropped">Refresh</button>
        <label className="small"><input type="checkbox" checked={hidden}
          onChange={(e) => { setHidden(e.target.checked); if (listing) void load(listing.path, e.target.checked); }} /> hidden</label>
        {loading && <span className="small muted">loading...</span>}
      </div>
      {listing && (
        <div className="row small mono crumbs">
          {crumbs.map((c, i) => {
            const p = i === 0 ? crumbBase : `${crumbBase}/${crumbs.slice(1, i + 1).join("/")}`;
            return <span key={p}>{i > 0 && " / "}<a onClick={() => load(p)} {...dropProps(p !== listing.path ? p : null)}>{c}</a></span>;
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
          <span className="grow" />
          <input ref={fileInput} type="file" multiple style={{ display: "none" }}
                 onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          <button disabled={!!uploading} onClick={() => fileInput.current?.click()}
                  title="upload files from this computer into the current folder (or drop them onto the list)">
            {uploading ? `Uploading ${uploading.n} file${uploading.n === 1 ? "" : "s"} (${fmtBytes(uploading.bytes)})...` : "Upload files"}</button>
          <label title="replace files of the same name (otherwise they are skipped)">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> overwrite</label>
        </div>
      ) : <div className="small muted">Read-only here (create, upload and delete only inside the writable roots).</div>)}
      {listing && selected.size > 0 && (
        <div className="row small card">
          <b>{selected.size} selected</b>
          <button onClick={() => download([...selected])} title="one file as is, several files as a zip (folders are skipped)">Download selected</button>
          {listing.writable && <>
          <label title="create this sub-folder in the current folder (if needed) and move the selection into it">Combine in sub-folder{" "}
            <input className="mono" placeholder="new sub-folder name" value={subName}
                   onChange={(e) => setSubName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && combine()} /></label>
          <button className="primary" disabled={!subName.trim() || subName.includes("/")} onClick={combine}>
            {subExists ? "Move into existing" : "Create and move"}</button>
          {folders.some((f) => !selected.has(f.path)) && (
            <label>Move to{" "}
              <select value="" onChange={(e) => e.target.value && setMoving({ paths: [...selected], dest: e.target.value })}>
                <option value="">folder...</option>
                {listing.parent && <option value={listing.parent}>.. (parent folder)</option>}
                {folders.filter((f) => !selected.has(f.path)).map((f) => <option key={f.path} value={f.path}>{f.name}/</option>)}
              </select></label>)}
          </>}
          <button onClick={() => setSelected(new Set())}>Clear selection</button>
          {listing.writable && <span className="muted">or drag rows onto a folder, a breadcrumb or Up</span>}
        </div>
      )}
      {listing?.writable && tool === "file" && (
        <textarea className="paste mono" rows={5} placeholder="optional text content" value={newText}
                  onChange={(e) => setNewText(e.target.value)} />
      )}
      {listing?.writable && tool === "batch" && (
        <BatchFolders parent={listing.path} existing={existingNames} onDone={batchDone} />
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
                  {` (${here.seconds} s scan)`}</span>
              : <span className="muted">not measured</span>}
            <button disabled={scanning} onClick={measureAll} title="recursive size of every sub-folder and of this folder (fresh scan)">
              {folders.some((f) => usage[f.path] && usage[f.path] !== "busy") ? "Re-measure folder sizes" : "Measure folder sizes"}</button>
            {scanning && <button onClick={() => { stop.current = true; }}>Stop</button>}
            {here && here !== "busy" && <button disabled={scanning} onClick={() => listing && measure(listing.path)}>Re-measure this folder</button>}
          </div>
        </div>
      )}
      {listing && (
        <div className={`tablewrap${osDrop ? " droptarget" : ""}`} {...osDragProps}>
          {osDrop && <div className="small muted">Drop to upload into {listing.path}</div>}
          <table className="grid">
            <thead><tr><th><input type="checkbox" checked={allSelected} title={`select all ${entries.length} entries`}
                onChange={(e) => setSelected(e.target.checked ? new Set(entries.map((x) => x.path)) : new Set())} /></th>
              {head("name", "name")}{head("size", "size")}<th>share</th>{head("mtime", "modified")}
              <th>actions</th></tr></thead>
            <tbody>
              {rows}
              {!entries.length && <tr><td colSpan={6} className="muted">(empty folder{listing.writable ? ": drop files here to upload" : ""})</td></tr>}
            </tbody>
          </table>
          {entries.length > limit && (
            <div className="row small">
              <span className="muted">showing the first {limit.toLocaleString()} of {entries.length.toLocaleString()} entries (sorting and "select all" apply to all of them)</span>
              <button onClick={() => setLimit(limit + ROW_STEP)}>Show {Math.min(ROW_STEP, entries.length - limit)} more</button>
              <button onClick={() => setLimit(entries.length)}>Show all</button>
            </div>)}
          {listing.truncated && <div className="muted small">Only the first 5000 entries are listed.</div>}
        </div>
      )}
      {viewing && <FileViewer path={viewing} onClose={closeViewer} />}
      {moving && (
        <MoveDialog paths={moving.paths} dest={moving.dest} title={destName(moving.dest)} onMove={doMove} onClose={() => setMoving(null)}
                    cases={moving.paths.some((p) => listing?.entries.find((e) => e.path === p)?.is_case)} />
      )}
      {renaming && (
        <RenameDialog e={renaming} onClose={() => setRenaming(null)} onDone={(e, name) => {
          setRenaming(null);
          stale(e.path);
          setNote(`renamed ${e.name} to ${name}`);
          reload();
        }} />
      )}
      {pending && (
        <DeleteDialog e={pending} onClose={() => setPending(null)} onDone={(e) => {
          setPending(null);
          if (viewing === e.path) setViewing(null);
          stale(e.path);
          setNote(`deleted ${e.name}`);
          reload();
        }} />
      )}
    </div>
  );
});
