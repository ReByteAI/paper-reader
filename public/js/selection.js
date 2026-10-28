// Text selection menu (Popover API), highlights, comments, inline explanations and translations.
import { app, saveState, rectsToPages, addPainter, repaint, rectStyle, inRects, openCard, closeCard, pageAtPoint, clientToPage, contextAround, pageText, scrollToPagePoint } from "./app.js";
import { h, esc, md, icon, stream, uid, toast } from "./util.js";
import { openPanel, askWithQuote } from "./panels.js";

export const COLORS = ["yellow", "green", "blue", "pink", "purple"];

// ---------- highlight overlay ----------

addPainter("hl", (i, el) => {
  el.innerHTML = app.state.highlights.filter((x) => x.rects[i]).map((x) => {
    const rs = x.rects[i];
    const boxes = rs.map((r) => `<div class="hl-box hl-${x.color}" data-id="${x.id}" style="${rectStyle(r)}"></div>`).join("");
    const last = rs.at(-1);
    const badge = x.comment && Number(Object.keys(x.rects).at(-1)) === i
      ? `<button class="hl-badge" data-id="${x.id}" style="left:${(last.l + last.w) * 100}%;top:${last.t * 100}%" title="${esc(x.comment)}">${icon("message", 12)}</button>` : "";
    return boxes + badge;
  }).join("");
  el.querySelectorAll(".hl-badge").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); openComment(app.state.highlights.find((x) => x.id === b.dataset.id)); }));
});

const repaintHl = (x) => Object.keys(x.rects).forEach((i) => repaint(Number(i), "hl"));

export function addHighlight(sel, color = "yellow", extra = {}) {
  const x = { id: uid(), color, text: sel.text, rects: sel.rects, page: sel.anchor.page, y: sel.anchor.y0, ts: Date.now(), ...extra };
  app.state.highlights.push(x);
  saveState();
  repaintHl(x);
  return x;
}
export function removeHighlight(id) {
  const x = app.state.highlights.find((y) => y.id === id);
  app.state.highlights = app.state.highlights.filter((y) => y.id !== id);
  saveState();
  if (x) repaintHl(x);
}
export function updateHighlight(id, patch) {
  const x = app.state.highlights.find((y) => y.id === id);
  if (!x) return;
  Object.assign(x, patch);
  saveState();
  repaintHl(x);
}

// ---------- selection snapshot ----------

let current = null; // { text, rects:{page:[...]}, anchor:{page,x,y,y0}, context }

function snapshot() {
  const s = getSelection();
  if (!s || s.isCollapsed || !s.rangeCount) return null;
  const range = s.getRangeAt(0);
  if (!app.viewer.viewer.contains(range.commonAncestorContainer)) return null;
  const text = s.toString().replace(/-\n(?=[a-z])/g, "").replace(/\s+/g, " ").trim();
  if (text.length < 2) return null;
  const rects = rectsToPages(range.getClientRects());
  const pages = Object.keys(rects).map(Number);
  if (!pages.length) return null;
  const lastPage = pages.at(-1), firstPage = pages[0];
  const last = rects[lastPage].at(-1);
  return {
    text, rects,
    anchor: { page: lastPage, x: rects[lastPage][0].l, y: last.t + last.h, y0: rects[firstPage][0].t },
    context: contextAround(firstPage, text),
  };
}

// ---------- the menu ----------

const menu = h(`<div id="selmenu" popover="manual">
  <button data-act="explain">${icon("lightbulb", 15)}<span>Explain</span><kbd>E</kbd></button>
  <span class="sep"></span>
  <span class="swatches">${COLORS.map((c) => `<button class="swatch hl-${c}" data-act="hl" data-color="${c}" title="Highlight ${c} (H)"></button>`).join("")}</span>
  <span class="sep"></span>
  <button data-act="translate">${icon("languages", 15)}<span>Translate</span><kbd>T</kbd></button>
  <button data-act="comment">${icon("message", 15)}<span>Comment</span><kbd>C</kbd></button>
  <button data-act="ask" class="primary">${icon("bot", 15)}<span>Ask AI</span><kbd>↵</kbd></button>
  <button data-act="copy" class="icon-only" title="Copy">${icon("copy", 15)}</button>
</div>`);
document.body.append(menu);

