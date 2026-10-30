// Theme: system (follows the OS, the default), light or dark. Saved in localStorage "pr-theme";
// no value means system. Each page sets data-theme in <head> before first paint; base.css does
// the rest.
import { icon } from "./util.js";

const ORDER = ["system", "light", "dark"];
const LABEL = { system: "System theme", light: "Light theme", dark: "Dark theme" };
const ICON = { system: "monitor", light: "sun", dark: "moon" };

export function getTheme() {
  try { return ORDER.includes(localStorage.getItem("pr-theme")) ? localStorage.getItem("pr-theme") : "system"; } catch { return "system"; }
}

export function setTheme(t) {
  const root = document.documentElement;
  if (t === "system") delete root.dataset.theme; else root.dataset.theme = t;
  try { if (t === "system") localStorage.removeItem("pr-theme"); else localStorage.setItem("pr-theme", t); } catch {}
}

// A button that steps through system → light → dark and shows the current choice.
export function mountThemeButton(btn, { label = false } = {}) {
  const paint = () => {
    const t = getTheme();
    btn.innerHTML = icon(ICON[t]) + (label ? `<span class="rail-label">${LABEL[t]}</span>` : "");
    btn.title = `${LABEL[t]} (click to change)`;
    btn.setAttribute("aria-label", btn.title);
  };
  btn.addEventListener("click", () => { setTheme(ORDER[(ORDER.indexOf(getTheme()) + 1) % ORDER.length]); paint(); });
  paint();
}
