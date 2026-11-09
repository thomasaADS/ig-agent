// Webhook verification + processing, and the polling fallback.
import crypto from 'node:crypto';
import { config, log, safeErr, WINDOW_MS } from './config.js';
import { db, getSetting, setSetting, getNum } from './db.js';
import * as ig from './instagram.js';
import { PLACEHOLDERS, resolveThreadId, upsertThread, getThread, recordMessage } from './store.js';
import * as agent from './agent.js';
import { notify } from './telegram.js';
import * as campaigns from './campaigns.js';

// ---------- webhook verification ----------

export function verifyChallenge(query) {
  const ok =
    query['hub.mode'] === 'subscribe' &&
    !!config.webhookVerifyToken &&
    query['hub.verify_token'] === config.webhookVerifyToken;
  return ok ? String(query['hub.challenge'] ?? '') : null;
}

// x-hub-signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body).
// Instagram Login apps have two secrets (Instagram app / Meta app); accept
// whichever is configured and remember which one matched.
export function verifySignature(rawBody, header) {
  if (typeof header !== 'string' || !header.startsWith('sha256=') || !rawBody) return false;
  const given = Buffer.from(header.slice(7), 'hex');
  const candidates = [
    ['instagram_app_secret', config.igAppSecret],
    ['meta_app_secret', config.metaAppSecret],
  ];
  for (const [kind, secret] of candidates) {
    if (!secret) continue;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
      if (getSetting('webhook_signed_with') !== kind) setSetting('webhook_signed_with', kind);
      return true;
    }
  }
  return false;
}

// ---------- message classification ----------

const withText = (placeholder, text) => (text ? `${placeholder} ${text}` : placeholder);

function attachmentPlaceholder(type) {
  if (type === 'image' || type === 'video' || type === 'audio' || type === 'share') return PLACEHOLDERS[type];
  if (type === 'story_mention') return PLACEHOLDERS.story_mention;
  if (type === 'ig_reel' || type === 'reel') return PLACEHOLDERS.share;
  return PLACEHOLDERS.attachment;
}

// Webhook `message` object -> { type, text } or null when there is nothing to store.
export function classifyWebhookMessage(message) {
  if (!message || message.is_deleted) return null;
  const text = (message.text || '').trim();
  if (message.is_unsupported) return { type: 'unsupported', text: PLACEHOLDERS.unsupported };
  if (message.reply_to?.story) return { type: 'story_reply', text: withText(PLACEHOLDERS.story_reply, text) };
  const att = message.attachments?.[0];
  if (att) {
    const type = att.type === 'story_mention' ? 'story_mention' : 'attachment';
    return { type, text: withText(attachmentPlaceholder(att.type), text) };
  }
  return text ? { type: 'text', text } : null;
}

// Message object from the conversations API -> { type, text } or null.
export function classifyPolledMessage(m) {
  const text = (m.message || '').trim();
  if (m.is_unsupported) return { type: 'unsupported', text: PLACEHOLDERS.unsupported };
  if (m.story?.mention) return { type: 'story_mention', text: withText(PLACEHOLDERS.story_mention, text) };
  if (m.story?.reply_to) return { type: 'story_reply', text: withText(PLACEHOLDERS.story_reply, text) };
  const att = m.attachments?.data?.[0];
  if (att) {
    const kind = att.video_data ? 'video' : att.image_data ? 'image' : 'attachment';
    return { type: 'attachment', text: withText(PLACEHOLDERS[kind], text) };
  }
  return text ? { type: 'text', text } : null;
}

// ---------- webhook processing ----------

async function ensureThread(participantId) {
  const threadId = resolveThreadId({ id: participantId });
  const existing = getThread(threadId);
  if (existing?.username) return threadId;
  let profile = {};
  try {
    profile = await ig.userProfile(participantId);
  } catch {
    // Profile lookups fail for some accounts; the thread still works by id.
  }
  // The same person may already have a thread created by polling under another id.
  const resolved = resolveThreadId({ id: participantId, username: profile.username });
  upsertThread({ id: resolved, username: profile.username, name: profile.name });
  return resolved;
}

