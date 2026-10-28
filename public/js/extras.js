// Export menu (PDF download, Markdown export of highlights and notes, print) and the
// "Personalize AI" dialog.
import { app, saveSettings } from "./app.js";
import { $, esc, toast } from "./util.js";

// ---------- export ----------

const fileName = (ext) => `${(app.meta.title || app.key).replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 120)}.${ext}`;

function download(blob, name) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

const pdfBlob = async () => {
  const r = await fetch(`/api/pdf/${app.key}`);
  if (!r.ok) throw new Error("Could not download the PDF");
  return r.blob();
};

// Highlights (with comments), explanations, notes, saved citations and the reading guide.
export function toMarkdown() {
  const s = app.state, m = app.meta;
  const quote = (t) => String(t || "").trim().split("\n").map((l) => "> " + l).join("\n");
  const by = (x) => (x?.name ? ` — ${x.name}` : "");
  const out = [`# ${m.title || app.key}`];
  if (m.authors?.length) out.push(m.authors.join(", "));
  if (!app.key.startsWith("local-")) out.push(`https://arxiv.org/abs/${m.id || app.key}`);
  if (s.summary) out.push("## Reading guide", s.summary);
  const hls = [...(s.highlights || [])].sort((a, b) => a.page - b.page || a.y - b.y);
  if (hls.length) {
    out.push("## Highlights");
    for (const x of hls) out.push(`**Page ${x.page + 1}**${by(x.by)}\n\n${quote(x.text)}${x.comment ? `\n\n💬 ${x.comment}${by(x.commentBy)}` : ""}`);
  }
  if (s.explanations?.length) {
    out.push("## Explanations");
    for (const x of s.explanations) out.push(`**Page ${x.page + 1}**\n\n${quote(x.quote)}\n\n${x.answer}`);
  }
  if (s.notes?.trim()) out.push("## Notes", s.notes.trim());
  if (s.citations?.length) {
    out.push("## Saved citations");
    out.push(s.citations.map((c) => `- ${c.title}${c.year ? ` (${c.year})` : ""}${c.url ? ` — ${c.url}` : ""}`).join("\n"));
  }
  return out.join("\n\n") + "\n";
}

export function initExport() {
  const dd = $("#dd-export");
  dd.addEventListener("click", async (e) => {
    const kind = e.target.closest("[data-export]")?.dataset.export;
    if (!kind) return;
    dd.hidePopover();
    try {
      if (kind === "md") return download(new Blob([toMarkdown()], { type: "text/markdown" }), fileName("md"));
      toast(kind === "pdf" ? "Downloading…" : "Preparing to print…");
      const blob = await pdfBlob();
      if (kind === "pdf") return download(blob, fileName("pdf"));
      const frame = Object.assign(document.createElement("iframe"), { src: URL.createObjectURL(blob), style: "position:fixed;width:0;height:0;border:0" });
      frame.onload = () => { frame.contentWindow.focus(); frame.contentWindow.print(); };
      document.body.append(frame);
      setTimeout(() => frame.remove(), 60_000);
    } catch (err) { toast(err.message); }
  });
}

// ---------- personalization ----------

const PERSONA_FIELDS = [
  ["about", "About you", "Applies to every answer.", "e.g. I'm a CS student learning ML. Explain from both theory and implementation."],
  ["explain", "Explanations", "Selected text, figures, tables and equations.", "e.g. Explain the intuition first, then the math, then how it would be coded."],
  ["keywords", "Keyword glossary", "", "e.g. Keep English terms and acronyms; say what they mean in this paper."],
  ["tldr", "Three-line summary", "", "e.g. One line each for the problem, the method and the result."],
  ["summary", "Reading guide", "", "e.g. Focus on architecture, training setup, results and limitations."],
];

export function editPersona() {
  const p = app.settings.persona || {};
  const dlg = document.createElement("dialog");
  dlg.className = "dialog persona";
  dlg.innerHTML = `<form>
    <h2>Personalize AI answers</h2>
    <p>Tell the assistant who you are and how you like answers. Saved in this browser.</p>
    ${PERSONA_FIELDS.map(([k, label, hint, ph]) => `<label class="field"><span>${label}${hint ? `<small>${hint}</small>` : ""}</span>
      <textarea class="input" name="${k}" rows="${k === "about" ? 3 : 2}" maxlength="600" placeholder="${esc(ph)}">${esc(p[k] || "")}</textarea></label>`).join("")}
    <div class="actions"><button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary">Save</button></div></form>`;
  document.body.append(dlg);
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector("[data-cancel]").onclick = close;
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  dlg.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    app.settings.persona = Object.fromEntries(PERSONA_FIELDS.map(([k]) => [k, dlg.querySelector(`[name=${k}]`).value.trim()]));
    saveSettings();
    close();
    toast("Saved. New answers use your preferences.");
  });
  dlg.showModal();
}
