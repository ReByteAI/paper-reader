// Block translation: each paragraph of the page is set in its translation, in the same box and at
// the original position. Figures, tables and display equations stay untouched. Two layouts:
//   inline: the boxes cover the original page;
//   side:   the boxes cover a copy of the page to its right, and the original stays as it is.
//   1. buildBlocks: text-layer spans → lines (same baseline, no wide gap, so columns stay apart)
//      → blocks (consecutive lines of one column with a normal line gap and the same text size).
//   2. translateBlocks: one model call per page; the model writes <|#n|> before block n.
//   3. painter: a box per block. Inline, the boxes sit between the PDF canvas and the text layer,
//      so selection, highlights, explanations and citations keep working on the original text
//      above them. The text size and line spacing are fitted to the box.
import { app, pageInfo, pageDiv, pageView, clientToPage, addPainter, repaint, rectStyle } from "./app.js";
import { md, stream } from "./util.js";

const MARK = /<\|#(\d+)\|>/g;
export const inlineOn = () => app.settings.translate && app.settings.trLayout !== "side";
export const sideOn = () => app.settings.translate && app.settings.trLayout === "side";

function spansOf(i) {
  const tl = pageDiv(i)?.querySelector(".textLayer");
  if (!tl) return [];
  const out = [];
  for (const s of tl.querySelectorAll("span:not(.markedContent)")) {
    const text = s.textContent;
    // Rotated text (the vertical arXiv stamp in the margin of page 1) is not part of any paragraph.
    if (!text.trim() || /rotate\((?!0deg)/.test(s.style.transform)) continue;
    const r = s.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) continue;
    const a = clientToPage(i, r.left, r.top), b = clientToPage(i, r.right, r.bottom);
    out.push({ l: a.x, t: a.y, r: b.x, b: b.y, h: b.y - a.y, text });
  }
  return out;
}

function linesOf(spans) {
  spans.sort((x, y) => (x.t + x.b) / 2 - (y.t + y.b) / 2 || x.l - y.l);
  const rows = [];
  for (const s of spans) {
    const row = rows.at(-1), c = (s.t + s.b) / 2;
    if (row && Math.abs(c - row.c) < Math.min(s.h, row.h) * 0.45) { row.items.push(s); row.h = Math.max(row.h, s.h); }
    else rows.push({ c, h: s.h, items: [s] });
  }
  // A row splits where the horizontal gap is wider than about two characters (column gutters).
  const lines = [];
  for (const [n, row] of rows.entries()) {
    row.items.sort((x, y) => x.l - y.l);
    let cur = null;
    for (const s of row.items) {
      if (cur && s.l - cur.r < row.h * 1.6) {
        cur.text += (s.l - cur.r > row.h * 0.12 && !/\s$/.test(cur.text) ? " " : "") + s.text;
        Object.assign(cur, { r: Math.max(cur.r, s.r), t: Math.min(cur.t, s.t), b: Math.max(cur.b, s.b) });
        cur.h = Math.max(cur.h, s.h);
      } else lines.push(cur = { ...s, row: n });
    }
  }
  // Table rows: several short pieces side by side. (Two text columns give two wide pieces.)
  const pieces = new Map();
  for (const ln of lines) pieces.set(ln.row, (pieces.get(ln.row) || 0) + 1);
  return lines.filter((ln) => !(pieces.get(ln.row) > 1 && ln.r - ln.l < 0.28));
}

function blocksOf(lines) {
  lines.sort((x, y) => x.t - y.t || x.l - y.l);
  const blocks = [];
  for (const ln of lines) {
    // Same column (overlapping x-range), next line down, similar text size.
    const b = blocks.findLast((b) => {
      const gap = ln.t - b.b, h = b.lh;
      // A new paragraph: the previous line stopped short, or the gap is wider than the block's own.
      if (b.lastR < b.r - h * 3 || (b.gap != null && gap > b.gap + h * 0.3)) return false;
      const overlap = Math.min(ln.r, b.r) - Math.max(ln.l, b.l);
      return gap > -h * 0.3 && gap < h * 0.85 && overlap > Math.min(ln.r - ln.l, b.r - b.l) * 0.5 &&
        ln.h / h > 0.8 && ln.h / h < 1.25 &&
        // Same left edge, or a shorter last line inside the block (centered notes, captions).
        (Math.abs(ln.l - b.l) < (b.r - b.l) * 0.25 || (ln.l >= b.l - h && ln.r <= b.r + h));
    });
    if (b) {
      b.text = /[a-z]-$/.test(b.text) ? b.text.slice(0, -1) + ln.text : b.text + " " + ln.text;
      Object.assign(b, { gap: b.gap ?? ln.t - b.b, l: Math.min(b.l, ln.l), r: Math.max(b.r, ln.r), b: ln.b, lastR: ln.r, lines: b.lines + 1 });
    } else blocks.push({ ...ln, lh: ln.h, lastR: ln.r, lines: 1 });
  }
  return blocks;
}

