// Reader entry: boots PDF.js, the top bar, and wires every interaction module together.
import * as pdfjsLib from "/vendor/pdfjs/build/pdf.mjs";
import { app, pageInfo, repaint, repaintAll, placeAllSoon, pageAtPoint, clientToPage, saveSettings, saveState, markSynced, pullState } from "./app.js";
import { $, esc, icon, debounce } from "./util.js";
import { prepareSentencesFor, sentenceAt, setHover, hover, ensureAutoHighlight } from "./sentences.js";
import { initSelection } from "./selection.js";
import { initCitations } from "./citations.js";
import { detectFigures, figureAt, setFigureHover } from "./figures.js";
import { initLeftRail, initRightPanel, initLayout, toggleOutline, ensureFullText } from "./panels.js";
import { translatePage, setTranslate, resetTranslations } from "./translate.js";
import { requireSignIn, authHeaders, me, showPaywall } from "./auth.js";
import { initExport, editPersona } from "./extras.js";

globalThis.pdfjsLib = pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.mjs";
const { EventBus, PDFViewer, PDFLinkService, PDFFindController, LinkTarget } = await import("/vendor/pdfjs/web/pdf_viewer.mjs");

try { const t = localStorage.getItem("pr-theme"); if (t) document.documentElement.dataset.theme = t; } catch {}

app.key = decodeURIComponent(location.pathname.split("/paper/")[1] || "");

// Answer and translation languages (names in their own script). Codes match LANG in lib/prompts.js.
const LANGS = [
  ["zh", "简体中文"], ["zh-TW", "繁體中文"], ["en", "English"], ["ja", "日本語"], ["ko", "한국어"],
  ["ar", "العربية"], ["fa", "فارسی"], ["he", "עברית"], ["hi", "हिन्दी"], ["bn", "বাংলা"],
  ["th", "ไทย"], ["vi", "Tiếng Việt"], ["id", "Bahasa Indonesia"], ["ms", "Bahasa Melayu"],
  ["fr", "Français"], ["de", "Deutsch"], ["es", "Español"], ["pt", "Português"], ["it", "Italiano"],
  ["nl", "Nederlands"], ["pl", "Polski"], ["ru", "Русский"], ["uk", "Українська"], ["tr", "Türkçe"],
];

// ---------- top bar ----------

function buildTopbar() {
  $("#topbar").innerHTML = `
    <div class="tb-group">
      <button class="icon-btn" id="btn-outline" title="Outline">${icon("outline")}</button>
      <button class="icon-btn" id="btn-info" title="Paper info">${icon("info")}</button>
      <button class="icon-btn" id="btn-find" title="Find (⌘F)">${icon("search")}</button>
    </div>
    <div class="tb-title" id="tb-title"></div>
    <div class="tb-group">
      <select id="zoom" class="select" title="Zoom">
        <option value="auto">Automatic Zoom</option><option value="page-fit">Page Fit</option><option value="page-width">Page Width</option>
        ${[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((z) => `<option value="${z}">${z * 100}%</option>`).join("")}
        <option value="custom" hidden></option>
      </select>
      <button class="icon-btn" id="zoom-out" title="Zoom out (⌘-)">${icon("minus")}</button>
      <button class="icon-btn" id="zoom-in" title="Zoom in (⌘+)">${icon("plus")}</button>
      <span class="pager"><input id="page-num" class="input" value="1" inputmode="numeric" aria-label="Page"> / <span id="page-count">–</span></span>
    </div>
    <div class="tb-group tb-tools">
      <button class="tool-btn" id="btn-ah" title="Mark key sentences: novelty / method / result">${icon("highlighter", 16)}<span>Auto Highlight</span></button>
      <button class="tool-btn" id="btn-fig" title="Hover figures, tables and equations to explain them">${icon("image", 16)}<span>Image Explanation</span></button>
      <span class="split"><button class="tool-btn" id="btn-tr" title="Translate the paper">${icon("languages", 16)}<span>Translate</span></button><button class="tool-btn caret" id="btn-trmode" title="Translation layout" aria-label="Translation layout">▾</button></span>
      <button class="icon-btn" id="btn-settings" title="Settings">${icon("settings")}</button>
      <button class="icon-btn" id="btn-export" title="Download & export">${icon("download")}</button>
    </div>
    <div class="dropdown menu" id="dd-export" popover="auto">
      <button class="menu-item" data-export="pdf">${icon("download", 16)} Download PDF</button>
      <button class="menu-item" data-export="md">${icon("note", 16)} Export highlights & notes (Markdown)</button>
      <button class="menu-item" data-export="print">${icon("printer", 16)} Print</button>
    </div>
    <div class="dropdown menu" id="dd-tr" popover="auto">
      <button class="menu-item" data-trmode="side"><span class="tick"></span>Side by side<small>Original page with the translation next to it</small></button>
      <button class="menu-item" data-trmode="inline"><span class="tick"></span>In place<small>Translation over the original paragraphs · hold ⌥/Alt to see the original</small></button>
    </div>
    <div class="dropdown" id="dd-info" popover="auto"></div>
    <div class="dropdown" id="dd-find" popover="auto">
      <div class="find-row"><input id="find-input" class="input" placeholder="Find in paper"><span id="find-count"></span>
      <button class="icon-btn" id="find-prev" title="Previous (⇧↵)">↑</button><button class="icon-btn" id="find-next" title="Next (↵)">↓</button></div>
    </div>
    <div class="dropdown" id="dd-settings" popover="auto">
      <label class="row">Answer language<select id="set-lang" class="select">
        ${LANGS.map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}
      </select></label>
      <label class="row">Translation model<select id="set-trmodel" class="select">
        <option value="lite">Fast · Flash Lite</option><option value="flash">Better · Flash 3.8</option>
      </select></label>
      <label class="row"><input type="checkbox" id="set-focus"> Highlight the sentence under the cursor</label>
      <div class="row"><span>Personalize AI answers</span><button class="btn small" id="set-persona">${icon("user", 14)} Edit</button></div>
      <div class="ah-legend"><span class="ah-novelty">Novelty</span><span class="ah-method">Method</span><span class="ah-result">Result</span></div>
    </div>`;
}

