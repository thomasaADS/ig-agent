# Changelog

## 1.5.1 - 2026-11-10

### Changed
- The dashboard assistant is now called **VEGA** (was NOVA), and the name is
  configurable with `ASSISTANT_NAME`. Entries below still say NOVA where they
  describe that release.

## 1.5.0 - 2026-11-10

### Added
- **NOVA**, an assistant inside the dashboard (`assistant.js`, floating orb
  -> chat panel). It answers questions about the account through eight
  read-only tools (overview, pending drafts, leads, one conversation, day
  stats, trends, campaigns, content) and can draft text in the owner's voice.
  It has no tool that sends, approves, publishes or edits, so the dashboard
  stays read-only. Bounded tool loop (6 model calls), input and history caps,
  30 questions per 10 minutes, stranger text treated as data.
  Endpoint: `POST /dash/<secret>/assistant`.

### Changed
- Dashboard redesigned again, now futuristic: dark glass panels over a
  generated aurora background, holographic gradient accents, an orb with a
  level ring in the hero, glass-orb avatars, bundled Rubik font (OFL).
  Replaces the 1.3/1.4 minimalist look. Same data and tabs.
- Artwork regenerated with Higgsfield (background, orb, empty state).

### Verified
- `npm test` 59/59 (4 new assistant tests with a scripted model; one timing
  flake in an older auto-send test fixed).
- Rendered in Chromium at 1360px and 390px with seeded demo data: no console
  errors, no failed requests, no horizontal overflow. The chat was exercised
  in the browser against a canned reply - NOVA has not yet answered through
  the real Anthropic API in this environment (no key here).

## 1.4.0 - 2026-11-10

### Changed
- Dashboard artwork generated with Higgsfield and bundled in `src/assets/`
  (about 110 KB in total): a header illustration in light and dark variants,
  an app icon / favicon, and an empty-state illustration. Served from
  `/dash/<secret>/assets/` behind the same secret; CSP now allows `img-src
  'self'`.
- One warm accent colour taken from the artwork for the active tab, badges
  and the progress line. Layout and data are unchanged; still read-only.

### Verified
- `npm test` 55/55; rendered in Chromium in light and dark mode at 1280px and
  390px, plus a fresh install with no data: no failed requests, no console
  errors, no horizontal overflow.

## 1.3.0 - 2026-11-10

### Changed
- Dashboard restyled to a minimalist look at the owner's request: light
  background, hairline dividers instead of panels, one text colour, colour
  used only as a signal (red = waiting for a reply), no gradients or emoji in
  the chrome. Follows the device's light/dark setting.
- Level, streak and points are now one quiet line in the header.
- Same data, tabs, CRM board and drawer as 1.2.0; still read-only.

### Verified
- `npm test` 55/55; rendered in Chromium at 1280px and 390px with seeded demo
  data: no console errors, no horizontal overflow.

## 1.2.0 - 2026-11-10

### Changed
- Dashboard reorganised into three tabs: overview, leads (CRM), content and
  campaigns.
- New CRM view: funnel summary, pipeline board by stage (new / interested /
  customer / VIP, optional spam column), lead cards with last message, tags,
  notes marker and reply-window timer, people waiting for a reply highlighted
  and sorted first, live search and a "waiting only" filter.
- Lead drawer: full conversation as chat bubbles (AI-sent replies marked),
  the owner's notes, message counts, reply window, and any pending draft.
  Served by a new read-only `/dash/<secret>/thread/<id>.json`.
- Still read-only: stage, tags and notes are changed through Claude
  (`update_lead`).

### Verified
- `npm test` 55/55; rendered in Chromium at 1280px and 390px with seeded demo
  data: no console errors, no horizontal overflow, search keeps focus across
  refreshes, drawer opens and closes with Esc.

## 1.1.0 - 2026-11-10

Ideas taken from similar open-source projects (OpenReply, Pilot,
AleemHaider/instagram-mcp), reimplemented here - no code was copied.

### Added
- **Comment -> DM campaigns** (`campaigns.js`): keyword in a comment triggers
  one private reply with a fixed, owner-approved text and a click-tracked link
  (`/l/<token>`). Draft until approved by a Telegram button (MCP cannot
  activate an unapproved campaign), once per person, hourly cap with a queue,
  7-day limit, no retries, per-campaign pause, covered by `/pause`.
