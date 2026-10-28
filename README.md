# XYZNOT — paper reader

A paper reader for arXiv papers and any PDF. PDF.js renders the paper;
our overlay layers add sentence hover, highlights, in-place citation cards, figure explanations and an
AI panel. Gemini powers the AI features.

```sh
npm install
npm start            # http://localhost:5178
```

Open a paper by pasting an arXiv link on the home page, or go to `localhost:5178/abs/<id>`.

## Gemini key

The server reads `GEMINI_API_KEY` from the environment, then from `./.env`, `~/.gemini-video.env`,
`~/.env.impo-gemini` or `~/.env` (first match). Models: `GEMINI_MODEL` (default `gemini-3.8-flash`)
for explanations and chat, `GEMINI_FAST_MODEL` (default `gemini-3.5-flash-lite`) for translation,
LaTeX and auto-highlight.

## Deploy (Cloudflare)

`npm run deploy` builds `dist/` (public/ + vendor files) and deploys the Worker `paper-reader` to
`https://xyznot.com` (`paper.xyznot.com` 301-redirects there). The Worker runs the same routes as the local server (`lib/core.js`).

| Piece | What |
|---|---|
| Clerk app `xyznot.com` (production instance, `clerk.xyznot.com`) | Sign-in. The Worker verifies the session JWT against the instance JWKS (`lib/auth.js`). |
| Clerk Organizations | Teams. With an organization active (switcher on the library page), the library, uploads, highlights, comments, explanations and saved citations belong to the team; notes, chat and reading position stay per member (`users/<org>/<key>.members/<uid>.json`). Saves merge per item (`lib/state.js`); open readers pull teammates' changes every 15 s. |
| Clerk Billing | A one-member team is free; teams of two or more need the organization plan `TEAM_PLAN` (`team`: $10 per member per month, seat-based, up to 20 members), else 402 and the team pricing table. Member counts come from the Backend API (Worker secret `CLERK_SECRET_KEY`). `PAID_PLAN` empty: AI is free for everyone (personal plan is free). Set it to a plan slug to gate `/api/ai/*` again; `FREE_USERS` lists exempt Clerk user ids. |
| R2 bucket `paper-reader` | Shared: `pdfs/`, `uploads/`, `meta/`, `text/`, `cache/`. Per user: `users/<uid>/<key>.json` = reading state of one paper. |
| D1 database `paper-reader` | `library` table: which papers each user has, with title, last opened, page, highlight count (`migrations/`). |
| Worker secret | `GEMINI_API_KEY` (`wrangler secret put GEMINI_API_KEY`). |
| Worker secret | `QUERIT_API_KEY`: home page paper search (Querit, restricted to arXiv and open proceedings sites; 20 searches/min per IP via the `SEARCH_LIMIT` rate limiter). |

Uploaded PDFs are only readable by users who uploaded them; arXiv papers are open to all signed-in users.
Locally, `npm start` runs without sign-in as user `local`; set `CLERK_PUBLISHABLE_KEY` to require Clerk.

## Interactions

| Where | What |
|---|---|
| Select text | Popover menu: Explain `E`, 5 highlight colors `H`, Translate `T`, Comment `C`, Ask AI `Enter`, Copy, `Esc` |
| Click a highlight | Change color, comment, explain, ask, copy, delete |
| Click `[12]` | Card with the parsed reference + Semantic Scholar / OpenAlex match, "Read here" for arXiv papers |
| Click a figure/section link | Rendered preview of the target region; "Go to" jumps |
| Hover a figure / table / equation | Dashed box; Explain `E`, Copy image `C`, Copy LaTeX (equations) |
| Hover text | Sentence under the cursor is lit (toggle in Settings) |
| Auto Highlight | Marks novelty / method / result sentences |
| Translate | Side-by-side column per page; hovering either side lights the matching sentence on the other |
| Left rail | Expands on hover; Home, Library, Upload PDF, Outline, Paper info, Dark mode |
| Right rail | With AI (reading guide + chat over the full paper), Highlights, Explanations, Comments, Notes, Citations; drag the left edge to resize |
| Zoom | Presets, ⌘+/⌘−/⌘0, ctrl/pinch wheel; overlays and cards stay anchored |

## Layout

```
lib/core.js          Routes: arXiv PDF + metadata cache, Gemini proxy, Scholar search, per-paper state
lib/auth.js          Clerk session JWT verification (user, active organization)
lib/state.js         per-item merge of shared reading state for teams
server.js            Local Node server: disk stores under data/ + static files
worker/index.js      Cloudflare Worker: R2 + D1 stores, Clerk config, static assets
migrations/          D1 schema
public/js/auth.js    Clerk sign-in, token on /api requests, Pro paywall
public/js/ai.js      With AI panel (keywords, three-line summary, reading guide, discussions with reference papers), Quiz, Related papers
public/js/extras.js  export (PDF, Markdown, print) and the Personalize AI dialog
lib/prompts.js       Prompt for every AI task
public/js/app.js     Shared context, page-fraction geometry, overlay layers, anchored cards
public/js/sentences.js   Text layer → sentences (Range rects), hover state, auto highlight
public/js/selection.js   Selection popover, highlights, comments, explain/translate cards
public/js/citations.js   Internal link interception → citation and preview cards
public/js/figures.js     Gemini layout detection → figure/table/equation hover tools
public/js/panels.js      Left rail, outline, right panel tabs, chat, notes
public/js/translate.js   Translation column with <|#n|> sentence markers
data/                PDFs, metadata, AI cache and user state (git-ignored)
```
