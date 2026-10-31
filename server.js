// Paper Reader — local server. Routes live in lib/core.js (shared with the Cloudflare Worker);
// this file supplies disk stores under data/, static files and the Node HTTP adapter.
// Set CLERK_PUBLISHABLE_KEY to require Clerk sign-in; otherwise everything runs as user "local".
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createHandler } from "./lib/core.js";
import { createVerifier } from "./lib/auth.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.PAPER_DATA_DIR || path.join(ROOT, "data");
const PORT = Number(process.env.PORT || 5178);
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const candidates = [process.env.GEMINI_ENV_FILE, path.join(ROOT, ".env"), path.join(os.homedir(), ".gemini-video.env"), path.join(os.homedir(), ".env.impo-gemini"), path.join(os.homedir(), ".env")].filter(Boolean);
  for (const f of candidates) {
    try {
      const m = fs.readFileSync(f, "utf8").match(/^(?:export\s+)?GEMINI_API_KEY\s*=\s*["']?([^"'\s]+)/m);
      if (m) { console.log(`[key] GEMINI_API_KEY from ${f}`); return m[1]; }
    } catch {}
  }
  console.warn("[key] GEMINI_API_KEY not found; AI features will fail");
  return "";
}

const diskStore = {
  async get(p) {
    const file = path.join(DATA, p);
    try {
      const st = await fsp.stat(file);
      return { size: st.size, body: Readable.toWeb(fs.createReadStream(file)), text: () => fsp.readFile(file, "utf8"), arrayBuffer: () => fsp.readFile(file) };
    } catch { return null; }
  },
  async put(p, data) {
    const file = path.join(DATA, p);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, data);
  },
  async list(prefix) {
    try { return (await fsp.readdir(path.join(DATA, prefix))).map((f) => prefix + f); } catch { return []; }
  },
  delete: (p) => fsp.rm(path.join(DATA, p), { force: true }),
};

// Per-user library index as data/library/<uid>/<key>.json (reading state itself is in the store at users/<uid>/).
const userFile = (uid, key) => path.join(DATA, "library", uid.replace(/[^\w-]/g, "_"), key + ".json");
const diskUsers = {
  async get(uid, key) {
    try { return JSON.parse(await fsp.readFile(userFile(uid, key), "utf8")); } catch { return null; }
  },
  async put(uid, key, entry) {
    const file = userFile(uid, key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const { customTitle, favorite } = (await this.get(uid, key)) || {};
    await fsp.writeFile(file, JSON.stringify({ key, ...entry, customTitle, favorite }));
  },
  async favorite(uid, key, on) {
    const entry = await this.get(uid, key);
    if (entry) await fsp.writeFile(userFile(uid, key), JSON.stringify({ ...entry, favorite: on || undefined }));
  },
  async rename(uid, key, title) {
    const entry = await this.get(uid, key);
    if (entry) await fsp.writeFile(userFile(uid, key), JSON.stringify({ ...entry, customTitle: title || undefined }));
  },
  delete: (uid, key) => fsp.rm(userFile(uid, key), { force: true }),
  async holders(key) {
    const root = path.join(DATA, "library");
    let n = 0;
    for (const u of await fsp.readdir(root).catch(() => [])) if (fs.existsSync(path.join(root, u, key + ".json"))) n++;
    return n;
  },
  async list(uid) {
    const dir = path.dirname(userFile(uid, "x"));
    const out = [];
    for (const f of await fsp.readdir(dir).catch(() => [])) {
      const e = JSON.parse(await fsp.readFile(path.join(dir, f), "utf8"));
      out.push({ ...e, title: e.customTitle || e.title, originalTitle: e.title, favorite: !!e.favorite });
    }
    return out;
  },
};

// One-time move of the pre-accounts layout (data/state/<key>.json, every paper in data/meta) to user "local".
async function migrateLocal() {
  if (fs.existsSync(path.join(DATA, "library")) || !fs.existsSync(path.join(DATA, "meta"))) return;
  for (const f of await fsp.readdir(path.join(DATA, "meta"))) {
    const key = f.replace(/\.json$/, "");
    const meta = JSON.parse(await fsp.readFile(path.join(DATA, "meta", f), "utf8"));
    let state = {};
    try { state = JSON.parse(await fsp.readFile(path.join(DATA, "state", f), "utf8")); } catch {}
    await diskStore.put(`users/local/${key}.json`, JSON.stringify(state));
    await diskUsers.put("local", key, { title: meta.title, authors: meta.authors || [], lastOpened: state.lastOpened || 0, lastPage: state.lastPage || 1, highlights: (state.highlights || []).length });
  }
  console.log("[migrate] moved library to data/library/local");
}
await migrateLocal();

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".map": "application/json", ".bcmap": "application/octet-stream", ".pfb": "application/octet-stream" };
const STATIC = [
  ["/vendor/pdfjs/", path.join(ROOT, "node_modules/pdfjs-dist")],
  ["/vendor/marked/", path.join(ROOT, "node_modules/marked")],
  ["/vendor/katex/", path.join(ROOT, "node_modules/katex/dist")],
  ["/", path.join(ROOT, "public")],
];
async function asset(urlPath) {
  for (const [prefix, dir] of STATIC) {
    if (!urlPath.startsWith(prefix)) continue;
    const file = path.normalize(path.join(dir, urlPath.slice(prefix.length)));
    if (!file.startsWith(dir)) break;
    try {
      if (!(await fsp.stat(file)).isFile()) continue;
      return new Response(Readable.toWeb(fs.createReadStream(file)), { headers: { "content-type": MIME[path.extname(file)] || "application/octet-stream" } });
    } catch {}
  }
  return null;
}

const CLERK_KEY = process.env.CLERK_PUBLISHABLE_KEY || "";
const handle = createHandler({
  store: diskStore, users: diskUsers, apiKey: loadKey(), model: MODEL, asset,
  searchKey: process.env.QUERIT_API_KEY || "",
  ...(CLERK_KEY ? {
    verify: createVerifier({ publishableKey: CLERK_KEY, authorizedParties: [`http://localhost:${PORT}`] }),
    publicConfig: { clerkPublishableKey: CLERK_KEY },
  } : {}),
});

const server = http.createServer(async (req, res) => {
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(new URL(req.url, `http://${req.headers.host || "localhost"}`), {
    method: req.method, headers: req.headers, ...(hasBody ? { body: Readable.toWeb(req), duplex: "half" } : {}),
  });
  const response = await handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return void res.end();
  Readable.fromWeb(response.body).on("error", () => res.end()).pipe(res);
});

server.listen(PORT, "127.0.0.1", () => console.log(`Paper Reader on http://localhost:${PORT}  (model ${MODEL})`));
