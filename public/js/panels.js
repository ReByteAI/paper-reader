// Left rail (hover-expand), outline panel, and the resizable right panel with its tabs.
import { mountUserButton, me } from "./auth.js";
import { app, saveState, onStateChange, scrollToPagePoint, placeAllSoon, pageText } from "./app.js";
import { $, $$, h, esc, md, icon, stream, toast } from "./util.js";

// In a team, list items show who added them.
const byline = (who) => (me.team && who?.name ? `<span class="by">${esc(who.name)}</span>` : "");

const TABS = [
  { id: "ai", label: "With AI", icon: "bot" },
  { id: "highlights", label: "Highlights", icon: "highlighter" },
  { id: "explanations", label: "Explanations", icon: "lightbulb" },
  { id: "comments", label: "Comments", icon: "message" },
  { id: "notes", label: "Notes", icon: "note" },
  { id: "citations", label: "Citations", icon: "quote" },
];
const root = document.documentElement;
let activeTab = null;

// ---------- layout variables ----------
// The PDF area reacts to --left-panel-w / --right-panel-w with a 180 ms transition; once it settles,
// PDF.js re-fits when the zoom is in an automatic mode.

function refit() {
  const v = app.viewer;
  if (!v) return;
  if (["auto", "page-width", "page-fit"].includes(v.currentScaleValue)) v.currentScaleValue = v.currentScaleValue;
  placeAllSoon();
}
export function initLayout() {
  $("#main").addEventListener("transitionend", (e) => { if (e.target.id === "main") refit(); });
  addEventListener("resize", refit);
}

// ---------- left rail ----------

export function initLeftRail() {
  const rail = $("#leftrail");
  rail.innerHTML = `
    <a class="rail-logo" href="/" title="Home"><span class="logo-dot"></span><span class="rail-label brand">XYZNOT</span></a>
    <nav>
      <a href="/library" class="rail-item">${icon("home")}<span class="rail-label">Home</span></a>
      <a href="/library#library" class="rail-item">${icon("library")}<span class="rail-label">Library</span></a>
      <button class="rail-item" data-act="upload">${icon("upload")}<span class="rail-label">Upload PDF</span></button>
      <span class="rail-sep"></span>
      <button class="rail-item" data-act="outline">${icon("outline")}<span class="rail-label">Outline</span></button>
      <button class="rail-item" data-act="info">${icon("info")}<span class="rail-label">Paper info</span></button>
    </nav>
    <span class="grow"></span>
    <button class="rail-item" data-act="theme">${icon("moon")}<span class="rail-label">Dark mode</span></button>
    <div class="rail-user" id="rail-user"></div>`;
  mountUserButton($("#rail-user"));
  // Expands over the content (no reflow) on hover or keyboard focus.
  const open = () => rail.classList.add("expanded");
  const close = () => rail.classList.remove("expanded");
  rail.addEventListener("pointerenter", open);
  rail.addEventListener("pointerleave", close);
  rail.addEventListener("focusin", open);
  rail.addEventListener("focusout", (e) => { if (!rail.contains(e.relatedTarget)) close(); });
  rail.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "upload") uploadPdf();
    if (act === "outline") toggleOutline();
    if (act === "info") $("#btn-info").click();
    if (act === "theme") toggleTheme();
  });
}

export function toggleTheme() {
  const dark = root.dataset.theme !== "dark";
  root.dataset.theme = dark ? "dark" : "light";
  try { localStorage.setItem("pr-theme", root.dataset.theme); } catch {}
}

export function uploadPdf() {
  const input = h(`<input type="file" accept="application/pdf" hidden>`);
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    toast("Uploading…");
    const r = await fetch("/api/upload", { method: "POST", headers: { "x-filename": encodeURIComponent(f.name) }, body: f }).then((x) => x.json());
    if (r.key) location.href = "/paper/" + r.key; else toast(r.error || "Upload failed");
  };
  input.click();
}

// ---------- outline ----------

export async function toggleOutline(force) {
  const show = force ?? !root.classList.contains("outline-open");
  root.classList.toggle("outline-open", show);
  $("#btn-outline").classList.toggle("on", show);
  if (show && !$("#outline").dataset.ready) await buildOutline();
}