async function processMessagingEvent(ev) {
  const senderId = ev.sender?.id && String(ev.sender.id);
  const recipientId = ev.recipient?.id && String(ev.recipient.id);
  if (!senderId || !recipientId) return;
  const createdAt = Number(ev.timestamp) || Date.now();

  if (ev.reaction) {
    if (ev.reaction.action === 'unreact' || ig.isMe({ id: senderId })) return;
    const threadId = await ensureThread(senderId);
    recordMessage({
      id: `${ev.reaction.mid}:reaction:${senderId}`,
      threadId,
      direction: 'in',
      type: 'reaction',
      text: withText(PLACEHOLDERS.reaction, ev.reaction.emoji || ev.reaction.reaction || ''),
      createdAt,
      source: 'webhook',
    });
    return;
  }

  const message = ev.message;
  if (!message?.mid) return; // read receipts, postbacks, edits...
  const classified = classifyWebhookMessage(message);
  if (!classified) return;

  const outgoing = !!message.is_echo || ig.isMe({ id: senderId });
  const threadId = await ensureThread(outgoing ? recipientId : senderId);
  const row = { id: message.mid, threadId, direction: outgoing ? 'out' : 'in', ...classified, createdAt, source: 'webhook' };
  if (!recordMessage(row)) return; // duplicate delivery, or already seen by polling
  if (outgoing) await agent.handleOutgoing(threadId);
  else await agent.handleIncoming(threadId, row);
}

async function processCommentChange(value, entryTime) {
  if (!value?.id || !value.text) return;
  const from = value.from || {};
  if (ig.isMe({ id: from.id, username: from.username })) return;
  const createdAt = entryTime ? entryTime * 1000 : Date.now();
  const isNew = storeComment({
    id: value.id,
    mediaId: value.media?.id,
    parentId: value.parent_id,
    fromId: from.id,
    username: from.username,
    text: value.text,
    createdAt,
    replied: false,
  });
  if (isNew) {
    await ensureCaption(value.media?.id);
    await onFreshComment(value.id);
  }
}

// A campaign keyword wins over an AI reply draft for the same comment.
async function onFreshComment(commentId) {
  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId);
  if (campaigns.enqueue(comment)) {
    campaigns.processQueue().catch((e) => log('campaign queue error:', safeErr(e)));
    return;
  }
  await agent.handleNewComment(commentId);
}

export async function processWebhook(payload) {
  setSetting('last_webhook_at', Date.now());
  if (payload?.object !== 'instagram') return;
  for (const entry of payload.entry || []) {
    for (const ev of entry.messaging || []) {
      try {
        await processMessagingEvent(ev);
      } catch (e) {
        log('webhook message error:', safeErr(e));
      }
    }
    for (const change of entry.changes || []) {
      try {
        if (change.field === 'comments') await processCommentChange(change.value, entry.time);
      } catch (e) {
        log('webhook comment error:', safeErr(e));
      }
    }
  }
}

// ---------- comments storage ----------

// Returns true when a brand-new comment that still needs a reply was stored.
function storeComment({ id, mediaId, parentId, fromId, username, text, createdAt, replied }) {
  const existing = db.prepare('SELECT status FROM comments WHERE id = ?').get(id);
  if (existing) {
    if (replied && existing.status === 'new') {
      db.prepare("UPDATE comments SET status = 'replied' WHERE id = ?").run(id);
      return false;
    }
    return false;
  }
  // Only fresh top-level comments are drafted; replies and old ones are kept for context.
  let status = 'new';
  if (replied) status = 'replied';
  else if (parentId) status = 'thread';
  else if (Date.now() - createdAt > config.commentMaxAgeMs) status = 'old';
  db.prepare(
    'INSERT INTO comments (id, media_id, parent_id, from_id, username, text, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, mediaId ?? null, parentId ?? null, fromId ?? null, username ?? null, text, createdAt, status);
  return status === 'new';
}

function cacheMedia(m, fetched = false) {
  db.prepare(
    `INSERT INTO media_cache (id, caption, permalink, timestamp, comments_count, fetched_at)
     VALUES (@id, @caption, @permalink, @timestamp, @count, @fetchedAt)
     ON CONFLICT(id) DO UPDATE SET caption = excluded.caption, permalink = excluded.permalink,
       comments_count = excluded.comments_count,
       fetched_at = COALESCE(excluded.fetched_at, media_cache.fetched_at)`,
  ).run({
    id: m.id,
    caption: m.caption ?? null,
    permalink: m.permalink ?? null,
    timestamp: m.timestamp ? Date.parse(m.timestamp) : null,
    count: m.comments_count ?? 0,
    fetchedAt: fetched ? Date.now() : null,
  });
}

// Captions are cached per media instead of re-listing media for every comment.
async function ensureCaption(mediaId) {
  if (!mediaId || db.prepare('SELECT 1 FROM media_cache WHERE id = ?').get(mediaId)) return;
  try {
    cacheMedia(await ig.mediaInfo(mediaId));
  } catch (e) {
    log('caption lookup failed:', safeErr(e));
  }
}

// ---------- polling fallback ----------

const OVERLAP_MS = 60_000;
const FIRST_SYNC_LOOKBACK_MS = 3 * 86_400_000;

export async function syncInbox() {
  // Capture the clock BEFORE fetching: anything updated while this sync runs
  // is picked up next time. The overlap is safe because inserts dedupe.
  const startedAt = Date.now();
  const since = getNum('last_sync', 0) || startedAt - FIRST_SYNC_LOOKBACK_MS;
  const convs = await ig.conversations(since);
  let added = 0;

  for (const conv of convs) {
    const other = (conv.participants?.data || []).find((p) => !ig.isMe(p));
    if (!other?.id) continue;
    const threadId = resolveThreadId(other);
    upsertThread({ id: threadId, username: other.username, name: other.name, conversationId: conv.id });

    const messages = (await ig.conversationMessages(conv.id))
      .filter((m) => m.id && m.created_time)
      .sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time));

    const fresh = [];
    for (const m of messages) {
      const classified = classifyPolledMessage(m);
      if (!classified) continue;
      const row = {
        id: m.id,
        threadId,
        direction: ig.isMe(m.from || {}) ? 'out' : 'in',
        ...classified,
        createdAt: Date.parse(m.created_time),
        source: 'poll',
      };
      if (recordMessage(row)) fresh.push(row);
    }
    added += fresh.length;
    if (!fresh.length) continue;

    if (fresh.some((r) => r.direction === 'out')) await agent.handleOutgoing(threadId);
    const last = fresh.at(-1);
    if (last.direction === 'in' && Date.now() - last.createdAt < WINDOW_MS) await agent.handleIncoming(threadId, last);
  }

  setSetting('last_sync', startedAt - OVERLAP_MS);
  return { conversations: convs.length, newMessages: added };
}

