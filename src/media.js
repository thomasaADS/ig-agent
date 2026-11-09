// Uploaded media: normalise, validate against Instagram limits, publish, clean up.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { config, log, safeErr, UserError } from './config.js';
import { db, isPaused } from './db.js';
import * as ig from './instagram.js';

const run = promisify(execFile);

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const MAX_FETCH_BYTES = MAX_VIDEO_BYTES;
const FEED_MIN = 4 / 5; // 0.8  (portrait 4:5)
const FEED_MAX = 1.91; // landscape 1.91:1
const STORY_RATIO = 9 / 16;
const RATIO_TOLERANCE = 0.03;

export const getMedia = (id) => db.prepare('SELECT * FROM media_files WHERE id = ?').get(id);
export const groupMedia = (groupId) => db.prepare('SELECT * FROM media_files WHERE group_id = ? ORDER BY id').all(groupId);
export const mediaUrl = (row) => `${config.publicUrl}/media/${row.filename}`;
export const listUnpublished = () =>
  db.prepare("SELECT * FROM media_files WHERE status != 'published' ORDER BY id DESC").all();

// ---------- ingest ----------

function sniffKind(buffer, mime = '') {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  // ISO-BMFF: "ftyp" at offset 4. HEIC/AVIF are images, the rest video.
  if (buffer.length > 12 && buffer.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buffer.toString('latin1', 8, 12);
    return /^(heic|heix|hevc|mif1|msf1|avif)/.test(brand) ? 'image' : 'video';
  }
  return 'image';
}

