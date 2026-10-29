// Figure / table / equation overlays. Each rendered page image goes to Gemini once for layout
// detection (cached server-side); hovering a detected region shows Explain / Copy / LaTeX tools.
import { app, pageInfo, pageView, addPainter, repaint, openCard, contextAround, pageText, saveState } from "./app.js";
import { h, icon, aiJson, stream, toast, uid } from "./util.js";
import { streamInto } from "./selection.js";
import { me } from "./auth.js";

const queue = [];
let running = 0;

export function detectFigures(i) {
  const info = pageInfo(i);
  if (!app.settings.figures || !me.ai || info.figures || info.figPending) return;
  info.figPending = true;
  queue.push(i);
  pump();
}

async function pump() {
  while (running < 2 && queue.length) {
    const i = queue.shift();
    running++;
    detect(i).finally(() => { running--; pump(); });
  }
}

async function detect(i) {
  const info = pageInfo(i);
  try {
    const image = await renderPage(i, 1100, "image/jpeg");
    info.figures = await aiJson("layout", { key: app.key, page: i, image });
  } catch (e) {
    console.warn("layout", i, e);
    info.figures = [];
  }
  info.figPending = false;
  repaint(i, "fig");
  repaint(i, "inl"); // inline translation leaves figures and tables uncovered
}

// Render page i independently of the viewer (works for pages that are not on screen).
async function renderPage(i, maxSide, type = "image/png") {
  const page = await app.pdf.getPage(i + 1);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: maxSide / Math.max(base.width, base.height) });
  const c = document.createElement("canvas");
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  return type === "canvas" ? c : c.toDataURL(type, 0.8);
}

async function cropFigure(i, f, pad = 0.008) {
  const c = await renderPage(i, 2000, "canvas");
  const l = Math.max(0, f.left - pad), t = Math.max(0, f.top - pad);
  const w = Math.min(1, f.right + pad) - l, hh = Math.min(1, f.bottom + pad) - t;
  const out = document.createElement("canvas");
  out.width = Math.round(c.width * w); out.height = Math.round(c.height * hh);
  out.getContext("2d").drawImage(c, -Math.round(c.width * l), -Math.round(c.height * t));
  return out;
}

const LABEL = { figure: "Figure", table: "Table", formula: "Equation" };

addPainter("fig", (i, el) => {
  const figs = app.settings.figures ? pageInfo(i).figures || [] : [];
  el.innerHTML = "";
  figs.forEach((f, k) => {
    if (f.hidden) return;
    const isHover = hovered?.i === i && hovered?.k === k;
    const box = h(`<div class="fig-box fig-${f.label}${isHover ? " hover" : ""}" data-k="${k}" style="left:${f.left * 100}%;top:${f.top * 100}%;width:${(f.right - f.left) * 100}%;height:${(f.bottom - f.top) * 100}%">
      <button class="fig-hide" title="Hide this box">${icon("x", 12)}</button>
      <div class="fig-tools">
        <button data-act="explain">${icon("sparkles", 14)} Explain ${LABEL[f.label].toLowerCase()} <kbd>E</kbd></button>
        ${f.label === "formula" ? `<button data-act="latex" title="Copy LaTeX">${icon("sigma", 14)} LaTeX</button>` : ""}
        <button data-act="copy" title="Copy image (C)">${icon("copy", 14)}</button>
      </div></div>`);
    box.querySelector(".fig-hide").onclick = (e) => { e.stopPropagation(); f.hidden = true; repaint(i, "fig"); };
    box.querySelector(".fig-tools").onclick = (e) => {
      const b = e.target.closest("button");
      if (b) figureAction(i, f, b.dataset.act);
    };
    el.append(box);
  });
});

// Hover is driven by the viewer-wide mousemove (boxes are pointer-events:none so text stays selectable).
let hovered = null; // { i, k }
export function figureAt(i, p) {
  const figs = app.settings.figures ? pageInfo(i).figures || [] : [];
  return figs.findIndex((f) => !f.hidden && p.x >= f.left && p.x <= f.right && p.y >= f.top && p.y <= f.bottom);
}
export function setFigureHover(i, k) {
  if (hovered && hovered.i === i && hovered.k === k) return;
  document.querySelectorAll(".fig-box.hover").forEach((x) => x.classList.remove("hover"));
  hovered = k >= 0 ? { i, k } : null;
  if (hovered) pageView(i)?.div.querySelector(`.ml-fig .fig-box[data-k="${k}"]`)?.classList.add("hover");
}
document.addEventListener("keydown", (e) => {
  if (!hovered || e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  if (!getSelection().isCollapsed) return;
  const f = pageInfo(hovered.i).figures?.[hovered.k];
  const k = e.key.toLowerCase();
  // ㄷ / ㅊ are E / C on a Korean keyboard layout.
  if (k === "e" || k === "ㄷ") { e.preventDefault(); figureAction(hovered.i, f, "explain"); }
  if (k === "c" || k === "ㅊ") { e.preventDefault(); figureAction(hovered.i, f, "copy"); }
});

async function figureAction(i, f, act) {
  if (act === "copy") {
    const c = await cropFigure(i, f);
    c.toBlob(async (blob) => {
      try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); toast("Image copied"); }
      catch { toast("Clipboard blocked by the browser"); }
    });
    return;
  }
  if (act === "latex") {
    const card = openCard({ anchor: { page: i, x: f.left, y: f.bottom }, title: "LaTeX", iconName: "sigma", cls: "latex-card" });
    card.body.innerHTML = `<pre class="latex-src"></pre>`;
    const pre = card.body.querySelector("pre");
    const image = (await cropFigure(i, f)).toDataURL("image/png");
    const tex = (await stream("latex", { image }, (t) => (pre.textContent = t))).trim();
    card.foot.innerHTML = `<span class="grow"></span><button class="btn primary">${icon("copy", 14)} Copy $$…$$</button>`;
    card.foot.querySelector("button").onclick = () => { navigator.clipboard.writeText(`$$${tex}$$`); toast("LaTeX copied"); };
    navigator.clipboard.writeText(`$$${tex}$$`).then(() => toast("LaTeX copied"), () => {});
    return;
  }
  const card = openCard({ anchor: { page: i, x: f.left, y: f.bottom }, title: `Explain ${LABEL[f.label].toLowerCase()}`, iconName: "sparkles", cls: "explain-card" });
  const c = await cropFigure(i, f);
  const thumb = h(`<img class="fig-thumb" alt="">`);
  thumb.src = c.toDataURL("image/png");
  card.body.append(thumb);
  await pageText(i);
  const answer = await streamInto(card, "explain-image", {
    key: app.key, lang: app.settings.lang, kind: f.label, page: i + 1,
    image: c.toDataURL("image/jpeg", 0.85), context: contextAround(i, f.caption || "", 900),
  });
  if (answer) {
    app.state.explanations.unshift({ id: uid(), kind: f.label, quote: f.caption || `${LABEL[f.label]} on page ${i + 1}`, answer, page: i, y: f.top, ts: Date.now() });
    saveState();
  }
}
