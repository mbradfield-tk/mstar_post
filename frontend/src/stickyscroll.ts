// Floating horizontal scrollbar: while the mouse is over a horizontally scrollable box whose own
// scrollbar is below the visible window, a synced scrollbar is pinned to the window bottom.

let box: HTMLElement | null = null;
let bar: HTMLDivElement;
let inner: HTMLDivElement;
let overBar = false;
let hideTimer = 0;

function scrollableX(el: Element | null): HTMLElement | null {
  for (let e = el as HTMLElement | null; e && e !== document.body; e = e.parentElement) {
    if (e === bar) return box;
    if (e.scrollWidth > e.clientWidth + 1) {
      const ox = getComputedStyle(e).overflowX;
      if (ox === "auto" || ox === "scroll") return e;
    }
  }
  return null;
}

function place() {
  if (!box || !box.isConnected) { hide(); return; }
  const r = box.getBoundingClientRect();
  const vh = window.innerHeight;
  // own scrollbar visible, or box (almost) out of view: nothing to do
  if (r.bottom <= vh || r.top > vh - 40 || box.scrollWidth <= box.clientWidth + 1) { hide(); return; }
  bar.style.left = `${r.left + box.clientLeft}px`;
  bar.style.width = `${box.clientWidth}px`;
  inner.style.width = `${box.scrollWidth}px`;
  if (bar.style.display !== "block") bar.style.display = "block";
  bar.scrollLeft = box.scrollLeft;
}

function hide() {
  bar.style.display = "none";
}

function setBox(b: HTMLElement | null) {
  if (b === box) return;
  box?.removeEventListener("scroll", fromBox);
  box = b;
  box?.addEventListener("scroll", fromBox, { passive: true });
}

function fromBox() {
  if (!box || bar.style.display !== "block") return;
  bar.scrollLeft = box.scrollLeft;
}

export function installStickyScroll() {
  bar = document.createElement("div");
  bar.className = "hscroll-float";
  inner = document.createElement("div");
  inner.style.height = "1px";
  bar.appendChild(inner);
  document.body.appendChild(bar);
  hide();
  bar.addEventListener("scroll", () => {
    if (box && Math.abs(box.scrollLeft - bar.scrollLeft) > 0.5) box.scrollLeft = bar.scrollLeft;
  }, { passive: true });
  bar.addEventListener("mouseenter", () => { overBar = true; clearTimeout(hideTimer); });
  bar.addEventListener("mouseleave", () => { overBar = false; });

  let pending: MouseEvent | null = null;
  document.addEventListener("mousemove", (e) => {
    if (!pending) requestAnimationFrame(() => {
      const ev = pending!;
      pending = null;
      if (overBar) return;
      const b = scrollableX(ev.target as Element);
      clearTimeout(hideTimer);
      if (b) { setBox(b); place(); }
      else hideTimer = window.setTimeout(() => { if (!overBar) { hide(); setBox(null); } }, 400);
    });
    pending = e;
  }, { passive: true });
  // one placement per frame: scroll and resize events arrive far more often than the screen is drawn
  let placing = false;
  const replace = () => {
    if (!box || placing) return;
    placing = true;
    requestAnimationFrame(() => { placing = false; if (box) place(); });
  };
  window.addEventListener("scroll", replace, { passive: true });
  window.addEventListener("resize", replace);
}