- **Read-only dashboard** at `/dash/<DASHBOARD_SECRET>/`: pending drafts,
  conversations, 14-day chart, campaigns with CTR, scheduled posts, account
  insights, health, plus level / streak / daily missions computed from real
  activity. No actions, strict CSP, off when the secret is empty.
- **Insights**: `instagram_business_manage_insights` scope, daily snapshots,
  `account_insights`, `media_insights`, `daily_summary`; daily Telegram
  summary and `/today`.
- **Lead card**: stage, tags, notes per thread (`update_lead`), passed to the
  model as trusted owner notes; `spam` silences a thread.
- `hide_comment`, `publish_limit`, and a publishing-quota check before publish.
- `/campaigns` command; GitHub Actions workflow running `npm test`.
- MCP tools: 25 -> 35. Tests: 44 -> 55.

### Changed
- This reverses two items the original brief listed as out of scope, at the
  owner's request: a web dashboard, and automated DMs (limited to people who
  commented a campaign keyword).

### Verified / not verified
- `npm test` 55/55 with mocked network; dashboard rendered in Chromium at
  desktop and phone widths with seeded demo data (no console errors, no
  horizontal overflow).
- Private-reply and insights request shapes were checked against Meta's
  documentation only. **Still nothing has run against the real Instagram
  API**; items 7-8 were added to `docs/api-validation.md`.

## 1.0.0 - 2026-11-09

First complete build. The brief described finishing an existing codebase; that
code was not available, so everything was written from scratch to the same
stack and file layout (plain JS ESM, Express 4, better-sqlite3, Anthropic SDK,
MCP SDK stateless Streamable HTTP, Telegram long polling, Docker + Caddy).
Extra files beyond the brief's table: `config.js`, `store.js`, `media.js`,
`scheduler.js`. Dependencies beyond the brief: `zod` (required by the MCP SDK
for tool schemas) and `sharp` (named in the brief).

### What is in it
- **Phase 1 (correctness):** single-use, constant-time, 10-minute OAuth state;
  atomic `pending -> sending` claim on every send; polling watermark taken
  before the fetch minus 60s; debounce recovery on boot; drafts superseded and
  cards closed when the owner answers himself; id-independent dedupe
  (same thread/direction/text within 5s from another source) and thread keys
  normalised by username; 24h window enforced with Hebrew errors, `expired`
  status and remaining time on the card; regenerate with previous draft and
  `/re` instruction; non-text messages stored with a `type` and placeholder;
  caption cache, pagination, stranger-proof `/start`, error-190 alert, retry
  with backoff on 429/5xx.
- **Phase 2 (media):** Telegram as the upload channel (photo, video, album),
  `list_media`, `upload_from_url` (SSRF-guarded), `generate_caption`, sharp
  normalisation (JPEG, EXIF stripped, <8MB), aspect-ratio and ffprobe checks,
  7/30-day cleanup.
- **Phase 3 (scheduling):** `scheduled_posts`, one-minute tick, two retries then
  alert, `schedule_post` / `list_scheduled` / `cancel_scheduled` / `reschedule`
  in Asia/Jerusalem, `/pending` `/queue` `/pause` `/resume` `/status`.
- **Phase 4 (voice):** `export_my_replies`, draft outcome log with both
  versions, `style_report`, XML-wrapped untrusted input, auto-send guardrails.
- **Phase 5 (ops):** 44 `node:test` tests, non-root Docker image with
  HEALTHCHECK and `npm ci`, graceful SIGTERM, extended `/health`, poll-failure
  alert, nightly `VACUUM INTO` backup (keep 7), Hebrew README with a
  troubleshooting table.

### Verified
- `npm test`: 44/44 passing, all network calls mocked.
- Server boots with dummy `.env.example` values; `/health`, webhook challenge,
  signature rejection, MCP `tools/list` and `tools/call` checked by hand.
- Video validation checked against real ffprobe with a valid MP4 and a WebM.
- `GRAPH_VERSION` default `v23.0` is listed by Meta as available until
  2027-10-08 (latest is v26.0); no bump needed.

### NOT verified - nothing has touched the real Instagram API
Phase 0 could not be run (no app credentials or account in the build
environment). Every item in `docs/api-validation.md` is still open. In
particular, unconfirmed assumptions are: the shape of the conversations /
messages responses, whether polling returns non-tester conversations in
Development mode, which secret signs webhooks, whether webhook and polling ids
match, and the exact publish parameters. The code is written defensively
around each of these (see that document), but none has been observed live.
The Docker image has not been built in this environment either.
