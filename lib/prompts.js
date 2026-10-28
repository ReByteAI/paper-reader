// Prompt builders for every AI task. Each returns { system, text, image?, history?, model?, cacheKey?, post? }.
const FAST_MODEL = globalThis.process?.env?.GEMINI_FAST_MODEL || "gemini-3.5-flash-lite";

const LANG = { zh: "Simplified Chinese", en: "English", ja: "Japanese", ko: "Korean", fr: "French", de: "German", es: "Spanish" };
const lang = (b) => LANG[b.lang] || b.lang || "Simplified Chinese";

const paperHeader = (ctx) => ctx.meta?.title ? `Paper: "${ctx.meta.title}"${ctx.meta.authors?.length ? " by " + ctx.meta.authors.slice(0, 6).join(", ") : ""}.` : "";
const FORMAT = "Use Markdown. Write math as LaTeX in $...$ or $$...$$. Be concrete and concise; no preamble.";

export const prompts = {
  // Selected text → explanation in context.
  explain: (b, ctx) => ({
    system: `You help a researcher read a paper. ${paperHeader(ctx)} Answer in ${lang(b)}; keep technical terms in English where natural. ${FORMAT}`,
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

  // Chat with the paper. history = [{role, text}].
  ask: (b, ctx) => ({
    system: `You are a research assistant answering questions about one paper. ${paperHeader(ctx)} Ground answers in the paper and cite sections, figures, tables or page numbers when you can; say so when the paper does not answer. Answer in ${lang(b)}. ${FORMAT}`,
    history: [
      ...(ctx.text ? [{ role: "user", text: `<paper>\n${ctx.text}\n</paper>\nRead this paper. I will ask questions.` }, { role: "model", text: "I've read the paper. Ask away." }] : []),
      ...(b.history || []),
    ],
    text: (b.quote ? `About this passage:\n"""${b.quote}"""\n\n` : "") + b.question,
  }),

  // Whole-paper structured summary for the "With AI" panel.
  summary: (b, ctx) => ({
    system: `You write reading guides for research papers in ${lang(b)}. ${FORMAT}`,
    text: `<paper>\n${ctx.text}\n</paper>\n\nWrite a reading guide with these sections (translate headings into ${lang(b)}):\n## TL;DR (2 sentences)\n## Problem & motivation\n## Key ideas / contributions (bullets)\n## Method (how it works, with the key equations)\n## Results (most important numbers, with the table/figure they come from)\n## Limitations & open questions\n## Terms to know (glossary of 5–10 terms)`,
    cacheKey: [ctx.meta?.key, b.lang, ctx.text.length],
  }),

  // Cropped figure/table/equation image → explanation.
  "explain-image": (b, ctx) => ({
    image: b.image,
    system: `You explain figures, tables and equations from research papers. ${paperHeader(ctx)} Answer in ${lang(b)}. ${FORMAT}`,
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
  "translate-page": (b) => ({
    model: FAST_MODEL,
    system: `You translate one page of an academic paper into ${lang(b)}.
Input sentences are numbered like <|#3|>. Output the translation as natural paragraphs separated by blank lines.
Before the translation of each input sentence, write its marker exactly, e.g. <|#3|>, so every marker appears once and in order.
Keep math as LaTeX in $...$, keep citations like [12] and keep names of models/datasets in English. Output nothing else.`,
    text: b.sentences.map((s, i) => `<|#${i}|>${s}`).join("\n"),
    cacheKey: [b.lang, b.sentences],
  }),

  // ---- JSON tasks ----

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
