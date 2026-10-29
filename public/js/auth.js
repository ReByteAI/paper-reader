// Clerk sign-in. When the server reports a publishable key, clerk-js is loaded from the instance's
// Frontend API and every same-origin /api request carries the session token. Without a key (local
// single-user mode) this is a no-op.

let clerk = null, fapi = "";
export const me = { ai: true }; // filled from /api/me after sign-in

export async function initAuth() {
  const { clerkPublishableKey: pk } = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
  if (!pk) return null;
  const host = fapi = atob(pk.replace(/^pk_(test|live)_/, "")).replace(/\$$/, "");
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
  if (clerk.user) {
    Object.assign(me, await fetch("/api/me").then((r) => r.json()).catch(() => ({})));
    const u = clerk.user;
    me.name = u.fullName || u.username || u.primaryEmailAddress?.emailAddress?.split("@")[0] || "Member";
    me.teamName = clerk.organization?.name || "";
  }
  return clerk;
}

export const signedIn = () => !clerk || !!clerk.user;

// The server reads the workspace from the token's `o` claim. Right after a workspace switch, Clerk
// can hand back the previous workspace's token (it seeds its cache from the last token the server
// minted), so a token whose claim does not match the active organization is minted again.
const tokenOrg = (t) => { try { return JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).o?.id || ""; } catch { return ""; } };
export async function authHeaders() {
  let token = await clerk?.session?.getToken();
  if (token && tokenOrg(token) !== (clerk.organization?.id || "")) token = await clerk.session.getToken({ skipCache: true });
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
  if (!signedIn()) { location.replace("/?signin=1&redirect=" + encodeURIComponent(location.pathname + location.search)); await new Promise(() => {}); }
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
  const team = !!clerk.organization;
  const el = document.createElement("div");
  el.id = "paywall";
  el.innerHTML = `<div class="pw-card"><button class="pw-close" title="Close">×</button>
    ${team
      ? `<h2>Subscribe ${clerk.organization.name.replace(/[&<>"']/g, "")}</h2><p>Teams share one library, highlights and comments. $10 per member per month.</p>`
      : `<h2>Upgrade to Pro</h2><p>AI explanations, figure analysis, chat with the paper, translation and citation cards.</p>`}
    <div class="pw-table"></div></div>`;
  document.body.append(el);
  const table = el.querySelector(".pw-table");
  clerk.mountPricingTable(table, { forOrganizations: team, for: team ? "organizations" : "users", newSubscriptionRedirectUrl: location.href }); // clerk-js 5 reads forOrganizations
  const close = () => { clerk.unmountPricingTable(table); el.remove(); };
  el.querySelector(".pw-close").onclick = close;
  el.addEventListener("pointerdown", (e) => { if (e.target === el) close(); });
}

// Workspace switcher: personal library or a team (Clerk organization). clerk-js 5.128 switches the
// active organization only in memory, so a reload fell back to the old one; the choice is saved
// on the session through the Frontend API, a token for it is minted, then the page reloads so every
// request carries it.
async function saveActiveOrg(id) {
  await fetch(`https://${fapi}/v1/client/sessions/${clerk.session.id}/touch`, {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: "active_organization_id=" + encodeURIComponent(id),
  });
}

export function mountWorkspaceSwitcher(el) {
  if (!clerk?.user) return false;
  let current = clerk.organization?.id || "";
  clerk.mountOrganizationSwitcher(el, { hidePersonal: false });
  clerk.addListener(({ organization }) => {
    const id = organization?.id || "";
    if (id === current) return;
    current = id;
    saveActiveOrg(id).then(() => clerk.session.getToken({ skipCache: true })).finally(() => location.reload());
  });
  return true;
}

export function mountUserButton(el) {
  if (!clerk?.user) return false;
  clerk.mountUserButton(el, { afterSignOutUrl: "/" });
  return true;
}
