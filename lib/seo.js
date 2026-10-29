// Public paper pages for search engines. Signed-out visitors (and crawlers) who open /paper/<id> get
// a server-rendered overview instead of the reader: title, authors, abstract and, for featured
// papers, an AI overview (three-line summary, reading guide, key terms, FAQ) written in advance.
// /<lang>/paper/<id> is the same page in another language (zh, zh-tw, ja, ko, ar, th, vi, ...).
// The English overview is written from the paper's full text; the other languages are translated
// from it. Featured papers are a fixed list of classics plus Hugging Face's trending papers,
// refreshed by the hourly cron (refreshFeatured in core.js).
import { marked } from "marked";
import katex from "katex";

export const SITE = "https://xyznot.com";

// code → URL segment, hreflang, <html lang>, og:locale, native name, name for the model, direction.
export const LANGS = {
  en: { seg: "", hreflang: "en", html: "en", og: "en_US", name: "English", ai: "English" },
  zh: { seg: "zh", hreflang: "zh-Hans", html: "zh-CN", og: "zh_CN", name: "简体中文", ai: "Simplified Chinese" },
  "zh-TW": { seg: "zh-tw", hreflang: "zh-Hant", html: "zh-TW", og: "zh_TW", name: "繁體中文", ai: "Traditional Chinese (Taiwan usage)" },
  ja: { seg: "ja", hreflang: "ja", html: "ja", og: "ja_JP", name: "日本語", ai: "Japanese" },
  ko: { seg: "ko", hreflang: "ko", html: "ko", og: "ko_KR", name: "한국어", ai: "Korean" },
  es: { seg: "es", hreflang: "es", html: "es", og: "es_ES", name: "Español", ai: "Spanish" },
  fr: { seg: "fr", hreflang: "fr", html: "fr", og: "fr_FR", name: "Français", ai: "French" },
  de: { seg: "de", hreflang: "de", html: "de", og: "de_DE", name: "Deutsch", ai: "German" },
  pt: { seg: "pt", hreflang: "pt", html: "pt-BR", og: "pt_BR", name: "Português", ai: "Brazilian Portuguese" },
  ru: { seg: "ru", hreflang: "ru", html: "ru", og: "ru_RU", name: "Русский", ai: "Russian" },
  ar: { seg: "ar", hreflang: "ar", html: "ar", og: "ar_AR", name: "العربية", ai: "Modern Standard Arabic", rtl: true },
  th: { seg: "th", hreflang: "th", html: "th", og: "th_TH", name: "ไทย", ai: "Thai" },
  vi: { seg: "vi", hreflang: "vi", html: "vi", og: "vi_VN", name: "Tiếng Việt", ai: "Vietnamese" },
  id: { seg: "id", hreflang: "id", html: "id", og: "id_ID", name: "Bahasa Indonesia", ai: "Indonesian" },
  tr: { seg: "tr", hreflang: "tr", html: "tr", og: "tr_TR", name: "Türkçe", ai: "Turkish" },
  hi: { seg: "hi", hreflang: "hi", html: "hi", og: "hi_IN", name: "हिन्दी", ai: "Hindi" },
};
export const SEO_LANGS = Object.keys(LANGS);
export const langFromSeg = (seg) => SEO_LANGS.find((l) => l !== "en" && LANGS[l].seg === seg) || null;

// Classic papers, always featured.
export const CLASSICS = [
  "1706.03762", "1810.04805", "1512.03385", "2005.14165", "1406.2661", "1312.6114", "2006.11239", "2112.10752",
  "2010.11929", "2103.00020", "2203.02155", "2106.09685", "2201.11903", "2302.13971", "2307.09288", "2005.11401",
  "1412.6980", "1502.03167", "2001.08361", "2203.15556", "2205.14135", "2305.18290", "2312.00752", "2210.03629",
  "2304.02643", "2501.12948", "2412.19437", "1707.06347", "1312.5602", "2104.09864", "2002.05709", "2003.08934",
  "1505.04597", "2308.04079", "1409.0473", "1301.3781", "1701.06538", "2401.04088", "2407.21783", "2303.08774",
  "2212.08073", "2109.01652",
];