function anchorDropdown(dd, btn) {
  const r = btn.getBoundingClientRect();
  dd.style.left = Math.min(r.left, innerWidth - 380) + "px";
  dd.style.top = r.bottom + 6 + "px";
  dd.togglePopover();
}

function wireTopbar() {
  const v = app.viewer;
  $("#btn-outline").onclick = () => toggleOutline();
  $("#btn-info").onclick = () => anchorDropdown($("#dd-info"), $("#btn-info"));
  $("#btn-find").onclick = () => { anchorDropdown($("#dd-find"), $("#btn-find")); $("#find-input").focus(); };
  $("#btn-settings").onclick = () => anchorDropdown($("#dd-settings"), $("#btn-settings"));
  $("#btn-export").onclick = () => anchorDropdown($("#dd-export"), $("#btn-export"));
  $("#set-persona").onclick = () => { $("#dd-settings").hidePopover(); editPersona(); };
  initExport();

  const zoomSel = $("#zoom");
  zoomSel.onchange = () => (v.currentScaleValue = zoomSel.value);
  const step = (dir) => { v.updateScale({ steps: dir }); };
  $("#zoom-in").onclick = () => step(1);
  $("#zoom-out").onclick = () => step(-1);
  app.eventBus.on("scalechanging", ({ scale, presetValue }) => {
    const opt = [...zoomSel.options].find((o) => o.value === (presetValue || String(scale)));
    if (opt) zoomSel.value = opt.value;
    else { zoomSel.querySelector("[value=custom]").textContent = Math.round(scale * 100) + "%"; zoomSel.value = "custom"; }
    placeAllSoon();
    saveViewSoon();
  });
  v.container.addEventListener("scroll", saveViewSoon, { passive: true });
  addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === "=" || e.key === "+") { e.preventDefault(); step(1); }
    if (e.key === "-") { e.preventDefault(); step(-1); }
    if (e.key === "0") { e.preventDefault(); v.currentScaleValue = "auto"; }
    if (e.key === "f") { e.preventDefault(); $("#btn-find").click(); }
  });
  // Pinch / ctrl+wheel zoom.
  v.container.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    v.updateScale({ scaleFactor: Math.exp(-e.deltaY / 200), origin: [e.clientX, e.clientY] });
  }, { passive: false });

  const pageNum = $("#page-num");
  pageNum.onchange = () => { const n = Number(pageNum.value); if (n >= 1 && n <= app.pdf.numPages) v.currentPageNumber = n; };
  pageNum.onfocus = () => pageNum.select();
  app.eventBus.on("pagechanging", ({ pageNumber }) => {
    pageNum.value = pageNumber;
    app.state.lastPage = pageNumber;
    saveLastPage();
  });

  // Find
  const fi = $("#find-input");
  const find = (again, prev) => app.eventBus.dispatch("find", { source: null, type: again ? "again" : "", query: fi.value, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: prev, matchDiacritics: false });
  fi.addEventListener("input", debounce(() => find(false, false), 200));
  fi.addEventListener("keydown", (e) => { if (e.key === "Enter") find(true, e.shiftKey); });
  $("#find-next").onclick = () => find(true, false);
  $("#find-prev").onclick = () => find(true, true);
  app.eventBus.on("updatefindmatchescount", ({ matchesCount: m }) => ($("#find-count").textContent = m.total ? `${m.current}/${m.total}` : fi.value ? "0" : ""));
  app.eventBus.on("updatefindcontrolstate", ({ matchesCount: m }) => m && ($("#find-count").textContent = m.total ? `${m.current}/${m.total}` : ""));

  // Tools
  const sync = () => {
    $("#btn-ah").classList.toggle("on", app.settings.autoHighlight);
    $("#btn-fig").classList.toggle("on", app.settings.figures);
    $("#btn-tr").classList.toggle("on", app.settings.translate);
    for (const b of document.querySelectorAll("[data-trmode]")) b.classList.toggle("on", b.dataset.trmode === app.settings.trLayout);
    document.documentElement.classList.toggle("ah-on", app.settings.autoHighlight);
  };
  // AI tools need the Pro plan; for free users the buttons open the pricing table instead.
  const pro = (fn) => () => (me.ai ? fn() : showPaywall());
  $("#btn-ah").onclick = pro(() => { app.settings.autoHighlight = !app.settings.autoHighlight; saveSettings(); sync(); forVisible((i) => { ensureAutoHighlight(i); repaint(i, "autohl"); }); });
  $("#btn-fig").onclick = pro(() => { app.settings.figures = !app.settings.figures; saveSettings(); sync(); forVisible((i) => { detectFigures(i); repaint(i, "fig"); }); });
  // Side by side needs room for two pages; inline keeps the zoom.
  const applyTranslate = (on, layout) => {
    const wasSide = app.settings.translate && app.settings.trLayout === "side";
    setTranslate(on, layout); saveSettings(); sync();
    const side = on && layout === "side";
    if (side !== wasSide) v.currentScaleValue = side ? fitTwoUp() : "auto";
    forVisible(translatePage);
  };
  $("#btn-tr").onclick = pro(() => applyTranslate(!app.settings.translate, app.settings.trLayout));
  // Picking a layout also turns translation on.
  $("#btn-trmode").onclick = () => anchorDropdown($("#dd-tr"), $("#btn-trmode"));
  for (const b of document.querySelectorAll("[data-trmode]")) b.onclick = pro(() => { $("#dd-tr").hidePopover(); applyTranslate(true, b.dataset.trmode); });
  const lang = $("#set-lang"), trModel = $("#set-trmodel"), focus = $("#set-focus");
  lang.value = app.settings.lang; trModel.value = app.settings.trModel; focus.checked = app.settings.sentenceFocus;
  const retranslate = () => { saveSettings(); resetTranslations(); forVisible(translatePage); };
  lang.onchange = () => { app.settings.lang = lang.value; retranslate(); };
  trModel.onchange = () => { app.settings.trModel = trModel.value; retranslate(); };
  focus.onchange = () => { app.settings.sentenceFocus = focus.checked; saveSettings(); setHover(-1, [], ""); };
  sync();
}

