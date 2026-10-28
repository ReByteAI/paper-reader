// XYZNOT extension service worker.
// - arXiv pages open as /paper/<id> on xyznot.com (toolbar button, link menu, optional redirect rules).
// - Any other PDF is read here, in the browser, with the user's own access to it (activeTab, or
//   file URLs when allowed), then handed to xyznot.com/open, which uploads it to the library.
import { arxivId, paperUrl, SITE } from "./arxiv.js";

const DEFAULTS = { autoPdf: true, autoAbs: false };
const pending = new Map(); // nonce → { data: base64, name, url }, kept until xyznot.com asks for it

async function applySettings() {
  const s = { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: [s.autoPdf && "arxiv_pdf", s.autoAbs && "arxiv_abs"].filter(Boolean),
    disableRulesetIds: [!s.autoPdf && "arxiv_pdf", !s.autoAbs && "arxiv_abs"].filter(Boolean),
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "open-arxiv-link", title: "Open in XYZNOT", contexts: ["link"],
    targetUrlPatterns: ["*://arxiv.org/abs/*", "*://arxiv.org/pdf/*", "*://www.arxiv.org/abs/*", "*://www.arxiv.org/pdf/*"],
  });
  applySettings();
});
chrome.runtime.onStartup.addListener(applySettings);
chrome.storage.onChanged.addListener((changes, area) => { if (area === "sync") applySettings(); });

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = arxivId(info.linkUrl);
  if (id) chrome.tabs.create({ url: paperUrl(id), index: tab ? tab.index + 1 : undefined });
});

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const fileName = (url) => {
  try { return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "Paper.pdf"); } catch { return "Paper.pdf"; }
};

// Opens the paper in the active tab in XYZNOT. Returns { ok } or { error } for the popup.
async function openTab(tab) {
  const id = arxivId(tab.url);
  if (id) { await chrome.tabs.create({ url: paperUrl(id), index: tab.index + 1 }); return { ok: true }; }
  if (!/^(https?|file):/.test(tab.url || "")) return { error: "Open a paper (arXiv page or PDF) in this tab first." };
  let res;
  try { res = await fetch(tab.url, { credentials: "include" }); } catch {
    return { error: tab.url.startsWith("file:") ? "Allow access to file URLs for this extension (chrome://extensions → Details)." : "Could not read this page." };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "%PDF") return { error: "This page is not a PDF." };
  if (bytes.length > 100e6) return { error: "This PDF is larger than 100 MB." };
  const nonce = crypto.randomUUID();
  pending.set(nonce, { data: toBase64(bytes), name: fileName(tab.url), url: tab.url });
  setTimeout(() => pending.delete(nonce), 5 * 60_000);
  await chrome.tabs.create({ url: `${SITE}/open?ext=${chrome.runtime.id}&n=${nonce}`, index: tab.index + 1 });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== "open-tab") return;
  openTab(msg.tab).then(reply, (e) => reply({ error: e.message }));
  return true; // async reply
});

// xyznot.com/open collects the PDF it was opened for (once).
chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
  if (msg?.type !== "xyznot-pdf") return;
  const item = pending.get(msg.nonce);
  pending.delete(msg.nonce);
  reply(item || { error: "This PDF is no longer available. Click the extension button again." });
});
