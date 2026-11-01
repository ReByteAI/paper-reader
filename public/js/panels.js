// Left rail (hover-expand), outline panel, and the resizable right panel with its tabs.
import { mountUserButton, me } from "./auth.js";
import { app, saveState, onStateChange, scrollToPagePoint, placeAllSoon } from "./app.js";
import { $, $$, h, esc, md, icon, toast } from "./util.js";
import { renderAI, renderQuiz, renderRelated } from "./ai.js";
import { mountThemeButton } from "./theme.js";

// In a team, list items show who added them.
const byline = (who) => (me.team && who?.name ? `<span class="by">${esc(who.name)}</span>` : "");

// key: the letter that opens the tab (first letter; Citations takes I because Comments has C).
const TABS = [
  { id: "ai", label: "With AI", icon: "bot", key: "A" },
  { id: "highlights", label: "Highlights", icon: "highlighter", key: "H" },
  { id: "explanations", label: "Explanations", icon: "lightbulb", key: "E" },
  { id: "comments", label: "Comments", icon: "message", key: "C" },
  { id: "notes", label: "Notes", icon: "note", key: "N" },
  { id: "citations", label: "Citations", icon: "quote", key: "I" },
  { id: "quiz", label: "Quiz", icon: "quiz", key: "Q" },
  { id: "related", label: "Related papers", icon: "compass", key: "R" },
];
const root = document.documentElement;
let activeTab = null;

// ---------- layout variables ----------
// The PDF area reacts to --left-panel-w / --right-panel-w with a 180 ms transition; once it settles,
// PDF.js re-fits when the zoom is in an automatic mode.

function refit() {
  const v = app.viewer;
  if (!v) return;
  if (["auto", "page-width", "page-fit"].includes(v.currentScaleValue)) v.currentScaleValue = v.currentScaleValue;
  placeAllSoon();
}
export function initLayout() {
  $("#main").addEventListener("transitionend", (e) => { if (e.target.id === "main") refit(); });
  addEventListener("resize", refit);
}

// ---------- left rail ----------

export function initLeftRail() {
  const rail = $("#leftrail");
  rail.innerHTML = `
    <a class="rail-logo" href="/" title="Home"><span class="logo-dot"></span><span class="rail-label brand">XYZNOT</span></a>
    <nav>
      <a href="/library" class="rail-item">${icon("home")}<span class="rail-label">Home</span></a>
      <a href="/library#library" class="rail-item">${icon("library")}<span class="rail-label">Library</span></a>
      <button class="rail-item" data-act="upload">${icon("upload")}<span class="rail-label">Upload PDF</span></button>
      <span class="rail-sep"></span>
      <button class="rail-item" data-act="outline">${icon("outline")}<span class="rail-label">Outline</span></button>
      <button class="rail-item" data-act="info">${icon("info")}<span class="rail-label">Paper info</span></button>
    </nav>
    <span class="grow"></span>
    <button class="rail-item" id="rail-theme"></button>
    <div class="rail-user" id="rail-user"></div>`;
  mountUserButton($("#rail-user"));
  mountThemeButton($("#rail-theme"), { label: true });
  // Expands over the content (no reflow) on hover or keyboard focus.
  const open = () => rail.classList.add("expanded");
  const close = () => rail.classList.remove("expanded");
  rail.addEventListener("pointerenter", open);
  rail.addEventListener("pointerleave", close);
  rail.addEventListener("focusin", open);
  rail.addEventListener("focusout", (e) => { if (!rail.contains(e.relatedTarget)) close(); });
  rail.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "upload") uploadPdf();
    if (act === "outline") toggleOutline();
    if (act === "info") $("#btn-info").click();
  });
}

export function uploadPdf() {
  const input = h(`<input type="file" accept="application/pdf" hidden>`);
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    toast("Uploading…");
    const r = await fetch("/api/upload", { method: "POST", headers: { "x-filename": encodeURIComponent(f.name) }, body: f }).then((x) => x.json());
    if (r.key) location.href = "/paper/" + r.key; else toast(r.error || "Upload failed");
  };
  input.click();
}

// ---------- outline ----------

export async function toggleOutline(force) {
  const show = force ?? !root.classList.contains("outline-open");
  root.classList.toggle("outline-open", show);
  $("#btn-outline").classList.toggle("on", show);
  if (show && !$("#outline").dataset.ready) await buildOutline();
}