async function buildOutline() {
  const box = $("#outline");
  box.dataset.ready = "1";
  const outline = await app.pdf.getOutline();
  const list = h(`<div class="outline-list"></div>`);
  const add = (items, depth) => {
    for (const it of items || []) {
      const b = h(`<button class="outline-item" style="padding-left:${12 + depth * 14}px">${esc(it.title)}</button>`);
      b.onclick = () => it.dest && app.navigate(it.dest);
      list.append(b);
      add(it.items, depth + 1);
    }
  };
  add(outline, 0);
  box.innerHTML = `<div class="panel-title">Outline</div>`;
  if (!outline?.length) {
    // No embedded outline: list pages instead.
    for (let i = 0; i < app.pdf.numPages; i++) {
      const b = h(`<button class="outline-item">Page ${i + 1}</button>`);
      b.onclick = () => scrollToPagePoint(i, 0);
      list.append(b);
    }
  }
  box.append(list);
}

// ---------- right panel ----------

export function initRightPanel() {
  const rail = $("#rightrail");
  rail.innerHTML = TABS.map((t) => `<button class="rail-item" data-tab="${t.id}" title="${t.label}">${icon(t.icon)}<span class="rail-tip">${t.label}</span></button>`).join("");
  rail.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]")?.dataset.tab;
    if (t) (activeTab === t ? closePanel() : openPanel(t));
  });
  $("#rp-close").onclick = closePanel;
  try {
    const w = Number(localStorage.getItem("pr-right-w"));
    if (w) root.style.setProperty("--right-panel-open-w", w + "px");
  } catch {}
  initResize();
  onStateChange(() => activeTab && activeTab !== "ai" && activeTab !== "notes" && renderTab(activeTab));
}

