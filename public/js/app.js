// Shared reader context. Modules import `app` and read pdf/viewer/state from it after boot.
import { h, esc, icon, debounce } from "./util.js";
import { me } from "./auth.js";

export const app = {
  key: "", meta: {}, pdf: null, viewer: null, eventBus: null, linkService: null,
  state: { highlights: [], explanations: [], citations: [], notes: "", chat: [] },
  settings: { lang: "zh", trModel: "lite", sentenceFocus: true, figures: true, autoHighlight: false, translate: false },
  pages: [], // per page index: { sentences, figures, autohl, translation }
};

// ---------- persistence ----------

// Shared lists are merged per item on the server (lib/state.js). Each save sends the ids this
// client had at its last sync (`_base`) and takes the merged lists back, which also brings in
// teammates' changes. pullState() fetches them between saves.
const SHARED = ["highlights", "explanations", "citations"];
let base = null, dirty = false, inflight = false;
const listeners = new Set();

export function markSynced() { base = Object.fromEntries(SHARED.map((k) => [k, (app.state[k] || []).map((x) => x.id)])); }

function applyServer(s) {
  let changed = false;
  for (const k of SHARED) {
    if (Array.isArray(s[k]) && JSON.stringify(s[k]) !== JSON.stringify(app.state[k])) { app.state[k] = s[k]; changed = true; }
  }
  markSynced();
  if (changed) { repaintAll("hl"); listeners.forEach((fn) => fn()); }
}

