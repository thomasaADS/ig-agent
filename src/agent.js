// Incoming event -> debounce -> draft -> Telegram card (or guarded auto-send).
// Also owns every send path: send / skip / edit / regenerate.
import crypto from 'node:crypto';
import { config, log, safeErr, UserError, localDay } from './config.js';
import { db, isPaused } from './db.js';
import * as ig from './instagram.js';
import { draftReply, NEEDS_ME } from './ai.js';
import {
  getThread,
  getDraft,
  getComment,
  recordMessage,
  threadMessages,
  windowRemaining,
  hasUserText,
  parseTags,
} from './store.js';
import * as tg from './telegram.js';

const now = () => Date.now();
const PAUSED_MSG = 'הסוכן מושהה (/resume כדי להפעיל מחדש). לא נשלח דבר.';
const WINDOW_MSG = 'חלון 24 השעות של אינסטגרם נסגר – אי אפשר לשלוח הודעה בשיחה הזו עד שהצד השני יכתוב שוב.';

// ---------- debounce ----------

const timers = new Map(); // threadId -> timeout
const drafting = new Set(); // threadIds with a draft being generated

export function scheduleDraft(threadId, delayMs = config.debounceMs) {
  clearTimeout(timers.get(threadId));
  const t = setTimeout(() => {
    timers.delete(threadId);
    draftForThread(threadId).catch((e) => log('draft error:', safeErr(e)));
  }, delayMs);
  t.unref?.();
  timers.set(threadId, t);
}

export function cancelDebounce(threadId) {
  clearTimeout(timers.get(threadId));
  timers.delete(threadId);
}

export function stopAgent() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

// Runs every waiting debounce right now (tests, /resume).
export async function flushDebounce() {
  const ids = [...timers.keys()];
  stopAgent();
  for (const id of ids) await draftForThread(id);
}

// Debounce timers live in memory. After a restart (or /resume) re-schedule
// every thread whose last message is incoming, has no newer draft, and is
// still inside the 24h window.
export function recoverPending() {
  const rows = db
    .prepare(
      `SELECT t.id FROM threads t
       WHERE t.last_incoming_at > ?
         AND (SELECT direction FROM messages m WHERE m.thread_id = t.id ORDER BY created_at DESC LIMIT 1) = 'in'
         AND COALESCE((SELECT MAX(created_at) FROM drafts d WHERE d.thread_id = t.id), 0) < t.last_incoming_at`,
    )
    .all(now() - 24 * 3600_000);
  for (const r of rows) scheduleDraft(r.id);
  return rows.length;
}

// A crash between claiming a draft and hearing back from Instagram leaves it
// in 'sending'. We cannot know whether it went out, so hand it back to the
// owner with a warning instead of guessing.
export async function recoverStuckSends() {
  const stuck = db.prepare("SELECT * FROM drafts WHERE status = 'sending'").all();
  for (const d of stuck) {
    db.prepare("UPDATE drafts SET status = 'pending', error = 'interrupted', updated_at = ? WHERE id = ?").run(now(), d.id);
    await tg.notify(`⚠️ טיוטה #${d.id} נקטעה באמצע שליחה (השרת הופעל מחדש). ייתכן שכבר נשלחה – כדאי לבדוק באינסטגרם לפני שמאשרים שוב.`);
    await tg.updateDraftCard(getDraft(d.id));
  }
}

// ---------- inbox hooks (called by inbox.js after a NEW row was stored) ----------

export async function handleIncoming(threadId, msg) {
  if (msg.type === 'reaction') return; // stored, never drafted
  if (getThread(threadId)?.stage === 'spam') return; // marked by the owner: store silently
  if (msg.type !== 'text') {
    const t = getThread(threadId);
    await tg.notify(`📎 ${tg.who(t)}: ${tg.esc(msg.text || '')}`);
  }
  if (isPaused()) return;
  scheduleDraft(threadId);
}

// The owner answered (in the app, or via the agent): open drafts are stale.
export async function handleOutgoing(threadId) {
  cancelDebounce(threadId);
  await supersedeDrafts(threadId, 'self_answered', 'ענית בעצמך');
}

export async function handleNewComment(commentId) {
  if (isPaused()) return;
  await draftForComment(commentId);
}

// ---------- drafting ----------