// Prose only: enough words and mostly letters. Equations, numbers, table cells and axis labels
// are left as they are.
function isProse(b) {
  const t = b.text.replace(/\s+/g, " ").trim();
  const words = t.match(/[A-Za-z]{2,}/g) || [];
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  if (letters / t.length < 0.6) return false;
  // One line: a heading ("3.2 Attention") or a short sentence.
  if (b.lines === 1 && t.length < 8 && !/^[\dA-Z][\d.]*\s+[A-Za-z]{4,}/.test(t)) return false;
  if (b.lines === 1 && words.length < 2 && !/^\d[\d.]*\s/.test(t)) return false;
  return b.lines === 1 || words.length >= 4;
}

// The model left the block as it was (names, e-mail addresses, a title kept in English): the
// original stays visible rather than a re-typeset copy.
const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const unchanged = (src, out) => norm(out.replace(/\$[^$]*\$/g, "")) === norm(src) || norm(src).includes(norm(out)) && norm(out).length > 0;

// Text inside a detected figure or table (figures.js; it may arrive after the translation).
function inFigure({ l, t, w, h }, figures) {
  const cx = l + w / 2, cy = t + h / 2;
  return (figures || []).some((f) => f.label !== "formula" && cx > f.left && cx < f.right && cy > f.top && cy < f.bottom);
}

export function buildBlocks(i) {
  const info = pageInfo(i);
  if (info.blocks) return info.blocks;
  if (!info.textReady) return null;
  const spans = spansOf(i);
  if (!spans.length) return (info.blocks = []);
  info.blocks = blocksOf(linesOf(spans))
    .filter(isProse)
    .map(({ l, t, r, b, lh, lines, text }) => ({ rect: { l, t, w: r - l, h: b - t }, lh, lines, text: text.replace(/\s+/g, " ").trim() }));
  return info.blocks;
}

function parse(text, n) {
  const out = new Array(n).fill("");
  let id = -1, last = 0, m;
  MARK.lastIndex = 0;
  while ((m = MARK.exec(text))) {
    if (id >= 0 && id < n) out[id] += text.slice(last, m.index);
    id = Number(m[1]); last = m.index + m[0].length;
  }
  if (id >= 0 && id < n) out[id] += text.slice(last);
  return out.map((t) => t.trim());
}

// A failed, empty or stalled request (no data for 45 s) is retried up to three times; before,
// such a page stayed in the original until the reader reloaded.
export async function translateBlocks(i, { regenerate = false, attempt = 0 } = {}) {
  const info = pageInfo(i);
  if (!app.settings.translate || info.inlPending || (info.inl && !regenerate)) return;
  const blocks = buildBlocks(i);
  if (!blocks?.length) return;
  info.inlPending = true;
  const lang = app.settings.lang, ctl = new AbortController();
  let timer;
  const idle = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), 45_000); };
  let ok = false;
  try {
    idle();
    const full = await stream("translate-blocks", { lang, model: app.settings.trModel, blocks: blocks.map((b) => b.text), regenerate: regenerate || attempt > 0 }, (t) => {
      idle();
      if (lang !== app.settings.lang) return;
      info.inlText = parse(t, blocks.length);
      repaint(i, "inl");
    }, { signal: ctl.signal });
    ok = !/\n> ⚠️/.test(full) && parse(full, blocks.length).filter(Boolean).length > 0;
  } catch (e) { console.warn("inline translation", i, e); }
  clearTimeout(timer);
  info.inlPending = false;
  if (lang !== app.settings.lang) return translateBlocks(i); // language changed meanwhile
  if (ok) info.inl = true;
  else if (attempt < 3) setTimeout(() => translateBlocks(i, { attempt: attempt + 1 }), 2000 * (attempt + 1));
  repaint(i, "inl");
}

// Translated block under a page point (side layout hover), or -1.
export function blockAt(i, p) {
  return (pageInfo(i).blocks || []).findIndex(({ rect: r }) => p.x >= r.l && p.x <= r.l + r.w && p.y >= r.t && p.y <= r.t + r.h);
}

// Side layout: the block under the pointer is marked on both pages.
let hovered = { i: -1, k: -1 };
export function setBlockHover(i, k) {
  if (hovered.i === i && hovered.k === k) return;
  if (hovered.i >= 0) mark(hovered.i, hovered.k, false);
  hovered = { i, k };
  if (i >= 0 && k >= 0) mark(i, k, true);
}
function mark(i, k, on) {
  const div = pageDiv(i), b = pageInfo(i).blocks?.[k];
  const box = div?.querySelector(`.tr-page .inl-block[data-k="${k}"]`);
  const mirror = div?.querySelector(".ml-inl > .inl-mirror");
  if (!box || !mirror) return;
  box.classList.toggle("on", on);
  if (on) mirror.style.cssText = rectStyle(b.rect);
  mirror.hidden = !on;
}

