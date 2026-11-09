// Comment -> DM campaigns ("comment LINK and get the link in your inbox").
//
// Approval model: the owner approves each campaign's exact text + link once,
// in Telegram. After that the agent sends that fixed text - and only that
// text - as one private reply per matching comment. No AI writes these.
import crypto from 'node:crypto';
import { config, log, safeErr, UserError } from './config.js';
import { db, isPaused } from './db.js';
import * as ig from './instagram.js';
import * as tg from './telegram.js';

const now = () => Date.now();
const PRIVATE_REPLY_MAX_AGE_MS = 7 * 86_400_000 - 3600_000; // Meta: within 7 days of the comment
const MAX_DM_LENGTH = 1000;

export const getCampaign = (id) => db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
const keywordsOf = (c) => JSON.parse(c.keywords);

// Lowercase, no punctuation; works for Hebrew and Latin text.
const normalise = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function matches(campaign, text) {
  const hay = normalise(text);
  if (!hay) return false;
  const words = hay.split(' ');
  return keywordsOf(campaign).some((k) => (campaign.match === 'contains' ? hay.includes(k) : words.includes(k)));
}

function stats(id) {
  const rows = db.prepare('SELECT status, COUNT(*) AS n, SUM(clicks > 0) AS clicked FROM campaign_sends WHERE campaign_id = ? GROUP BY status').all(id);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const sent = by.sent || 0;
  const clicked = rows.find((r) => r.status === 'sent')?.clicked || 0;
  return { sent, queued: by.queued || 0, skipped: by.skipped || 0, failed: by.failed || 0, clicked, ctr: sent ? Math.round((clicked / sent) * 100) : null };
}

export const view = (c) => ({
  id: c.id,
  name: c.name,
  status: c.status,
  keywords: keywordsOf(c),
  match: c.match,
  post: c.media_id || 'all posts',
  dm_text: c.dm_text,
  link_url: c.link_url,
  public_reply: c.public_reply,
  ...stats(c.id),
});

export const listCampaigns = () => db.prepare("SELECT * FROM campaigns WHERE status != 'deleted' ORDER BY id DESC").all().map(view);

// ---------- create / approve ----------

function cardText(c) {
  const preview = render(c, { username: 'username', token: 'XXXX' });
  return (
    `🎯 <b>קמפיין #${c.id}: ${tg.esc(c.name)}</b>\n` +
    `מילות מפתח: ${keywordsOf(c).map((k) => `<code>${tg.esc(k)}</code>`).join(', ')} (${c.match === 'contains' ? 'מכיל' : 'מילה שלמה'})\n` +
    `פוסט: ${c.media_id ? tg.esc(c.media_id) : 'כל הפוסטים'}\n\n` +
    `<b>ההודעה הפרטית שתישלח לכל מי שמגיב:</b>\n${tg.esc(preview)}` +
    (c.link_url ? `\n\n<b>יעד הקישור:</b> ${tg.esc(c.link_url)}` : '') +
    (c.public_reply ? `\n\n<b>תגובה ציבורית:</b> ${tg.esc(c.public_reply)}` : '')
  );
}

const approveKeyboard = (id) => [[{ text: 'הפעל ✅', callback_data: `c:on:${id}` }, { text: 'מחק 🗑', callback_data: `c:del:${id}` }]];

