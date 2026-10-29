// Translation on/off and layout. Both layouts translate paragraph blocks (inline.js): inline
// covers the original page, side by side covers a copy of the page next to it.
import { app, repaint } from "./app.js";
import { inlineOn, sideOn, translateBlocks, resetInline } from "./inline.js";
import { useTranslationFont } from "./fonts.js";

// regenerate: retranslate a page the reader marked as wrong (server skips the cache).
export const translatePage = (i, { regenerate = false } = {}) => translateBlocks(i, { regenerate });

// Boxes are sized with the font, so they are fitted again once it has loaded.
function loadFont() {
  if (app.settings.translate) useTranslationFont(app.settings.lang).then(() => { for (let i = 0; i < app.pages.length; i++) repaint(i, "inl"); });
}
loadFont();

export function setTranslate(on, layout = app.settings.trLayout) {
  Object.assign(app.settings, { translate: on, trLayout: layout });
  loadFont();
  document.documentElement.classList.toggle("tr-on", sideOn());
  document.documentElement.classList.toggle("inl-on", inlineOn());
  for (let i = 0; i < (app.pdf?.numPages || 0); i++) repaint(i, "inl");
}

// Language or model changed: translate again.
export function resetTranslations() {
  loadFont();
  for (let i = 0; i < app.pages.length; i++) if (app.pages[i]) resetInline(i);
}