// ---------- prompts ----------

// The English overview, from the paper's full text (or only the abstract when there is none).
export function overviewPrompt(meta, text) {
  return {
    system: "You write public study pages for research papers. Be accurate and specific to this paper; never invent numbers. Write math as LaTeX in $...$.",
    text: `${text ? `<paper>\n${text.slice(0, 200_000)}\n</paper>` : `Title: ${meta.title}\nAbstract: ${meta.abstract}`}

Write a study page for the paper "${meta.title}". Return JSON:
{
  "title": "the original title",
  "description": "one sentence of at most 150 characters for search results: what the paper does and why it matters",
  "tldr": ["🎯 the problem it solves", "🔧 the core method", "📈 the main result, with a concrete number if the paper has one"],
  "guide": "Markdown reading guide with these ## sections: Problem and motivation; Key ideas; Method (with the key equations); Results (with the most important numbers); Limitations and open questions",
  "keywords": [{"term": "a term as the paper writes it", "definition": "one or two sentences on what it means in this paper"}],
  "faq": [{"q": "a question a reader would search for", "a": "a short answer from the paper"}]
}
Give 6 to 10 keywords and 3 to 5 FAQ entries.`,
  };
}

// Another language, translated from the English overview.
export function translatePrompt(meta, en, lang) {
  const L = LANGS[lang].ai;
  const src = { title: meta.title, description: en.description, abstract: meta.abstract, tldr: en.tldr, guide: en.guide, keywords: en.keywords, faq: en.faq };
  return {
    system: `You translate study pages about research papers into ${L}. Write natural ${L} that a researcher in that language would search for and read. Keep math ($...$ LaTeX), model, dataset and method names, and citations unchanged. Keep each keyword "term" as written (you may add the ${L} name in parentheses); translate everything else.`,
    text: `Translate every string value of this JSON into ${L}. "description" must stay under 150 characters. Keep the same keys and structure, keep the Markdown structure of "guide", keep the emoji at the start of each "tldr" line. Return only the JSON.\n\n${JSON.stringify(src)}`,
  };
}

export function validOverview(o, lang) {
  return o && typeof o === "object" && o.title && o.description && Array.isArray(o.tldr) && o.tldr.length >= 2 && o.guide
    && Array.isArray(o.keywords) && (lang === "en" || o.abstract);
}

// ---------- page text ----------

