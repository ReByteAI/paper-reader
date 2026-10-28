// Reading state of one paper, shared by a team: highlights (with comments), AI explanations and
// saved citations belong to the workspace; notes, chat and the reading position belong to each
// member. Shared lists are merged per item on save, so teammates editing at the same time do not
// overwrite each other.

export const SHARED = ["highlights", "explanations", "citations"];
export const PERSONAL = ["notes", "chat", "lastPage", "lastOpened"];

const time = (x) => x.mt || x.ts || 0;

// server: the stored list. client: the list the client saved. base: ids the client had seen at its
// last sync, which tells a deletion on the client apart from an item a teammate added since.
export function mergeItems(server = [], client = [], base) {
  if (!Array.isArray(base)) return client; // client without sync info: its list wins
  const seen = new Set(base), fromClient = new Map(client.map((x) => [x.id, x]));
  const out = [];
  for (const s of server) {
    const c = fromClient.get(s.id);
    if (c) { out.push(time(c) >= time(s) ? c : s); fromClient.delete(s.id); }
    else if (!seen.has(s.id)) out.push(s); // added by a teammate; otherwise deleted on the client
  }
  for (const c of fromClient.values()) if (!seen.has(c.id)) out.push(c); // seen but gone from the server: a teammate deleted it
  return out;
}

// Merges a client save into the stored shared state. Returns the new shared state.
export function mergeShared(stored = {}, client = {}) {
  const base = client._base || {};
  const out = { ...stored };
  for (const k of SHARED) {
    if (!(k in client)) continue;
    out[k] = mergeItems(stored[k], client[k], base[k]);
    if (k !== "highlights") out[k].sort((a, b) => (b.ts || 0) - (a.ts || 0)); // newest first, as the panels list them
  }
  for (const [k, v] of Object.entries(client)) if (!SHARED.includes(k) && !PERSONAL.includes(k) && k !== "_base") out[k] = v; // e.g. summary
  return out;
}

export const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
