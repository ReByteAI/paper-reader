// Paper search box with suggestions, shared by the home page and the library. A pasted arXiv link
// or id opens directly; other text searches /api/search. arXiv results open /paper/<id>; venue
// results are imported into the library first (/api/import).
//
// attachSearch({ form, input, list, tip, go, importPdf, onToggle })
//   go(path)        navigate (the home page signs the visitor in first)
//   importPdf(r)    optional override for venue results (the home page signs in first)
//   onToggle(open)  called when the suggestion list opens or closes

const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ARXIV = /arxiv\.org\/(?:abs|pdf|html)\/([\w.\-\/]+?)(?:v\d+)?(?:\.pdf)?\/?(?:[?#]|$)|^\s*(?:arxiv:)?(\d{4}\.\d{4,5})(?:v\d+)?\s*$/i;
export const arxivId = (text) => { const m = text.trim().match(ARXIV); return m ? (m[1] || m[2]) : ""; };

export async function importPaper(r, tip) {
  tip.textContent = "Fetching the PDF…";
  const res = await fetch("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: r.url, title: r.title }) });
  const data = await res.json().catch(() => ({}));
  if (data.key) location.href = "/paper/" + data.key; else tip.textContent = data.error || "Could not open this paper.";
}

export function attachSearch({ form, input, list, tip, go = (p) => (location.href = p), importPdf = (r) => importPaper(r, tip), onToggle = () => {} }) {
  let results = [], active = -1, timer, ctrl;
  const box = list.parentElement;

  function render() {
    list.innerHTML = results.map((r, i) => `<li role="option" id="r${i}" aria-selected="${i === active}" data-i="${i}">
      <span class="r-title">${esc(r.title)}</span>
      <span class="r-meta">${esc([r.site, r.year, r.kind === "arxiv" ? r.id : ""].filter(Boolean).join(" · "))}</span>
      ${r.snippet ? `<span class="r-snip">${esc(r.snippet)}</span>` : ""}</li>`).join("");
    list.hidden = !results.length;
    onToggle(!list.hidden);
    // Keep the list on screen below the input; it scrolls inside when longer.
    if (!list.hidden) list.style.maxHeight = Math.max(200, innerHeight - list.getBoundingClientRect().top - 20) + "px";
    input.setAttribute("aria-expanded", String(!list.hidden));
    input.setAttribute("aria-activedescendant", active >= 0 ? "r" + active : "");
  }
  const close = () => { list.hidden = true; onToggle(false); input.setAttribute("aria-expanded", "false"); };

  async function search(text) {
    ctrl?.abort();
    const id = arxivId(text);
    if (id) { results = [{ kind: "arxiv", id, title: "Open arXiv:" + id, site: "arXiv" }]; active = 0; render(); return; }
    if (text.trim().length < 3) { results = []; render(); return; }
    ctrl = new AbortController();
    tip.textContent = "Searching…";
    try {
      const r = await fetch("/api/search?q=" + encodeURIComponent(text), { signal: ctrl.signal });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Search failed");
      results = data; active = results.length ? 0 : -1;
      tip.textContent = results.length ? "" : "No papers found. Try the title or an arXiv link.";
    } catch (e) {
      if (e.name === "AbortError") return;
      results = []; tip.textContent = e.message;
    }
    render();
  }

  const open = (r) => (r.kind === "arxiv" ? go("/paper/" + r.id) : importPdf(r));

  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => search(input.value), 300); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!results.length) return;
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : results.length - 1)) % results.length;
      render();
    } else if (e.key === "Escape") { results = []; render(); }
  });
  input.addEventListener("focus", () => { if (results.length) render(); });
  // "click", not "pointerdown": a touch that scrolls the list must not open a result.
  list.addEventListener("click", (e) => { const li = e.target.closest("li"); if (li) open(results[li.dataset.i]); });
  document.addEventListener("pointerdown", (e) => { if (!box.contains(e.target)) close(); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearTimeout(timer);
    const id = arxivId(input.value);
    if (id) return go("/paper/" + id);
    if (!results.length || active < 0) await search(input.value);
    if (results[active]) open(results[active]);
  });
  return { open };
}