const T = {
  en: { read: "Read with translation and AI", tldr: "Summary in three lines", abstract: "Abstract", guide: "Reading guide", terms: "Key terms", faq: "Questions", original: "Original abstract (English)", papers: "Papers", trending: "Trending", classics: "Classics", note: "The overview on this page was written by AI from the paper and may contain mistakes. Read the paper for the details.", blurb: "Popular and classic papers with a short AI overview. Open any of them in the reader for full translation, explanations and chat.", indexTitle: "Papers worth reading", published: "Published", languages: "Other languages", suffix: "Summary and explanation" },
  zh: { read: "用 XYZNOT 阅读（全文翻译与 AI 讲解）", tldr: "三句话总结", abstract: "摘要", guide: "论文解读", terms: "关键术语", faq: "常见问题", original: "英文原文摘要", papers: "论文", trending: "热门", classics: "经典", note: "本页解读由 AI 根据论文生成，可能有错误；细节请以原文为准。", blurb: "热门论文与经典论文的中文解读。在阅读器中打开即可全文翻译、划词讲解、和 AI 讨论。", indexTitle: "值得读的论文", published: "发表于", languages: "其他语言", suffix: "论文解读" },
  "zh-TW": { read: "用 XYZNOT 閱讀（全文翻譯與 AI 講解）", tldr: "三句話總結", abstract: "摘要", guide: "論文解讀", terms: "關鍵術語", faq: "常見問題", original: "英文原文摘要", papers: "論文", trending: "熱門", classics: "經典", note: "本頁解讀由 AI 根據論文生成，可能有錯誤；細節請以原文為準。", blurb: "熱門論文與經典論文的中文解讀。在閱讀器中開啟即可全文翻譯、劃詞講解、與 AI 討論。", indexTitle: "值得讀的論文", published: "發表於", languages: "其他語言", suffix: "論文解讀" },
  ja: { read: "XYZNOT で読む（全文翻訳と AI 解説）", tldr: "3行まとめ", abstract: "概要", guide: "論文解説", terms: "重要用語", faq: "よくある質問", original: "英語の原文概要", papers: "論文", trending: "話題の論文", classics: "定番の論文", note: "このページの解説は AI が論文から作成したもので、誤りを含む場合があります。詳細は原文をご確認ください。", blurb: "話題の論文と定番の論文を日本語で短く解説。リーダーで開くと全文翻訳、解説、AI との対話ができます。", indexTitle: "読むべき論文", published: "公開日", languages: "他の言語", suffix: "論文解説" },
  ko: { read: "XYZNOT로 읽기 (전문 번역과 AI 해설)", tldr: "세 줄 요약", abstract: "초록", guide: "논문 해설", terms: "핵심 용어", faq: "자주 묻는 질문", original: "영어 원문 초록", papers: "논문", trending: "인기 논문", classics: "고전 논문", note: "이 페이지의 해설은 AI가 논문을 바탕으로 작성했으며 오류가 있을 수 있습니다. 자세한 내용은 원문을 확인하세요.", blurb: "인기 논문과 고전 논문을 한국어로 짧게 해설합니다. 리더에서 열면 전문 번역, 해설, AI 대화를 이용할 수 있습니다.", indexTitle: "읽어볼 만한 논문", published: "게시일", languages: "다른 언어", suffix: "논문 리뷰" },
  es: { read: "Leer con traducción e IA", tldr: "Resumen en tres líneas", abstract: "Resumen", guide: "Guía de lectura", terms: "Términos clave", faq: "Preguntas", original: "Resumen original (inglés)", papers: "Artículos", trending: "Tendencia", classics: "Clásicos", note: "La explicación de esta página la escribió una IA a partir del artículo y puede contener errores. Consulte el artículo para los detalles.", blurb: "Artículos populares y clásicos con un breve resumen hecho por IA. Ábralos en el lector para traducirlos completos, pedir explicaciones y conversar.", indexTitle: "Artículos que vale la pena leer", published: "Publicado", languages: "Otros idiomas", suffix: "Resumen y explicación" },
  fr: { read: "Lire avec traduction et IA", tldr: "Résumé en trois lignes", abstract: "Résumé", guide: "Guide de lecture", terms: "Termes clés", faq: "Questions", original: "Résumé original (anglais)", papers: "Articles", trending: "Tendances", classics: "Classiques", note: "La présentation de cette page a été rédigée par une IA à partir de l'article et peut contenir des erreurs. Consultez l'article pour les détails.", blurb: "Articles populaires et classiques avec un court résumé rédigé par IA. Ouvrez-les dans le lecteur pour une traduction complète, des explications et un chat.", indexTitle: "Articles à lire", published: "Publié le", languages: "Autres langues", suffix: "Résumé et explication" },
  de: { read: "Mit Übersetzung und KI lesen", tldr: "Zusammenfassung in drei Zeilen", abstract: "Abstract", guide: "Leseleitfaden", terms: "Schlüsselbegriffe", faq: "Fragen", original: "Original-Abstract (Englisch)", papers: "Paper", trending: "Im Trend", classics: "Klassiker", note: "Die Übersicht auf dieser Seite wurde von einer KI aus dem Paper erstellt und kann Fehler enthalten. Details stehen im Paper.", blurb: "Beliebte und klassische Paper mit einer kurzen KI-Übersicht. Im Reader geöffnet: vollständige Übersetzung, Erklärungen und Chat.", indexTitle: "Lesenswerte Paper", published: "Veröffentlicht", languages: "Andere Sprachen", suffix: "Zusammenfassung und Erklärung" },
  pt: { read: "Ler com tradução e IA", tldr: "Resumo em três linhas", abstract: "Resumo", guide: "Guia de leitura", terms: "Termos-chave", faq: "Perguntas", original: "Resumo original (inglês)", papers: "Artigos", trending: "Em alta", classics: "Clássicos", note: "A explicação desta página foi escrita por IA a partir do artigo e pode conter erros. Consulte o artigo para os detalhes.", blurb: "Artigos populares e clássicos com um breve resumo feito por IA. Abra no leitor para tradução completa, explicações e chat.", indexTitle: "Artigos que valem a leitura", published: "Publicado em", languages: "Outros idiomas", suffix: "Resumo e explicação" },
  ru: { read: "Читать с переводом и ИИ", tldr: "Кратко в трёх строках", abstract: "Аннотация", guide: "Разбор статьи", terms: "Ключевые термины", faq: "Вопросы", original: "Оригинальная аннотация (англ.)", papers: "Статьи", trending: "Популярное", classics: "Классика", note: "Обзор на этой странице написан ИИ по тексту статьи и может содержать ошибки. Подробности смотрите в самой статье.", blurb: "Популярные и классические статьи с кратким обзором от ИИ. Откройте любую в читалке для полного перевода, объяснений и чата.", indexTitle: "Статьи, которые стоит прочитать", published: "Опубликовано", languages: "Другие языки", suffix: "Краткий разбор" },
  ar: { read: "اقرأ مع الترجمة والذكاء الاصطناعي", tldr: "الملخص في ثلاثة أسطر", abstract: "الملخص", guide: "دليل القراءة", terms: "المصطلحات الرئيسية", faq: "أسئلة شائعة", original: "الملخص الأصلي (بالإنجليزية)", papers: "الأوراق البحثية", trending: "الأكثر رواجًا", classics: "أوراق كلاسيكية", note: "كتب الذكاء الاصطناعي الشرح في هذه الصفحة استنادًا إلى الورقة، وقد يحتوي على أخطاء. راجع الورقة للتفاصيل.", blurb: "أوراق بحثية رائجة وكلاسيكية مع شرح موجز بالذكاء الاصطناعي. افتح أيًّا منها في القارئ للحصول على ترجمة كاملة وشروح ومحادثة.", indexTitle: "أوراق تستحق القراءة", published: "تاريخ النشر", languages: "لغات أخرى", suffix: "ملخص وشرح" },
  th: { read: "อ่านพร้อมคำแปลและ AI", tldr: "สรุปสามบรรทัด", abstract: "บทคัดย่อ", guide: "คู่มือการอ่าน", terms: "คำศัพท์สำคัญ", faq: "คำถามที่พบบ่อย", original: "บทคัดย่อต้นฉบับ (ภาษาอังกฤษ)", papers: "งานวิจัย", trending: "กำลังมาแรง", classics: "งานวิจัยคลาสสิก", note: "คำอธิบายในหน้านี้เขียนโดย AI จากงานวิจัยและอาจมีข้อผิดพลาด โปรดอ่านต้นฉบับเพื่อดูรายละเอียด", blurb: "งานวิจัยยอดนิยมและคลาสสิกพร้อมสรุปสั้นๆ โดย AI เปิดในโปรแกรมอ่านเพื่อแปลทั้งฉบับ ขอคำอธิบาย และสนทนากับ AI", indexTitle: "งานวิจัยที่ควรอ่าน", published: "เผยแพร่", languages: "ภาษาอื่น", suffix: "สรุปและอธิบายงานวิจัย" },
  vi: { read: "Đọc với bản dịch và AI", tldr: "Tóm tắt trong ba dòng", abstract: "Tóm tắt", guide: "Hướng dẫn đọc", terms: "Thuật ngữ chính", faq: "Câu hỏi thường gặp", original: "Tóm tắt gốc (tiếng Anh)", papers: "Bài báo", trending: "Thịnh hành", classics: "Kinh điển", note: "Phần giải thích trên trang này do AI viết dựa trên bài báo và có thể có sai sót. Hãy đọc bài báo gốc để biết chi tiết.", blurb: "Các bài báo nổi bật và kinh điển kèm phần tóm tắt ngắn của AI. Mở trong trình đọc để dịch toàn văn, giải thích và trò chuyện.", indexTitle: "Bài báo đáng đọc", published: "Xuất bản", languages: "Ngôn ngữ khác", suffix: "Tóm tắt và giải thích" },
  id: { read: "Baca dengan terjemahan dan AI", tldr: "Ringkasan tiga baris", abstract: "Abstrak", guide: "Panduan membaca", terms: "Istilah kunci", faq: "Pertanyaan", original: "Abstrak asli (bahasa Inggris)", papers: "Makalah", trending: "Sedang tren", classics: "Klasik", note: "Ulasan di halaman ini ditulis oleh AI dari makalah dan mungkin mengandung kesalahan. Baca makalahnya untuk detail.", blurb: "Makalah populer dan klasik dengan ulasan singkat dari AI. Buka di pembaca untuk terjemahan lengkap, penjelasan, dan obrolan.", indexTitle: "Makalah yang layak dibaca", published: "Terbit", languages: "Bahasa lain", suffix: "Ringkasan dan penjelasan" },
  tr: { read: "Çeviri ve yapay zekâ ile oku", tldr: "Üç satırda özet", abstract: "Özet", guide: "Okuma rehberi", terms: "Temel terimler", faq: "Sorular", original: "Orijinal özet (İngilizce)", papers: "Makaleler", trending: "Gündemde", classics: "Klasikler", note: "Bu sayfadaki açıklama yapay zekâ tarafından makaleden yazılmıştır ve hata içerebilir. Ayrıntılar için makaleyi okuyun.", blurb: "Popüler ve klasik makaleler, kısa bir yapay zekâ özetiyle. Okuyucuda açarak tam çeviri, açıklama ve sohbet kullanın.", indexTitle: "Okumaya değer makaleler", published: "Yayımlanma", languages: "Diğer diller", suffix: "Özet ve açıklama" },
  hi: { read: "अनुवाद और AI के साथ पढ़ें", tldr: "तीन पंक्तियों में सारांश", abstract: "सार", guide: "पढ़ने की गाइड", terms: "मुख्य शब्द", faq: "प्रश्न", original: "मूल सार (अंग्रेज़ी)", papers: "शोध पत्र", trending: "ट्रेंडिंग", classics: "क्लासिक", note: "इस पृष्ठ की व्याख्या AI ने शोध पत्र से लिखी है और इसमें गलतियाँ हो सकती हैं। विवरण के लिए मूल शोध पत्र पढ़ें।", blurb: "लोकप्रिय और क्लासिक शोध पत्र, AI के छोटे सारांश के साथ। रीडर में खोलकर पूरा अनुवाद, व्याख्या और चैट पाएँ।", indexTitle: "पढ़ने लायक शोध पत्र", published: "प्रकाशित", languages: "अन्य भाषाएँ", suffix: "सारांश और व्याख्या" },
};