const COMMENT_RECHECK_MS = 15 * 60_000;
const COMMENT_MEDIA_AGE_MS = 7 * 86_400_000;

export async function syncComments() {
  const media = await ig.recentMedia(10);
  let added = 0;
  for (const m of media) {
    const cached = db.prepare('SELECT comments_count, fetched_at FROM media_cache WHERE id = ?').get(m.id);
    cacheMedia(m);
    const count = m.comments_count ?? 0;
    if (!count) continue;
    const changed = !cached || cached.comments_count !== count || !cached.fetched_at;
    const recent = m.timestamp && Date.now() - Date.parse(m.timestamp) < COMMENT_MEDIA_AGE_MS;
    const stale = Date.now() - (cached?.fetched_at || 0) > COMMENT_RECHECK_MS;
    if (!changed && !(recent && stale)) continue;

    const list = await ig.comments(m.id);
    cacheMedia(m, true);
    for (const c of list) {
      const from = { id: c.from?.id, username: c.username || c.from?.username };
      if (ig.isMe(from)) continue;
      const replied = (c.replies?.data || []).some((r) => ig.isMe({ id: r.from?.id, username: r.username }));
      const wasNew = db.prepare("SELECT 1 FROM comments WHERE id = ? AND status = 'new'").get(c.id);
      const isNew = storeComment({
        id: c.id,
        mediaId: m.id,
        fromId: from.id,
        username: from.username,
        text: c.text || '',
        createdAt: c.timestamp ? Date.parse(c.timestamp) : Date.now(),
        replied,
      });
      if (isNew) {
        added++;
        await onFreshComment(c.id);
      } else if (wasNew && replied) {
        await agent.closeCommentDrafts(c.id); // the owner replied in the app
      }
    }
  }
  return { media: media.length, newComments: added };
}

// ---------- poll loop ----------

let pollTimer = null;
let polling = false;
let failures = 0;

export async function pollOnce() {
  if (polling || !ig.isConnected()) return null;
  polling = true;
  try {
    const inbox = await syncInbox();
    const comments = await syncComments();
    setSetting('last_poll_ok', Date.now());
    failures = 0;
    return { ...inbox, ...comments };
  } catch (e) {
    failures++;
    log(`poll failed (${failures} in a row):`, safeErr(e));
    if (failures === 5) await notify('⚠️ הסנכרון מול אינסטגרם נכשל 5 פעמים ברצף. כדאי לבדוק /status ואת הלוגים.');
    throw e;
  } finally {
    polling = false;
  }
}

export function startPolling() {
  if (!config.pollingEnabled || pollTimer) return;
  pollTimer = setInterval(() => pollOnce().catch(() => {}), config.pollIntervalMs);
  setTimeout(() => pollOnce().catch(() => {}), 5000).unref();
}

export function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}
