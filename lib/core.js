// Paper Reader request handler, written against Web APIs (Request/Response/fetch) so that the
// local Node server and the Cloudflare Worker share it. Storage is injected:
//   store.get(path) → { text(), arrayBuffer(), body, size } | null
//   store.put(path, string | ArrayBuffer | Uint8Array)
//   store.list(prefix) → [path]
//   store.delete(path)
// Shared by all users: pdfs/<key>.pdf, uploads/<key>.pdf, meta/<key>.json, text/<key>.txt, cache/<task>-<hash>.json
// Workspaces: a library belongs to a workspace, the active Clerk organization (team) or else the
// user. Below, <ws> is that workspace id; in a personal workspace it equals the user id.
// Per workspace: users/<ws>/<key>.json holds the reading state of one paper (highlights, comments,
// explanations, notes, chat, ...). The `users` index (a database) holds only library metadata:
//   users.get(uid, key) → entry | null
//   users.put(uid, key, { title, authors, lastOpened, lastPage, highlights })
//   users.list(uid) → [{ key, title, authors, lastOpened, lastPage, highlights }]
//   users.delete(uid, key)
//   users.rename(uid, key, title | null)   display name in the library; null restores the paper title
//   users.holders(key) → number of users with this paper in their library
// With `verify` (Clerk), every /api route except /api/config needs a valid session; without it,
// everything runs as the single user "local". With `paidPlan`, AI routes also need that Clerk
// Billing plan (users listed in `freeUsers` are exempt).
import { prompts } from "./prompts.js";
import { sessionToken } from "./auth.js";
import { paperSearch, pdfUrl, pdfSources } from "./search.js";
import { mergeShared, pick, PERSONAL } from "./state.js";

