# Instagram API validation (Phase 0)

**Status: not started.** Nothing in this project has run against the real
Instagram API yet. The biggest risk is the Meta side, not the code - work
through this list with the app in Development mode before trusting the agent,
and write the result under each item.

Setup: fill `.env`, `docker compose up -d --build`, set the webhook and
redirect URI in the Meta app, open `/auth/login`.

Legend: ☐ open · ✅ confirmed · ❌ failed (write what happened)

---

## 1. OAuth ☐
- Open `https://<DOMAIN>/auth/login`, approve.
- Expected: Telegram says "אינסטגרם חובר", `/health` shows `"connected": true`
  and `token_days_remaining` around 59.
- Result:

## 2. Polling returns real conversations ☐  ← decides whether polling is a real fallback
- Have someone who is **not** an app tester DM the account. In Claude run `sync`,
  then `list_threads` / `get_thread`.
- Expected: the conversation and its messages appear.
- **If they do not appear: stop.** Polling cannot be the fallback the README
  describes while the app is in Development mode; the README must say so and
  the agent depends on webhooks (or on App Review) alone.
- Also note: does `GET /{conversation}?fields=messages{...}` return full
  message fields, or only `id` + `created_time`? (The code falls back to one
  request per message in the second case - check the logs for rate limits.)
- Result:

## 3. Webhook delivery and signature ☐
- Which events arrive in Development mode: DMs from testers only, or from anyone?
  Comments? Reactions? Echoes of messages sent from the Instagram app?
- Which secret signs `x-hub-signature-256`? After the first accepted webhook,
  look at the `settings` table: `webhook_signed_with` is `instagram_app_secret`
  or `meta_app_secret`.
  `sqlite3 data/agent.db "select * from settings where key='webhook_signed_with'"`
- If every webhook is rejected with 401, set `META_APP_SECRET` and retry.
- Result:

## 4. ID consistency ☐
After one conversation has been seen by **both** the webhook and a `sync`:

```sql
-- more than one row per person = the ids differ between webhook and polling
select id, username from threads;
-- the same text twice in one thread within seconds = message ids differ
select thread_id, text, count(*), group_concat(source) from messages
group by thread_id, text having count(*) > 1;
```

- Does webhook `sender.id` equal `participants[].id` from the conversations API?
- Does webhook `message.mid` equal the polled message `id`?
- The code already assumes the worst: threads are matched by username when ids
  differ, and a message with the same thread/direction/text within 5 seconds
  from a different source is treated as a duplicate. If this section shows
  duplicates anyway, that window or the matching needs adjusting.
- Result:

## 5. Writes ☐
- Reply to one DM inside the 24h window (approve a draft in Telegram).
- Reply to one comment.
- Publish one image (send a photo to the bot, tap `פוסט`).
- Also worth trying: a story, a reel, a carousel; a send outside the 24h window
  (must be refused by the agent before Instagram is called).
- Result:

## 6. Graph API version ✅ (checked 2026-11-09, documentation only)
- `GRAPH_VERSION` defaults to `v23.0`. Meta's version table lists v23.0 as
  available until 2027-10-08; the latest is v26.0. No bump needed now.
- Still to confirm live: that `graph.instagram.com/v23.0` answers for this app.
- Result:

---

## Other assumptions worth a look while you are there
- `Authorization: Bearer` is used instead of `?access_token=` on all Graph
  calls (keeps tokens out of URLs and logs). Confirm no endpoint rejects it.
- `POST /me/messages`, `/me/media`, `/me/media_publish` are used with `me`
  rather than the numeric account id.
- Do reactions open or extend the 24h window? The agent assumes they do not.
- Comment webhooks: is `entry.time` in seconds (assumed) and is `parent_id`
  present on replies?

---

## 7. Insights ☐ (added in 1.1.0)
- Requires the `instagram_business_manage_insights` permission on the app and a
  fresh login. Run `account_insights` and `/today`.
- Which account metrics does this account actually return? The code asks for
  reach, views, accounts_engaged, total_interactions, likes, comments, shares,
  saves, profile_links_taps and silently drops the ones Instagram rejects.
- Does `GET /me?fields=followers_count` work (follower history depends on it)?
- Does `GET /me/content_publishing_limit` return `quota_usage` / `config.quota_total`?
- Result:

## 8. Comment -> DM campaigns ☐ (added in 1.1.0)
- Create a campaign, approve it in Telegram, comment the keyword from a second
  account. Expected: one DM with the approved text; `/l/<token>` redirects and
  the click shows in `list_campaigns`.
- Confirm `POST /me/messages` with `recipient.comment_id` works with the
  Instagram Login token (documented as needing `instagram_business_manage_comments`).
- In Development mode, do private replies reach non-tester accounts?
- Does the optional public reply post correctly under the comment?
- `hide_comment`: confirm `POST /{comment-id}` with `hide=true`.
- Result:
