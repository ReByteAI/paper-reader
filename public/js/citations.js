// In-place cards for internal PDF links. Citations ([12]) show the parsed reference plus a
// Semantic Scholar match; links to figures/sections/equations show a rendered preview of the target.
import { app, openCard, pageIndexOf, clientToPage, saveState, pageInfo } from "./app.js";
import { esc, icon, aiJson, uid } from "./util.js";

let lastLink = null;
let refsStart = null; // first page index of the bibliography

export function initCitations() {
  const ls = app.linkService;
  const navigate = ls.goToDestination.bind(ls);
  app.navigate = navigate;
  app.viewer.viewer.addEventListener("pointerdown", (e) => {
    const a = e.target.closest(".annotationLayer a");
    lastLink = a ? { el: a, x: e.clientX, y: e.clientY } : null;
  }, true);
  // PDF.js link annotations call goToDestination; intercept clicks that came from the page.
  ls.goToDestination = async (dest) => {
    const link = lastLink;
    lastLink = null;
    if (!link) return navigate(dest);
    try { await showLinkCard(dest, link); } catch (e) { console.warn(e); navigate(dest); }
  };
}

async function resolveDest(dest) {
  const explicit = typeof dest === "string" ? await app.pdf.getDestination(dest) : dest;
  if (!Array.isArray(explicit)) return null;
  const ref = explicit[0];
  const page = typeof ref === "object" && ref ? await app.pdf.getPageIndex(ref) : Number(ref);
  const kind = explicit[1]?.name;
  // XYZ: [ref, XYZ, left, top, zoom]; FitH/FitBH: [ref, Fit*, top]
  const left = kind === "XYZ" ? explicit[2] : null;
  const top = kind === "XYZ" ? explicit[3] : /FitB?H/.test(kind) ? explicit[2] : null;
  return { page, left, top, name: typeof dest === "string" ? dest : "" };
}

async function findRefsStart() {
  if (refsStart != null) return refsStart;
  refsStart = Infinity;
  for (let i = app.pdf.numPages - 1; i >= Math.max(0, app.pdf.numPages - 25); i--) {
    const tc = await (await app.pdf.getPage(i + 1)).getTextContent();
    if (tc.items.some((it) => /^\s*(\d+\.?\s*)?(References|REFERENCES|Bibliography|BIBLIOGRAPHY)\s*$/.test(it.str))) { refsStart = i; break; }
  }
  return refsStart;
}

// Pull the bibliography text starting at the destination point, within its column.
async function refTextAt({ page, left, top }) {
  const p = await app.pdf.getPage(page + 1);
  const [, , W, H] = p.view;
  const tc = await p.getTextContent();
  const items = tc.items.filter((it) => it.str.trim()).map((it) => ({ s: it.str, x: it.transform[4], y: it.transform[5], h: Math.abs(it.transform[3]) || 8 }));
  const yTop = top ?? H;
  const twoCol = items.filter((it) => it.x > W * 0.5).length > items.length * 0.25;
  const colL = left == null || !twoCol ? 0 : left < W * 0.5 ? 0 : W * 0.48;
  const colR = left == null || !twoCol ? W : left < W * 0.5 ? W * 0.52 : W;
  const lines = new Map();
  for (const it of items) {
    if (it.x < colL - 4 || it.x > colR || it.y > yTop + 2) continue;
    const k = Math.round(it.y / 2) * 2;
    if (!lines.has(k)) lines.set(k, []);
    lines.get(k).push(it);
  }
  const sorted = [...lines.entries()].sort((a, b) => b[0] - a[0]).slice(0, 7).map(([, its]) => its.sort((a, b) => a.x - b.x).map((x) => x.s).join(" "));
  return sorted.join(" ").replace(/-\s(?=[a-z])/g, "").replace(/\s+/g, " ").trim();
}

async function showLinkCard(dest, link) {
  const target = await resolveDest(dest);
  if (!target) return app.navigate(dest);
  const srcPage = pageIndexOf(link.el);
  const r = link.el.getBoundingClientRect();
  const a = clientToPage(srcPage, r.left, r.bottom);
  const anchor = { page: srcPage, x: a.x, y: a.y };
  const isCite = target.name.startsWith("cite.") || target.name.startsWith("bib") || target.page >= (await findRefsStart());
  if (isCite) return citeCard(target, anchor, link.el.textContent.trim(), dest);
  return previewCard(target, anchor, dest);
}

