// Resizable columns for every table.grid in the app: drag the right edge of a header cell,
// double-click the edge to reset the table. Widths are kept in localStorage per header layout.

const EDGE = 6;       // px from a header cell's right edge that grab the resize
const MIN_W = 28;
const KEY = "mstar_post.colwidths.";

type Drag = { table: HTMLTableElement; th: HTMLTableCellElement; x0: number; w0: number; tw0: number };
let drag: Drag | null = null;
let suppressClick = false;

const headerRow = (t: HTMLTableElement) => t.tHead?.rows[0] ?? t.rows[0];

// tables are identified by their header texts, so the same view keeps its widths across visits
function signature(t: HTMLTableElement): string {
  const r = headerRow(t);
  if (!r) return "";
  const s = Array.from(r.cells).map((c) => (c.textContent ?? "").replace(/[\u25b2\u25bc]/g, "").trim()).join("|");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `${r.cells.length}.${(h >>> 0).toString(36)}`;
}

function edgeCell(e: MouseEvent): HTMLTableCellElement | null {
  const th = (e.target as Element | null)?.closest?.("table.grid th") as HTMLTableCellElement | null;
  if (!th || th.parentElement !== headerRow(th.closest("table") as HTMLTableElement)) return null;
  const r = th.getBoundingClientRect();
  return e.clientX >= r.right - EDGE && e.clientX <= r.right + 2 ? th : null;
}

// switch to fixed layout with the current widths, so single columns can then shrink or grow
function freeze(t: HTMLTableElement) {
  if (t.classList.contains("colfixed")) return;
  const cells = Array.from(headerRow(t)?.cells ?? []);
  const ws = cells.map((c) => c.getBoundingClientRect().width);
  cells.forEach((c, i) => { c.style.width = `${ws[i]}px`; });
  t.style.width = `${ws.reduce((a, b) => a + b, 0)}px`;
  t.classList.add("colfixed");
}

function save(t: HTMLTableElement) {
  const sig = signature(t);
  if (!sig) return;
  const ws = Array.from(headerRow(t)!.cells).map((c) => Math.round(c.getBoundingClientRect().width));
  try { localStorage.setItem(KEY + sig, JSON.stringify(ws)); } catch { /* storage full or blocked */ }
}

function reset(t: HTMLTableElement) {
  Array.from(headerRow(t)?.cells ?? []).forEach((c) => { c.style.width = ""; });
  t.style.width = "";
  t.classList.remove("colfixed");
  delete t.dataset.colsig;
  try { localStorage.removeItem(KEY + signature(t)); } catch { /* ignore */ }
}

function restore(t: HTMLTableElement) {
  const sig = signature(t);
  if (!sig || t.dataset.colsig === sig) return;
  t.dataset.colsig = sig;
  let ws: number[] | null = null;
  try { ws = JSON.parse(localStorage.getItem(KEY + sig) ?? "null"); } catch { ws = null; }
  const cells = Array.from(headerRow(t)?.cells ?? []);
  if (!Array.isArray(ws) || ws.length !== cells.length) {
    if (t.classList.contains("colfixed")) { cells.forEach((c) => { c.style.width = ""; }); t.style.width = ""; t.classList.remove("colfixed"); }
    return;
  }
  cells.forEach((c, i) => { c.style.width = `${ws![i]}px`; });
  t.style.width = `${ws.reduce((a, b) => a + b, 0)}px`;
  t.classList.add("colfixed");
}

// Only tables whose header changed or that were just added are looked at (collected per mutation,
// applied once per frame): the observer sees every DOM change of the app, including hidden tabs,
// logs and plots, and must stay cheap there.
const dirty = new Set<HTMLTableElement>();
let scheduled = false;
function scan() {
  scheduled = false;
  dirty.forEach((t) => { if (t.isConnected) restore(t); });
  dirty.clear();
}
function mark(t: HTMLTableElement | null) {
  if (!t) return;
  dirty.add(t);
  if (!scheduled) { scheduled = true; requestAnimationFrame(scan); }
}
// the table.grid whose header row contains (or is) the node, if any
function headerTable(n: Node | null): HTMLTableElement | null {
  const el = n instanceof Element ? n : n?.parentElement;
  const t = el?.closest<HTMLTableElement>("table.grid");
  if (!t || !el) return null;
  if (el === t || el.tagName === "THEAD" || (el.tagName === "TBODY" && !t.tHead)) return t;
  const tr = el.closest("tr");
  return tr && tr === headerRow(t) ? t : null;
}
function onMutations(records: MutationRecord[]) {
  // a burst (a big view mounting or updating at once): looking at every record would cost more than one pass over the tables
  if (records.length > 200) {
    document.querySelectorAll<HTMLTableElement>("table.grid").forEach(mark);
    return;
  }
  for (const r of records) {
    mark(headerTable(r.target));
    r.addedNodes.forEach((n) => {
      if (!(n instanceof Element)) return;
      if (n.matches("table.grid")) mark(n as HTMLTableElement);
      else if (n.firstElementChild) n.querySelectorAll<HTMLTableElement>("table.grid").forEach(mark);
    });
  }
}

export function installColumnResize() {
  document.addEventListener("mousemove", (e) => {
    if (drag) {
      const w = Math.max(MIN_W, drag.w0 + e.clientX - drag.x0);
      drag.th.style.width = `${w}px`;
      drag.table.style.width = `${drag.tw0 + w - drag.w0}px`;
      return;
    }
    document.body.classList.toggle("col-resize-hover", !!edgeCell(e));
  });
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const th = edgeCell(e);
    if (!th) return;
    e.preventDefault();
    e.stopPropagation();
    const table = th.closest("table") as HTMLTableElement;
    freeze(table);
    drag = { table, th, x0: e.clientX, w0: th.getBoundingClientRect().width, tw0: table.getBoundingClientRect().width };
    document.body.classList.add("col-resizing");
  }, true);
  document.addEventListener("mouseup", () => {
    if (!drag) return;
    save(drag.table);
    drag.table.dataset.colsig = signature(drag.table);
    drag = null;
    suppressClick = true;  // the click that ends a drag must not sort the column
    setTimeout(() => { suppressClick = false; }, 0);
    document.body.classList.remove("col-resizing");
  });
  document.addEventListener("click", (e) => {
    if (suppressClick || edgeCell(e)) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  document.addEventListener("dblclick", (e) => {
    const th = edgeCell(e);
    if (!th) return;
    e.stopPropagation();
    reset(th.closest("table") as HTMLTableElement);
  }, true);
  new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true, characterData: true });
  document.querySelectorAll<HTMLTableElement>("table.grid").forEach(mark);
}