// Title of an uploaded PDF: its metadata title when it looks like one, else the largest text in
// the top part of the first page.
async function guessTitle(pdf) {
  const info = (await pdf.getMetadata().catch(() => null))?.info;
  const meta = String(info?.Title || "").trim();
  if (meta.length >= 10 && /\s/.test(meta) && !/^(untitled|microsoft word|slide)/i.test(meta)) return meta.slice(0, 300);
  const page = await pdf.getPage(1);
  const top = page.view[3] * 0.45;
  const items = (await page.getTextContent()).items.filter((t) => t.str.trim() && t.transform[5] > top);
  if (!items.length) return "";
  // The title is the line(s) holding the largest text. Small caps ("FLASHATTENTION") mix sizes on
  // one line, so take every item on those lines, and join pieces without a space when they touch.
  const sz = (t) => Math.abs(t.transform[3]);
  const size = Math.max(...items.map(sz));
  const ys = [...new Set(items.filter((t) => sz(t) > size - 0.5).map((t) => Math.round(t.transform[5])))];
  const parts = items.filter((t) => sz(t) >= size * 0.55 && ys.some((y) => Math.abs(t.transform[5] - y) < size * 0.6))
    .sort((a, b) => Math.round(b.transform[5]) - Math.round(a.transform[5]) || a.transform[4] - b.transform[4]);
  let line = "", prev = null;
  for (const t of parts) {
    const sameLine = prev && Math.abs(t.transform[5] - prev.transform[5]) < size * 0.6;
    const touching = sameLine && t.transform[4] - (prev.transform[4] + prev.width) < size * 0.15;
    line += (prev && !touching ? " " : "") + t.str;
    prev = t;
  }
  line = line.replace(/\s+/g, " ").trim();
  return line.length >= 8 ? line.slice(0, 300) : "";
}

