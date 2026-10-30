// "With AI" panel (keyword glossary, three-line summary, reading guide, discussions with reference
// papers), the Quiz tab and the Related tab.
import { app, saveState, pageText } from "./app.js";
import { $, esc, md, icon, stream, aiJson, toast, uid } from "./util.js";
import { openPanel } from "./panels.js";
import { confirmDialog } from "./ui.js";

let quote = null; // { text, page } attached to the next question
let chatAbort = null;
let activeChat = null; // id of the open discussion
const mem = {}; // per paper and language: { keywords, kwSeed, tldr, quiz, related }
const cache = () => (mem[app.key + app.settings.lang] ||= {});

export function askWithQuote(text, page) {
  quote = { text, page };
  openPanel("ai");
  setTimeout(() => $("#chat-input")?.focus(), 50);
}

// The server answers from the paper's extracted text; send it once per session.
export async function ensureFullText() {
  if (app.fullTextSent) return app.fullTextSent;
  app.fullTextSent = (async () => {
    const parts = [];
    for (let i = 0; i < app.pdf.numPages; i++) parts.push(`[Page ${i + 1}]\n` + (await pageText(i)));
    await fetch(`/api/text/${app.key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: parts.join("\n\n") }) });
  })();
  return app.fullTextSent;
}

// ---------- discussions ----------
// state.chats = [{ id, title, refs: [{ key, title }], messages: [{ role, text, quote? }] }], per member.

function chats() {
  if (!Array.isArray(app.state.chats)) {
    const old = app.state.chat || [];
    app.state.chats = old.length ? [{ id: uid(), title: old[0].text.slice(0, 60), refs: [], messages: old }] : [];
  }
  return app.state.chats;
}
function currentChat(create) {
  let c = chats().find((x) => x.id === activeChat) || chats()[0];
  if (!c && create) { c = { id: uid(), title: "", refs: [], messages: [] }; chats().unshift(c); }
  activeChat = c?.id || null;
  return c;
}

// ---------- panel ----------

const SUGGEST = ["What problem does this paper solve?", "Explain the core method step by step", "What are the main results and baselines?", "What are the limitations?"];
const secHead = (id, title, extra = "") => `<summary><span class="sec-title">${title}</span><span class="grow"></span>${extra}
  <button class="icon-btn sm" data-copy="${id}" title="Copy">${icon("copy", 14)}</button><button class="icon-btn sm" data-regen="${id}" title="Regenerate">${icon("refresh", 14)}</button></summary>`;

export function renderAI(body) {
  if (!body.querySelector(".ai")) {
    body.innerHTML = `<div class="ai">
      <div class="ai-scroll">
        <details class="ai-sec" open data-sec="kw">${secHead("kw", "Keywords")}<div class="kw-chips"></div><div class="kw-def" hidden></div></details>
        <details class="ai-sec" open data-sec="tldr">${secHead("tldr", "Three-line summary")}<div class="md tldr"></div></details>
        <details class="ai-sec" data-sec="guide">${secHead("guide", "Reading guide")}<div class="md summary"></div></details>
        <div class="disc-bar"><select class="select" id="disc-select" aria-label="Discussion"></select><button class="icon-btn" id="disc-del" title="Delete discussion">${icon("trash", 15)}</button><button class="btn small" id="disc-new">${icon("plus", 14)} New</button></div>
        <div class="chat"></div>
      </div>
      <div class="composer">
        <div class="quote-chip" hidden></div>
        <div class="refs"></div>
        <div class="suggest"></div>
        <div class="input-row"><textarea id="chat-input" rows="1" placeholder="Ask anything about this paper…"></textarea><button class="btn primary send" title="Send (Enter)">${icon("send", 16)}</button></div>
      </div></div>`;
    const ta = body.querySelector("#chat-input");
    ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 160) + "px"; });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(body); } });
    body.querySelector(".send").onclick = () => send(body);
    body.querySelector("#disc-new").onclick = () => { chatAbort?.abort(); activeChat = null; const c = { id: uid(), title: "", refs: [], messages: [] }; chats().unshift(c); activeChat = c.id; renderAI(body); ta.focus(); };
    body.querySelector("#disc-select").onchange = (e) => { chatAbort?.abort(); activeChat = e.target.value; renderAI(body); };
    body.querySelector(".ai-scroll").addEventListener("click", (e) => onSectionClick(e, body));
    body.querySelector(".chat").addEventListener("click", (e) => {
      const b = e.target.closest("[data-copymsg]");
      const text = b && currentChat(false)?.messages[b.dataset.copymsg]?.text;
      if (text) { navigator.clipboard.writeText(text); toast("Copied"); }
    });
    body.querySelector("#disc-del").onclick = async () => {
      const c = currentChat(false);
      if (!c?.messages.length) return;
      if (!(await confirmDialog({ title: "Delete this discussion?", description: c.title || "", confirmLabel: "Delete", destructive: true }))) return;
      chatAbort?.abort();
      app.state.chats = chats().filter((x) => x.id !== c.id);
      activeChat = null;
      saveState();
      renderAI(body);
    };
    body.querySelector(".kw-chips").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-i]");
      if (!chip) return;
      const def = body.querySelector(".kw-def"), k = cache().keywords?.[chip.dataset.i];
      const same = !def.hidden && def.dataset.i === chip.dataset.i;
      body.querySelectorAll(".kw-chip").forEach((c) => c.classList.toggle("on", !same && c === chip));
      def.hidden = same;
      def.dataset.i = chip.dataset.i;
      if (k) def.innerHTML = `<b>${esc(k.term)}</b>${md(k.definition)}`;
    });
    body.querySelector("[data-sec=guide]").addEventListener("toggle", (e) => { if (e.target.open && !app.state.summary) runGuide(body); });
    loadKeywords(body);
    loadTldr(body);
    if (app.state.summary) body.querySelector(".summary").innerHTML = md(app.state.summary);
  }
  renderChat(body);
}

function onSectionClick(e, body) {
  const copy = e.target.closest("[data-copy]"), regen = e.target.closest("[data-regen]");
  if (!copy && !regen) return;
  e.preventDefault(); // keep the <details> open/closed
  const id = (copy || regen).dataset.copy || (copy || regen).dataset.regen;
  if (copy) {
    const text = id === "kw" ? (cache().keywords || []).map((k) => `- ${k.term}: ${k.definition}`).join("\n") : id === "tldr" ? cache().tldr : app.state.summary;
    if (text) { navigator.clipboard.writeText(text); toast("Copied"); }
    return;
  }
  if (id === "kw") { cache().kwSeed = (cache().kwSeed || 0) + 1; cache().keywords = null; loadKeywords(body); }
  if (id === "tldr") { cache().tldr = null; loadTldr(body, true); }
  if (id === "guide") { body.querySelector("[data-sec=guide]").open = true; runGuide(body, true); }
}

const skeleton = (n = 3) => `<div class="skeleton">${"<i></i>".repeat(n - 1)}<i style="width:60%"></i></div>`;

async function loadKeywords(body) {
  const box = body.querySelector(".kw-chips"), c = cache();
  const show = () => (box.innerHTML = (c.keywords || []).map((k, i) => `<button class="kw-chip" data-i="${i}">${esc(k.term)}</button>`).join("") || `<span class="muted">No keywords.</span>`);
  if (c.keywords) return show();
  box.innerHTML = skeleton(2);
  try {
    await ensureFullText();
    c.keywords = await aiJson("keywords", { key: app.key, lang: app.settings.lang, seed: c.kwSeed || 0 });
    if (box.isConnected) show();
  } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

async function loadTldr(body, regenerate = false) {
  const box = body.querySelector(".tldr"), c = cache();
  if (c.tldr) { box.innerHTML = md(c.tldr); return; }
  box.innerHTML = skeleton(3);
  try {
    await ensureFullText();
    c.tldr = await stream("tldr", { key: app.key, lang: app.settings.lang, regenerate }, (t) => box.isConnected && (box.innerHTML = md(t)));
  } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

async function runGuide(body, regenerate = false) {
  const box = body.querySelector(".summary");
  box.innerHTML = skeleton(4);
  box.classList.add("streaming");
  try {
    await ensureFullText();
    app.state.summary = await stream("summary", { key: app.key, lang: app.settings.lang, regenerate }, (t) => (box.innerHTML = md(t)));
    saveState();
  } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  box.classList.remove("streaming");
}

const copyMsg = (k) => `<div class="msg-acts"><button class="icon-btn sm" data-copymsg="${k}" title="Copy">${icon("copy", 14)}</button></div>`;

function renderChat(body) {
  const c = currentChat(false);
  const sel = body.querySelector("#disc-select");
  sel.innerHTML = chats().length
    ? chats().map((x, i) => `<option value="${x.id}" ${x.id === c?.id ? "selected" : ""}>${esc(x.title || `Discussion ${chats().length - i}`)}</option>`).join("")
    : `<option>New discussion</option>`;
  const msgs = c?.messages || [];
  const chat = body.querySelector(".chat");
  chat.innerHTML = msgs.map((m, k) => `<div class="msg ${m.role}">${m.quote ? `<blockquote class="quote small">${esc(m.quote.slice(0, 200))}</blockquote>` : ""}<div class="${m.role === "user" ? "" : "md"}" data-k="${k}">${m.role === "user" ? esc(m.text) : md(m.text)}</div>${m.role === "model" && m.text ? copyMsg(k) : ""}</div>`).join("");
  body.querySelector("#disc-del").hidden = !msgs.length;

  const chip = body.querySelector(".quote-chip");
  chip.hidden = !quote;
  if (quote) {
    chip.innerHTML = `${icon("quote", 12)}<span>${esc(quote.text.slice(0, 180))}${quote.text.length > 180 ? "…" : ""}</span><button class="icon-btn">${icon("x", 12)}</button>`;
    chip.querySelector("button").onclick = () => { quote = null; chip.hidden = true; };
  }
  const refs = body.querySelector(".refs");
  refs.innerHTML = (c?.refs || []).map((r) => `<span class="ref-chip" title="${esc(r.title)}">${icon("note", 12)}<span>${esc(r.title)}</span><button class="icon-btn" data-unref="${esc(r.key)}">${icon("x", 12)}</button></span>`).join("")
    + `<button class="btn ghost small" id="add-ref">${icon("plus-circle", 14)} Reference paper</button>`;
  refs.onclick = async (e) => {
    const un = e.target.closest("[data-unref]");
    if (un) { c.refs = c.refs.filter((r) => r.key !== un.dataset.unref); saveState(); return renderChat(body); }
    if (!e.target.closest("#add-ref")) return;
    const r = await pickPaper();
    if (!r) return;
    const cc = currentChat(true);
    if (!cc.refs.some((x) => x.key === r.key)) cc.refs.push(r);
    cc.refs = cc.refs.slice(-3);
    saveState();
    renderAI(body);
  };
  const sug = body.querySelector(".suggest");
  sug.innerHTML = msgs.length ? "" : SUGGEST.map((q) => `<button class="pill">${q}</button>`).join("");
  sug.onclick = (e) => { if (e.target.matches(".pill")) { body.querySelector("#chat-input").value = e.target.textContent; send(body); } };
}

async function send(body) {
  const ta = body.querySelector("#chat-input");
  const q = ta.value.trim();
  if (!q) return;
  chatAbort?.abort();
  const c = currentChat(true);
  if (!c.title) c.title = q.slice(0, 60);
  const history = c.messages.slice(-12).map((m) => ({ role: m.role, text: m.quote ? `About: """${m.quote}"""\n${m.text}` : m.text }));
  const qq = quote;
  quote = null;
  c.messages.push({ role: "user", text: q, quote: qq?.text }, { role: "model", text: "" });
  ta.value = ""; ta.style.height = "auto";
  renderChat(body);
  const scroll = body.querySelector(".ai-scroll");
  scroll.scrollTop = scroll.scrollHeight;
  const msg = c.messages.at(-1);
  const out = body.querySelector(`.chat [data-k="${c.messages.length - 1}"]`);
  out.parentElement.classList.add("streaming");
  out.innerHTML = skeleton(2);
  chatAbort = new AbortController();
  try {
    await ensureFullText();
    msg.text = await stream("ask", { key: app.key, lang: app.settings.lang, question: q, quote: qq?.text, history, refs: c.refs.map((r) => r.key) }, (t) => {
      out.innerHTML = md(t);
      if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120) scroll.scrollTop = scroll.scrollHeight;
    }, { signal: chatAbort.signal });
  } catch (e) {
    if (e.name !== "AbortError") { msg.text = `⚠️ ${e.message}`; out.innerHTML = md(msg.text); }
  }
  out.parentElement.classList.remove("streaming");
  if (msg.text && out.isConnected) out.insertAdjacentHTML("afterend", copyMsg(c.messages.length - 1));
  saveState();
}

// Choose a reference paper: from the library, or an arXiv search. Resolves { key, title } or null.
function pickPaper() {
  const dlg = document.createElement("dialog");
  dlg.className = "dialog picker";
  dlg.innerHTML = `<form><h2>Add a reference paper</h2><p>The assistant reads it alongside this paper, so you can compare them.</p>
    <input class="input" placeholder="Search your library or arXiv" autocomplete="off"><ul class="pick-list"></ul>
    <div class="actions"><button class="btn" type="button" data-cancel>Cancel</button></div></form>`;
  document.body.append(dlg);
  const input = dlg.querySelector("input"), list = dlg.querySelector(".pick-list");
  let library = [], found = [], timer;
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const mine = library.filter((p) => p.key !== app.key && (!q || p.title.toLowerCase().includes(q))).slice(0, 6).map((p) => ({ key: p.key, title: p.title, meta: "In your library" }));
    const web = found.filter((r) => r.kind === "arxiv").map((r) => ({ key: r.id.replace("/", "_"), title: r.title, meta: ["arXiv", r.year, r.id].filter(Boolean).join(" · ") }))
      .filter((r) => r.key !== app.key && !mine.some((m) => m.key === r.key));
    const all = [...mine, ...web];
    list.innerHTML = all.length ? all.map((r, i) => `<li><button type="button" data-i="${i}"><span>${esc(r.title)}</span><small>${esc(r.meta)}</small></button></li>`).join("") : `<li class="muted">${q.length < 3 ? "Type at least 3 characters to search arXiv." : "No papers found."}</li>`;
    list._items = all;
  };
  return new Promise((resolve) => {
    const finish = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.querySelector("[data-cancel]").onclick = () => finish(null);
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
    dlg.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); if (list._items?.[0]) finish({ key: list._items[0].key, title: list._items[0].title }); });
    list.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) { const r = list._items[b.dataset.i]; finish({ key: r.key, title: r.title }); } });
    input.addEventListener("input", () => {
      render();
      clearTimeout(timer);
      if (input.value.trim().length >= 3) timer = setTimeout(async () => { found = await fetch("/api/search?q=" + encodeURIComponent(input.value)).then((r) => r.json()).catch(() => []); if (Array.isArray(found)) render(); else found = []; }, 350);
    });
    fetch("/api/papers").then((r) => r.json()).then((xs) => { library = Array.isArray(xs) ? xs : []; render(); });
    dlg.showModal();
    input.focus();
  });
}

// ---------- quiz ----------

export function renderQuiz(body) {
  const c = cache();
  const opt = c.quizOpt ||= { count: 5, level: "easy", seed: 0 };
  const pills = (name, vals, labels) => vals.map((v, i) => `<button class="pill ${opt[name] === v ? "on" : ""}" data-${name}="${v}">${labels[i]}</button>`).join("");
  body.innerHTML = `<div class="quiz">
    <div class="quiz-opts"><div><span class="lbl">Questions</span>${pills("count", [5, 10, 15], ["5", "10", "15"])}</div>
    <div><span class="lbl">Difficulty</span>${pills("level", ["easy", "hard"], ["Easy", "Hard"])}</div>
    <button class="btn primary" id="quiz-go">${c.quiz ? "New quiz" : "Generate quiz"}</button></div>
    <div class="quiz-body"></div></div>`;
  body.querySelector(".quiz-opts").onclick = (e) => {
    const b = e.target.closest("[data-count],[data-level]");
    if (b) { if (b.dataset.count) opt.count = Number(b.dataset.count); if (b.dataset.level) opt.level = b.dataset.level; renderQuiz(body); }
  };
  body.querySelector("#quiz-go").onclick = async (e) => {
    e.target.disabled = true;
    const qb = body.querySelector(".quiz-body");
    qb.innerHTML = skeleton(4);
    try {
      await ensureFullText();
      if (c.quiz) opt.seed++;
      c.quiz = { items: await aiJson("quiz", { key: app.key, lang: app.settings.lang, count: opt.count, level: opt.level, seed: opt.seed }), picked: {} };
      renderQuiz(body);
    } catch (err) { qb.innerHTML = `<p class="error">${esc(err.message)}</p>`; e.target.disabled = false; }
  };
  if (c.quiz) drawQuiz(body.querySelector(".quiz-body"), c.quiz);
}

function drawQuiz(box, quiz) {
  const done = Object.keys(quiz.picked).length, right = quiz.items.filter((q, i) => quiz.picked[i] === q.answer).length;
  box.innerHTML = quiz.items.map((q, i) => {
    const p = quiz.picked[i];
    return `<div class="q ${p == null ? "" : p === q.answer ? "right" : "wrong"}"><div class="q-text"><b>${i + 1}.</b> ${md(q.question).replace(/^<p>|<\/p>\s*$/g, "")}</div>
      ${q.options.map((o, k) => `<button class="q-opt ${p == null ? "" : k === q.answer ? "correct" : k === p ? "picked" : ""}" data-q="${i}" data-k="${k}" ${p == null ? "" : "disabled"}><span class="q-letter">${"ABCD"[k]}</span>${md(String(o)).replace(/^<p>|<\/p>\s*$/g, "")}</button>`).join("")}
      ${p == null ? "" : `<div class="q-exp md">${md(q.explanation || "")}${q.page ? `<p class="muted">Page ${q.page}</p>` : ""}</div>`}</div>`;
  }).join("") + (quiz.items.length ? `<div class="q-score">${done}/${quiz.items.length} answered · ${right} correct</div>` : `<p class="muted">No questions came back. Try again.</p>`);
  box.onclick = (e) => {
    const b = e.target.closest(".q-opt");
    if (!b || b.disabled) return;
    quiz.picked[b.dataset.q] = Number(b.dataset.k);
    drawQuiz(box, quiz);
  };
}

// ---------- related papers ----------

export async function renderRelated(body) {
  const c = cache();
  body.innerHTML = `<div class="related">${skeleton(4)}</div>`;
  try {
    c.related ||= await fetch(`/api/related/${app.key}`).then((r) => r.json());
  } catch { c.related = []; }
  const list = Array.isArray(c.related) ? c.related : [];
  body.innerHTML = `<div class="related">${list.length ? list.map((r, i) => `<div class="list-item rel">
      <div class="ref-title">${esc(r.title)}</div><div class="ref-meta">${esc([r.site, r.year, r.kind === "arxiv" ? r.id : ""].filter(Boolean).join(" · "))}</div>
      ${r.snippet ? `<div class="li-quote small">${esc(r.snippet)}</div>` : ""}
      <div class="ref-links"><button class="btn primary small" data-open="${i}">Read</button>${r.kind === "arxiv" ? `<button class="btn ghost small" data-ref="${i}">${icon("plus-circle", 14)} Add to discussion</button>` : ""}</div></div>`).join("")
    : `<div class="empty">${icon("compass", 28)}<p>No related papers found.</p></div>`}</div>`;
  body.onclick = async (e) => {
    const o = e.target.closest("[data-open]"), a = e.target.closest("[data-ref]");
    const r = list[(o || a)?.dataset.open ?? (o || a)?.dataset.ref];
    if (!r) return;
    if (a) {
      const cc = currentChat(true);
      const key = r.id.replace("/", "_");
      if (!cc.refs.some((x) => x.key === key)) cc.refs = [...cc.refs, { key, title: r.title }].slice(-3);
      saveState();
      toast("Added to the current discussion");
      return;
    }
    if (r.kind === "arxiv") return void window.open(`/paper/${r.id}`, "_blank");
    toast("Fetching the PDF…");
    const res = await fetch("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: r.url, title: r.title }) }).then((x) => x.json()).catch(() => ({}));
    if (res.key) window.open(`/paper/${res.key}`, "_blank"); else toast(res.error || "Could not open this paper");
  };
}