// ---------- rendering ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Markdown with KaTeX: math is pulled out before marked runs, then rendered back in (as in the reader).
function md(text, inline = false) {
  const math = [];
  const stash = (tex, display) => `\u0000${math.push({ tex, display }) - 1}\u0000`;
  const src = String(text || "")
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => stash(t, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => stash(t, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => stash(t, false))
    .replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g, (_, pre, t) => pre + stash(t, false));
  const html = inline ? marked.parseInline(src, { gfm: true }) : marked.parse(src, { gfm: true });
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    try { return katex.renderToString(math[i].tex, { displayMode: math[i].display, throwOnError: false, output: "html" }); }
    catch { return esc(math[i].tex); }
  });
}
const plain = (s) => String(s || "").replace(/\$([^$]+)\$/g, "$1").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();

export const pagePath = (key, lang) => `${lang === "en" ? "" : "/" + LANGS[lang].seg}/paper/${key}`;
const indexPath = (lang) => (lang === "en" ? "/papers" : `/${LANGS[lang].seg}/papers`);

// alternates: [[lang, path]] for every language this page exists in.
function shell({ lang, title, description, path, alternates = [], noindex = false, type = "website", extraMeta = "", jsonld = [], body }) {
  const L = LANGS[lang];
  const alt = alternates.length > 1 ? [...alternates.map(([l, p]) => [LANGS[l].hreflang, p]), ["x-default", (alternates.find(([l]) => l === "en") || alternates[0])[1]]] : [];
  return `<!doctype html>
<html lang="${L.html}"${L.rtl ? ' dir="rtl"' : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}${path}">
${alt.map(([h, p]) => `<link rel="alternate" hreflang="${h}" href="${SITE}${p}">`).join("\n")}
${noindex ? '<meta name="robots" content="noindex, follow">' : '<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">'}
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="XYZNOT">
<meta property="og:locale" content="${L.og}">
${alternates.filter(([l]) => l !== lang).map(([l]) => `<meta property="og:locale:alternate" content="${LANGS[l].og}">`).join("\n")}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${SITE}${path}">
<meta property="og:image" content="${SITE}/assets/logo-512.png">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
${extraMeta}
<link rel="icon" href="/assets/mark.svg" type="image/svg+xml">
<link rel="icon" href="/assets/logo-512.png" type="image/png" sizes="512x512">
<link rel="apple-touch-icon" href="/assets/logo-512.png">
<link rel="stylesheet" href="/assets/fonts.css">
<link rel="stylesheet" href="/vendor/katex/katex.min.css">
<link rel="stylesheet" href="/css/paper-page.css">
${jsonld.map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, "\\u003c")}</script>`).join("\n")}
</head>
<body>
<header class="top"><a class="wordmark" href="${lang === "en" ? "/" : indexPath(lang)}">XYZNOT</a><nav><a href="${indexPath(lang)}">${T[lang].papers}</a></nav></header>
${body}
${alternates.length > 1 ? `<nav class="langs" aria-label="${esc(T[lang].languages)}"><span>${T[lang].languages}:</span>${alternates.map(([l, p]) => l === lang ? `<b lang="${LANGS[l].html}">${LANGS[l].name}</b>` : `<a href="${p}" hreflang="${LANGS[l].hreflang}" lang="${LANGS[l].html}">${LANGS[l].name}</a>`).join("")}</nav>` : ""}
<footer><a href="/">XYZNOT</a><a href="${indexPath(lang)}">${T[lang].papers}</a><a href="/privacy.html">Privacy</a><a href="/terms.html">Terms</a></footer>
</body>
</html>`;
}

// meta: arXiv metadata. ov: the overview in `lang`, or null (abstract only; not indexed).
// langs: languages that have an overview for this paper.
export function paperPage({ key, meta, ov, lang, langs }) {
  const t = T[lang], L = LANGS[lang];
  const id = meta.id || key;
  const path = pagePath(key, lang);
  const local = ov && lang !== "en" && ov.title && ov.title !== meta.title ? ov.title : "";
  const cjk = /^(zh|ja)/.test(lang);
  const shown = local ? `${local}${cjk ? "（" : " ("}${meta.title}${cjk ? "）" : ")"}` : meta.title;
  const title = ov ? `${shown} – ${t.suffix} | XYZNOT` : `${meta.title} | XYZNOT`;
  const description = ov?.description || plain(meta.abstract).slice(0, 155);
  const authors = meta.authors || [];
  const byline = authors.slice(0, 12).join(", ") + (authors.length > 12 ? " et al." : "");
  const date = (meta.published || "").slice(0, 10);
  const read = `/?signin=1&redirect=${encodeURIComponent("/paper/" + key)}`;
  const alternates = ov ? langs.map((l) => [l, pagePath(key, l)]) : [];
  // Google Scholar reads citation_* tags; they describe the paper, not this page.
  const extraMeta = [
    ["citation_title", meta.title], ...authors.slice(0, 50).map((a) => ["citation_author", a]),
    date && ["citation_publication_date", date.replace(/-/g, "/")], ["citation_arxiv_id", id],
    ["citation_pdf_url", `https://arxiv.org/pdf/${id}`], ["citation_abstract_html_url", `https://arxiv.org/abs/${id}`],
    ov && ["keywords", ov.keywords.map((k) => k.term).join(", ")],
  ].filter(Boolean).map(([n, c]) => `<meta name="${n}" content="${esc(c)}">`).join("\n")
    + (date ? `\n<meta property="article:published_time" content="${esc(meta.published)}">` : "");
  const jsonld = [{
    "@context": "https://schema.org", "@type": "ScholarlyArticle",
    headline: (local || meta.title).slice(0, 110), name: meta.title, ...(local ? { alternateName: local } : {}),
    url: SITE + path, mainEntityOfPage: SITE + path, sameAs: [`https://arxiv.org/abs/${id}`], identifier: `arXiv:${id}`,
    author: authors.slice(0, 30).map((name) => ({ "@type": "Person", name })),
    ...(date ? { datePublished: date } : {}), abstract: meta.abstract, inLanguage: L.hreflang,
    ...(meta.categories?.length ? { about: meta.categories.slice(0, 4) } : {}),
    ...(ov ? { description: ov.description, keywords: ov.keywords.map((k) => k.term).join(", "), dateModified: new Date(ov.generated).toISOString().slice(0, 10) } : {}),
    publisher: { "@type": "Organization", name: "XYZNOT", url: SITE },
  }, {
    "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "XYZNOT", item: SITE + "/" },
      { "@type": "ListItem", position: 2, name: t.papers, item: SITE + indexPath(lang) },
      { "@type": "ListItem", position: 3, name: local || meta.title, item: SITE + path },
    ],
  }];
  const body = `<main class="paper">
  <article>
    <p class="crumb"><a href="${indexPath(lang)}">${t.papers}</a> · arXiv ${esc(id)}</p>
    <h1>${esc(local || meta.title)}</h1>
    ${local ? `<p class="orig-title" lang="en" dir="ltr">${esc(meta.title)}</p>` : ""}
    <p class="byline" lang="en" dir="ltr">${esc(byline)}</p>
    <p class="facts">${date ? `<span>${t.published} <time datetime="${esc(date)}">${esc(date)}</time></span>` : ""}${(meta.categories || []).slice(0, 4).map((c) => `<span class="tag" dir="ltr">${esc(c)}</span>`).join("")}
      <a href="https://arxiv.org/abs/${esc(id)}" rel="nofollow">arXiv</a><a href="https://arxiv.org/pdf/${esc(id)}" rel="nofollow">PDF</a></p>
    <p><a class="cta" href="${esc(read)}">${t.read} <span aria-hidden="true">${L.rtl ? "←" : "→"}</span></a></p>
    ${ov ? `<section><h2>${t.tldr}</h2><ol class="tldr">${ov.tldr.slice(0, 3).map((x) => `<li>${md(x, true)}</li>`).join("")}</ol></section>` : ""}
    <section><h2>${t.abstract}</h2>
      ${lang !== "en" && ov?.abstract ? `<div class="abstract">${md(ov.abstract)}</div><details><summary>${t.original}</summary><div class="abstract" lang="en" dir="ltr">${md(meta.abstract)}</div></details>` : `<div class="abstract" lang="en" dir="ltr">${md(meta.abstract)}</div>`}
    </section>
    ${ov ? `<section class="guide"><h2>${t.guide}</h2>${md(ov.guide).replace(/<h[12]/g, "<h3").replace(/<\/h[12]>/g, "</h3>")}</section>
    <section><h2>${t.terms}</h2><dl class="terms">${ov.keywords.slice(0, 12).map((k) => `<dt>${esc(k.term)}</dt><dd>${md(k.definition, true)}</dd>`).join("")}</dl></section>
    ${ov.faq?.length ? `<section><h2>${t.faq}</h2>${ov.faq.slice(0, 6).map((f) => `<details class="faq"><summary>${esc(f.q)}</summary>${md(f.a)}</details>`).join("")}</section>` : ""}
    <p class="note">${t.note}</p>` : ""}
    <p><a class="cta" href="${esc(read)}">${t.read} <span aria-hidden="true">${L.rtl ? "←" : "→"}</span></a></p>
  </article>
</main>`;
  return shell({ lang, title, description, path, alternates, noindex: !ov, type: "article", extraMeta, jsonld, body });
}

