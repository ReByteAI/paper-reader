import { arxivId } from "./arxiv.js";

const $ = (s) => document.querySelector(s);
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const id = arxivId(tab?.url);
const maybePdf = /^(https?|file):/.test(tab?.url || "");

$("#status").innerHTML = id ? `arXiv paper <b>${id}</b>`
  : maybePdf ? (/\.pdf($|[?#])/i.test(tab.url) ? "A PDF is open in this tab." : "If this tab shows a PDF, it opens in XYZNOT.")
  : "Open a paper (arXiv page or PDF) in this tab.";
$("#open").disabled = !id && !maybePdf;
$("#open").onclick = async () => {
  $("#open").disabled = true;
  $("#open").textContent = id ? "Opening…" : "Reading the PDF…";
  const r = await chrome.runtime.sendMessage({ type: "open-tab", tab: { url: tab.url, index: tab.index } });
  if (r?.ok) return window.close();
  $("#error").hidden = false;
  $("#error").textContent = r?.error || "Something went wrong.";
  $("#open").textContent = "Open in XYZNOT";
  $("#open").disabled = false;
};

const s = await chrome.storage.sync.get({ autoPdf: true, autoAbs: false });
for (const k of ["autoPdf", "autoAbs"]) {
  $("#" + k).checked = s[k];
  $("#" + k).onchange = (e) => chrome.storage.sync.set({ [k]: e.target.checked });
}