// Zoom and scroll position per paper, remembered in this browser (localStorage "pr-view:<key>").
// The position is a page number plus how far down that page the view starts (0..1).
const viewKey = () => "pr-view:" + app.key;
let viewReady = false; // no saving while the saved view is being restored on open
function saveView() {
  const v = app.viewer, page = v?.currentPageNumber, div = page && v.getPageView(page - 1)?.div;
  if (!div || !viewReady) return;
  const offset = Math.min(1, Math.max(0, (v.container.scrollTop - div.offsetTop) / div.offsetHeight));
  try { localStorage.setItem(viewKey(), JSON.stringify({ scale: v.currentScaleValue, page, offset })); } catch {}
}
const saveViewSoon = debounce(saveView, 400);

function restoreView() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(viewKey()) || "null"); } catch {}
  const v = app.viewer;
  if (!saved?.scale || !(saved.page >= 1 && saved.page <= app.pdf.numPages)) return false;
  v.currentScaleValue = saved.scale;
  // PDF.js lays the pages out again after a scale change; scrollPageIntoView waits for that.
  const height = v.getPageView(saved.page - 1).viewport.viewBox[3];
  v.scrollPageIntoView({ pageNumber: saved.page, destArray: [null, { name: "XYZ" }, null, (1 - (saved.offset || 0)) * height, null] });
  return true;
}

// Scale so that page + translation column fit side by side.
function fitTwoUp() {
  const pv = app.viewer.getPageView(0);
  const w1 = pv.viewport.width / pv.viewport.scale * (96 / 72);
  return String(Math.max(0.4, Math.min(2, (app.viewer.container.clientWidth - 72) / (w1 * 2.06))));
}

const saveLastPage = debounce(() => saveState(), 1500);

function forVisible(fn) {
  for (const { id } of app.viewer._getVisiblePages().views) fn(id - 1);
}

function renderInfo() {
  const m = app.meta;
  document.title = m.title || app.key;
  $("#tb-title").textContent = m.title || "";
  $("#dd-info").innerHTML = `<div class="info">
    <div class="info-title">${esc(m.title)}</div>
    <div class="info-authors">${esc((m.authors || []).join(", "))}</div>
    <div class="info-meta">${m.published ? new Date(m.published).toLocaleDateString() : ""} ${(m.categories || []).slice(0, 3).map((c) => `<span class="tag">${esc(c)}</span>`).join("")}</div>
    ${m.abstract ? `<div class="info-abs">${esc(m.abstract)}</div>` : ""}
    <div class="ref-links">${app.key.startsWith("local-") ? "" : `<a class="btn ghost" target="_blank" href="https://arxiv.org/abs/${esc(m.id)}">${icon("external", 14)} arXiv</a>`}<a class="btn ghost" target="_blank" href="/api/pdf/${esc(app.key)}">${icon("external", 14)} PDF</a></div></div>`;
}

// ---------- mouse hover dispatcher ----------
// One rAF-throttled mousemove decides which sentence and which figure are under the pointer.

function initHover() {
  let pending = null;
  app.viewer.container.addEventListener("mousemove", (e) => {
    if (pending) { pending = e; return; }
    pending = e;
    requestAnimationFrame(() => {
      const ev = pending; pending = null;
      if (ev.buttons || ev.target.closest(".ml-card, .tr-col")) return;
      const i = pageAtPoint(ev.clientX, ev.clientY);
      if (i < 0) { setFigureHover(-1, -1); return; }
      const p = clientToPage(i, ev.clientX, ev.clientY);
      const fk = figureAt(i, p);
      setFigureHover(i, fk);
      if (!(app.settings.sentenceFocus || (app.settings.translate && app.settings.trLayout === "side"))) return;
      const s = fk >= 0 ? -1 : sentenceAt(i, p);
      if (s >= 0) setHover(i, [s], "pdf");
      else if (hover.from === "pdf") setHover(-1, [], "pdf");
    });
  });
  app.viewer.container.addEventListener("mouseleave", () => { setHover(-1, [], "pdf"); setFigureHover(-1, -1); });
}

