// Thread / message / comment persistence shared by inbox.js and agent.js.
// (Kept apart from db.js so that file stays schema-only.)
import { WINDOW_MS } from './config.js';
import { db } from './db.js';

export const PLACEHOLDERS = {
  image: '[תמונה]',
  video: '[וידאו]',
  audio: '[הודעה קולית]',
  attachment: '[קובץ מצורף]',
  share: '[פוסט משותף]',
  story_reply: '[תגובה לסטורי]',
  story_mention: '[אזכור בסטורי]',
  reaction: '[ריאקציה]',
  unsupported: '[הודעה לא נתמכת]',
};

// True when the message carries words the person actually typed.
export const hasUserText = (m) => m.type === 'text' || !/^\[[^\]]+\]$/.test((m.text || '').trim());

export const getThread = (id) => db.prepare('SELECT * FROM threads WHERE id = ?').get(id);

// One person must map to one thread even if webhook and polling disagree on
// their id: fall back to matching by username before creating a new thread.
export function resolveThreadId({ id, username }) {
  if (id && getThread(String(id))) return String(id);
  if (username) {
    const byName = db.prepare('SELECT id FROM threads WHERE username = ? COLLATE NOCASE').get(username);
    if (byName) return byName.id;
  }
  return id ? String(id) : null;
}

export function upsertThread({ id, username, name, conversationId }) {
  db.prepare(
    `INSERT INTO threads (id, username, name, conversation_id, updated_at)
     VALUES (@id, @username, @name, @conversationId, @now)
     ON CONFLICT(id) DO UPDATE SET
       username = COALESCE(excluded.username, threads.username),
       name = COALESCE(excluded.name, threads.name),
       conversation_id = COALESCE(excluded.conversation_id, threads.conversation_id),
       updated_at = excluded.updated_at`,
  ).run({ id, username: username ?? null, name: name ?? null, conversationId: conversationId ?? null, now: Date.now() });
}

/**
 * Inserts a message once. Dedupes on id, and - because the webhook `mid` and
 * the polled message id are not guaranteed to match - on the same
 * thread/direction/text seen within 5s from a different source.
 * Returns true when the row is new.
 */
export function recordMessage({ id, threadId, direction, type = 'text', text, createdAt, source }) {
  if (db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id)) return false;
  // Rows we wrote ourselves at send time use the local clock, so allow more slack.
  const twin = db
    .prepare(
      `SELECT 1 FROM messages
       WHERE thread_id = ? AND direction = ? AND text IS ? AND source IS NOT ?
         AND ABS(created_at - ?) <= CASE WHEN source = 'agent' OR ? = 'agent' THEN 60000 ELSE 5000 END`,
    )
    .get(threadId, direction, text ?? null, source ?? null, createdAt, source ?? null);
  if (twin) return false;

  db.prepare(
    'INSERT INTO messages (id, thread_id, direction, type, text, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, threadId, direction, type, text ?? null, createdAt, source ?? null);

  db.prepare('UPDATE threads SET last_message_at = MAX(COALESCE(last_message_at, 0), ?) WHERE id = ?').run(
    createdAt,
    threadId,
  );
  if (direction === 'in' && type !== 'reaction') {
    db.prepare('UPDATE threads SET last_incoming_at = MAX(COALESCE(last_incoming_at, 0), ?) WHERE id = ?').run(
      createdAt,
      threadId,
    );
  }
  return true;
}

export const threadMessages = (threadId, limit = 30) =>
  db
    .prepare('SELECT * FROM (SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC')
    .all(threadId, limit);

// Milliseconds left in Instagram's 24h reply window (<= 0 means closed).
export function windowRemaining(thread, now = Date.now()) {
  if (!thread?.last_incoming_at) return 0;
  return thread.last_incoming_at + WINDOW_MS - now;
}

export const getDraft = (id) => db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
export const getComment = (id) => db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
export const pendingDrafts = () => db.prepare("SELECT * FROM drafts WHERE status = 'pending' ORDER BY created_at").all();
export const pendingCount = () => db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'pending'").get().n;

// One status snapshot for /health, Telegram /status and the MCP status tool.
export function statusInfo() {
  const num = (k) => {
    const v = Number(db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
  const exp = num('token_expires_at');
  return {
    connected: !!get('access_token'),
    username: get('ig_username'),
    paused: get('paused') === '1',
    pending_drafts: pendingCount(),
    scheduled_posts: db.prepare("SELECT COUNT(*) AS n FROM scheduled_posts WHERE status = 'pending'").get().n,
    token_days_remaining: exp ? Math.floor((exp - Date.now()) / 86_400_000) : null,
    last_poll_ok: num('last_poll_ok'),
    last_webhook_at: num('last_webhook_at'),
  };
}
