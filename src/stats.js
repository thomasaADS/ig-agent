// Numbers for the owner: daily activity, Instagram insights snapshots,
// the Telegram summary, and the dashboard's progress ("game") layer.
import { log, safeErr, parseLocal, localDay, formatLocal } from './config.js';
import { db } from './db.js';
import * as ig from './instagram.js';

const DAY = 86_400_000;
const count = (sql, ...args) => db.prepare(sql).get(...args).n;

// [start, end) of a Jerusalem calendar day in epoch ms.
function bounds(day) {
  const start = parseLocal(`${day} 00:00`);
  return [start, parseLocal(`${localDay(start + DAY + 2 * 3600_000)} 00:00`)];
}
export const dayOffset = (n, from = Date.now()) => localDay(parseLocal(`${localDay(from)} 12:00`) + n * DAY);

export function dayStats(day = localDay()) {
  const [a, b] = bounds(day);
  const drafts = Object.fromEntries(
    db.prepare('SELECT outcome, COUNT(*) AS n FROM drafts WHERE updated_at >= ? AND updated_at < ? AND outcome IS NOT NULL GROUP BY outcome').all(a, b).map((r) => [r.outcome, r.n]),
  );
  return {
    day,
    messages_in: count("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in' AND type != 'reaction' AND created_at >= ? AND created_at < ?", a, b),
    people: count("SELECT COUNT(DISTINCT thread_id) AS n FROM messages WHERE direction = 'in' AND created_at >= ? AND created_at < ?", a, b),
    replies_sent: count("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND created_at >= ? AND created_at < ?", a, b),
    comments_in: count("SELECT COUNT(*) AS n FROM comments WHERE created_at >= ? AND created_at < ?", a, b),
    comments_replied: count("SELECT COUNT(*) AS n FROM drafts WHERE kind = 'comment' AND status = 'sent' AND updated_at >= ? AND updated_at < ?", a, b),
    drafts_as_is: drafts.as_is || 0,
    drafts_edited: drafts.edited || 0,
    drafts_skipped: drafts.skipped || 0,
    needs_me: drafts.needs_me || 0,
    auto_sent: count("SELECT COUNT(*) AS n FROM drafts WHERE auto = 1 AND status = 'sent' AND updated_at >= ? AND updated_at < ?", a, b),
    published: count("SELECT COUNT(DISTINCT group_id) AS n FROM media_files WHERE status = 'published' AND published_at >= ? AND published_at < ?", a, b),
    campaign_dms: count("SELECT COUNT(*) AS n FROM campaign_sends WHERE status = 'sent' AND sent_at >= ? AND sent_at < ?", a, b),
    campaign_clicks: count('SELECT COUNT(*) AS n FROM campaign_sends WHERE first_click_at >= ? AND first_click_at < ?', a, b),
  };
}

export function series(days = 14) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const s = dayStats(dayOffset(-i));
    out.push({ day: s.day, messages_in: s.messages_in, replies_sent: s.replies_sent, published: s.published });
  }
  return out;
}

// Conversations where the other side wrote last and the 24h window is still open.
export const waitingThreads = () =>
  db
    .prepare(
      `SELECT t.* FROM threads t
       WHERE t.stage != 'spam' AND t.last_incoming_at > ?
         AND (SELECT direction FROM messages m WHERE m.thread_id = t.id ORDER BY created_at DESC LIMIT 1) = 'in'
       ORDER BY t.last_incoming_at`,
    )
    .all(Date.now() - DAY);

// ---------- Instagram insights ----------

export const getInsights = (day) => {
  const row = db.prepare('SELECT * FROM insights_daily WHERE day = ?').get(day);
  return row ? { day: row.day, followers: row.followers, ...JSON.parse(row.data || '{}'), fetched_at: row.fetched_at } : null;
};

/** Stores today's follower count + last-24h account metrics. Safe to call often. */
export async function snapshotInsights({ maxAgeMs = 3600_000 } = {}) {
  if (!ig.isConnected()) return null;
  const day = localDay();
  const existing = getInsights(day);
  if (existing && Date.now() - existing.fetched_at < maxAgeMs) return existing;
  try {
    const [profile, metrics] = await Promise.all([ig.profile(), ig.accountInsights(Date.now() - DAY, Date.now())]);
    db.prepare(
      `INSERT INTO insights_daily (day, followers, data, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET followers = excluded.followers, data = excluded.data, fetched_at = excluded.fetched_at`,
    ).run(day, profile.followers_count ?? null, JSON.stringify({ ...metrics, media_count: profile.media_count ?? null }), Date.now());
  } catch (e) {
    log('insights snapshot failed:', safeErr(e));
  }
  return getInsights(day);
}

export const followerTrend = (days = 14) =>
  db.prepare('SELECT day, followers FROM insights_daily WHERE followers IS NOT NULL ORDER BY day DESC LIMIT ?').all(days).reverse();