const putState = debounce(async () => {
  dirty = false;
  // Items new since the last sync are this member's: sign them for the team view.
  for (const k of SHARED) for (const x of app.state[k] || []) if (!x.by && !base?.[k]?.includes(x.id)) x.by = { id: me.uid, name: me.name };
  inflight = true;
  try {
    const r = await fetch(`/api/state/${app.key}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...app.state, _base: base }) });
    if (r.ok && !dirty) applyServer(await r.json());
  } finally { inflight = false; }
}, 400);
export function saveState() { dirty = true; putState(); listeners.forEach((fn) => fn()); }
export const onStateChange = (fn) => listeners.add(fn);

export async function pullState() {
  if (dirty || inflight || !app.key) return;
  const s = await fetch(`/api/state/${app.key}`).then((r) => r.json()).catch(() => null);
  if (s && !dirty && !inflight) applyServer(s);
}

export function saveSettings() {
  try { localStorage.setItem("pr-settings", JSON.stringify(app.settings)); } catch {}
}
try { Object.assign(app.settings, JSON.parse(localStorage.getItem("pr-settings") || "{}")); } catch {}

export const pageInfo = (i) => (app.pages[i] ||= {});

// ---------- page geometry ----------
// Positions are stored as fractions (0..1) of the page box, so they survive zoom and re-render.

export const pageView = (i) => app.viewer?.getPageView(i);
export const pageDiv = (i) => pageView(i)?.div;

export function pageIndexOf(el) {
  const p = el?.closest?.(".page");
  return p ? Number(p.dataset.pageNumber) - 1 : -1;
}

export function clientToPage(i, x, y) {
  const div = pageDiv(i);
  const r = div.getBoundingClientRect();
  return { x: (x - r.left - div.clientLeft) / div.clientWidth, y: (y - r.top - div.clientTop) / div.clientHeight };
}

// Geometric test (works off-screen too, unlike elementsFromPoint).
export function pageAtPoint(x, y) {
  for (const div of app.viewer?.viewer.children || []) {
    if (!div.classList.contains("page")) continue;
    const r = div.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return Number(div.dataset.pageNumber) - 1;
  }
  return -1;
}

// Client rects (from a Range) → { [page]: [{l,t,w,h}] } in page fractions, with same-line rects merged.
export function rectsToPages(rects) {
  const out = {};
  for (const r of rects) {
    if (r.width < 1 || r.height < 1) continue;
    const i = pageAtPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (i < 0) continue;
    const a = clientToPage(i, r.left, r.top), b = clientToPage(i, r.right, r.bottom);
    (out[i] ||= []).push({ l: a.x, t: a.y, w: b.x - a.x, h: b.y - a.y });
  }
  for (const i in out) out[i] = mergeLineRects(out[i]);
  return out;
}

export function mergeLineRects(rects) {
  const sorted = [...rects].sort((a, b) => a.t - b.t || a.l - b.l);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    const sameLine = last && Math.abs(last.t + last.h / 2 - (r.t + r.h / 2)) < Math.min(last.h, r.h) * 0.5;
    if (sameLine && r.l <= last.l + last.w + 0.02) {
      const l = Math.min(last.l, r.l), rgt = Math.max(last.l + last.w, r.l + r.w);
      const t = Math.min(last.t, r.t), btm = Math.max(last.t + last.h, r.t + r.h);
      Object.assign(last, { l, t, w: rgt - l, h: btm - t });
    } else out.push({ ...r });
  }
  return out;
}

export const inRects = (rects, p, pad = 0.002) => rects?.some((r) => p.x >= r.l - pad && p.x <= r.l + r.w + pad && p.y >= r.t - pad && p.y <= r.t + r.h + pad);

export const rectStyle = (r) => `left:${r.l * 100}%;top:${r.t * 100}%;width:${r.w * 100}%;height:${r.h * 100}%`;

// ---------- per-page overlay layer ----------
// PDF.js removes unknown children of .page on re-render, so each layer is rebuilt by painters
// whenever a page renders. Painters are pure functions of app state.

const painters = [];
export function addPainter(name, fn) { painters.push({ name, fn }); }

export function layer(i, name) {
  const div = pageDiv(i);
  if (!div) return null;
  let root = div.querySelector(":scope > .ml-layer");
  if (!root) { root = h(`<div class="ml-layer"></div>`); div.append(root); }
  let sub = root.querySelector(`:scope > .ml-${name}`);
  if (!sub) { sub = h(`<div class="ml-sub ml-${name}"></div>`); root.append(sub); }
  return sub;
}

export function repaint(i, only) {
  if (!pageDiv(i)) return;
  for (const p of painters) {
    if (only && p.name !== only) continue;
    const l = layer(i, p.name);
    if (l) p.fn(i, l);
  }
}
export function repaintAll(only) {
  for (let i = 0; i < (app.pdf?.numPages || 0); i++) if (pageView(i)?.renderingState) repaint(i, only);
}

// ---------- anchored floating cards ----------
// Cards live in #viewer (not inside .page) so they can overflow page edges; they are re-placed
// from their page-fraction anchor after every zoom/resize (debounced 100 ms).

const floats = new Set();
export function placeFloat(f) {
  const div = pageDiv(f.anchor.page);
  if (!div) return;
  const viewer = app.viewer.viewer;
  let x = div.offsetLeft + div.clientLeft + f.anchor.x * div.clientWidth;
  let y = div.offsetTop + div.clientTop + f.anchor.y * div.clientHeight;
  const w = f.el.offsetWidth;
  const maxX = Math.max(viewer.scrollWidth, app.viewer.container.clientWidth) - w - 12;
  if (f.align === "right-of") x += 12;
  x = Math.max(8, Math.min(x, maxX));
  f.el.style.left = x + "px";
  f.el.style.top = y + 6 + "px";
}
export const placeAll = () => floats.forEach(placeFloat);
export const placeAllSoon = debounce(placeAll, 100);

let activeCard = null;
export function openCard({ anchor, title, iconName = "sparkles", cls = "", align, onClose }) {
  closeCard();
  const el = h(`<div class="ml-card ${cls}" role="dialog">
      <div class="ml-card-head">${icon(iconName, 16)}<span class="ml-card-title">${esc(title)}</span><span class="grow"></span>
        <button class="icon-btn ml-card-close" title="Close (Esc)">${icon("x", 16)}</button></div>
      <div class="ml-card-body"></div><div class="ml-card-foot"></div></div>`);
  app.viewer.viewer.append(el);
  const card = { el, anchor, align, body: el.querySelector(".ml-card-body"), foot: el.querySelector(".ml-card-foot"), onClose, close: () => closeCard(card) };
  el.querySelector(".ml-card-close").onclick = card.close;
  floats.add(card);
  placeFloat(card);
  activeCard = card;
  requestAnimationFrame(() => { el.classList.add("in"); revealCard(card); });
  return card;
}
// Scroll the PDF so a freshly opened card (at its expected full height) is on screen.
function revealCard(card) {
  const c = app.viewer.container.getBoundingClientRect();
  const r = card.el.getBoundingClientRect();
  const expected = Math.min(640, innerHeight * 0.62);
  const overflow = r.top + expected - (c.bottom - 16);
  if (overflow > 0) app.viewer.container.scrollBy({ top: Math.min(overflow, r.top - c.top - 80), behavior: "smooth" });
}
export function closeCard(card = activeCard) {
  if (!card) return;
  floats.delete(card);
  card.el.remove();
  card.onClose?.();
  if (activeCard === card) activeCard = null;
}
export const currentCard = () => activeCard;

// Close the card on outside pointerdown or Escape (the selection menu has its own handling).
document.addEventListener("pointerdown", (e) => {
  if (activeCard && !activeCard.el.contains(e.target) && !e.target.closest("#selmenu, #hlmenu, .ml-keep-card")) closeCard();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && activeCard && !document.querySelector("#selmenu:popover-open")) closeCard();
});

export function scrollToPagePoint(i, y = 0) {
  app.viewer.scrollPageIntoView({ pageNumber: i + 1, destArray: [null, { name: "XYZ" }, 0, (1 - Math.max(0, y - 0.08)) * (pageView(i).viewport.viewBox[3]), null] });
}

// Text of a page as one string (cached), from PDF.js text content.
export async function pageText(i) {
  const info = pageInfo(i);
  if (info.text != null) return info.text;
  const page = await app.pdf.getPage(i + 1);
  const tc = await page.getTextContent();
  info.text = tc.items.map((it) => it.str + (it.hasEOL ? "\n" : "")).join("").replace(/-\n(?=[a-z])/g, "").replace(/\n/g, " ");
  return info.text;
}

export function contextAround(i, needle, radius = 700) {
  const t = pageInfo(i).text || "";
  const k = t.indexOf(needle.slice(0, 40));
  if (k < 0) return t.slice(0, radius * 2);
  return t.slice(Math.max(0, k - radius), k + needle.length + radius);
}