// Accepts abs/pdf/html URLs, bare ids (2607.24653, 2607.24653v2) and old-style ids (hep-th/9901001).
export function parseArxivId(input) {
  const s = decodeURIComponent(String(input || "")).trim();
  const m = s.match(/(\d{4}\.\d{4,5}(?:v\d+)?)/) || s.match(/([a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i);
  return m ? m[1] : null;
}
const idToKey = (id) => id.replace(/\//g, "_");
const keyToId = (key) => key.startsWith("local-") ? key : key.replace(/_/, "/");
const isPdf = (bytes) => bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === "%PDF";

const UA = { "user-agent": "paper-reader/0.1 (+https://xyznot.com)" };

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const redirect = (location) => new Response(null, { status: 302, headers: { location } });

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", typeof s === "string" ? new TextEncoder().encode(s) : s);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// searchKey: Querit API key for the home page search. searchAllowed(req): optional per-client rate
// limit for that search, which is open to signed-out visitors.
// teamPlan: Clerk Billing plan slug a team (organization) of two or more members needs for its
// shared workspace; a one-member team is free like a personal library. teamSize(orgId) → members.
export function createHandler({ store, users, apiKey, model = "gemini-3.8-flash", asset, verify, paidPlan = "", teamPlan = "", teamSize = async () => 1, freeUsers = [], publicConfig = {}, searchKey = "", searchAllowed = async () => true }) {
  const getJson = async (p) => { const o = await store.get(p); if (!o) return null; try { return JSON.parse(await o.text()); } catch { return null; } };
  const putJson = (p, v) => store.put(p, JSON.stringify(v));

  // ---------- arXiv ----------

  async function getPdf(key) {
    const p = (key.startsWith("local-") ? "uploads/" : "pdfs/") + key + ".pdf";
    const hit = await store.get(p);
    if (hit) return hit;
    if (key.startsWith("local-")) throw httpError(404, "upload not found");
    const res = await fetch(`https://arxiv.org/pdf/${keyToId(key)}`, { redirect: "follow" });
    if (!res.ok) throw httpError(502, `arXiv returned ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!isPdf(buf)) throw httpError(502, "arXiv did not return a PDF");
    await store.put(p, buf);
    return { body: buf, size: buf.length };
  }

  async function getMeta(key) {
    const hit = await getJson(`meta/${key}.json`);
    if (hit) return hit;
    let meta = { key, id: keyToId(key), title: keyToId(key), authors: [], abstract: "", published: "" };
    if (!key.startsWith("local-")) {
      try {
        const xml = await (await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(keyToId(key))}`)).text();
        const entry = xml.split("<entry>")[1] || "";
        const tag = (t) => (entry.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]?.replace(/\s+/g, " ").trim() || "";
        if (entry) meta = {
          ...meta,
          title: tag("title") || meta.title,
          abstract: tag("summary"),
          published: tag("published"),
          authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((x) => x[1].trim()),
          categories: [...entry.matchAll(/<category term="([^"]+)"/g)].map((x) => x[1]),
        };
      } catch (e) { console.warn("[meta]", e.message); }
    }
    await putJson(`meta/${key}.json`, meta);
    return meta;
  }

  // ---------- Gemini ----------

  function geminiBody({ system, parts, history = [], json = false, thinking = "low" }) {
    const contents = [...history.map((m) => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.text }] })), { role: "user", parts }];
    return {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: { ...(json ? { responseMimeType: "application/json" } : {}), thinkingConfig: { thinkingLevel: thinking } },
    };
  }

  async function geminiStream(model, body, onText) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey }, body: JSON.stringify(body),
    });
    if (!res.ok) throw httpError(502, `Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buf = "", full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r/g, "");
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
        if (!line.startsWith("data:")) continue;
        try {
          const d = JSON.parse(line.slice(5));
          const text = (d.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
          if (text) { full += text; await onText(text); }
        } catch {}
      }
    }
    return full;
  }

  // Occasionally the model emits malformed JSON; one retry almost always fixes it.
  async function geminiJson(model, body, tries = 2) {
    let out = "";
    await geminiStream(model, body, (t) => (out += t));
    out = out.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    try { return JSON.parse(out); }
    catch (e) { if (tries > 1) return geminiJson(model, body, tries - 1); throw e; }
  }

  const cachePath = async (task, payload) => `cache/${task}-${(await sha256hex(JSON.stringify(payload))).slice(0, 24)}.json`;
  async function cached(task, payload, fn) {
    const p = await cachePath(task, payload);
    const hit = await getJson(p);
    if (hit != null) return hit;
    const value = await fn();
    await putJson(p, value);
    return value;
  }

  async function paperContext(key) {
    const meta = await getMeta(key);
    const t = await store.get(`text/${key}.txt`);
    return { meta, text: t ? (await t.text()).slice(0, 400_000) : "" };
  }

  const imagePart = (dataUrl) => {
    const m = String(dataUrl || "").match(/^data:(image\/\w+);base64,(.+)$/);
    return m ? { inlineData: { mimeType: m[1], data: m[2] } } : null;
  };

  // Streaming tasks: text is written to the response as it arrives.
  // Deterministic tasks (translate, summary, latex) are cached and replayed.
  async function aiStream(req, task) {
    const body = await req.json().catch(() => ({}));
    const p = prompts[task];
    if (!p) throw httpError(404, "unknown task " + task);
    if (body.key) await requireAccess(req.ws, body.key);
    const ctx = body.key ? await paperContext(body.key) : { meta: {}, text: "" };
    const { system, text, image, history, model: taskModel = model, cacheKey, valid = () => true } = p(body, ctx);
    // `regenerate`: the user rejected the cached answer; skip the cache and use the main model.
    const m = body.regenerate ? model : taskModel;
    const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" };
    const file = cacheKey ? await cachePath(task, cacheKey) : null;
    const hit = file && !body.regenerate && (await getJson(file));
    if (hit) return new Response(hit, { headers });
    const parts = [image && imagePart(image), { text }].filter(Boolean);
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    (async () => {
      try {
        const full = await geminiStream(m, geminiBody({ system, parts, history }), (t) => writer.write(enc.encode(t)));
        if (file && full && valid(full)) await putJson(file, full);
      } catch (e) { await writer.write(enc.encode(`\n\n> ⚠️ ${e.message}`)).catch(() => {}); }
      await writer.close().catch(() => {});
    })();
    return new Response(readable, { headers });
  }

  async function aiJson(req, task) {
    const body = await req.json().catch(() => ({}));
    const p = prompts[task];
    if (!p) throw httpError(404, "unknown task " + task);
    const { system, text, image, model: m = model, cacheKey, post = (x) => x } = p(body, {});
    const parts = [image && imagePart(image), { text }].filter(Boolean);
    const run = async () => post(await geminiJson(m, geminiBody({ system, parts, json: true })));
    return json(cacheKey ? await cached(task, cacheKey, run) : await run());
  }

  // ---------- Semantic Scholar ----------

  // Semantic Scholar first (has TL;DRs), OpenAlex as fallback when S2 rate-limits (no API key).
  // Results are normalized to the S2 shape. Empty results are not cached.
  async function scholarSearch(query) {
    const file = await cachePath("s2", query);
    const hit = await getJson(file);
    if (hit) return hit;
    const q = query.slice(0, 300);
    let data = [];
    try {
      const fields = "title,authors,year,venue,abstract,citationCount,url,externalIds,openAccessPdf,tldr";
      const r = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?limit=3&fields=${fields}&query=${encodeURIComponent(q)}`, { headers: UA });
      if (r.ok) data = (await r.json()).data || [];
      else console.warn("[s2]", r.status);
    } catch (e) { console.warn("[s2]", e.message); }
    if (!data.length) {
      try {
        const r = await fetch(`https://api.openalex.org/works?per-page=3&search=${encodeURIComponent(q)}`, { headers: UA });
        if (r.ok) data = ((await r.json()).results || []).map(fromOpenAlex);
        else console.warn("[openalex]", r.status, (await r.text()).slice(0, 200));
      } catch (e) { console.warn("[openalex]", e.message); }
    }
    // Both above rate-limit shared IPs (e.g. Cloudflare egress); arXiv and Crossref need no key.
    if (!data.length) data = await arxivSearch(q);
    if (!data.length) data = await crossrefSearch(q);
    const out = { data };
    if (data.length) await putJson(file, out);
    return out;
  }

  async function listPapers(uid) {
    return (await users.list(uid)).map((r) => ({ ...r, id: keyToId(r.key) })).sort((a, b) => b.lastOpened - a.lastOpened);
  }

  // Stores a PDF as a private upload and adds it to the user's library.
  async function saveUpload(uid, buf, name) {
    if (buf.length > 100e6) throw httpError(413, "file too large");
    if (!isPdf(buf)) throw httpError(400, "not a PDF");
    const key = "local-" + (await sha256hex(buf)).slice(0, 12);
    await store.put(`uploads/${key}.pdf`, buf);
    const meta = (await getJson(`meta/${key}.json`)) || { key, id: key, title: name, authors: [], abstract: "" };
    await putJson(`meta/${key}.json`, meta);
    if (!(await users.get(uid, key))) await users.put(uid, key, { title: meta.title, authors: meta.authors, lastOpened: Date.now(), lastPage: 1, highlights: 0 });
    return key;
  }

  // Uploaded PDFs are private to the users who uploaded them; arXiv papers are open to everyone.
  async function requireAccess(uid, key) {
    if (key.startsWith("local-") && !(await users.get(uid, key))) throw httpError(404, "not found");
  }

  // ---------- routes ----------

  async function route(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const method = req.method;
    let m;
    if (method === "GET" && p === "/") return asset("/index.html");
    if (method === "GET" && p === "/library") return asset("/library.html");
    if (method === "GET" && (m = p.match(/^\/paper\/(.+)$/))) {
      const key = m[1].startsWith("local-") ? m[1] : idToKey(parseArxivId(m[1]) || "");
      if (!key) throw httpError(400, "not an arXiv id");
      if (key !== m[1]) return redirect("/paper/" + key);
      return asset("/reader.html");
    }
    if (method === "GET" && (m = p.match(/^\/(abs|pdf|html)\/(.+)$/))) {
      const id = parseArxivId(m[2]);
      if (!id) throw httpError(400, "not an arXiv id");
      return redirect("/paper/" + idToKey(id));
    }
    if (method === "GET" && p === "/api/config") return json(publicConfig);
    if (method === "GET" && p === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim().slice(0, 300);
      if (q.length < 3) return json([]);
      if (!searchKey) throw httpError(503, "search is not configured");
      if (!(await searchAllowed(req))) throw httpError(429, "too many searches, try again in a minute");
      return json(await paperSearch(q, searchKey));
    }
    if (p.startsWith("/api/")) {
      const who = verify ? await verify(sessionToken(req)) : { uid: "local" };
      if (!who) throw httpError(401, "sign in required");
      req.uid = who.uid;
      req.ws = who.org || who.uid;
      req.ai = !paidPlan || who.plan === paidPlan || freeUsers.includes(who.uid);
      // A team of two or more needs the team plan ($10 per member); /api/me stays open so the page can tell.
      req.teamPaid = !who.org || !teamPlan || who.plan === teamPlan || freeUsers.includes(who.uid) || (await teamSize(who.org)) <= 1;
      if (!req.teamPaid && p !== "/api/me") throw httpError(402, "Teams of two or more need the Team plan");
      if (p.startsWith("/api/ai/") && !req.ai) throw httpError(402, "AI features need the Pro plan");
    }
    if (method === "GET" && p === "/api/me") return json({ uid: req.uid, ws: req.ws, team: req.ws !== req.uid, teamPaid: req.teamPaid, ai: req.ai });
    if (method === "GET" && p === "/api/resolve") {
      const id = parseArxivId(url.searchParams.get("q"));
      if (!id) throw httpError(400, "Could not find an arXiv id in that input");
      return json({ key: idToKey(id) });
    }
    if (method === "GET" && p === "/api/papers") return json(await listPapers(req.ws));
    // Removes a paper from the user's library with its reading state. An uploaded PDF is deleted
    // once no library holds it; arXiv files are shared and kept.
    if (method === "PATCH" && (m = p.match(/^\/api\/papers\/([\w.\-]+)$/))) {
      if (!(await users.get(req.ws, m[1]))) throw httpError(404, "not in your library");
      const title = String((await req.json()).title || "").trim().slice(0, 300);
      await users.rename(req.ws, m[1], title || null);
      return json({ ok: true });
    }
    if (method === "DELETE" && (m = p.match(/^\/api\/papers\/([\w.\-]+)$/))) {
      const key = m[1];
      await users.delete(req.ws, key);
      await store.delete(`users/${req.ws}/${key}.json`);
      for (const f of await store.list(`users/${req.ws}/${key}.members/`)) await store.delete(f);
      if (key.startsWith("local-") && !(await users.holders(key))) {
        for (const f of [`uploads/${key}.pdf`, `meta/${key}.json`, `text/${key}.txt`]) await store.delete(f);
      }
      return json({ ok: true });
    }
    if ((m = p.match(/^\/api\/(?:pdf|meta|state|text)\/([\w.\-]+)$/))) await requireAccess(req.ws, m[1]);
    if (method === "GET" && (m = p.match(/^\/api\/pdf\/([\w.\-]+)$/))) {
      const o = await getPdf(m[1]);
      return new Response(o.body, { headers: { "content-type": "application/pdf", ...(o.size ? { "content-length": String(o.size) } : {}) } });
    }
    if (method === "GET" && (m = p.match(/^\/api\/meta\/([\w.\-]+)$/))) return json(await getMeta(m[1]));
    if (method === "POST" && p === "/api/upload") {
      const name = decodeURIComponent(req.headers.get("x-filename") || "Uploaded PDF").replace(/\.pdf$/i, "");
      return json({ key: await saveUpload(req.ws, new Uint8Array(await req.arrayBuffer()), name) });
    }
    // A search result from a proceedings site: only URLs that pdfUrl() derives are fetched.
    if (method === "POST" && p === "/api/import") {
      const { url: link, title } = await req.json();
      const pdf = pdfUrl(link);
      if (!pdf || pdf !== link) throw httpError(400, "unsupported paper link");
      let r;
      for (const src of pdfSources(pdf)) if ((r = await fetch(src, { headers: UA })).ok) break;
      if (!r.ok) throw httpError(502, `could not download the PDF (${r.status})`);
      return json({ key: await saveUpload(req.ws, new Uint8Array(await r.arrayBuffer()), String(title || "Paper").slice(0, 300)) });
    }
    // Reading state. In a team, shared lists live in users/<ws>/<key>.json and each member's notes,
    // chat and position in users/<ws>/<key>.members/<uid>.json. Saves are merged (lib/state.js) and
    // answered with the merged state, which brings in teammates' changes.
    if ((m = p.match(/^\/api\/state\/([\w.\-]+)$/))) {
      const key = m[1], team = req.ws !== req.uid;
      const sharedFile = `users/${req.ws}/${key}.json`, ownFile = `users/${req.ws}/${key}.members/${req.uid}.json`;
      const load = async () => {
        const shared = (await getJson(sharedFile)) || {};
        return team ? { ...shared, ...((await getJson(ownFile)) || {}) } : shared;
      };
      if (method === "GET") return json(await load());
      if (method === "PUT") {
        const client = await req.json();
        const shared = mergeShared((await getJson(sharedFile)) || {}, client);
        if (team) {
          for (const k of PERSONAL) delete shared[k];
          await putJson(ownFile, { ...((await getJson(ownFile)) || {}), ...pick(client, PERSONAL) });
        } else Object.assign(shared, pick(client, PERSONAL));
        await putJson(sharedFile, shared);
        const meta = await getMeta(key);
        await users.put(req.ws, key, {
          title: meta.title, authors: meta.authors || [],
          lastOpened: client.lastOpened || Date.now(), lastPage: client.lastPage || 1, highlights: (shared.highlights || []).length,
        });
        return json(team ? { ...shared, ...((await getJson(ownFile)) || {}) } : shared);
      }
    }
    if (method === "POST" && (m = p.match(/^\/api\/text\/([\w.\-]+)$/))) {
      const { text = "", meta } = await req.json();
      await store.put(`text/${m[1]}.txt`, text);
      if (meta?.title && m[1].startsWith("local-")) await putJson(`meta/${m[1]}.json`, { ...(await getMeta(m[1])), ...meta });
      return json({ ok: true });
    }
    if (method === "POST" && (m = p.match(/^\/api\/ai\/stream\/([\w-]+)$/))) return aiStream(req, m[1]);
    if (method === "POST" && (m = p.match(/^\/api\/ai\/json\/([\w-]+)$/))) return aiJson(req, m[1]);
    if (method === "GET" && p === "/api/scholar") return json(await scholarSearch(url.searchParams.get("q") || ""));
    if (method === "GET") { const r = await asset(p); if (r) return r; }
    throw httpError(404, "not found");
  }

  return async function handle(req) {
    try {
      return (await route(req)) || json({ error: "not found" }, 404);
    } catch (e) {
      console.warn(`[${req.method} ${new URL(req.url).pathname}]`, e.message);
      return json({ error: e.message }, e.status || 500);
    }
  };
}

