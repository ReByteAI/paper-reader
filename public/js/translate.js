// Side-by-side translation column per page. The model tags each translated piece with <|#n|>
// (n = source sentence index), which drives hover linking in both directions.
import { app, pageInfo, addPainter, repaint } from "./app.js";
import { buildSentences, setHover, hover, onHover } from "./sentences.js";
import { md, stream, esc } from "./util.js";

const MARK = /<\|#(\d+)\|>/g;

// Turn "<|#0|>foo <|#1|>bar\n\n<|#2|>baz" into paragraphs of linked spans.
function renderTranslation(text) {
  return text.split(/\n{2,}/).map((para) => {
    const pieces = [];
    let last = 0, id = null, m;
    MARK.lastIndex = 0;
    while ((m = MARK.exec(para))) {
      if (m.index > last) pieces.push([id, para.slice(last, m.index)]);
      id = Number(m[1]); last = m.index + m[0].length;
    }
    pieces.push([id, para.slice(last)]);
    const inner = pieces.filter(([, t]) => t.trim()).map(([k, t]) => {
      const html = md(t.trim()).replace(/^<p>|<\/p>\s*$/g, "");
      return k == null ? html : `<span class="tr-seg" data-s="${k}">${html}</span> `;
    }).join("");
    return inner ? `<p>${inner}</p>` : "";
  }).join("");
}

// regenerate: retranslate a page the reader marked as wrong (server skips the cache, main model).
export async function translatePage(i, { regenerate = false } = {}) {
  const info = pageInfo(i);
  if (!app.settings.translate || info.trPending || (info.translation && !regenerate)) return;
  const ss = buildSentences(i);
  if (!ss) return;
  info.trPending = true;
  info.trText = "";
  try {
    await stream("translate-page", { lang: app.settings.lang, model: app.settings.trModel, sentences: ss.map((s) => s.text), regenerate }, (t) => {
      info.trText = t;
      paintColumn(i);
    });
    info.translation = true;
  } catch (e) { info.trText = `> ⚠️ ${esc(e.message)}`; }
  info.trPending = false;
  paintColumn(i);
}

const REDO_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>`;

function paintColumn(i) {
  const col = document.querySelector(`.page[data-page-number="${i + 1}"] .tr-col .tr-body`);
  if (col) col.innerHTML = renderTranslation(pageInfo(i).trText || "") || `<div class="skeleton"><i></i><i></i><i style="width:70%"></i></div>`;
  col?.parentElement.querySelector(".tr-redo")?.toggleAttribute("disabled", !!pageInfo(i).trPending);
  markActive();
}

addPainter("tr", (i, el) => {
  if (!app.settings.translate) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="tr-col"><button class="icon-btn tr-redo" title="Translation looks wrong? Regenerate this page" aria-label="Regenerate translation">${REDO_ICON}</button><div class="tr-body"></div></div>`;
  el.querySelector(".tr-redo").onclick = () => translatePage(i, { regenerate: true });
  const body = el.querySelector(".tr-body");
  body.addEventListener("mouseover", (e) => {
    const seg = e.target.closest(".tr-seg");
    if (!seg) return;
    const segs = [...body.querySelectorAll(".tr-seg")], k = segs.indexOf(seg);
    const a = Number(seg.dataset.s), b = Math.max(a + 1, k + 1 < segs.length ? Number(segs[k + 1].dataset.s) : a + 1);
    setHover(i, Array.from({ length: b - a }, (_, n) => a + n), "tr");
  });
  body.addEventListener("mouseleave", () => setHover(-1, [], "tr"));
  paintColumn(i);
});

function markActive() {
  document.querySelectorAll(".tr-seg.active").forEach((x) => x.classList.remove("active"));
  if (hover.page < 0) return;
  const segs = [...document.querySelectorAll(`.page[data-page-number="${hover.page + 1}"] .tr-seg`)];
  // A segment covers its sentence id up to the next segment's id.
  segs.forEach((s, k) => {
    const a = Number(s.dataset.s), b = k + 1 < segs.length ? Number(segs[k + 1].dataset.s) : Infinity;
    if ([...hover.ids].some((x) => x >= a && x < b)) s.classList.add("active");
  });
}
onHover(markActive);

export function setTranslate(on) {
  app.settings.translate = on;
  document.documentElement.classList.toggle("tr-on", on);
  for (let i = 0; i < (app.pdf?.numPages || 0); i++) repaint(i, "tr");
}
