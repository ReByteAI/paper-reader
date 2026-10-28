// arXiv id from an arXiv URL (abs, pdf, html; new or old style ids), or "".
const ARXIV = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\/([0-9]{4}\.[0-9]{4,5}(?:v[0-9]+)?|[a-z-]+(?:\.[A-Z]{2})?\/[0-9]{7}(?:v[0-9]+)?)(?:\.pdf)?\/?(?:[?#].*)?$/;

export const SITE = "https://xyznot.com";
export const arxivId = (url) => (String(url || "").match(ARXIV) || [])[1] || "";
export const paperUrl = (id) => `${SITE}/paper/${id}`;