let menuPos = { x: 0, y: 0 };
function positionMenu() {
  const r = menu.getBoundingClientRect();
  const x = Math.min(Math.max(8, menuPos.x - r.width / 2), innerWidth - r.width - 8);
  let y = menuPos.y + 10;
  if (y + r.height > innerHeight - 8) y = menuPos.y - r.height - 28;
  menu.style.translate = `${x}px ${Math.max(8, y)}px`;
}
function showMenu(x, y) {
  menuPos = { x, y };
  if (!menu.matches(":popover-open")) menu.showPopover();
  positionMenu();
}
export function hideMenu() { if (menu.matches(":popover-open")) menu.hidePopover(); }

// Keep the menu glued to the selection on any scroll/resize.
const follow = () => {
  if (!menu.matches(":popover-open")) return;
  const s = getSelection();
  if (!s.rangeCount || s.isCollapsed) return hideMenu();
  const rs = s.getRangeAt(0).getClientRects();
  const last = rs[rs.length - 1];
  if (last) { menuPos = { x: last.right, y: last.bottom }; positionMenu(); }
};
addEventListener("scroll", follow, true);
addEventListener("resize", follow);

export function initSelection() {
  const vc = app.viewer.container;
  vc.addEventListener("mouseup", (e) => {
    if (e.button !== 0 || e.target.closest(".ml-card, .tr-col, .fig-tools")) return;
    setTimeout(() => {
      current = snapshot();
      if (current) { hideHlMenu(); showMenu(e.clientX, e.clientY); } else hideMenu();
    }, 0);
  });
  document.addEventListener("selectionchange", () => { if (getSelection().isCollapsed) hideMenu(); });
  menu.addEventListener("pointerdown", (e) => e.preventDefault()); // keep the selection alive
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) act(b.dataset.act, b.dataset.color);
  });
  document.addEventListener("keydown", (e) => {
    if (!menu.matches(":popover-open") || e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    const k = e.key.toLowerCase();
    const map = { e: "explain", h: "hl", t: "translate", c: "comment", enter: "ask", escape: "close" };
    if (map[k]) { e.preventDefault(); act(map[k], "yellow"); }
  });

  // Click on an existing highlight → highlight menu.
  vc.addEventListener("click", (e) => {
    if (!getSelection().isCollapsed || e.target.closest(".ml-card, .tr-col, .fig-tools, a, button")) return;
    const i = pageAtPoint(e.clientX, e.clientY);
    if (i < 0) return;
    const p = clientToPage(i, e.clientX, e.clientY);
    const x = [...app.state.highlights].reverse().find((y) => inRects(y.rects[i], p));
    if (x) showHlMenu(x, e.clientX, e.clientY); else hideHlMenu();
  });
}

function act(kind, color) {
  const sel = current;
  if (kind === "close" || !sel) { hideMenu(); getSelection().removeAllRanges(); return; }
  hideMenu();
  if (kind === "copy") { navigator.clipboard.writeText(sel.text); toast("Copied"); return; }
  getSelection().removeAllRanges();
  if (kind === "hl") addHighlight(sel, color);
  else if (kind === "explain") explainText(sel);
  else if (kind === "translate") translateText(sel);
  else if (kind === "comment") openComment(addHighlight(sel, "yellow", { comment: "" }), true);
  else if (kind === "ask") askWithQuote(sel.text, sel.anchor.page);
}

// ---------- highlight menu ----------

const hlmenu = h(`<div id="hlmenu" popover="manual">
  <span class="swatches">${COLORS.map((c) => `<button class="swatch hl-${c}" data-color="${c}"></button>`).join("")}</span>
  <span class="sep"></span>
  <button data-act="comment" title="Comment">${icon("message", 15)}</button>
  <button data-act="explain" title="Explain">${icon("lightbulb", 15)}</button>
  <button data-act="ask" title="Ask AI">${icon("bot", 15)}</button>
  <button data-act="copy" title="Copy">${icon("copy", 15)}</button>
  <button data-act="delete" title="Delete">${icon("trash", 15)}</button>
</div>`);
document.body.append(hlmenu);
let hlTarget = null;
function showHlMenu(x, cx, cy) {
  hlTarget = x;
  if (!hlmenu.matches(":popover-open")) hlmenu.showPopover();
  const r = hlmenu.getBoundingClientRect();
  hlmenu.style.translate = `${Math.min(Math.max(8, cx - r.width / 2), innerWidth - r.width - 8)}px ${Math.max(8, cy - r.height - 14)}px`;
}
function hideHlMenu() { if (hlmenu.matches(":popover-open")) hlmenu.hidePopover(); }
document.addEventListener("pointerdown", (e) => { if (!hlmenu.contains(e.target)) hideHlMenu(); }, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideHlMenu(); });
hlmenu.addEventListener("click", (e) => {
  const b = e.target.closest("button"); const x = hlTarget;
  if (!b || !x) return;
  hideHlMenu();
  const page = Number(Object.keys(x.rects).at(-1)), last = x.rects[page].at(-1);
  const sel = { text: x.text, rects: x.rects, anchor: { page, x: x.rects[page][0].l, y: last.t + last.h }, context: contextAround(page, x.text) };
  if (b.dataset.color) updateHighlight(x.id, { color: b.dataset.color });
  else if (b.dataset.act === "delete") removeHighlight(x.id);
  else if (b.dataset.act === "comment") openComment(x, true);
  else if (b.dataset.act === "explain") explainText(sel);
  else if (b.dataset.act === "ask") askWithQuote(x.text, page);
  else if (b.dataset.act === "copy") { navigator.clipboard.writeText(x.text); toast("Copied"); }
});

