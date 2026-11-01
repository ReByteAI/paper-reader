// Prompt builders for every AI task. Each returns { system, text, image?, history?, model?, cacheKey?, post? }.
const FAST_MODEL = globalThis.process?.env?.GEMINI_FAST_MODEL || "gemini-3.5-flash-lite";

const LANG = {
  zh: "Simplified Chinese", "zh-TW": "Traditional Chinese", en: "English", ja: "Japanese", ko: "Korean",
  fr: "French", de: "German", es: "Spanish", pt: "Portuguese", it: "Italian", nl: "Dutch", pl: "Polish", ru: "Russian", uk: "Ukrainian", tr: "Turkish",
  ar: "Arabic", fa: "Persian", he: "Hebrew", hi: "Hindi", bn: "Bengali", th: "Thai", vi: "Vietnamese", id: "Indonesian", ms: "Malay",
};
const lang = (b) => LANG[b.lang] || b.lang || "English";

// True when a "translation" is mostly the source text copied back.
function isEcho(out, sentences) {
  const words = (t) => new Set(t.toLowerCase().match(/[a-z]{4,}/g) || []);
  const src = words(sentences.join(" ")), dst = words(out);
  if (src.size < 20) return false;
  let same = 0;
  for (const w of src) if (dst.has(w)) same++;
  return same / src.size > 0.6;
}

// The reader's personalization (Settings → Personalize AI): who they are, applied to every task,
// plus per-task preferences. b.persona = { about, explain, keywords, tldr, summary }.
const clip = (s) => String(s || "").trim().slice(0, 600);
function personal(b, kind) {
  const p = b.persona || {};
  return [clip(p.about) && `About the reader: ${clip(p.about)}`, kind && clip(p[kind]) && `Reader's preference for this answer: ${clip(p[kind])}`].filter(Boolean).join("\n");
}
const withPersonal = (system, b, kind) => [system, personal(b, kind)].filter(Boolean).join("\n\n");
const personaKey = (b, kind) => [clip(b.persona?.about), clip(b.persona?.[kind])];

const paperHeader = (ctx) => ctx.meta?.title ? `Paper: "${ctx.meta.title}"${ctx.meta.authors?.length ? " by " + ctx.meta.authors.slice(0, 6).join(", ") : ""}.` : "";
const FORMAT = "Use Markdown. Write math as LaTeX in $...$ or $$...$$. Be concrete and concise; no preamble.";

