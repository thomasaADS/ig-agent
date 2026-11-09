# Changelog

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
