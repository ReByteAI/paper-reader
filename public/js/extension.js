// Chrome Web Store listing of the XYZNOT extension, and a one-time card that suggests it to
// desktop Chrome/Edge visitors who do not have it yet.
export const EXT_ID = "ieiignclmajohmabdhfnikenigmaemnb";
export const STORE_URL = `https://chromewebstore.google.com/detail/xyznot-paper-reader/${EXT_ID}`;
const SEEN = "pr-ext-promo";

const chromeDesktop = () => {
  const ua = navigator.userAgentData;
  return !!ua && !ua.mobile && ua.brands.some((b) => b.brand === "Chromium");
};

// A page sees chrome.runtime only when an installed extension lists it in externally_connectable.
// The extension answers any "xyznot-pdf" message, so an answer means it is installed.
export function hasExtension() {
  if (!globalThis.chrome?.runtime?.sendMessage) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(EXT_ID, { type: "xyznot-pdf", nonce: "ping" }, (r) => { void chrome.runtime.lastError; resolve(!!r); });
    } catch { resolve(false); }
    setTimeout(() => resolve(false), 1500);
  });
}

export async function promoteExtension({ delay = 1200 } = {}) {
  try { if (localStorage.getItem(SEEN)) return; } catch { return; }
  if (!chromeDesktop() || (await hasExtension())) return;
  await new Promise((r) => setTimeout(r, delay));
  const card = document.createElement("div");
  card.id = "ext-promo";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "XYZNOT for Chrome");
  card.innerHTML = `<style>
      #ext-promo { position: fixed; right: 20px; bottom: 20px; z-index: 9000; width: 340px; padding: 16px; display: grid; grid-template-columns: 40px 1fr; gap: 4px 12px;
        background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow, 0 10px 30px rgba(0,0,0,.15));
        font-size: 13px; line-height: 1.45; animation: ext-in .25s ease-out; }
      @keyframes ext-in { from { opacity: 0; translate: 0 12px; } }
      #ext-promo .logo { grid-row: span 2; width: 40px; height: 40px; border-radius: 10px; background: url(/assets/mark.svg) center/cover; }
      #ext-promo b { font-size: 14px; }
      #ext-promo p { margin: 0; color: var(--muted); }
      #ext-promo .row { grid-column: 2; display: flex; gap: 8px; margin-top: 10px; }
      #ext-promo .x { position: absolute; top: 8px; right: 8px; width: 26px; height: 26px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font-size: 16px; cursor: pointer; }
      #ext-promo .x:hover { background: var(--panel-2); }
    </style>
    <div class="logo"></div><b>XYZNOT for Chrome</b>
    <p>Open any arXiv paper or PDF in XYZNOT with one click.</p>
    <div class="row"><a class="btn primary small" href="${STORE_URL}" target="_blank" rel="noopener">Add to Chrome</a><button class="btn ghost small" type="button">Not now</button></div>
    <button class="x" type="button" aria-label="Close">×</button>`;
  const close = () => { try { localStorage.setItem(SEEN, "1"); } catch {} card.remove(); };
  card.querySelector(".row a").addEventListener("click", close);
  card.querySelector(".row button").onclick = close;
  card.querySelector(".x").onclick = close;
  document.body.append(card);
}