// ---------- cards ----------

export function openComment(x, focus) {
  const page = Number(Object.keys(x.rects).at(-1)), last = x.rects[page].at(-1);
  const card = openCard({ anchor: { page, x: x.rects[page][0].l, y: last.t + last.h }, title: "Comment", iconName: "message", cls: "comment-card" });
  card.body.innerHTML = `<blockquote class="quote">${esc(x.text.slice(0, 300))}</blockquote><textarea rows="4" placeholder="Write a comment…">${esc(x.comment || "")}</textarea>`;
  card.foot.innerHTML = `<button class="btn ghost" data-act="del">${icon("trash", 14)} Delete</button><span class="grow"></span><button class="btn primary" data-act="save">Save <kbd>⌘↵</kbd></button>`;
  const ta = card.body.querySelector("textarea");
  const save = () => { updateHighlight(x.id, { comment: ta.value.trim() }); closeCard(card); };
  card.foot.querySelector("[data-act=save]").onclick = save;
  card.foot.querySelector("[data-act=del]").onclick = () => { removeHighlight(x.id); closeCard(card); };
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(); });
  // Closing an empty new comment drops the comment flag but keeps the highlight.
  card.onClose = () => { if (!x.comment) updateHighlight(x.id, { comment: undefined }); };
  if (focus) setTimeout(() => ta.focus(), 30);
}

// Streams an AI answer into a card body, with a blinking caret while streaming.
export async function streamInto(card, task, body) {
  const out = h(`<div class="md streaming"><div class="skeleton"><i></i><i></i><i style="width:60%"></i></div></div>`);
  card.body.append(out);
  const ctrl = new AbortController();
  const prevClose = card.onClose;
  card.onClose = () => { ctrl.abort(); prevClose?.(); };
  try {
    const text = await stream(task, body, (t) => { if (t) out.innerHTML = md(t); }, { signal: ctrl.signal });
    out.classList.remove("streaming");
    return text;
  } catch (e) {
    if (e.name !== "AbortError") out.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    out.classList.remove("streaming");
    return null;
  }
}

export async function explainText(sel) {
  const card = openCard({ anchor: sel.anchor, title: "Explain", iconName: "lightbulb", cls: "explain-card" });
  card.body.innerHTML = `<blockquote class="quote">${esc(sel.text.slice(0, 400))}${sel.text.length > 400 ? "…" : ""}</blockquote>`;
  card.foot.innerHTML = `<button class="btn ghost" data-act="ask">${icon("bot", 14)} Follow up</button><span class="grow"></span><button class="btn ghost" data-act="hl">${icon("highlighter", 14)} Highlight</button>`;
  card.foot.querySelector("[data-act=ask]").onclick = () => { closeCard(card); askWithQuote(sel.text, sel.anchor.page); };
  card.foot.querySelector("[data-act=hl]").onclick = (e) => { addHighlight(sel, "yellow"); e.currentTarget.disabled = true; };
  await pageText(sel.anchor.page);
  const answer = await streamInto(card, "explain", { key: app.key, lang: app.settings.lang, selection: sel.text, context: sel.context || contextAround(sel.anchor.page, sel.text), page: sel.anchor.page + 1 });
  if (answer) {
    app.state.explanations.unshift({ id: uid(), kind: "text", quote: sel.text, answer, page: sel.anchor.page, y: sel.anchor.y0 ?? sel.anchor.y, ts: Date.now() });
    saveState();
  }
}

export async function translateText(sel) {
  const card = openCard({ anchor: sel.anchor, title: "Translate", iconName: "languages", cls: "translate-card" });
  await streamInto(card, "translate-text", { lang: app.settings.lang, selection: sel.text });
}

export function jumpTo(page, y) { scrollToPagePoint(page, y); }
export { openPanel };