// ---------- daily summary (Telegram) ----------

export function summaryText(day = localDay()) {
  const s = dayStats(day);
  const ins = getInsights(day);
  const prev = getInsights(dayOffset(-1, parseLocal(`${day} 12:00`)));
  const pending = count("SELECT COUNT(*) AS n FROM drafts WHERE status = 'pending'");
  const waiting = waitingThreads().length;
  const delta = ins?.followers != null && prev?.followers != null ? ins.followers - prev.followers : null;
  const sign = (n) => (n > 0 ? `+${n}` : String(n));
  const lines = [
    `📊 <b>סיכום ${day}</b>`,
    '',
    `💬 הודעות: ${s.messages_in} נכנסו מ-${s.people} אנשים · ${s.replies_sent} תשובות יצאו`,
    `✍️ טיוטות: ${s.drafts_as_is} נשלחו כמו שהן · ${s.drafts_edited} נערכו · ${s.drafts_skipped} דולגו${s.auto_sent ? ` · ${s.auto_sent} אוטומטיות` : ''}`,
    `🗨 תגובות: ${s.comments_in} חדשות · ${s.comments_replied} נענו`,
    `📸 פורסמו: ${s.published}`,
  ];
  if (s.campaign_dms || s.campaign_clicks) lines.push(`🎯 קמפיינים: ${s.campaign_dms} הודעות נשלחו · ${s.campaign_clicks} קליקים`);
  if (ins) {
    const bits = [];
    if (ins.followers != null) bits.push(`${ins.followers} עוקבים${delta != null ? ` (${sign(delta)})` : ''}`);
    if (ins.reach != null) bits.push(`חשיפה ${ins.reach}`);
    if (ins.views != null) bits.push(`צפיות ${ins.views}`);
    if (ins.total_interactions != null) bits.push(`אינטראקציות ${ins.total_interactions}`);
    if (bits.length) lines.push(`📈 ${bits.join(' · ')}`);
  }
  lines.push('', pending || waiting ? `⏳ מחכה לך: ${pending} טיוטות לאישור · ${waiting} שיחות בלי מענה` : '✅ אין שום דבר שמחכה לך');
  if (s.needs_me) lines.push(`🙋 ${s.needs_me} הודעות הועברו אליך אישית`);
  return lines.join('\n');
}

// ---------- progress layer for the dashboard ----------
// A score built only from real activity in the database. It rewards what the
// owner actually wants more of: answering people and publishing.

const XP = { reply: 10, comment: 5, post: 50, campaign: 2 };

export function gameState() {
  const replies = count("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out'");
  const commentReplies = count("SELECT COUNT(*) AS n FROM drafts WHERE kind = 'comment' AND status = 'sent'");
  const posts = count("SELECT COUNT(DISTINCT group_id) AS n FROM media_files WHERE status = 'published'");
  const campaignDms = count("SELECT COUNT(*) AS n FROM campaign_sends WHERE status = 'sent'");
  const xp = replies * XP.reply + commentReplies * XP.comment + posts * XP.post + campaignDms * XP.campaign;

  // Level n needs 100 * (n-1)^2 xp: 0, 100, 400, 900, 1600 ...
  const level = Math.floor(Math.sqrt(xp / 100)) + 1;
  const floor = 100 * (level - 1) ** 2;
  const next = 100 * level ** 2;

  // Streak: consecutive days with at least one reply or publish. Today may still be empty.
  const active = (day) => {
    const s = dayStats(day);
    return s.replies_sent + s.published + s.comments_replied > 0;
  };
  let streak = 0;
  let i = active(localDay()) ? 0 : -1;
  while (streak < 365 && active(dayOffset(i))) {
    streak++;
    i--;
  }

  const today = dayStats();
  const pending = count("SELECT COUNT(*) AS n FROM drafts WHERE status = 'pending'");
  const waiting = waitingThreads().length;
  const missions = [
    { id: 'inbox', title: 'אינבוקס נקי', detail: pending + waiting ? `${pending} טיוטות · ${waiting} שיחות מחכות` : 'אין מה שמחכה', done: pending + waiting === 0 },
    { id: 'publish', title: 'פרסום היום', detail: today.published ? `${today.published} פורסמו` : 'עוד לא פורסם כלום היום', done: today.published > 0 },
    { id: 'comments', title: 'מענה לתגובות', detail: `${today.comments_replied} מתוך ${today.comments_in} נענו`, done: today.comments_in > 0 && today.comments_replied >= today.comments_in },
  ];
  return { xp, level, level_floor: floor, level_next: next, streak, missions, totals: { replies, comment_replies: commentReplies, posts, campaign_dms: campaignDms } };
}

export const stamp = (ms) => (ms ? formatLocal(ms) : null);
