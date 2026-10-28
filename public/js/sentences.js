// Sentence model: split each page's text layer into sentences, map each to page-fraction rects,
// and keep a "hover" set that the translation column and the overlay both read.
import { app, pageInfo, pageView, rectsToPages, addPainter, repaint, rectStyle, inRects, layer } from "./app.js";
import { aiJson } from "./util.js";

const ABBREV = new Set("e.g i.e et al fig figs eq eqs sec secs tab tabs vs cf etc resp approx no vol pp ref refs def thm lem prop alg appx ch dr mr ms prof jr sr st inc ltd co corp dept univ".split(" "));

// Build sentences from the rendered text layer of page i. Result: [{ text, rects }].
export function buildSentences(i) {
  const info = pageInfo(i);
  if (info.sentences) return info.sentences;
  // Only trust the text layer after PDF.js reported "textlayerrendered" for this page.
  const tl = pageView(i)?.textLayer?.div;
  if (!info.textReady || !tl || !tl.childElementCount) return null;

  // Flatten text nodes into one string with a char → (node, offset) map.
  const nodes = [], offs = [], lineEnds = [];
  let str = "";
  const walker = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    if (n.parentElement.closest(".endOfContent")) continue;
    const t = n.nodeValue;
    for (let k = 0; k < t.length; k++) { str += t[k]; nodes.push(n); offs.push(k); }
    const span = n.parentElement;
    if (span.nextSibling?.nodeName === "BR" || !span.nextSibling) {
      // Line break: join hyphenated words, otherwise insert a space mapped to the last char.
      if (str.endsWith("-") && /[a-z]/.test(str.at(-2) || "")) { /* keep; hyphen stays in text */ }
      else { str += " "; nodes.push(n); offs.push(Math.max(0, t.length - 1)); }
      lineEnds.push(str.length);
    }
  }
  if (!str.trim()) return (info.sentences = []);

  // Find sentence boundaries.
  const bounds = [];
  let start = 0;
  const push = (end) => { if (str.slice(start, end).trim().length > 1) bounds.push([start, end]); start = end; };
  // Section headings ("3.1 Encoder and Decoder Stacks") end at their line break, without punctuation.
  const headingEnds = new Set();
  lineEnds.forEach((end, k) => {
    const line = str.slice(k ? lineEnds[k - 1] : 0, end).trim();
    if (/^(\d+(\.\d+)*\.?|[A-Z]\.|[IVX]+\.)\s+[A-Z][^.!?]{1,80}$/.test(line) || /^(Abstract|References|Acknowledg(e)?ments?|Appendix|Introduction|Conclusions?)$/i.test(line)) {
      if (k) headingEnds.add(lineEnds[k - 1]);
      headingEnds.add(end);
    }
  });
  for (let k = 0; k < str.length; k++) {
    if (headingEnds.has(k) && k > start) { push(k); continue; }
    const c = str[k];
    if (!".!?".includes(c)) continue;
    let j = k + 1;
    while (j < str.length && `"')]”’`.includes(str[j])) j++;
    if (j < str.length && str[j] !== " ") continue;
    let n = j; while (n < str.length && str[n] === " ") n++;
    const next = str[n];
    if (next && !/[A-Z0-9(\[“"Α-Ω]/.test(next)) continue;
    const word = (str.slice(start, k).match(/([A-Za-z.]+)$/) || [])[1] || "";
    const w = word.toLowerCase().replace(/^\.+/, "");
    if (ABBREV.has(w) || ABBREV.has(w.replace(/\./g, "")) || /^[A-Z]$/.test(word) || /\d$/.test(str[k - 1]) && /\d/.test(next)) continue;
    push(j);
    if (j - start > 900) push(j);
  }
  push(str.length);

  // Range → rects for each sentence.
  const out = [];
  for (const [s, e0] of bounds) {
    let a = s; while (a < e0 && str[a] === " ") a++;
    let e = e0 - 1; while (e > a && str[e] === " ") e--;
    if (e <= a) continue;
    const range = document.createRange();
    range.setStart(nodes[a], offs[a]);
    range.setEnd(nodes[e], Math.min(offs[e] + 1, nodes[e].nodeValue.length));
    const rects = rectsToPages(range.getClientRects())[i] || [];
    const text = str.slice(a, e + 1).replace(/\s+/g, " ").trim();
    if (rects.length && text.length > 1) out.push({ text, rects });
  }
  // A sentence without terminal punctuation at the end of the page continues on the next page.
  const last = out.at(-1);
  if (last && !/[.!?:]["')\]]?$/.test(last.text)) last.continues = true;
  info.sentences = out;
  return out;
}

export function sentenceAt(i, p) {
  const ss = pageInfo(i).sentences || buildSentences(i);
  if (!ss) return -1;
  return ss.findIndex((s) => inRects(s.rects, p, 0.003));
}

// ---------- hover state ----------
// hover = { page, ids:Set } — source of truth for both PDF overlay and translation column.
export const hover = { page: -1, ids: new Set(), from: "" };
const hoverListeners = new Set();
export const onHover = (fn) => hoverListeners.add(fn);

export function setHover(page, ids, from) {
  const same = page === hover.page && ids.length === hover.ids.size && ids.every((x) => hover.ids.has(x));
  if (same) return;
  const prev = hover.page;
  hover.page = page; hover.ids = new Set(ids); hover.from = from;
  if (prev >= 0) repaint(prev, "hover");
  if (page >= 0 && page !== prev) repaint(page, "hover");
  // Continuing sentence: also light the first sentence of the next page.
  const ss = pageInfo(page)?.sentences;
  if (ss && ids.includes(ss.length - 1) && ss.at(-1).continues) repaint(page + 1, "hover");
  if (prev + 1 !== page + 1) repaint(prev + 1, "hover");
  hoverListeners.forEach((fn) => fn(hover));
}

function hoverIdsFor(i) {
  if (hover.page === i) return [...hover.ids];
  const prev = pageInfo(i - 1)?.sentences;
  if (hover.page === i - 1 && prev?.at(-1)?.continues && hover.ids.has(prev.length - 1)) return [0];
  return [];
}

addPainter("hover", (i, el) => {
  const ss = pageInfo(i).sentences;
  const ids = hoverIdsFor(i);
  const show = app.settings.sentenceFocus || app.settings.translate;
  el.innerHTML = !ss || !show ? "" : ids.flatMap((k) => (ss[k]?.rects || []).map((r) => `<div class="sentence-box" style="${rectStyle(r)}"></div>`)).join("");
});

// ---------- auto highlight ----------

const AH_COLORS = { novelty: "novelty", method: "method", result: "result" };
export async function ensureAutoHighlight(i) {
  const info = pageInfo(i);
  if (!app.settings.autoHighlight || info.autohl || info.autohlPending) return;
  const ss = buildSentences(i);
  if (!ss?.length) return;
  info.autohlPending = true;
  try {
    info.autohl = await aiJson("autohighlight", { key: app.key, page: i, sentences: ss.map((s) => s.text.slice(0, 400)) });
  } catch (e) { console.warn("autohighlight", e); info.autohl = []; }
  info.autohlPending = false;
  repaint(i, "autohl");
}

addPainter("autohl", (i, el) => {
  const info = pageInfo(i);
  el.innerHTML = !app.settings.autoHighlight || !info.autohl || !info.sentences ? "" :
    info.autohl.flatMap(({ i: k, type }) => (info.sentences[k]?.rects || []).map((r) => `<div class="ah-box ah-${AH_COLORS[type]}" style="${rectStyle(r)}"></div>`)).join("");
});

export function prepareSentencesFor(i) {
  if (!buildSentences(i)) return;
  layer(i, "hover");
  if (app.settings.autoHighlight) ensureAutoHighlight(i);
}