async function citeCard(target, anchor, label, dest) {
  const card = openCard({ anchor, title: label ? `Reference ${label.replace(/^\[|\]$/g, "")}` : "Reference", iconName: "quote", cls: "cite-card" });
  card.body.innerHTML = `<div class="skeleton"><i></i><i></i><i style="width:70%"></i></div>`;
  card.foot.innerHTML = `<button class="btn ghost" data-act="go">${icon("arrow", 14)} Go to reference</button>`;
  card.foot.querySelector("[data-act=go]").onclick = () => { card.close(); app.navigate(dest); };

  const raw = await refTextAt(target);
  let ref;
  try { ref = await aiJson("parse-ref", { text: raw, label }); } catch { ref = { raw, title: "" }; }
  if (!card.el.isConnected) return;
  card.body.innerHTML = `<div class="ref-raw">${esc(ref.raw || raw)}</div><div class="ref-s2"><div class="skeleton"><i></i><i style="width:80%"></i></div></div>`;
  const s2el = card.body.querySelector(".ref-s2");
  if (!ref.title) { s2el.innerHTML = ""; return; }
  const res = await fetch(`/api/scholar?q=${encodeURIComponent(ref.title)}`).then((r) => r.json()).catch(() => ({}));
  if (!card.el.isConnected) return;
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const best = (res.data || []).find((p) => norm(p.title) === norm(ref.title)) || (res.data || [])[0];
  if (!best) {
    s2el.innerHTML = `<div class="ref-links"><a class="btn ghost" target="_blank" href="https://scholar.google.com/scholar?q=${encodeURIComponent(ref.title)}">${icon("search", 14)} Google Scholar</a></div>`;
    return;
  }
  const arxiv = best.externalIds?.ArXiv;
  const abs = best.tldr?.text || best.abstract || "";
  s2el.innerHTML = `
    <div class="ref-title">${esc(best.title)}</div>
    <div class="ref-meta">${esc((best.authors || []).slice(0, 4).map((x) => x.name).join(", "))}${best.authors?.length > 4 ? " et al." : ""} · ${esc(best.venue || "")} ${best.year || ""}${best.citationCount != null ? ` · ${best.citationCount} citations` : ""}</div>
    ${abs ? `<div class="ref-abs">${best.tldr ? "<b>TL;DR</b> " : ""}${esc(abs)}</div>` : ""}
    <div class="ref-links">
      ${arxiv ? `<a class="btn primary" href="/paper/${esc(arxiv)}" target="_blank">${icon("library", 14)} Read here</a>` : ""}
      ${best.openAccessPdf?.url ? `<a class="btn ghost" target="_blank" href="${esc(best.openAccessPdf.url)}">${icon("external", 14)} PDF</a>` : ""}
      <a class="btn ghost" target="_blank" href="${esc(best.url)}">${icon("external", 14)} ${best.source || "Semantic Scholar"}</a>
      <button class="btn ghost" data-act="save">${icon("bookmark", 14)} Save</button>
    </div>`;
  s2el.querySelector("[data-act=save]").onclick = (e) => {
    if (!app.state.citations.some((c) => c.title === best.title)) {
      app.state.citations.unshift({ id: uid(), label, title: best.title, url: best.url, arxiv, year: best.year, authors: (best.authors || []).slice(0, 4).map((x) => x.name).join(", "), page: anchor.page, ts: Date.now() });
      saveState();
    }
    e.currentTarget.textContent = "Saved";
  };
}

// Render the destination region of the target page into an image.
async function previewCard(target, anchor, dest) {
  const card = openCard({ anchor, title: destTitle(dest) || `Page ${target.page + 1}`, iconName: "image", cls: "preview-card" });
  card.foot.innerHTML = `<button class="btn ghost" data-act="go">${icon("arrow", 14)} Go to</button>`;
  card.foot.querySelector("[data-act=go]").onclick = () => { card.close(); app.navigate(dest); };
  card.body.innerHTML = `<div class="skeleton tall"></div>`;
  const page = await app.pdf.getPage(target.page + 1);
  const H = page.view[3];
  const scale = 2;
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = vp.width; canvas.height = vp.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  const yTop = target.top == null ? 0 : Math.max(0, (H - target.top) / H - 0.01);
  // Figure/table anchors usually point at the caption, so prefer the detected region nearest the anchor.
  const fig = nearestFigure(target.page, yTop);
  const pad = 0.01;
  const box = fig
    ? { l: Math.max(0, fig.left - pad), t: Math.max(0, fig.top - pad), r: Math.min(1, fig.right + pad), b: Math.min(1, Math.max(fig.bottom, yTop + 0.045) + pad) }
    : { l: 0, t: yTop, r: 1, b: Math.min(1, yTop + 0.42) };
  const out = document.createElement("canvas");
  out.width = Math.round(canvas.width * (box.r - box.l)); out.height = Math.round(canvas.height * (box.b - box.t));
  out.getContext("2d").drawImage(canvas, -Math.round(canvas.width * box.l), -Math.round(canvas.height * box.t));
  if (!card.el.isConnected) return;
  card.body.innerHTML = "";
  out.className = "preview-img";
  card.body.append(out);
}

function nearestFigure(i, y) {
  let best = null, bestD = 0.08;
  for (const f of pageInfo(i).figures || []) {
    const d = y < f.top ? f.top - y : y > f.bottom ? y - f.bottom : 0;
    if (d < bestD) { best = f; bestD = d; }
  }
  return best;
}

// LaTeX hyperref names destinations like "figure.1", "table.2", "section.3.1", "equation.3".
function destTitle(dest) {
  const m = typeof dest === "string" && dest.match(/^(figure|table|section|subsection|equation|appendix)\.(.+)$/i);
  if (!m) return "";
  const name = { subsection: "Section", equation: "Equation" }[m[1].toLowerCase()] || m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return `${name} ${m[2]}`;
}
