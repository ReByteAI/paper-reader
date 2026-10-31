// Cloudflare Worker entry: the shared handler with R2 for files and reading state, D1 for the
// per-user library index, Clerk for sign-in and Workers static assets for the UI.
import { createHandler } from "../lib/core.js";
import { createVerifier } from "../lib/auth.js";

const r2Store = (bucket) => ({
  async get(p) {
    const o = await bucket.get(p);
    return o && { size: o.size, body: o.body, text: () => o.text(), arrayBuffer: () => o.arrayBuffer() };
  },
  put: (p, data) => bucket.put(p, data),
  delete: (p) => bucket.delete(p),
  async list(prefix) {
    const out = [];
    let cursor;
    do {
      const page = await bucket.list({ prefix, cursor });
      out.push(...page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out;
  },
});

const d1Users = (db) => ({
  get: (uid, key) => db.prepare("SELECT key FROM library WHERE user_id = ? AND key = ?").bind(uid, key).first(),
  put: (uid, key, e) => db.prepare(
    `INSERT INTO library (user_id, key, title, authors, last_opened, last_page, highlights) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET title = excluded.title, authors = excluded.authors,
       last_opened = excluded.last_opened, last_page = excluded.last_page, highlights = excluded.highlights`,
  ).bind(uid, key, e.title, JSON.stringify(e.authors || []), e.lastOpened, e.lastPage, e.highlights).run(),
  delete: (uid, key) => db.prepare("DELETE FROM library WHERE user_id = ? AND key = ?").bind(uid, key).run(),
  rename: (uid, key, title) => db.prepare("UPDATE library SET custom_title = ? WHERE user_id = ? AND key = ?").bind(title, uid, key).run(),
  favorite: (uid, key, on) => db.prepare("UPDATE library SET favorite = ? WHERE user_id = ? AND key = ?").bind(on ? 1 : 0, uid, key).run(),
  holders: async (key) => (await db.prepare("SELECT COUNT(*) AS n FROM library WHERE key = ?").bind(key).first()).n,
  async list(uid) {
    const { results } = await db.prepare("SELECT key, COALESCE(custom_title, title) AS title, title AS original_title, authors, last_opened, last_page, highlights, favorite FROM library WHERE user_id = ? ORDER BY last_opened DESC").bind(uid).all();
    return results.map((r) => ({ key: r.key, title: r.title, originalTitle: r.original_title, authors: JSON.parse(r.authors || "[]"), lastOpened: r.last_opened, lastPage: r.last_page, highlights: r.highlights, favorite: !!r.favorite }));
  },
});

// Member count of a Clerk organization (Backend API), cached for a minute per isolate.
const sizes = new Map();
async function orgSize(env, id) {
  const hit = sizes.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.n;
  const r = await fetch(`https://api.clerk.com/v1/organizations/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}` } });
  if (!r.ok) return 2; // unknown: treat as a paying team, do not cache
  const n = (await r.json()).members_count ?? 2;
  sizes.set(id, { n, at: Date.now() });
  return n;
}

// Gemini refuses some regions (e.g. Hong Kong), and a Worker runs where the visitor is. Gemini calls
// therefore go through a Durable Object placed in North America, which makes the request there.
export class GeminiProxy {
  fetch(req) { return fetch(req); }
}
const aiFetch = (env) => (url, init) => {
  const ns = env.GEMINI_PROXY;
  const stub = ns.get(ns.idFromName("wnam-" + Math.floor(Math.random() * 8)), { locationHint: "wnam" });
  return stub.fetch(new Request(url, init));
};

let handle;
function handler(env) {
  return handle ||= createHandler({
    store: r2Store(env.PAPERS),
    users: d1Users(env.DB),
    apiKey: env.GEMINI_API_KEY,
    aiFetch: aiFetch(env),
    model: env.GEMINI_MODEL,
    verify: createVerifier({ publishableKey: env.CLERK_PUBLISHABLE_KEY, authorizedParties: env.AUTH_ORIGINS.split(",") }),
    paidPlan: env.PAID_PLAN,
    teamPlan: env.TEAM_PLAN,
    teamSize: (id) => orgSize(env, id),
    freeUsers: (env.FREE_USERS || "").split(",").filter(Boolean),
    publicConfig: { clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY },
    searchKey: env.QUERIT_API_KEY,
    searchAllowed: async (r) => (await env.SEARCH_LIMIT.limit({ key: r.headers.get("cf-connecting-ip") || "" })).success,
    asset: async (p) => {
        const r = await env.ASSETS.fetch(new URL(p, "https://assets.local"));
      return r.status === 404 ? null : r;
    },
  });
}

export default {
  fetch(req, env) {
    // The app moved from paper.xyznot.com to the apex; keep old links working.
    const url = new URL(req.url);
    if (url.hostname === "paper.xyznot.com") return Response.redirect("https://xyznot.com" + url.pathname + url.search, 301);
    return handler(env)(req);
  },
  // Every 15 minutes: featured papers for the public pages (classics + Hugging Face trending), see lib/seo.js.
  scheduled(event, env, ctx) {
    ctx.waitUntil(handler(env).refreshFeatured().then((r) => console.log("[featured]", JSON.stringify(r))));
  },
};