// Any image format sharp can read -> upright sRGB JPEG, no EXIF, under 8MB.
async function normaliseImage(buffer) {
  let img;
  let meta;
  try {
    img = sharp(buffer, { failOn: 'error' }).rotate(); // applies EXIF orientation, then metadata is dropped
    meta = await img.metadata();
  } catch {
    throw new UserError('לא הצלחתי לקרוא את התמונה. פורמטים נתמכים: JPEG, PNG, WebP (HEIC – רק אם השרת תומך). נסה לשלוח כ-JPEG.');
  }
  if (!meta.width || !meta.height) throw new UserError('קובץ התמונה פגום או ריק.');

  for (const quality of [90, 82, 74, 66]) {
    const out = await img
      .clone()
      .resize({ width: 1440, height: 1800, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    if (out.data.length <= MAX_IMAGE_BYTES) {
      return { data: out.data, width: out.info.width, height: out.info.height };
    }
  }
  throw new UserError('התמונה גדולה מדי גם אחרי דחיסה (מקסימום 8MB).');
}

let ffprobeAvailable;
async function probeVideo(file) {
  if (ffprobeAvailable === false) return null;
  try {
    const { stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeout: 20_000 },
    );
    ffprobeAvailable = true;
    return JSON.parse(stdout);
  } catch (e) {
    if (e.code === 'ENOENT') {
      ffprobeAvailable = false;
      log('ffprobe not found: videos are passed through unvalidated');
      return null;
    }
    throw new UserError('קובץ הווידאו לא קריא או פגום.');
  }
}

async function inspectVideo(file) {
  const info = await probeVideo(file);
  if (!info) return {}; // no ffprobe: let Instagram judge
  const container = info.format?.format_name || '';
  const video = (info.streams || []).find((s) => s.codec_type === 'video');
  const audio = (info.streams || []).find((s) => s.codec_type === 'audio');
  if (!/mp4|mov/.test(container)) throw new UserError('אינסטגרם מקבל וידאו רק בפורמט MP4 או MOV.');
  if (!video) throw new UserError('לא נמצא ערוץ וידאו בקובץ.');
  if (!['h264', 'hevc'].includes(video.codec_name)) {
    throw new UserError(`קידוד וידאו לא נתמך (${video.codec_name}). צריך H.264 או HEVC.`);
  }
  if (audio && audio.codec_name !== 'aac') throw new UserError(`קידוד אודיו לא נתמך (${audio.codec_name}). צריך AAC.`);
  const rotated = Math.abs(Number(video.side_data_list?.[0]?.rotation || video.tags?.rotate || 0)) % 180 === 90;
  return {
    width: rotated ? video.height : video.width,
    height: rotated ? video.width : video.height,
    duration: Number(info.format?.duration) || null,
  };
}

/**
 * Stores an uploaded file. Images are converted to JPEG; videos are validated
 * when ffprobe exists. Throws UserError with a Hebrew explanation on bad input.
 */
export async function saveUpload(buffer, { mime, source, caption, groupId } = {}) {
  const kind = sniffKind(buffer, mime);
  const name = crypto.randomBytes(16).toString('hex'); // unguessable public URL
  let row;

  if (kind === 'image') {
    const { data, width, height } = await normaliseImage(buffer);
    const filename = `${name}.jpg`;
    fs.writeFileSync(path.join(config.mediaDir, filename), data);
    row = { filename, kind, mime: 'image/jpeg', width, height, size: data.length, duration: null };
  } else {
    if (buffer.length > MAX_VIDEO_BYTES) throw new UserError('הווידאו גדול מדי (מקסימום 300MB).');
    const filename = `${name}.mp4`;
    const file = path.join(config.mediaDir, filename);
    fs.writeFileSync(file, buffer);
    let meta;
    try {
      meta = await inspectVideo(file);
    } catch (e) {
      fs.rmSync(file, { force: true });
      throw e;
    }
    row = { filename, kind, mime: 'video/mp4', width: meta.width ?? null, height: meta.height ?? null, size: buffer.length };
  }

  const info = db
    .prepare(
      `INSERT INTO media_files (filename, kind, mime, width, height, size, caption, source, group_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.filename,
      row.kind,
      row.mime,
      row.width,
      row.height,
      row.size,
      caption || null,
      source || null,
      groupId || crypto.randomBytes(4).toString('hex'),
      Date.now(),
    );
  return getMedia(Number(info.lastInsertRowid));
}

// ---------- fetch from a public URL (SSRF-guarded) ----------

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UserError('כתובת URL לא תקינה.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new UserError('רק כתובות http/https נתמכות.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new UserError('הכתובת לא נגישה או מצביעה לרשת פנימית.');
  }
  return url;
}

export async function fetchFromUrl(raw, opts = {}) {
  let url = await assertPublicUrl(raw);
  let res;
  for (let hop = 0; ; hop++) {
    res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    if (res.status < 300 || res.status >= 400) break;
    if (hop >= 4) throw new UserError('יותר מדי הפניות (redirects).');
    url = await assertPublicUrl(new URL(res.headers.get('location') || '', url).toString());
  }
  if (!res.ok) throw new UserError(`ההורדה נכשלה (HTTP ${res.status}).`);
  if (Number(res.headers.get('content-length') || 0) > MAX_FETCH_BYTES) throw new UserError('הקובץ גדול מדי.');

  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_FETCH_BYTES) throw new UserError('הקובץ גדול מדי.');
    chunks.push(chunk);
  }
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
  return saveUpload(Buffer.concat(chunks), { mime, source: 'url', ...opts });
}

// ---------- validation against Instagram's limits ----------

export function validateFor(row, type) {
  const ratio = row.width && row.height ? row.width / row.height : null;
  const label = `קובץ #${row.id}`;
  if (type === 'reel' && row.kind !== 'video') throw new UserError(`${label}: ריל חייב להיות וידאו.`);
  if (type === 'image' && row.kind !== 'image') throw new UserError(`${label}: פוסט תמונה חייב להיות תמונה. לווידאו השתמש בריל.`);
  if (!ratio) return; // unknown dimensions (no ffprobe): Instagram decides

  if ((type === 'image' || type === 'carousel') && (ratio < FEED_MIN - RATIO_TOLERANCE || ratio > FEED_MAX + RATIO_TOLERANCE)) {
    throw new UserError(
      `${label}: יחס התמונה ${ratio.toFixed(2)}:1 לא מתאים לפיד. אינסטגרם מקבל בין 4:5 (לאורך) ל-1.91:1 (לרוחב). צריך לחתוך את התמונה.`,
    );
  }
  if (type === 'story' && Math.abs(ratio - STORY_RATIO) > RATIO_TOLERANCE) {
    throw new UserError(`${label}: סטורי צריך יחס 9:16 (לאורך). היחס כאן ${ratio.toFixed(2)}:1 – צריך לחתוך.`);
  }
}

export function resolveMedia(ids, type) {
  const rows = ids.map((id) => {
    const row = getMedia(id);
    if (!row) throw new UserError(`קובץ מדיה #${id} לא נמצא.`);
    if (!fs.existsSync(path.join(config.mediaDir, row.filename))) throw new UserError(`קובץ מדיה #${id} נמחק מהשרת.`);
    return row;
  });
  if (!rows.length) throw new UserError('לא נבחרה מדיה.');
  if (type === 'carousel' && (rows.length < 2 || rows.length > 10)) throw new UserError('קרוסלה צריכה בין 2 ל-10 פריטים.');
  if (['image', 'reel', 'story'].includes(type) && rows.length !== 1) throw new UserError('לסוג הפרסום הזה צריך קובץ אחד בדיוק.');
  if (!['image', 'reel', 'story', 'carousel'].includes(type)) throw new UserError('סוג פרסום לא מוכר.');
  for (const row of rows) validateFor(row, type);
  return rows;
}

// ---------- publish ----------

// Callers invoke this only after an explicit owner action (Telegram button,
// MCP tool call, or a post the owner scheduled).
export async function publishMedia({ type, ids, caption }) {
  if (isPaused()) throw new UserError('הסוכן מושהה (/resume כדי להפעיל מחדש). לא פורסם דבר.');
  const rows = resolveMedia(ids, type);
  const text = caption ?? rows[0].caption ?? '';
  // Instagram's rolling 24h publishing quota. Unknown / failed lookup never blocks.
  const quota = await ig.publishingLimit().catch(() => null);
  if (quota?.limit && quota.used >= quota.limit) {
    throw new UserError(`הגעת למכסת הפרסום של אינסטגרם (${quota.used}/${quota.limit} ב-24 שעות). נסה שוב מאוחר יותר.`);
  }
  const result = await ig.publish({
    type,
    caption: type === 'story' ? undefined : text,
    media: rows.map((r) => ({ url: mediaUrl(r), kind: r.kind })),
  });
  const mark = db.prepare("UPDATE media_files SET status = 'published', published_at = ? WHERE id = ?");
  for (const r of rows) mark.run(Date.now(), r.id);
  return result;
}

// ---------- cleanup ----------

const DAY = 86_400_000;

export function cleanupMedia(now = Date.now()) {
  const scheduled = new Set(
    db
      .prepare("SELECT media FROM scheduled_posts WHERE status IN ('pending', 'publishing')")
      .all()
      .flatMap((r) => JSON.parse(r.media)),
  );
  const stale = db
    .prepare(
      `SELECT * FROM media_files
       WHERE (status = 'published' AND published_at < ?) OR (status != 'published' AND created_at < ?)`,
    )
    .all(now - 7 * DAY, now - 30 * DAY)
    .filter((r) => !scheduled.has(r.id));
  for (const r of stale) {
    try {
      fs.rmSync(path.join(config.mediaDir, r.filename), { force: true });
      db.prepare('DELETE FROM media_files WHERE id = ?').run(r.id);
    } catch (e) {
      log('media cleanup failed:', safeErr(e));
    }
  }
  return stale.length;
}