// ---------- boot ----------

async function boot() {
  // Free plan: AI tools start off (not saved, so the user's choices return after upgrading).
  if (!me.ai) Object.assign(app.settings, { autoHighlight: false, figures: false, translate: false });
  buildTopbar();
  initLeftRail();
  initRightPanel();
  initLayout();
  const status = $("#status");

  const [meta, state] = await Promise.all([
    fetch(`/api/meta/${app.key}`).then((r) => r.json()),
    fetch(`/api/state/${app.key}`).then((r) => r.json()),
  ]);
  app.meta = meta;
  Object.assign(app.state, state);
  markSynced();
  app.state.lastOpened = Date.now();
  // In a team, pick up teammates' highlights and comments while the paper is open.
  if (me.team) {
    setInterval(() => document.visibilityState === "visible" && pullState(), 15000);
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && pullState());
  }
  saveState();
  renderInfo();

  status.textContent = "Downloading PDF…";
  const task = pdfjsLib.getDocument({
    url: `/api/pdf/${app.key}`,
    httpHeaders: await authHeaders(),
    cMapUrl: "/vendor/pdfjs/cmaps/", cMapPacked: true,
    standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
    wasmUrl: "/vendor/pdfjs/wasm/",
  });
  task.onProgress = ({ loaded, total }) => { if (total) status.textContent = `Downloading PDF… ${Math.round((loaded / total) * 100)}%`; };
  let pdf;
  try { pdf = await task.promise; }
  catch (e) { status.innerHTML = `Could not load this PDF: ${esc(e.message)}. <a href="/library">Back</a>`; return; }
  status.remove();
  app.pdf = pdf;

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
  const findController = new PDFFindController({ eventBus, linkService });
  const viewer = new PDFViewer({
    container: $("#viewerContainer"), viewer: $("#viewer"), eventBus, linkService, findController,
    textLayerMode: 1, annotationMode: pdfjsLib.AnnotationMode.ENABLE, removePageBorders: false,
  });
  linkService.setViewer(viewer);
  Object.assign(app, { viewer, eventBus, linkService, findController });

  eventBus.on("pagesinit", () => {
    setTimeout(() => (viewReady = true), 1000);
    if (restoreView()) return;
    viewer.currentScaleValue = app.settings.translate && app.settings.trLayout === "side" ? fitTwoUp() : "auto";
    if (app.state.lastPage > 1) viewer.currentPageNumber = app.state.lastPage;
  });
  // Rebuild overlay layers whenever PDF.js (re)renders a page.
  eventBus.on("pagerendered", ({ pageNumber }) => {
    const i = pageNumber - 1;
    repaint(i);
    detectFigures(i);
    translatePage(i); // picks up a page whose translation has not finished (no-op otherwise)
  });
  eventBus.on("textlayerrendered", ({ pageNumber }) => {
    const i = pageNumber - 1;
    pageInfo(i).textReady = true;
    prepareSentencesFor(i);
    repaint(i);
    translatePage(i);
  });
  eventBus.on("annotationlayerrendered", ({ pageNumber }) => repaint(pageNumber - 1));

  viewer.setDocument(pdf);
  linkService.setDocument(pdf, null);
  $("#page-count").textContent = pdf.numPages;
  if (app.settings.translate) document.documentElement.classList.add(app.settings.trLayout === "side" ? "tr-on" : "inl-on");

  wireTopbar();
  initSelection();
  initCitations();
  initHover();
  // Upload full text in the background so chat/explain have the whole paper as context.
  setTimeout(() => ensureFullText(), 1500);
  // Uploads are named after their file ("2024.naacl-long.35"); find the real title and keep it.
  if (app.key.startsWith("local-") && !/\s/.test(app.meta.title || "")) {
    const title = await guessTitle(pdf);
    if (title) {
      app.meta.title = title;
      renderInfo();
      await fetch(`/api/meta/${app.key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
      saveState(); // refreshes the library entry
    }
  }
  app.repaintAll = repaintAll;
  globalThis.app = app; // handy for debugging in DevTools
}

await requireSignIn();
boot();