// Language or model changed.
export function resetInline(i) { Object.assign(pageInfo(i), { inl: false, inlText: null }); }

// "1. Introduction" and "- item" are text in a block, not Markdown lists.
const literalStart = (t) => t.replace(/^(\d+)\.(\s)/, "$1\\.$2").replace(/^([-*+])(\s)/, "\\$1$2");

const REDO_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>`;

// Side layout: a copy of the page canvas to the right of the page. PDF.js draws a new canvas
// on each render, so the copy is made again when the source changes or finishes drawing.
function sidePage(i, el) {
  let page = el.querySelector(":scope > .tr-page");
  if (!page) {
    el.innerHTML = `<div class="inl-mirror" hidden></div><div class="tr-page"><canvas></canvas><div class="inl-layer"></div>
      <button class="icon-btn tr-redo" title="Translation looks wrong? Regenerate this page" aria-label="Regenerate translation">${REDO_ICON}</button></div>`;
    page = el.querySelector(".tr-page");
    page.querySelector(".tr-redo").onclick = () => translateBlocks(i, { regenerate: true });
    page.addEventListener("mouseover", (e) => setBlockHover(i, Number(e.target.closest(".inl-block")?.dataset.k ?? -1)));
    page.addEventListener("mouseleave", () => setBlockHover(-1, -1));
  }
  const src = pageDiv(i).querySelector(".canvasWrapper canvas"), copy = page.querySelector("canvas");
  const done = pageView(i)?.renderingState === 3; // RenderingStates.FINISHED
  if (src && (copy.src !== src || !copy.done)) {
    Object.assign(copy, { width: src.width, height: src.height, src, done });
    copy.getContext("2d").drawImage(src, 0, 0);
  }
  page.querySelector(".tr-redo").toggleAttribute("disabled", !!pageInfo(i).inlPending);
  return page.querySelector(".inl-layer");
}

addPainter("inl", (i, el) => {
  const div = pageDiv(i);
  if (!div) return;
  const inlineHost = div.querySelector(":scope > .inl-layer");
  if (!inlineOn()) inlineHost?.remove();
  if (!sideOn()) el.innerHTML = "";
  if (!app.settings.translate) return;
  let host;
  if (sideOn()) host = sidePage(i, el);
  else {
    host = inlineHost || Object.assign(document.createElement("div"), { className: "inl-layer" });
    // Below the text layer: the original text stays selectable and hoverable.
    const tl = div.querySelector(":scope > .textLayer");
    if (host.nextSibling !== tl) div.insertBefore(host, tl);
  }
  const info = pageInfo(i), blocks = info.blocks || [], texts = info.inlText || [];
  const H = div.clientHeight;
  host.innerHTML = blocks.map((b, k) => texts[k] && !inFigure(b.rect, info.figures) && !(info.inl && unchanged(b.text, texts[k]))
    ? `<div class="inl-block${b.lines > 1 ? " multi" : ""}" data-k="${k}" style="${rectStyle(b.rect)};font-size:${(b.lh * H * 0.82).toFixed(1)}px"><div>${md(literalStart(texts[k])).replace(/^<p>|<\/p>\s*$/g, "")}</div></div>`
    : "").join("");
  if (hovered.i === i) mark(i, hovered.k, true);
  // Largest text size (up to a little above the original) that fits the box; then the line
  // spacing grows so a shorter translation still fills the paragraph instead of leaving a blank.
  for (const box of host.children) {
    const base = parseFloat(box.style.fontSize), text = box.firstChild;
    const fits = (size) => { box.style.fontSize = size + "px"; return text.scrollHeight <= box.clientHeight + 1; };
    let lo = base * 0.5, hi = base * 1.15;
    if (fits(hi)) lo = hi;
    else { for (let k = 0; k < 7; k++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; } fits(lo); }
    const lines = Math.round(text.scrollHeight / (lo * 1.22));
    if (lines > 1) box.style.lineHeight = Math.min(1.8, Math.max(1.22, box.clientHeight / lines / lo)).toFixed(2);
  }
});

// Hold Alt (⌥) to see the original page under the translation.
const peek = (on) => document.documentElement.classList.toggle("inl-peek", on);
addEventListener("keydown", (e) => { if (e.key === "Alt") peek(true); });
addEventListener("keyup", (e) => { if (e.key === "Alt") peek(false); });
addEventListener("blur", () => peek(false));