// papers: [{ key, source, added, title, local, description }] featured papers with an overview in `lang`.
export function indexPage({ lang, papers }) {
  const t = T[lang];
  const item = (p) => `<li><a href="${pagePath(p.key, lang)}"><span class="i-title">${esc(p.local || p.title)}</span>${p.local && p.local !== p.title ? `<span class="i-orig" lang="en" dir="ltr">${esc(p.title)}</span>` : ""}<span class="i-desc">${esc(p.description || "")}</span></a></li>`;
  const trending = papers.filter((p) => p.source === "trending").sort((a, b) => b.added - a.added);
  const classics = papers.filter((p) => p.source === "classic");
  const body = `<main class="paper index">
  <h1>${t.indexTitle}</h1>
  <p class="byline">${t.blurb}</p>
  ${trending.length ? `<section><h2>${t.trending}</h2><ul class="list">${trending.map(item).join("")}</ul></section>` : ""}
  ${classics.length ? `<section><h2>${t.classics}</h2><ul class="list">${classics.map(item).join("")}</ul></section>` : ""}
</main>`;
  const jsonld = [{
    "@context": "https://schema.org", "@type": "CollectionPage", name: t.indexTitle, description: t.blurb, url: SITE + indexPath(lang), inLanguage: LANGS[lang].hreflang,
    mainEntity: { "@type": "ItemList", itemListElement: [...trending, ...classics].slice(0, 100).map((p, i) => ({ "@type": "ListItem", position: i + 1, url: SITE + pagePath(p.key, lang), name: p.local || p.title })) },
  }];
  return shell({ lang, title: `${t.indexTitle} | XYZNOT`, description: t.blurb, path: indexPath(lang), alternates: SEO_LANGS.map((l) => [l, indexPath(l)]), jsonld, body });
}