export const prompts = {
  // Selected text → explanation in context.
  explain: (b, ctx) => ({
    system: withPersonal(`You help a researcher read a paper. ${paperHeader(ctx)} Answer in ${lang(b)}; keep technical terms in English where natural. ${FORMAT}`, b, "explain"),
    text: [
      ctx.text ? `<paper>\n${ctx.text.slice(0, 250_000)}\n</paper>` : "",
      b.context ? `Surrounding text on page ${b.page}:\n"""${b.context}"""` : "",
      `Explain this passage so I understand what it means, why it matters in this paper, and any notation or prior work it relies on:\n"""${b.selection}"""`,
    ].filter(Boolean).join("\n\n"),
  }),

  // Selected text → quick translation.
  "translate-text": (b) => ({
    model: FAST_MODEL,
    system: `Translate academic text into ${lang(b)}. Output only the translation. Keep math, symbols and citations like [12] unchanged; write math as LaTeX in $...$.`,
    text: b.selection,
    cacheKey: [b.lang, b.selection],
  }),

  // Chat with the paper. history = [{role, text}]. ctx.refs: other papers the reader attached to
  // this discussion ({ meta, text }), for comparisons.
  ask: (b, ctx) => ({
    system: withPersonal(`You are a research assistant answering questions about a paper. ${paperHeader(ctx)} Ground answers in the paper and cite sections, figures, tables or page numbers when you can; say so when the paper does not answer.${ctx.refs?.length ? " The reader also attached reference papers; when you use them, name the paper you are citing." : ""} Answer in ${lang(b)}. ${FORMAT}`, b),
    history: [
      ...(ctx.text ? [{ role: "user", text: `<paper>\n${ctx.text}\n</paper>\nRead this paper. I will ask questions.` }, { role: "model", text: "I've read the paper. Ask away." }] : []),
      ...(ctx.refs || []).flatMap((r) => [
        { role: "user", text: `<reference_paper title="${r.meta.title}">\n${r.text || r.meta.abstract || ""}\n</reference_paper>\nAlso read this reference paper.` },
        { role: "model", text: `I've read "${r.meta.title}" as well.` },
      ]),
      ...(b.history || []),
    ],
    text: (b.quote ? `About this passage:\n"""${b.quote}"""\n\n` : "") + b.question,
  }),

  // Whole-paper structured summary for the "With AI" panel.
  summary: (b, ctx) => ({
    system: withPersonal(`You write reading guides for research papers in ${lang(b)}. ${FORMAT}`, b, "summary"),
    text: `<paper>\n${ctx.text}\n</paper>\n\nWrite a reading guide with these sections (translate headings into ${lang(b)}):\n## TL;DR (2 sentences)\n## Problem & motivation\n## Key ideas / contributions (bullets)\n## Method (how it works, with the key equations)\n## Results (most important numbers, with the table/figure they come from)\n## Limitations & open questions\n## Terms to know (glossary of 5–10 terms)`,
    cacheKey: [ctx.meta?.key, b.lang, ctx.text.length, ...personaKey(b, "summary")],
  }),

  // Three-line summary: problem, method, result.
  tldr: (b, ctx) => ({
    system: withPersonal(`You summarize research papers in exactly three lines, in ${lang(b)}. Keep technical terms in English where natural.`, b, "tldr"),
    text: `<paper>\n${ctx.text}\n</paper>\n\nSummarize this paper in exactly three numbered lines, one sentence each:\n1. 🎯 the problem it solves\n2. 🔧 the core method\n3. 📈 the main result, with a concrete number if the paper has one\nOutput only the three lines.`,
    cacheKey: [ctx.meta?.key, b.lang, ctx.text.length, ...personaKey(b, "tldr")],
  }),

  // Cropped figure/table/equation image → explanation.
  "explain-image": (b, ctx) => ({
    image: b.image,
    system: withPersonal(`You explain figures, tables and equations from research papers. ${paperHeader(ctx)} Answer in ${lang(b)}. ${FORMAT}`, b, "explain"),
    text: [
      b.context ? `Text near this region on page ${b.page}:\n"""${b.context}"""` : "",
      b.kind === "formula"
        ? "Explain this equation: define every symbol, say what it computes, and why it is needed in the paper."
        : b.kind === "table"
          ? "Explain this table: what is compared, how to read it, and the key takeaways with concrete numbers."
          : "Explain this figure: what it shows, how to read it (axes, legends, arrows), and the key takeaway.",
    ].filter(Boolean).join("\n\n"),
  }),

  // Cropped equation image → LaTeX source.
  latex: (b) => ({
    model: FAST_MODEL,
    image: b.image,
    system: "Transcribe the equation in the image to LaTeX. Output only LaTeX source without $ delimiters or code fences.",
    text: "LaTeX:",
    cacheKey: [b.image?.length, b.image?.slice(-200)],
  }),

  // One page of sentences → translation with <|#n|> source markers (drives bidirectional hover).
  // The instruction is repeated in the user turn: with it only in the system prompt, the fast model
  // sometimes copied whole pages back in English. Echoed output is not cached (see `valid`).
  // b.model: "lite" (default, fast) or "flash" (the main model; slower, more reliable).
  "translate-page": (b) => ({
    model: b.model === "flash" ? undefined : FAST_MODEL,
    system: `You are a translator. You translate academic papers into ${lang(b)}. Never copy the source text; every sentence must be written in ${lang(b)}.
Keep math as LaTeX in $...$, keep citations like [12] and keep names of models/datasets in English.`,
    text: `Translate the numbered sentences below into ${lang(b)}. Output natural paragraphs separated by blank lines. Write each sentence's marker (e.g. <|#3|>) exactly once, in order, before its translation. Output only the translation.\n\n<source>\n${b.sentences.map((s, i) => `<|#${i}|>${s}`).join("\n")}\n</source>`,
    cacheKey: b.model === "flash" ? ["v2", b.lang, "flash", b.sentences] : ["v2", b.lang, b.sentences],
    valid: (out) => !isEcho(out, b.sentences),
  }),

  // Inline translation (public/js/inline.js): each paragraph block of a page is translated to fit
  // back into its own box, so the output keeps one piece per block.
  "translate-blocks": (b) => ({
    model: b.model === "flash" ? undefined : FAST_MODEL,
    system: `You are a translator. You translate academic papers into ${lang(b)}. Never copy the source text; every block must be written in ${lang(b)}.
Keep math as LaTeX in $...$, keep citations like [12], and keep people's names, e-mail addresses, URLs and names of models/datasets as written.`,
    text: `Translate the numbered text blocks of one PDF page into ${lang(b)}. The text was extracted from the PDF, so inline math may be garbled: write it as LaTeX. A block may begin or end mid-sentence; translate it as it is. Write each block's marker (e.g. <|#3|>) exactly once, in order, followed by its translation on one line, with no line breaks inside a block. Keep the translation about as long as the source so it fits the same space. Output only the translation.\n\n<source>\n${(b.blocks || []).map((t, i) => `<|#${i}|>${t}`).join("\n")}\n</source>`,
    cacheKey: b.model === "flash" ? ["v1", b.lang, "flash", b.blocks] : ["v1", b.lang, b.blocks],
    valid: (out) => !isEcho(out, b.blocks || []),
  }),

  // ---- JSON tasks ----

  // Key terms of the paper with short definitions (the keyword glossary).
  keywords: (b, ctx) => ({
    system: withPersonal(`You build glossaries for research papers. Write definitions in ${lang(b)}; keep each term as the paper writes it.`, b, "keywords"),
    text: `<paper>\n${ctx.text.slice(0, 250_000)}\n</paper>\n\nList the 8 to 12 terms a reader must know to follow this paper: its own methods, models, datasets, metrics and key background concepts. For each, write one or two sentences on what it means in this paper.\nReturn JSON: [{"term":string,"definition":string}]`,
    cacheKey: [ctx.meta?.key, b.lang, ctx.text.length, ...personaKey(b, "keywords"), b.seed || 0, "v1"],
    post: (xs) => (Array.isArray(xs) ? xs : []).filter((x) => x?.term && x?.definition).slice(0, 14),
  }),

  // Multiple-choice quiz on the paper. b.count 5|10|15, b.level "easy"|"hard", b.seed varies a new quiz.
  quiz: (b, ctx) => ({
    system: withPersonal(`You write quizzes that check understanding of a research paper. Write in ${lang(b)}; keep technical terms in English where natural. Write math as LaTeX in $...$.`, b),
    text: `<paper>\n${ctx.text.slice(0, 250_000)}\n</paper>\n\nWrite ${[5, 10, 15].includes(b.count) ? b.count : 5} ${b.level === "hard" ? "hard questions that need reasoning about the method, its assumptions and the results" : "easy questions about the main ideas and findings"}. Each question has 4 options with exactly one correct answer; vary the position of the correct answer. Give a short explanation that cites where the paper says it.\nReturn JSON: [{"question":string,"options":[string,string,string,string],"answer":0|1|2|3,"explanation":string,"page":number|null}]`,
    cacheKey: [ctx.meta?.key, b.lang, b.count, b.level, b.seed || 0, ctx.text.length],
    post: (xs) => (Array.isArray(xs) ? xs : []).filter((x) => x?.question && Array.isArray(x.options) && x.options.length === 4 && Number.isInteger(x.answer) && x.answer >= 0 && x.answer < 4),
  }),

  // Page image → layout boxes (figure/table/formula). Gemini box_2d is [ymin,xmin,ymax,xmax] in 0..1000.
  layout: (b) => ({
    image: b.image,
    system: "You are a document layout detector.",
    text: `Detect every figure, table and display (block) equation on this page of a research paper.
Return JSON: [{"label":"figure"|"table"|"formula","box_2d":[ymin,xmin,ymax,xmax],"caption":"first words of its caption or equation number"}]
Coordinates are integers in 0..1000 relative to the page image. A figure box covers the graphic only (not the caption); a table box covers the table body; a formula box covers one display equation including its number. Skip inline math, text paragraphs, headers and footers. Return [] if none.`,
    cacheKey: [b.key, b.page, "v1"],
    post: (boxes) => (Array.isArray(boxes) ? boxes : []).filter((x) => Array.isArray(x.box_2d) && x.box_2d.length === 4).map((x) => ({
      label: ["figure", "table", "formula"].includes(x.label) ? x.label : "figure",
      caption: String(x.caption || ""),
      top: x.box_2d[0] / 1000, left: x.box_2d[1] / 1000, bottom: x.box_2d[2] / 1000, right: x.box_2d[3] / 1000,
    })),
  }),

  // Sentences → which are novelty / method / result. Drives Auto Highlight.
  autohighlight: (b) => ({
    model: FAST_MODEL,
    system: "You mark the most important sentences of a research paper page for a skimming reader.",
    text: `Sentences:\n${b.sentences.map((s, i) => `[${i}] ${s}`).join("\n")}\n\nPick at most 6 sentences total that a reader skimming the paper must not miss, and label each as "novelty" (what is new / the claim), "method" (how it works) or "result" (findings / numbers). Skip captions, references and boilerplate.\nReturn JSON: [{"i":<index>,"type":"novelty"|"method"|"result"}]`,
    cacheKey: [b.key, b.page, b.sentences.length, "v1"],
    post: (xs) => (Array.isArray(xs) ? xs : []).filter((x) => Number.isInteger(x.i) && ["novelty", "method", "result"].includes(x.type)),
  }),

  // Raw bibliography entry → structured fields for the citation card.
  "parse-ref": (b) => ({
    model: FAST_MODEL,
    system: "You parse bibliography entries.",
    text: `Bibliography text (may contain neighbouring entries; use the one starting closest to the beginning${b.label ? ` or labelled ${b.label}` : ""}):\n"""${b.text}"""\nReturn JSON {"title":string,"authors":string,"year":string,"venue":string,"raw":string} where raw is the exact entry text.`,
    cacheKey: [b.text, b.label],
  }),
};