export function openPanel(tab) {
  activeTab = tab;
  root.classList.add("rp-open");
  $$("#rightrail [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $("#rp-title").textContent = TABS.find((t) => t.id === tab).label;
  renderTab(tab);
}
export function closePanel() {
  activeTab = null;
  root.classList.remove("rp-open");
  $$("#rightrail [data-tab]").forEach((b) => b.classList.remove("on"));
}

function initResize() {
  const grip = $("#rp-resize");
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    root.classList.add("rp-resizing");
    document.body.style.userSelect = "none";
    const move = (ev) => {
      const w = Math.min(Math.max(innerWidth - ev.clientX - 56, 300), Math.min(900, innerWidth - 420));
      root.style.setProperty("--right-panel-open-w", w + "px");
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      root.classList.remove("rp-resizing");
      document.body.style.userSelect = "";
      try { localStorage.setItem("pr-right-w", parseInt(getComputedStyle(root).getPropertyValue("--right-panel-open-w"))); } catch {}
      refit();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
}

const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const empty = (iconName, text) => `<div class="empty">${icon(iconName, 28)}<p>${text}</p></div>`;

function renderTab(tab) {
  const body = $("#rp-body");
  body.dataset.tab = tab;
  if (tab === "ai") return renderAI(body);
  if (tab === "notes") return renderNotes(body);
  if (tab === "highlights") {
    const xs = [...app.state.highlights].sort((a, b) => a.page - b.page || a.y - b.y);
    body.innerHTML = xs.length ? xs.map((x) => `<div class="list-item" data-page="${x.page}" data-y="${x.y}">
        <div class="li-head"><span class="dot hl-${x.color}"></span>Page ${x.page + 1}${byline(x.by)}<span class="grow"></span><button class="icon-btn" data-del="${x.id}">${icon("trash", 14)}</button></div>
        <div class="li-quote">${esc(x.text)}</div>${x.comment ? `<div class="li-comment">${icon("message", 12)} ${esc(x.comment)}</div>` : ""}</div>`).join("")
      : empty("highlighter", "Select text and pick a color to highlight.");
  }
  if (tab === "comments") {
    const xs = app.state.highlights.filter((x) => x.comment).sort((a, b) => a.page - b.page || a.y - b.y);
    body.innerHTML = xs.length ? xs.map((x) => `<div class="list-item" data-page="${x.page}" data-y="${x.y}">
        <div class="li-head">Page ${x.page + 1} · ${fmtDate(x.mt || x.ts)}${byline(x.commentBy || x.by)}</div>
        <div class="li-quote small">${esc(x.text.slice(0, 160))}</div><div class="li-comment big">${esc(x.comment)}</div></div>`).join("")
      : empty("message", "Select text and press C to comment.");
  }
  if (tab === "explanations") {
    const xs = app.state.explanations;
    body.innerHTML = xs.length ? xs.map((x) => `<details class="list-item exp" data-page="${x.page}" data-y="${x.y}">
        <summary><div class="li-head">${x.kind === "text" ? "Text" : esc(x.kind)} · Page ${x.page + 1}<span class="grow"></span><button class="icon-btn" data-delexp="${x.id}">${icon("trash", 14)}</button></div>
        <div class="li-quote">${esc(x.quote.slice(0, 200))}</div></summary><div class="md">${md(x.answer)}</div></details>`).join("")
      : empty("lightbulb", "Select text and press E, or hover a figure and press E.");
  }
  if (tab === "citations") {
    const xs = app.state.citations;
    body.innerHTML = xs.length ? xs.map((x) => `<div class="list-item">
        <div class="li-head">${esc(x.label || "")} · cited on page ${x.page + 1}<span class="grow"></span><button class="icon-btn" data-delcite="${x.id}">${icon("trash", 14)}</button></div>
        <div class="ref-title">${esc(x.title)}</div><div class="ref-meta">${esc(x.authors || "")} ${x.year || ""}</div>
        <div class="ref-links">${x.arxiv ? `<a class="btn primary" href="/paper/${esc(x.arxiv)}" target="_blank">Read here</a>` : ""}<a class="btn ghost" target="_blank" href="${esc(x.url)}">Semantic Scholar</a></div></div>`).join("")
      : empty("quote", "Click a citation like [12] in the paper, then Save.");
  }
  body.onclick = (e) => {
    const del = e.target.closest("[data-del],[data-delexp],[data-delcite]");
    if (del) {
      e.preventDefault(); e.stopPropagation();
      if (del.dataset.del) app.state.highlights = app.state.highlights.filter((x) => x.id !== del.dataset.del);
      if (del.dataset.delexp) app.state.explanations = app.state.explanations.filter((x) => x.id !== del.dataset.delexp);
      if (del.dataset.delcite) app.state.citations = app.state.citations.filter((x) => x.id !== del.dataset.delcite);
      saveState();
      import("./app.js").then((m) => m.repaintAll("hl"));
      return;
    }
    const item = e.target.closest("[data-page]");
    if (item && !e.target.closest("a, summary .icon-btn")) scrollToPagePoint(Number(item.dataset.page), Number(item.dataset.y) || 0);
  };
}

// ---------- notes ----------

function renderNotes(body) {
  body.innerHTML = `<div class="notes">
    <div class="seg"><button data-m="edit" class="on">Write</button><button data-m="preview">Preview</button></div>
    <textarea placeholder="Notes for this paper (Markdown + $math$)…">${esc(app.state.notes || "")}</textarea>
    <div class="md notes-preview" hidden></div></div>`;
  const ta = body.querySelector("textarea"), pv = body.querySelector(".notes-preview");
  ta.oninput = () => { app.state.notes = ta.value; saveState(); };
  body.querySelector(".seg").onclick = (e) => {
    const m = e.target.dataset.m;
    if (!m) return;
    body.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
    ta.hidden = m !== "edit"; pv.hidden = m !== "preview";
    if (m === "preview") pv.innerHTML = md(ta.value) || "<p class='muted'>Nothing yet.</p>";
  };
}

// ---------- AI: summary + chat ----------

let quote = null; // { text, page }
let chatAbort = null;

export function askWithQuote(text, page) {
  quote = { text, page };
  openPanel("ai");
  setTimeout(() => $("#chat-input")?.focus(), 50);
}

function renderAI(body) {
  if (!body.querySelector(".ai")) {
    body.innerHTML = `<div class="ai">
      <div class="ai-scroll">
        <section class="summary-box"><div class="li-head">${icon("sparkles", 14)} Reading guide<span class="grow"></span><button class="btn ghost small" id="sum-btn">Generate</button></div><div class="md summary"></div></section>
        <div class="chat"></div>
      </div>
      <div class="composer">
        <div class="quote-chip" hidden></div>
        <div class="suggest"></div>
        <div class="input-row"><textarea id="chat-input" rows="1" placeholder="Ask anything about this paper…"></textarea><button class="btn primary send" title="Send (Enter)">${icon("send", 16)}</button></div>
      </div></div>`;
    body.querySelector("#sum-btn").onclick = () => runSummary(body);
    const ta = body.querySelector("#chat-input");
    ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 160) + "px"; });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(body); } });
    body.querySelector(".send").onclick = () => send(body);
    if (app.state.summary) body.querySelector(".summary").innerHTML = md(app.state.summary);
    if (app.state.summary) body.querySelector("#sum-btn").textContent = "Regenerate";
  }
  renderChat(body);
  const chip = body.querySelector(".quote-chip");
  chip.hidden = !quote;
  if (quote) {
    chip.innerHTML = `${icon("quote", 12)}<span>${esc(quote.text.slice(0, 180))}${quote.text.length > 180 ? "…" : ""}</span><button class="icon-btn">${icon("x", 12)}</button>`;
    chip.querySelector("button").onclick = () => { quote = null; chip.hidden = true; };
  }
  const sug = body.querySelector(".suggest");
  sug.innerHTML = app.state.chat.length ? "" : ["What problem does this paper solve?", "Explain the core method step by step", "What are the main results and baselines?", "What are the limitations?"].map((q) => `<button class="pill">${q}</button>`).join("");
  sug.onclick = (e) => { if (e.target.matches(".pill")) { body.querySelector("#chat-input").value = e.target.textContent; send(body); } };
}