export const sitemapIndex = () => `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${SEO_LANGS.map((l) => `<sitemap><loc>${SITE}/sitemap-${l}.xml</loc></sitemap>`).join("\n")}
</sitemapindex>
`;

// The pages of one language. papers: [{ key, langs: { <lang>: generatedAt } }]. Each URL lists its
// language versions (hreflang), as Google recommends for multilingual sitemaps.
export function sitemap(papers, lang) {
  const links = (pairs) => pairs.map(([l, p]) => `<xhtml:link rel="alternate" hreflang="${LANGS[l].hreflang}" href="${SITE}${p}"/>`).join("");
  const url = (loc, ms, pairs = []) => `<url><loc>${SITE}${loc}</loc>${ms ? `<lastmod>${new Date(ms).toISOString().slice(0, 10)}</lastmod>` : ""}${links(pairs)}</url>`;
  const idx = SEO_LANGS.map((l) => [l, indexPath(l)]);
  const urls = [...(lang === "en" ? [url("/")] : []), url(indexPath(lang), 0, idx)];
  for (const p of papers) {
    if (!p.langs?.[lang]) continue;
    const pairs = SEO_LANGS.filter((l) => p.langs[l]).map((l) => [l, pagePath(p.key, l)]);
    urls.push(url(pagePath(p.key, lang), p.langs[lang], pairs));
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`;
}
