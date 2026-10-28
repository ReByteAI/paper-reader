// Modal dialogs in place of window.confirm / window.prompt (styles: dialog.dialog in base.css).
// Esc, the backdrop and Cancel count as cancel. Results come from the submit/cancel handlers
// directly rather than the dialog "close" event, which some Chrome builds do not dispatch.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Shows a dialog whose content is a <form>. Resolves with onSubmit() on submit, `cancelValue` otherwise.
function openDialog(html, focusSel, onSubmit, cancelValue) {
  const dlg = document.createElement("dialog");
  dlg.className = "dialog";
  dlg.innerHTML = html;
  document.body.append(dlg);
  return new Promise((resolve) => {
    const finish = (value) => { dlg.close(); dlg.remove(); resolve(value); };
    dlg.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); finish(onSubmit(dlg)); });
    dlg.querySelector("[data-cancel]").addEventListener("click", () => finish(cancelValue));
    dlg.addEventListener("click", (e) => { if (e.target === dlg) finish(cancelValue); }); // backdrop
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(cancelValue); }); // Esc
    dlg.showModal();
    dlg.querySelector(focusSel)?.focus();
  });
}

// confirmDialog({ title, description, confirmLabel, destructive }) → Promise<boolean>
export function confirmDialog({ title, description = "", confirmLabel = "Continue", destructive = false }) {
  return openDialog(`<form>
    <h2>${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ""}
    <div class="actions"><button class="btn" type="button" data-cancel>Cancel</button>
    <button class="btn ${destructive ? "destructive" : "primary"}">${esc(confirmLabel)}</button></div></form>`,
  "button:not([data-cancel])", () => true, false);
}

// promptDialog({ title, description, value, placeholder, confirmLabel }) → Promise<string | null>
export function promptDialog({ title, description = "", value = "", placeholder = "", confirmLabel = "Save" }) {
  const p = openDialog(`<form>
    <h2>${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ""}
    <input class="input" name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">
    <div class="actions"><button class="btn" type="button" data-cancel>Cancel</button>
    <button class="btn primary">${esc(confirmLabel)}</button></div></form>`,
  "input", (dlg) => dlg.querySelector("input").value.trim(), null);
  document.querySelector("dialog.dialog:last-of-type input")?.select();
  return p;
}