async function buildOutline() {
  const box = $("#outline");
  box.dataset.ready = "1";
  const outline = await app.pdf.getOutline();
  const list = h(`<div class="outline-list"></div>`);
  const add = (items, depth) => {
    for (const it of items || []) {
      const b = h(`<button class="outline-item" style="padding-left:${12 + depth * 14}px">${esc(it.title)}</button>`);
      b.onclick = () => it.dest && app.navigate(it.dest);
      list.append(b);
      add(it.items, depth + 1);
    }
  };
  add(outline, 0);
  box.innerHTML = `<div class="panel-title">Outline</div>`;
  if (!outline?.length) {
    // No embedded outline: list pages instead.
    for (let i = 0; i < app.pdf.numPages; i++) {
      const b = h(`<button class="outline-item">Page ${i + 1}</button>`);
      b.onclick = () => scrollToPagePoint(i, 0);
      list.append(b);
    }
  }
  box.append(list);
}

// ---------- right panel ----------

export function initRightPanel() {
  const rail = $("#rightrail");
  rail.innerHTML = TABS.map((t) => `<button class="rail-item" data-tab="${t.id}" title="${t.label} (${t.key})">${icon(t.icon)}<span class="rail-tip">${t.label} <kbd>${t.key}</kbd></span><kbd class="rail-key">${t.key}</kbd></button>`).join("");
  initTabKeys(rail);
  // A click focuses the panel too, except on touch screens, where that would pop up the keyboard.
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
  rail.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]")?.dataset.tab;
    if (t) (activeTab === t ? closePanel() : openPanel(t, { focus: finePointer.matches }));
  });
  $("#rp-close").onclick = closePanel;
  try {
    const w = Number(localStorage.getItem("pr-right-w"));
    if (w) root.style.setProperty("--right-panel-open-w", w + "px");
  } catch {}
  initResize();
  onStateChange(() => activeTab && !["ai", "notes", "quiz", "related"].includes(activeTab) && renderTab(activeTab));
}

// Tab shortcuts: each tab's letter (A opens With AI, and so on) opens it and puts the focus in
// it; the same letter closes it. Esc in the panel gives the focus back to the paper. Letters do
// nothing while typing or with text selected (the selection menu has its own letters), and a
// figure under the cursor keeps E and C (figures.js, which handles the key first).
// Holding Control (Mac) or Alt shows each tab's letter on the rail.
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? "Control" : "Alt";
export const typing = (el) => !!el?.closest?.("input, textarea, select, [contenteditable]");
function initTabKeys(rail) {
  const show = (on) => rail.classList.toggle("show-keys", on);
  addEventListener("keydown", (e) => {
    if (e.key === MOD) return show(true);
    if (e.key === "Escape" && $("#rightpanel").contains(document.activeElement)) return document.activeElement.blur();
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat || e.isComposing || e.defaultPrevented) return;
    if (typing(e.target) || !getSelection().isCollapsed) return;
    // e.code, not e.key: the key itself, whatever the keyboard layout prints.
    const t = TABS.find((x) => e.code === "Key" + x.key);
    if (!t) return;
    e.preventDefault();
    activeTab === t.id ? closePanel() : openPanel(t.id, { focus: true });
  });
  addEventListener("keyup", (e) => { if (e.key === MOD) show(false); });
  addEventListener("blur", () => show(false));
}

// The tab's text box (With AI, Notes), else the panel itself so the arrow keys scroll it.
function focusPanel() {
  const body = $("#rp-body");
  const box = body.querySelector("#chat-input, .notes textarea:not([hidden])");
  if (!box) return body.focus({ preventScroll: true });
  box.focus({ preventScroll: true });
  box.setSelectionRange?.(box.value.length, box.value.length);
}

