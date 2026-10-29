// Typeface for translated text (inline boxes and the side column): a serif that matches the
// paper's own type, one family per script, loaded from Google Fonts only for the language in use.
// Google Fonts slices CJK fonts by unicode-range, so only the characters on screen are fetched.
const FAMILY = {
  zh: "Noto Serif SC", "zh-TW": "Noto Serif TC", ja: "Noto Serif JP", ko: "Noto Serif KR",
  ar: "Noto Naskh Arabic", fa: "Vazirmatn", he: "Noto Serif Hebrew", hi: "Noto Serif Devanagari",
  bn: "Noto Serif Bengali", th: "Noto Serif Thai",
};
const LATIN = "Source Serif 4"; // Latin, Cyrillic and Vietnamese (all other languages)
const loaded = new Set();

// Sets --tr-font and resolves when the font is ready, so boxes can be measured with it.
export function useTranslationFont(lang) {
  const family = FAMILY[lang] || LATIN;
  document.documentElement.style.setProperty("--tr-font", `"${family}", "${LATIN}"`);
  for (const f of new Set([family, LATIN])) {
    if (loaded.has(f)) continue;
    loaded.add(f);
    document.head.append(Object.assign(document.createElement("link"), {
      rel: "stylesheet", href: `https://fonts.googleapis.com/css2?family=${f.replace(/ /g, "+")}:wght@400;600&display=swap`,
    }));
  }
  // A sample in the script makes the browser fetch the right slice.
  const sample = { zh: "中文", "zh-TW": "中文", ja: "日本語", ko: "한국어", ar: "عربي", fa: "فارسی", he: "עברית", hi: "हिन्दी", bn: "বাংলা", th: "ไทย" }[lang] || "Aa";
  return document.fonts.load(`16px "${family}"`, sample).catch(() => {});
}