function renderChat(body) {
  const chat = body.querySelector(".chat");
  chat.innerHTML = app.state.chat.map((m, k) => `<div class="msg ${m.role}">${m.quote ? `<blockquote class="quote small">${esc(m.quote.slice(0, 200))}</blockquote>` : ""}<div class="${m.role === "user" ? "" : "md"}" data-k="${k}">${m.role === "user" ? esc(m.text) : md(m.text)}</div></div>`).join("")
    + (app.state.chat.length ? `<button class="btn ghost small clear-chat">Clear chat</button>` : "");
  chat.querySelector(".clear-chat")?.addEventListener("click", () => { app.state.chat = []; saveState(); renderAI(body); });
}

async function ensureFullText() {
  if (app.fullTextSent) return app.fullTextSent;
  app.fullTextSent = (async () => {
    const parts = [];
    for (let i = 0; i < app.pdf.numPages; i++) parts.push(`[Page ${i + 1}]\n` + (await pageText(i)));
    await fetch(`/api/text/${app.key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: parts.join("\n\n") }) });
  })();
  return app.fullTextSent;
}
export { ensureFullText };

async function send(body) {
  const ta = body.querySelector("#chat-input");
  const q = ta.value.trim();
  if (!q) return;
  chatAbort?.abort();
  const history = app.state.chat.slice(-12).map((m) => ({ role: m.role, text: m.quote ? `About: """${m.quote}"""\n${m.text}` : m.text }));
  app.state.chat.push({ role: "user", text: q, quote: quote?.text });
  const qq = quote;
  quote = null;
  ta.value = ""; ta.style.height = "auto";
  app.state.chat.push({ role: "model", text: "" });
  renderAI(body);
  const scroll = body.querySelector(".ai-scroll");
  scroll.scrollTop = scroll.scrollHeight;
  const msg = app.state.chat.at(-1);
  const out = body.querySelector(`.chat [data-k="${app.state.chat.length - 1}"]`);
  out.parentElement.classList.add("streaming");
  out.innerHTML = `<div class="skeleton"><i></i><i style="width:70%"></i></div>`;
  chatAbort = new AbortController();
  try {
    await ensureFullText();
    msg.text = await stream("ask", { key: app.key, lang: app.settings.lang, question: q, quote: qq?.text, history }, (t) => {
      out.innerHTML = md(t);
      if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120) scroll.scrollTop = scroll.scrollHeight;
    }, { signal: chatAbort.signal });
  } catch (e) {
    if (e.name !== "AbortError") { msg.text = `⚠️ ${e.message}`; out.innerHTML = md(msg.text); }
  }
  out.parentElement.classList.remove("streaming");
  saveState();
}

async function runSummary(body) {
  const box = body.querySelector(".summary");
  const btn = body.querySelector("#sum-btn");
  btn.disabled = true;
  box.innerHTML = `<div class="skeleton"><i></i><i></i><i style="width:60%"></i></div>`;
  box.classList.add("streaming");
  await ensureFullText();
  try {
    app.state.summary = await stream("summary", { key: app.key, lang: app.settings.lang }, (t) => (box.innerHTML = md(t)));
    saveState();
  } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  box.classList.remove("streaming");
  btn.disabled = false;
  btn.textContent = "Regenerate";
}
