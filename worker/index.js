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
  async list(uid) {
    const { results } = await db.prepare("SELECT key, title, authors, last_opened, last_page, highlights FROM library WHERE user_id = ? ORDER BY last_opened DESC").bind(uid).all();
    return results.map((r) => ({ key: r.key, title: r.title, authors: JSON.parse(r.authors || "[]"), lastOpened: r.last_opened, lastPage: r.last_page, highlights: r.highlights }));
  },
});

let handle;
export default {
  fetch(req, env) {
    // The app moved from paper.xyznot.com to the apex; keep old links working.
    const url = new URL(req.url);
    if (url.hostname === "paper.xyznot.com") return Response.redirect("https://xyznot.com" + url.pathname + url.search, 301);
    handle ||= createHandler({
      store: r2Store(env.PAPERS),
      users: d1Users(env.DB),
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
      verify: createVerifier({ publishableKey: env.CLERK_PUBLISHABLE_KEY, authorizedParties: env.AUTH_ORIGINS.split(",") }),
      paidPlan: env.PAID_PLAN,
      freeUsers: (env.FREE_USERS || "").split(",").filter(Boolean),
      publicConfig: { clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY },
      searchKey: env.QUERIT_API_KEY,
      searchAllowed: async (r) => (await env.SEARCH_LIMIT.limit({ key: r.headers.get("cf-connecting-ip") || "" })).success,
      asset: async (p) => {
        const r = await env.ASSETS.fetch(new URL(p, "https://assets.local"));
        return r.status === 404 ? null : r;
      },
    });
    return handle(req);
  },
};