/** Creates a campaign as a DRAFT and asks the owner to approve it in Telegram. */
export async function createCampaign({ name, keywords, match = 'word', dmText, linkUrl, mediaId, publicReply }) {
  const keys = [...new Set((keywords || []).map(normalise).filter(Boolean))];
  if (!keys.length) throw new UserError('צריך לפחות מילת מפתח אחת.');
  const text = String(dmText || '').trim();
  if (!text) throw new UserError('חסר טקסט להודעה הפרטית.');
  if (text.length > MAX_DM_LENGTH) throw new UserError(`ההודעה ארוכה מדי (מקסימום ${MAX_DM_LENGTH} תווים).`);
  if (linkUrl) {
    let u;
    try {
      u = new URL(linkUrl);
    } catch {
      throw new UserError('הקישור לא תקין.');
    }
    if (!['http:', 'https:'].includes(u.protocol)) throw new UserError('הקישור חייב להתחיל ב-http או https.');
  }
  const info = db
    .prepare(
      `INSERT INTO campaigns (name, media_id, keywords, match, dm_text, link_url, public_reply, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
    )
    .run(String(name || keys[0]).slice(0, 80), mediaId || null, JSON.stringify(keys), match === 'contains' ? 'contains' : 'word', text, linkUrl || null, publicReply?.trim() || null, now());
  const c = getCampaign(Number(info.lastInsertRowid));
  const msg = await tg.notify(`${cardText(c)}\n\n<i>הקמפיין לא פעיל עד שתאשר כאן.</i>`, { reply_markup: { inline_keyboard: approveKeyboard(c.id) } });
  if (msg?.message_id) db.prepare('UPDATE campaigns SET tg_message_id = ? WHERE id = ?').run(msg.message_id, c.id);
  return view(getCampaign(c.id));
}

// Called only from the Telegram button: this is the owner's explicit approval.
export function approveCampaign(id) {
  const r = db.prepare("UPDATE campaigns SET status = 'active', approved_at = ? WHERE id = ? AND status = 'draft'").run(now(), id);
  if (r.changes !== 1) throw new UserError('הקמפיין כבר טופל.');
  return getCampaign(id);
}

// Pause any time. Re-activate only a campaign the owner already approved.
export function setStatus(id, status) {
  const c = getCampaign(id);
  if (!c || c.status === 'deleted') throw new UserError('הקמפיין לא נמצא.');
  if (status === 'paused') db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ? AND status = 'active'").run(id);
  else if (status === 'active') {
    if (!c.approved_at) throw new UserError('הקמפיין עוד לא אושר. צריך ללחוץ "הפעל" בכרטיס שנשלח לטלגרם.');
    db.prepare("UPDATE campaigns SET status = 'active' WHERE id = ? AND status = 'paused'").run(id);
  } else if (status === 'deleted') {
    db.prepare("UPDATE campaigns SET status = 'deleted' WHERE id = ?").run(id);
    db.prepare("UPDATE campaign_sends SET status = 'skipped', reason = 'campaign_deleted' WHERE campaign_id = ? AND status = 'queued'").run(id);
  } else throw new UserError('סטטוס לא מוכר.');
  return view(getCampaign(id));
}

export const cardFor = (id) => ({ text: cardText(getCampaign(id)), keyboard: approveKeyboard(id) });

// ---------- matching & queue ----------

/**
 * Called for every fresh top-level comment. Returns true when a campaign
 * claimed it (so no AI reply draft is created for that comment).
 */
export function enqueue(comment) {
  const campaign = db
    .prepare("SELECT * FROM campaigns WHERE status = 'active' AND (media_id IS NULL OR media_id = ?) ORDER BY media_id IS NULL, id DESC")
    .all(comment.media_id ?? null)
    .find((c) => matches(c, comment.text));
  if (!campaign) return false;

  // One DM per person per campaign, however many times they comment.
  const already = db
    .prepare("SELECT 1 FROM campaign_sends WHERE campaign_id = ? AND status IN ('queued', 'sending', 'sent') AND ((from_id IS NOT NULL AND from_id = ?) OR username = ?)")
    .get(campaign.id, comment.from_id ?? null, comment.username ?? null);
  db.prepare(
    `INSERT OR IGNORE INTO campaign_sends (campaign_id, comment_id, from_id, username, token, status, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(campaign.id, comment.id, comment.from_id ?? null, comment.username ?? null, crypto.randomBytes(6).toString('base64url'), already ? 'skipped' : 'queued', already ? 'already_sent_to_user' : null, now());
  db.prepare("UPDATE comments SET status = 'campaign' WHERE id = ?").run(comment.id);
  return true;
}

function render(campaign, { username, token }) {
  const link = campaign.link_url ? `${config.publicUrl}/l/${token}` : '';
  let text = campaign.dm_text.replaceAll('{username}', username || '');
  if (link) text = text.includes('{link}') ? text.replaceAll('{link}', link) : `${text}\n${link}`;
  return text.replaceAll('{link}', '').trim();
}

let draining = false;

/** Sends queued private replies, oldest first, under the hourly cap. */
export async function processQueue() {
  if (draining || isPaused() || !ig.isConnected()) return 0;
  draining = true;
  let sent = 0;
  try {
    for (;;) {
      const lastHour = db.prepare("SELECT COUNT(*) AS n FROM campaign_sends WHERE status = 'sent' AND sent_at > ?").get(now() - 3600_000).n;
      if (lastHour >= config.campaignMaxPerHour) break; // the rest waits; nothing is dropped
      const job = db
        .prepare(
          `SELECT s.*, c.created_at AS comment_at FROM campaign_sends s
           JOIN campaigns k ON k.id = s.campaign_id AND k.status = 'active'
           LEFT JOIN comments c ON c.id = s.comment_id
           WHERE s.status = 'queued' ORDER BY s.created_at LIMIT 1`,
        )
        .get();
      if (!job) break;
      const claim = db.prepare("UPDATE campaign_sends SET status = 'sending' WHERE id = ? AND status = 'queued'").run(job.id);
      if (claim.changes !== 1) continue;
      const finish = (status, reason = null) =>
        db.prepare('UPDATE campaign_sends SET status = ?, reason = ?, sent_at = ? WHERE id = ?').run(status, reason, status === 'sent' ? now() : null, job.id);

      if (job.comment_at && now() - job.comment_at > PRIVATE_REPLY_MAX_AGE_MS) {
        finish('skipped', 'comment_older_than_7_days');
        continue;
      }
      const campaign = getCampaign(job.campaign_id);
      try {
        await ig.privateReply(job.comment_id, render(campaign, job));
        finish('sent');
        sent++;
      } catch (e) {
        // Not retried: Meta allows one private reply per comment and a failed
        // POST may still have been delivered.
        finish('failed', safeErr(e).slice(0, 300));
        log(`campaign ${campaign.id} send failed:`, safeErr(e));
        if (e.code === 190) break;
        continue;
      }
      if (campaign.public_reply) {
        try {
          await ig.replyToComment(job.comment_id, campaign.public_reply);
        } catch (e) {
          log('campaign public reply failed:', safeErr(e));
        }
      }
    }
  } finally {
    draining = false;
  }
  return sent;
}

// A crash mid-send leaves rows in 'sending'. They are closed, never resent.
export function recoverInterrupted() {
  return db.prepare("UPDATE campaign_sends SET status = 'failed', reason = 'interrupted_by_restart' WHERE status = 'sending'").run().changes;
}

// ---------- tracked links ----------

/** Counts a click on /l/<token> and returns where to redirect, or null. */
export function resolveClick(token) {
  const row = db
    .prepare('SELECT s.id, c.link_url FROM campaign_sends s JOIN campaigns c ON c.id = s.campaign_id WHERE s.token = ?')
    .get(String(token || ''));
  if (!row?.link_url) return null;
  db.prepare('UPDATE campaign_sends SET clicks = clicks + 1, first_click_at = COALESCE(first_click_at, ?) WHERE id = ?').run(now(), row.id);
  return row.link_url;
}

export const sendLog = (campaignId, limit = 50) =>
  db
    .prepare('SELECT username, status, reason, clicks, created_at, sent_at FROM campaign_sends WHERE campaign_id = ? ORDER BY id DESC LIMIT ?')
    .all(campaignId, limit);