async function supersedeDrafts(threadId, outcome, label, exceptId = 0) {
  const open = db
    .prepare("SELECT * FROM drafts WHERE thread_id = ? AND kind = 'dm' AND status = 'pending' AND id != ?")
    .all(threadId, exceptId);
  for (const d of open) {
    const r = db
      .prepare("UPDATE drafts SET status = 'superseded', outcome = COALESCE(outcome, ?), updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(outcome, now(), d.id);
    if (r.changes) await tg.closeDraftCard(d, label);
  }
}

async function createDraft({ kind, threadId = null, commentId = null, text, regenOf = null }) {
  const info = db
    .prepare(
      `INSERT INTO drafts (kind, thread_id, comment_id, text, original_text, status, regen_of, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(kind, threadId, commentId, text, text, regenOf, now(), now());
  const id = Number(info.lastInsertRowid);
  if (kind === 'dm') await supersedeDrafts(threadId, 'replaced', 'הוחלף בטיוטה חדשה', id);
  return getDraft(id);
}

function markNeedsMe(kind, threadId, commentId) {
  db.prepare(
    `INSERT INTO drafts (kind, thread_id, comment_id, text, status, outcome, created_at, updated_at)
     VALUES (?, ?, ?, '', 'needs_me', 'needs_me', ?, ?)`,
  ).run(kind, threadId, commentId, now(), now());
}

export async function draftForThread(threadId, { previous, instruction, regenOf } = {}) {
  if (isPaused() || drafting.has(threadId)) return null;
  const thread = getThread(threadId);
  const history = threadMessages(threadId, 30);
  const last = history.at(-1);
  if (!thread || !last || last.direction !== 'in' || thread.stage === 'spam') return null;
  if (windowRemaining(thread) <= 0) return null;

  // Only draft when the unanswered part contains real words.
  const lastOut = history.findLastIndex((m) => m.direction === 'out');
  const unanswered = history.slice(lastOut + 1).filter((m) => m.type !== 'reaction');
  if (!unanswered.some(hasUserText)) return null;

  drafting.add(threadId);
  let text;
  try {
    text = await draftReply({
      kind: 'dm',
      username: thread.username,
      history: history.filter((m) => m.type !== 'reaction'),
      lead: leadNotes(thread),
      previous,
      instruction,
    });
  } finally {
    drafting.delete(threadId);
  }

  // The world may have moved while the model was thinking.
  const latest = threadMessages(threadId, 1).at(-1);
  if (latest?.direction === 'out') return null;
  if (latest && latest.id !== last.id) {
    scheduleDraft(threadId); // newer incoming message: draft again on top of it
    return null;
  }
  if (isPaused()) return null;

  const incoming = unanswered.map((m) => m.text).join('\n');
  if (text === NEEDS_ME) {
    markNeedsMe('dm', threadId, null);
    await tg.notify(`🙋 ${tg.who(thread)} – צריך אותך אישית:\n\n${tg.esc(incoming)}`);
    return null;
  }

  const draft = await createDraft({ kind: 'dm', threadId, text, regenOf });
  if (config.autoSendDm && !regenOf && autoSendAllowed(thread, text, incoming)) {
    try {
      await sendDraft(draft.id, { via: 'auto' });
      await tg.notify(`🤖 נשלח אוטומטית ל-${tg.who(thread)}:\n\n${tg.esc(text)}`);
      return getDraft(draft.id);
    } catch (e) {
      log('auto-send failed, falling back to approval:', safeErr(e));
    }
  }
  const fresh = getDraft(draft.id);
  if (fresh.status === 'pending') await tg.sendDraftCard(fresh);
  return fresh;
}

export async function draftForComment(commentId, { previous, instruction, regenOf } = {}) {
  const c = getComment(commentId);
  if (!c || c.status !== 'new' || isPaused()) return null;
  if (!regenOf && db.prepare("SELECT 1 FROM drafts WHERE comment_id = ? AND status IN ('pending','sending','needs_me')").get(commentId)) return null;
  const caption = db.prepare('SELECT caption FROM media_cache WHERE id = ?').get(c.media_id)?.caption;
  const text = await draftReply({ kind: 'comment', username: c.username, text: c.text, caption, previous, instruction });
  if (isPaused()) return null;

  if (text === NEEDS_ME) {
    markNeedsMe('comment', null, commentId);
    await tg.notify(`🙋 תגובה מ-@${tg.esc(c.username || '?')} שצריכה אותך:\n\n${tg.esc(c.text)}`);
    return null;
  }
  const draft = await createDraft({ kind: 'comment', commentId, text, regenOf });
  if (config.autoSendComments && !regenOf && !looksRisky(text) && !looksRisky(c.text)) {
    try {
      await sendDraft(draft.id, { via: 'auto' });
      await tg.notify(`🤖 תגובה נשלחה אוטומטית ל-@${tg.esc(c.username || '?')}:\n\n${tg.esc(text)}`);
      return getDraft(draft.id);
    } catch (e) {
      log('auto-send comment failed, falling back to approval:', safeErr(e));
    }
  }
  const fresh = getDraft(draft.id);
  if (fresh.status === 'pending') await tg.sendDraftCard(fresh);
  return fresh;
}

function leadNotes(thread) {
  const parts = [];
  if (thread.stage && thread.stage !== 'new') parts.push(`stage: ${thread.stage}`);
  const tags = parseTags(thread);
  if (tags.length) parts.push(`tags: ${tags.join(', ')}`);
  if (thread.notes) parts.push(thread.notes);
  return parts.join('\n') || undefined;
}

// ---------- auto-send guardrails ----------

// Links, phone numbers, prices, dates and times nearly always contain a digit
// or one of these words - any of them forces manual approval.
const RISKY_PATTERNS = [
  /\d/,
  /https?:\/\/|www\.|[\w-]+\.(com|co\.il|net|org|io|me|ly|app|link)(\/|\s|$)/i,
  /[₪$€£]|ש"ח|ש״ח|שקל|דולר|יורו|מחיר|עלות|עולה|כמה זה|תשלום|לשלם|הנחה|כסף|price|cost|how much|pay|discount|usd|nis|eur/i,
  /מחר|מחרתיים|היום|הערב|הלילה|בבוקר|בצהריים|בשעה|יום (ראשון|שני|שלישי|רביעי|חמישי|שישי)|בשבת|שבוע הבא|פגישה|נפגש/,
  /\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|o'clock|am|pm)\b/i,
];
export const looksRisky = (text) => RISKY_PATTERNS.some((re) => re.test(text || ''));

export function autoSendAllowed(thread, draftText, incomingText) {
  // Never the first reply to someone new.
  const priorOut = db.prepare("SELECT 1 FROM messages WHERE thread_id = ? AND direction = 'out' LIMIT 1").get(thread.id);
  if (!priorOut) return false;
  if (looksRisky(draftText) || looksRisky(incomingText)) return false;
  const count = thread.auto_day === localDay() ? thread.auto_count : 0;
  return count < config.autoSendMaxPerThread;
}

function countAutoSend(threadId) {
  const day = localDay();
  db.prepare(
    'UPDATE threads SET auto_count = CASE WHEN auto_day = ? THEN auto_count + 1 ELSE 1 END, auto_day = ? WHERE id = ?',
  ).run(day, day, threadId);
}

// ---------- send / skip / edit / regenerate ----------

function assertWindow(threadId) {
  const thread = getThread(threadId);
  if (!thread) throw new UserError('השיחה לא נמצאה.');
  if (windowRemaining(thread) <= 0) throw new UserError(WINDOW_MSG);
  return thread;
}

/**
 * Sends an approved draft. The status flip pending -> sending is the lock:
 * whichever caller (Telegram, MCP, auto) wins it is the only one that sends.
 */
export async function sendDraft(id, { via = 'manual' } = {}) {
  if (isPaused()) throw new UserError(PAUSED_MSG);
  const claim = db
    .prepare("UPDATE drafts SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'pending'")
    .run(now(), id);
  if (claim.changes !== 1) throw new UserError('הטיוטה הזו כבר טופלה (נשלחה, דולגה או הוחלפה).');
  const draft = getDraft(id);

  try {
    if (draft.kind === 'dm') {
      const thread = getThread(draft.thread_id);
      if (!thread || windowRemaining(thread) <= 0) {
        db.prepare("UPDATE drafts SET status = 'expired', outcome = 'expired', updated_at = ? WHERE id = ?").run(now(), id);
        await tg.closeDraftCard(draft, 'פג חלון 24 השעות');
        throw new UserError(WINDOW_MSG);
      }
      const mid = await ig.sendMessage(thread.id, draft.text);
      recordMessage({
        id: mid || `local-${crypto.randomUUID()}`,
        threadId: thread.id,
        direction: 'out',
        text: draft.text,
        createdAt: now(),
        source: 'agent',
      });
      if (via === 'auto') countAutoSend(thread.id);
    } else {
      await ig.replyToComment(draft.comment_id, draft.text);
      db.prepare("UPDATE comments SET status = 'replied' WHERE id = ?").run(draft.comment_id);
    }
  } catch (e) {
    // Give the draft back unless it was closed as expired above.
    db.prepare("UPDATE drafts SET status = 'pending', error = ?, updated_at = ? WHERE id = ? AND status = 'sending'").run(
      safeErr(e).slice(0, 300),
      now(),
      id,
    );
    throw e;
  }

  const outcome = draft.text === draft.original_text ? 'as_is' : 'edited';
  db.prepare("UPDATE drafts SET status = 'sent', outcome = ?, auto = ?, error = NULL, updated_at = ? WHERE id = ?").run(
    outcome,
    via === 'auto' ? 1 : 0,
    now(),
    id,
  );
  await tg.closeDraftCard(getDraft(id), via === 'auto' ? 'נשלח אוטומטית' : 'נשלח ✅');
  return getDraft(id);
}

export async function skipDraft(id) {
  const draft = getDraft(id);
  const r = db
    .prepare("UPDATE drafts SET status = 'skipped', outcome = 'skipped', updated_at = ? WHERE id = ? AND status = 'pending'")
    .run(now(), id);
  if (r.changes !== 1) throw new UserError('הטיוטה הזו כבר טופלה.');
  if (draft.kind === 'comment') db.prepare("UPDATE comments SET status = 'skipped' WHERE id = ?").run(draft.comment_id);
  await tg.closeDraftCard(draft, 'דולג ⏭');
  return getDraft(id);
}

// Changes the text only; sending still needs an explicit approval.
export async function editDraft(id, text) {
  const clean = String(text || '').trim();
  if (!clean) throw new UserError('טקסט ריק.');
  const r = db
    .prepare("UPDATE drafts SET text = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
    .run(clean, now(), id);
  if (r.changes !== 1) throw new UserError('הטיוטה הזו כבר טופלה.');
  const draft = getDraft(id);
  await tg.updateDraftCard(draft);
  return draft;
}

export async function regenerateDraft(id, instruction) {
  if (isPaused()) throw new UserError(PAUSED_MSG);
  const old = getDraft(id);
  const r = db
    .prepare("UPDATE drafts SET status = 'superseded', outcome = 'regenerated', updated_at = ? WHERE id = ? AND status = 'pending'")
    .run(now(), id);
  if (r.changes !== 1) throw new UserError('הטיוטה הזו כבר טופלה.');

  const opts = { previous: old.text, instruction: instruction?.trim() || undefined, regenOf: id };
  let next;
  try {
    next = old.kind === 'dm' ? await draftForThread(old.thread_id, opts) : await draftForComment(old.comment_id, opts);
  } catch (e) {
    db.prepare("UPDATE drafts SET status = 'pending', outcome = NULL, updated_at = ? WHERE id = ?").run(now(), id);
    throw e;
  }
  await tg.closeDraftCard(old, next ? 'נוסח מחדש 🔄' : 'נסגר');
  return next;
}

// ---------- direct sends typed by the owner (MCP) ----------

export async function sendDm(threadId, text) {
  if (isPaused()) throw new UserError(PAUSED_MSG);
  const clean = String(text || '').trim();
  if (!clean) throw new UserError('טקסט ריק.');
  const thread = assertWindow(threadId);
  const mid = await ig.sendMessage(thread.id, clean);
  recordMessage({
    id: mid || `local-${crypto.randomUUID()}`,
    threadId: thread.id,
    direction: 'out',
    text: clean,
    createdAt: now(),
    source: 'agent',
  });
  await handleOutgoing(thread.id);
  return mid;
}

export async function replyComment(commentId, text) {
  if (isPaused()) throw new UserError(PAUSED_MSG);
  const clean = String(text || '').trim();
  if (!clean) throw new UserError('טקסט ריק.');
  if (!getComment(commentId)) throw new UserError('התגובה לא נמצאה.');
  const id = await ig.replyToComment(commentId, clean);
  db.prepare("UPDATE comments SET status = 'replied' WHERE id = ?").run(commentId);
  await closeCommentDrafts(commentId);
  return id;
}

// The owner replied to this comment himself: open drafts for it are stale.
export async function closeCommentDrafts(commentId) {
  const open = db.prepare("SELECT * FROM drafts WHERE comment_id = ? AND status = 'pending'").all(commentId);
  for (const d of open) {
    const r = db
      .prepare("UPDATE drafts SET status = 'superseded', outcome = 'self_answered', updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(now(), d.id);
    if (r.changes) await tg.closeDraftCard(d, 'ענית בעצמך');
  }
}
