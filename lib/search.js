// Paper search for the home page: Querit web search restricted to arXiv and a few open-access
// proceedings sites. arXiv hits become arXiv ids (opened directly); other hits carry the URL of
// their PDF, which /api/import downloads into the user's library like an upload.

const QUERIT_URL = "https://api.querit.ai/v1/search";
// OpenReview is left out: its PDFs sit behind a browser check that server-side fetches fail.
const SITES = ["arxiv.org", "aclanthology.org", "proceedings.mlr.press", "openaccess.thecvf.com", "proceedings.neurips.cc"];

const ARXIV_URL = /^https?:\/\/(?:www\.|export\.|ar5iv\.labs\.|ar5iv\.)?arxiv\.org\/(?:abs|pdf|html)\/((?:\d{4}\.\d{4,5})|(?:[a-z\-]+(?:\.[A-Z]{2})?\/\d{7}))(?:v\d+)?(?:\.pdf)?\/?(?:[?#]|$)/i;

// PDF URL for a result page on one of the non-arXiv SITES, or "" when the page is not a paper.
export function pdfUrl(link) {
  let u;
  try { u = new URL(link); } catch { return ""; }
  if (u.protocol !== "https:") u.protocol = "https:";
  const h = u.hostname, p = u.pathname;
  if (h === "aclanthology.org") {
    const m = p.match(/^\/([\w.\-]+?)(?:\.pdf)?\/?$/);
    return m && /\d/.test(m[1]) ? `https://aclanthology.org/${m[1]}.pdf` : "";
  }
  if (h === "proceedings.mlr.press") {
    let m;
    if ((m = p.match(/^\/(v\d+)\/([\w\-]+)\.html$/))) return `https://proceedings.mlr.press/${m[1]}/${m[2]}/${m[2]}.pdf`;
    return /^\/v\d+\/[\w\-]+\/[\w\-]+\.pdf$/.test(p) ? u.origin + p : "";
  }
  if (h === "openaccess.thecvf.com") {
    if (/\/papers\/[^/]+\.pdf$/.test(p)) return u.origin + p;
    return /\/html\/[^/]+_paper\.html$/.test(p) ? u.origin + p.replace("/html/", "/papers/").replace(/\.html$/, ".pdf") : "";
  }
  if (h === "proceedings.neurips.cc" || h === "papers.nips.cc") {
    let m;
    if ((m = p.match(/^(.*)\/hash\/(\w+)-Abstract(-\w+)?\.html$/))) return `https://${h}${m[1]}/file/${m[2]}-Paper${m[3] || ""}.pdf`;
    return /\/file\/\w+-Paper(-\w+)?\.pdf$/.test(p) ? u.origin + p : "";
  }
  return "";
}

// Download locations to try for a pdfUrl(): newer PMLR volumes keep PDFs on GitHub instead.
export function pdfSources(pdf) {
  const m = pdf.match(/^https:\/\/proceedings\.mlr\.press\/(v\d+)\/([\w\-]+)\/[\w\-]+\.pdf$/);
  return m ? [pdf, `https://raw.githubusercontent.com/mlresearch/${m[1]}/main/assets/${m[2]}/${m[2]}.pdf`] : [pdf];
}

const SITE_NAMES = { "aclanthology.org": "ACL Anthology", "proceedings.mlr.press": "PMLR", "openaccess.thecvf.com": "CVF", "proceedings.neurips.cc": "NeurIPS", "papers.nips.cc": "NeurIPS" };

const cleanTitle = (t) => String(t || "")
  .replace(/^\[[^\]]+\]\s*/, "")                       // "[1706.03762] Attention…"
  .replace(/\s+-\s+(ACL Anthology|OpenReview|arXiv)$/i, "")
  .replace(/\s+/g, " ").trim();

// CVF result pages are titled "CVPR 2026 Open Access Repository"; the PDF name holds the title:
// ".../Li_CRAFT-LoRA_Content-Style_Personalization_CVPR_2026_paper.pdf".
const cvfTitle = (pdf) => decodeURIComponent(pdf.split("/").pop())
  .replace(/_(?:CVPR|ICCV|WACV|ECCV)W?_\d{4}_paper\.pdf$/, "").replace(/^[^_]+_/, "").replace(/_/g, " ");
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, "");

async function querit(query, sites, apiKey) {
  const res = await fetch(QUERIT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, count: 10, filters: { sites: { include: sites } } }),
  });
  if (!res.ok) throw new Error(`search failed (${res.status})`);
  const data = await res.json();
  if (data.error_code && data.error_code !== 200) throw new Error(`search failed: ${data.error_msg || data.error_code}`);
  return data.results?.result || [];
}

// arXiv and the venue sites are searched separately: in one mixed search, venue pages often push
// the arXiv original off the list. arXiv hits come first because they open directly.
export async function paperSearch(query, apiKey) {
  const [arxiv, venues] = await Promise.all([
    querit(query, ["arxiv.org"], apiKey),
    querit(query, SITES.filter((s) => s !== "arxiv.org"), apiKey).catch(() => []),
  ]);

  const papers = [], others = [], seen = new Set();
  for (const r of [...arxiv, ...venues]) {
    let title = cleanTitle(r.title);
    const snippet = /^%\d/.test(r.snippet || "") ? "" : String(r.snippet || "").replace(/\s+/g, " ")
      .replace(/^\s*\[Submitted on [^\]]*\]\s*/, "").replace(/\\[a-z]+/gi, "").trim().slice(0, 220);
    const m = String(r.url || "").match(ARXIV_URL);
    if (m) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      // New-style ids start with YYMM; page_age is often the crawl date, so it is not used.
      const year = /^\d{4}\./.test(m[1]) ? "20" + m[1].slice(0, 2) : "";
      papers.push({ kind: "arxiv", id: m[1], title, snippet, site: "arXiv", year });
    } else {
      const pdf = pdfUrl(r.url);
      if (pdf.includes("openaccess.thecvf.com")) title = cvfTitle(pdf);
      if (!pdf || !title || /-supp\.pdf$|supplementary/i.test(pdf + " " + title) || /verifying your browser|just a moment|access denied/i.test(title) || seen.has(pdf)) continue;
      seen.add(pdf);
      others.push({ kind: "pdf", url: pdf, title, snippet, site: SITE_NAMES[new URL(pdf).hostname] || "", year: (pdf.match(/(?:\/|[A-Z]{3,})(20\d\d)\b/) || [])[1] || "" });
    }
  }
  // The same paper often appears on arXiv and at its venue; keep the arXiv entry.
  const onArxiv = new Set(papers.map((r) => norm(r.title)));
  const venue = others.filter((r) => !onArxiv.has(norm(r.title)));
  return [...papers.slice(0, 5), ...venue.slice(0, 3), ...papers.slice(5)].slice(0, 8);
}