const normTitle = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Only accept an arXiv hit whose title matches; arXiv search is fuzzy.
async function arxivSearch(q) {
  try {
    const terms = q.replace(/[^\w\s-]/g, " ").trim().split(/\s+/).slice(0, 20).join(" ");
    const xml = await (await fetch(`https://export.arxiv.org/api/query?max_results=3&search_query=${encodeURIComponent(`ti:"${terms}"`)}`, { headers: UA })).text();
    return xml.split("<entry>").slice(1).map((entry) => {
      const tag = (t) => (entry.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]?.replace(/\s+/g, " ").trim() || "";
      const id = (tag("id").match(/abs\/([^\s]+?)(v\d+)?$/) || [])[1];
      return {
        title: tag("title"), authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((x) => ({ name: x[1].trim() })),
        year: Number(tag("published").slice(0, 4)) || undefined, venue: "arXiv", abstract: tag("summary"),
        url: `https://arxiv.org/abs/${id}`, externalIds: { ArXiv: id }, openAccessPdf: { url: `https://arxiv.org/pdf/${id}` }, source: "arXiv",
      };
    }).filter((p) => p.externalIds.ArXiv && normTitle(p.title) === normTitle(q));
  } catch (e) { console.warn("[arxiv]", e.message); return []; }
}

