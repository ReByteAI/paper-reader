// Clerk sign-in. When the server reports a publishable key, clerk-js is loaded from the instance's
// Frontend API and every same-origin /api request carries the session token. Without a key (local
// single-user mode) this is a no-op.

let clerk = null;
export const me = { ai: true }; // filled from /api/me after sign-in

export async function initAuth() {
  const { clerkPublishableKey: pk } = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
  if (!pk) return null;
  const host = atob(pk.replace(/^pk_(test|live)_/, "")).replace(/\$$/, "");
  await new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement("script"), {
      src: `https://${host}/npm/@clerk/clerk-js@5.128.0/dist/clerk.browser.js`, async: true, crossOrigin: "anonymous",
      onload: resolve, onerror: () => reject(new Error("Could not load Clerk")),
    });
    s.dataset.clerkPublishableKey = pk;
    document.head.append(s);
  });
  clerk = window.Clerk;
  await clerk.load();
  patchFetch();
  if (clerk.user) Object.assign(me, await fetch("/api/me").then((r) => r.json()).catch(() => ({})));
  return clerk;
}

export const signedIn = () => !clerk || !!clerk.user;

export async function authHeaders() {
  const token = await clerk?.session?.getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function patchFetch() {
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input); // Clerk passes URL objects
    if (url.startsWith("/api/") || url.startsWith(location.origin + "/api/")) {
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      for (const [k, v] of Object.entries(await authHeaders())) headers.set(k, v);
      init = { ...init, headers };
    }
    const res = await orig(input, init);
    if (res.status === 401 && clerk && !clerk.user) location.href = "/?signin=1&redirect=" + encodeURIComponent(location.pathname);
    if (res.status === 402) showPaywall();
    return res;
  };
}

// Reader pages: send signed-out visitors to the home page, which shows the sign-in form.
export async function requireSignIn() {
  await initAuth();
  if (!signedIn()) { location.replace("/?signin=1&redirect=" + encodeURIComponent(location.pathname)); await new Promise(() => {}); }
}

// Sign-in modal; after sign-in or sign-up Clerk sends the visitor to `next` (a same-origin path).
export function openSignIn(next = "/library") {
  if (!next.startsWith("/") || next.startsWith("//")) next = "/library";
  clerk?.openSignIn({ forceRedirectUrl: next, signUpForceRedirectUrl: next });
}

// Clerk's pricing table + checkout in a modal. A finished subscription reloads the page so the
// next session token carries the new plan.
export function showPaywall() {
  if (!clerk || document.querySelector("#paywall")) return;
  const el = document.createElement("div");
  el.id = "paywall";
  el.innerHTML = `<div class="pw-card"><button class="pw-close" title="Close">×</button>
    <h2>Upgrade to Pro</h2><p>AI explanations, figure analysis, chat with the paper, translation and citation cards.</p>
    <div class="pw-table"></div></div>`;
  document.body.append(el);
  const table = el.querySelector(".pw-table");
  clerk.mountPricingTable(table, { newSubscriptionRedirectUrl: location.href });
  const close = () => { clerk.unmountPricingTable(table); el.remove(); };
  el.querySelector(".pw-close").onclick = close;
  el.addEventListener("pointerdown", (e) => { if (e.target === el) close(); });
}

export function mountUserButton(el) {
  if (!clerk?.user) return false;
  clerk.mountUserButton(el, { afterSignOutUrl: "/" });
  return true;
}