export function openPanel(tab, { focus = false } = {}) {
  activeTab = tab;
  root.classList.add("rp-open");
  $$("#rightrail [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $("#rp-title").textContent = TABS.find((t) => t.id === tab).label;
  renderTab(tab);
  if (focus) focusPanel();
}
export function closePanel() {
  if ($("#rightpanel").contains(document.activeElement)) document.activeElement.blur();
  activeTab = null;
  root.classList.remove("rp-open");
  $$("#rightrail [data-tab]").forEach((b) => b.classList.remove("on"));
}

function initResize() {
  const grip = $("#rp-resize");
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    root.classList.add("rp-resizing");
    document.body.style.userSelect = "none";
    const move = (ev) => {
      const w = Math.min(Math.max(innerWidth - ev.clientX - 56, 300), Math.min(900, innerWidth - 420));
      root.style.setProperty("--right-panel-open-w", w + "px");
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      root.classList.remove("rp-resizing");
      document.body.style.userSelect = "";
      try { localStorage.setItem("pr-right-w", parseInt(getComputedStyle(root).getPropertyValue("--right-panel-open-w"))); } catch {}
      refit();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
}

const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const empty = (iconName, text) => `<div class="empty">${icon(iconName, 28)}<p>${text}</p></div>`;

function renderTab(tab) {
  const body = $("#rp-body");
  body.dataset.tab = tab;
  if (tab === "ai") return renderAI(body);
  if (tab === "quiz") return renderQuiz(body);
  if (tab === "related") return renderRelated(body);
  if (tab === "notes") return renderNotes(body);
  if (tab === "highlights") {
    const xs = [...app.state.highlights].sort((a, b) => a.page - b.page || a.y - b.y);
    body.innerHTML = xs.length ? xs.map((x) => `<div class="list-item" data-page="${x.page}" data-y="${x.y}">
        <div class="li-head"><span class="dot hl-${x.color}"></span>Page ${x.page + 1}${byline(x.by)}<span class="grow"></span><button class="icon-btn" data-del="${x.id}">${icon("trash", 14)}</button></div>
        <div class="li-quote">${esc(x.text)}</div>${x.comment ? `<div class="li-comment">${icon("message", 12)} ${esc(x.comment)}</div>` : ""}</div>`).join("")
      : empty("highlighter", "Select text and pick a color to highlight.");
  }
  if (tab === "comments") {
    const xs = app.state.highlights.filter((x) => x.comment).sort((a, b) => a.page - b.page || a.y - b.y);
    body.innerHTML = xs.length ? xs.map((x) => `<div class="list-item" data-page="${x.page}" data-y="${x.y}">
        <div class="li-head">Page ${x.page + 1} · ${fmtDate(x.mt || x.ts)}${byline(x.commentBy || x.by)}</div>
        <div class="li-quote small">${esc(x.text.slice(0, 160))}</div><div class="li-comment big">${esc(x.comment)}</div></div>`).join("")
      : empty("message", "Select text and press C to comment.");
  }
  if (tab === "explanations") {
    const xs = app.state.explanations;
    body.innerHTML = xs.length ? xs.map((x) => `<details class="list-item exp" data-page="${x.page}" data-y="${x.y}">
        <summary><div class="li-head">${x.kind === "text" ? "Text" : esc(x.kind)} · Page ${x.page + 1}<span class="grow"></span><button class="icon-btn" data-delexp="${x.id}">${icon("trash", 14)}</button></div>
        <div class="li-quote">${esc(x.quote.slice(0, 200))}</div></summary><div class="md">${md(x.answer)}</div></details>`).join("")
      : empty("lightbulb", "Select text and press E, or hover a figure and press E.");
  }
  if (tab === "citations") {
    const xs = app.state.citations;
    body.innerHTML = xs.length ? xs.map((x) => `<div class="list-item">
        <div class="li-head">${esc(x.label || "")} · cited on page ${x.page + 1}<span class="grow"></span><button class="icon-btn" data-delcite="${x.id}">${icon("trash", 14)}</button></div>
        <div class="ref-title">${esc(x.title)}</div><div class="ref-meta">${esc(x.authors || "")} ${x.year || ""}</div>
        <div class="ref-links">${x.arxiv ? `<a class="btn primary" href="/paper/${esc(x.arxiv)}" target="_blank">Read here</a>` : ""}<a class="btn ghost" target="_blank" href="${esc(x.url)}">Semantic Scholar</a></div></div>`).join("")
      : empty("quote", "Click a citation like [12] in the paper, then Save.");
  }
  body.onclick = (e) => {
    const del = e.target.closest("[data-del],[data-delexp],[data-delcite]");
    if (del) {
      e.preventDefault(); e.stopPropagation();
      if (del.dataset.del) app.state.highlights = app.state.highlights.filter((x) => x.id !== del.dataset.del);
      if (del.dataset.delexp) app.state.explanations = app.state.explanations.filter((x) => x.id !== del.dataset.delexp);
      if (del.dataset.delcite) app.state.citations = app.state.citations.filter((x) => x.id !== del.dataset.delcite);
      saveState();
      import("./app.js").then((m) => m.repaintAll("hl"));
      return;
    }
    const item = e.target.closest("[data-page]");
    if (item && !e.target.closest("a, summary .icon-btn")) scrollToPagePoint(Number(item.dataset.page), Number(item.dataset.y) || 0);
  };
}

// ---------- notes ----------

function renderNotes(body) {
  body.innerHTML = `<div class="notes">
    <div class="seg"><button data-m="edit" class="on">Write</button><button data-m="preview">Preview</button></div>
    <textarea placeholder="Notes for this paper (Markdown + $math$)…">${esc(app.state.notes || "")}</textarea>
    <div class="md notes-preview" hidden></div></div>`;
  const ta = body.querySelector("textarea"), pv = body.querySelector(".notes-preview");
  ta.oninput = () => { app.state.notes = ta.value; saveState(); };
  body.querySelector(".seg").onclick = (e) => {
    const m = e.target.dataset.m;
    if (!m) return;
    body.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
    ta.hidden = m !== "edit"; pv.hidden = m !== "preview";
    if (m === "preview") pv.innerHTML = md(ta.value) || "<p class='muted'>Nothing yet.</p>";
  };
}

// ---------- AI, quiz, related: see ai.js ----------

export { askWithQuote, ensureFullText } from "./ai.js";