// Share of the words of a that also appear in b.
function titleOverlap(a, b) {
  const words = (t) => String(t).toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const have = new Set(words(b)), want = words(a);
  return want.length ? want.filter((w) => have.has(w)).length / want.length : 0;
}

async function crossrefSearch(q) {
  try {
    const r = await fetch(`https://api.crossref.org/works?rows=3&query.bibliographic=${encodeURIComponent(q)}`, { headers: UA });
    if (!r.ok) { console.warn("[crossref]", r.status); return []; }
    return ((await r.json()).message?.items || []).map((w) => ({
      title: w.title?.[0] || "", authors: (w.author || []).map((a) => ({ name: [a.given, a.family].filter(Boolean).join(" ") })),
      year: w.issued?.["date-parts"]?.[0]?.[0], venue: w["container-title"]?.[0] || "",
      abstract: String(w.abstract || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      citationCount: w["is-referenced-by-count"], url: w.URL, externalIds: {}, openAccessPdf: null, source: "Crossref",
    })).filter((p) => p.year && Math.min(titleOverlap(q, p.title), titleOverlap(p.title, q)) >= 0.8);
  } catch (e) { console.warn("[crossref]", e.message); return []; }
}

function fromOpenAlex(w) {
  const words = [];
  for (const [word, pos] of Object.entries(w.abstract_inverted_index || {})) for (const p of pos) words[p] = word;
  const urls = (w.locations || []).map((l) => l.landing_page_url || "").concat(w.primary_location?.landing_page_url || "");
  const arxiv = urls.map((u) => (u.match(/arxiv\.org\/abs\/([^\s?#]+?)(v\d+)?$/) || [])[1]).find(Boolean);
  return {
    title: w.title || w.display_name,
    authors: (w.authorships || []).map((a) => ({ name: a.author?.display_name })),
    year: w.publication_year,
    venue: w.primary_location?.source?.display_name || "",
    abstract: words.filter(Boolean).join(" "),
    citationCount: w.cited_by_count,
    url: w.doi || w.id,
    externalIds: arxiv ? { ArXiv: arxiv } : {},
    openAccessPdf: w.open_access?.oa_url ? { url: w.open_access.oa_url } : null,
    source: "OpenAlex",
  };
}
