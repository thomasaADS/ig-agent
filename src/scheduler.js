// Scheduled posts, plus the once-a-minute housekeeping tick
// (nightly backup, media cleanup, token refresh).
import fs from 'node:fs';
import path from 'node:path';
import { config, log, safeErr, UserError, parseLocal, formatLocal, localDay, localHour } from './config.js';
import { db, getSetting, setSetting, isPaused } from './db.js';
import * as ig from './instagram.js';
import { publishMedia, resolveMedia, cleanupMedia } from './media.js';
import { notify, esc } from './telegram.js';

const MAX_ATTEMPTS = 3; // first try + two retries
const RETRY_DELAY_MS = 5 * 60_000;
const TYPES = ['image', 'carousel', 'story', 'reel'];

const getPost = (id) => db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(id);
const view = (p) => ({
  id: p.id,
  type: p.type,
  media: JSON.parse(p.media),
  caption: p.caption,
  run_at: formatLocal(p.run_at),
  status: p.status,
  attempts: p.attempts,
  result: p.result,
});

function parseFuture(when) {
  const runAt = parseLocal(when);
  if (runAt < Date.now() - 60_000) throw new UserError('הזמן שנבחר כבר עבר (הזמנים בשעון ישראל).');
  return runAt;
}

export function schedulePost({ type, mediaIds, caption, when }) {
  if (!TYPES.includes(type)) throw new UserError('סוג פרסום לא מוכר.');
  const runAt = parseFuture(when);
  resolveMedia(mediaIds, type); // fail now, not at 3am
  const info = db
    .prepare('INSERT INTO scheduled_posts (type, media, caption, run_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(type, JSON.stringify(mediaIds), caption ?? null, runAt, Date.now());
  const mark = db.prepare("UPDATE media_files SET status = 'scheduled' WHERE id = ? AND status = 'new'");
  for (const id of mediaIds) mark.run(id);
  return view(getPost(Number(info.lastInsertRowid)));
}

export const listScheduled = ({ all = false } = {}) =>
  db
    .prepare(
      all
        ? 'SELECT * FROM scheduled_posts ORDER BY run_at DESC LIMIT 50'
        : "SELECT * FROM scheduled_posts WHERE status IN ('pending', 'publishing') ORDER BY run_at",
    )
    .all()
    .map(view);

export function cancelScheduled(id) {
  const post = getPost(id);
  const r = db.prepare("UPDATE scheduled_posts SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(id);
  if (r.changes !== 1) throw new UserError('הפוסט המתוזמן לא נמצא או שכבר פורסם/בוטל.');
  const free = db.prepare("UPDATE media_files SET status = 'new' WHERE id = ? AND status = 'scheduled'");
  for (const mid of JSON.parse(post.media)) free.run(mid);
  return view(getPost(id));
}

export function reschedule(id, when) {
  const runAt = parseFuture(when);
  const r = db
    .prepare("UPDATE scheduled_posts SET run_at = ?, attempts = 0 WHERE id = ? AND status = 'pending'")
    .run(runAt, id);
  if (r.changes !== 1) throw new UserError('הפוסט המתוזמן לא נמצא או שכבר פורסם/בוטל.');
  return view(getPost(id));
}

// Publishes every due post. While paused nothing runs; posts wait for /resume.
export async function runDuePosts(now = Date.now()) {
  if (isPaused() || !ig.isConnected()) return 0;
  const due = db.prepare("SELECT * FROM scheduled_posts WHERE status = 'pending' AND run_at <= ? ORDER BY run_at").all(now);
  let done = 0;
  for (const post of due) {
    // Atomic claim so overlapping ticks can never publish the same post twice.
    const claim = db
      .prepare("UPDATE scheduled_posts SET status = 'publishing', attempts = attempts + 1 WHERE id = ? AND status = 'pending'")
      .run(post.id);
    if (claim.changes !== 1) continue;
    const attempts = post.attempts + 1;
    try {
      const res = await publishMedia({ type: post.type, ids: JSON.parse(post.media), caption: post.caption ?? undefined });
      db.prepare("UPDATE scheduled_posts SET status = 'done', result = ? WHERE id = ?").run(res.permalink || res.id, post.id);
      await notify(`✅ פוסט מתוזמן #${post.id} פורסם${res.permalink ? `\n${esc(res.permalink)}` : ''}`);
      done++;
    } catch (e) {
      const reason = e instanceof UserError ? e.message : safeErr(e);
      if (attempts >= MAX_ATTEMPTS) {
        db.prepare("UPDATE scheduled_posts SET status = 'failed', result = ? WHERE id = ?").run(reason.slice(0, 500), post.id);
        await notify(`❌ פוסט מתוזמן #${post.id} נכשל ${MAX_ATTEMPTS} פעמים ולא יפורסם.\nסיבה: ${esc(reason)}`);
      } else {
        db.prepare("UPDATE scheduled_posts SET status = 'pending', run_at = ?, result = ? WHERE id = ?").run(
          Date.now() + RETRY_DELAY_MS,
          reason.slice(0, 500),
          post.id,
        );
        log(`scheduled post ${post.id} failed (attempt ${attempts}), will retry:`, reason);
      }
    }
  }
  return done;
}

// ---------- nightly backup ----------

export function backupNow() {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const file = path.join(config.backupDir, `agent-${localDay()}.db`);
  fs.rmSync(file, { force: true }); // VACUUM INTO refuses to overwrite
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = fs
    .readdirSync(config.backupDir)
    .filter((f) => /^agent-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .reverse()
    .slice(7);
  for (const f of old) fs.rmSync(path.join(config.backupDir, f), { force: true });
  return file;
}

async function nightly() {
  const today = localDay();
  if (getSetting('last_nightly') === today || localHour() < 3) return;
  setSetting('last_nightly', today);
  try {
    backupNow();
    const removed = cleanupMedia();
    log(`nightly: backup done, ${removed} media files cleaned`);
  } catch (e) {
    log('nightly failed:', safeErr(e));
    await notify(`⚠️ הגיבוי הלילי נכשל: ${esc(safeErr(e))}`);
  }
}

// ---------- tick ----------

let timer = null;
let ticking = false;

export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await runDuePosts();
    await nightly();
    await ig.refreshTokenIfNeeded().catch((e) => log('token refresh failed:', safeErr(e)));
    const days = ig.tokenDaysLeft();
    if (days != null && days <= 5 && getSetting('token_low_alert') !== localDay()) {
      setSetting('token_low_alert', localDay());
      await notify(`⚠️ הטוקן של אינסטגרם יפוג בעוד ${days} ימים והרענון האוטומטי לא הצליח. התחבר מחדש:\n${config.publicUrl}/auth/login`);
    }
  } catch (e) {
    log('tick error:', safeErr(e));
  } finally {
    ticking = false;
  }
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(tick, 60_000);
  setTimeout(tick, 10_000).unref();
}

export function stopScheduler() {
  clearInterval(timer);
  timer = null;
}
