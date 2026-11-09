// Telegram: notifications, draft cards with inline buttons, reply-to-edit,
// media upload channel, owner commands, long polling.
import crypto from 'node:crypto';
import { config, log, safeErr, UserError, humanDuration } from './config.js';
import { db, getSetting, setSetting, setPaused } from './db.js';
import { getThread, getDraft, getComment, threadMessages, windowRemaining, pendingDrafts, statusInfo } from './store.js';
import * as agent from './agent.js';
import * as media from './media.js';
import { listScheduled } from './scheduler.js';
import * as campaigns from './campaigns.js';
import { summaryText, snapshotInsights } from './stats.js';

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const who = (t) => (t?.username ? `@${esc(t.username)}` : esc(t?.name || t?.id || '?'));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ---------- Bot API ----------

export async function tg(method, params = {}, { timeoutMs = 20_000, signal } = {}) {
  if (!config.telegramToken) return null;
  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    const err = new Error(`telegram ${method}: ${json.description || res.status}`);
    err.code = json.error_code || res.status;
    throw err;
  }
  return json.result;
}

// Never throws: a Telegram outage must not break message handling.
export async function notify(text, extra = {}) {
  if (!config.telegramToken || !config.telegramChatId) return null;
  try {
    return await tg('sendMessage', {
      chat_id: config.telegramChatId,
      text: clip(text, 4000),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (e) {
    log('telegram notify failed:', safeErr(e));
    return null;
  }
}

async function editCard(messageId, text, keyboard = []) {
  if (!messageId || !config.telegramChatId) return;
  try {
    await tg('editMessageText', {
      chat_id: config.telegramChatId,
      message_id: messageId,
      text: clip(text, 4000),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (e) {
    if (!/not modified/i.test(e.message)) log('telegram edit failed:', safeErr(e));
  }
}

// ---------- draft cards ----------

function draftBody(draft) {
  let head;
  let incoming;
  if (draft.kind === 'dm') {
    const thread = getThread(draft.thread_id);
    const history = threadMessages(draft.thread_id, 30);
    const lastOut = history.findLastIndex((m) => m.direction === 'out' && m.created_at <= draft.created_at);
    incoming = history
      .slice(lastOut + 1)
      .filter((m) => m.direction === 'in' && m.created_at <= draft.updated_at)
      .map((m) => m.text)
      .join('\n');
    head = `💬 <b>הודעה</b> · ${who(thread)}`;
    if (draft.status === 'pending') head += `\n⏳ נותרו ${humanDuration(windowRemaining(thread))} לחלון המענה`;
  } else {
    const c = getComment(draft.comment_id);
    incoming = c?.text || '';
    head = `🗨 <b>תגובה לפוסט</b> · @${esc(c?.username || '?')}`;
  }
  return (
    `${head}\n\n<b>נכתב:</b>\n<i>${esc(clip(incoming, 1200))}</i>\n\n` +
    `<b>טיוטה #${draft.id}:</b>\n${esc(clip(draft.text, 2200))}`
  );
}

const draftKeyboard = (id) => [
  [
    { text: 'שלח ✅', callback_data: `d:send:${id}` },
    { text: 'נסח מחדש 🔄', callback_data: `d:regen:${id}` },
    { text: 'דלג ⏭', callback_data: `d:skip:${id}` },
  ],
];
const DRAFT_HINT = '\n\n<i>↩️ השב להודעה הזו כדי לערוך את הטקסט, או /re + הנחיה לניסוח מחדש</i>';

export async function sendDraftCard(draft) {
  const msg = await notify(draftBody(draft) + DRAFT_HINT, { reply_markup: { inline_keyboard: draftKeyboard(draft.id) } });
  if (msg?.message_id) db.prepare('UPDATE drafts SET tg_message_id = ? WHERE id = ?').run(msg.message_id, draft.id);
  return msg;
}

export async function updateDraftCard(draft) {
  if (!draft?.tg_message_id) return sendDraftCard(draft);
  await editCard(draft.tg_message_id, draftBody(draft) + DRAFT_HINT, draftKeyboard(draft.id));
}

// Final state: no buttons, a label saying what happened.
export async function closeDraftCard(draft, label) {
  if (!draft?.tg_message_id) return;
  const current = getDraft(draft.id) || draft;
  await editCard(draft.tg_message_id, `${draftBody(current)}\n\n— <b>${esc(label)}</b>`);
}

// ---------- media cards ----------

const TYPE_LABEL = { image: 'פוסט', story: 'סטורי', reel: 'ריל', carousel: 'קרוסלה' };

function mediaBody(rows) {
  const ids = rows.map((r) => `#${r.id}`).join(', ');
  const kinds = rows.every((r) => r.kind === 'video') ? 'וידאו' : rows.every((r) => r.kind === 'image') ? 'תמונה' : 'מדיה';
  const caption = rows[0].caption;
  return (
    `🖼 <b>${kinds}</b> ${ids}${rows.length > 1 ? ` · ${rows.length} קבצים` : ''}\n\n` +
    `<b>כיתוב:</b>\n${caption ? esc(clip(caption, 2200)) : '<i>(ללא)</i>'}`
  );
}

function mediaKeyboard(rows) {
  const gid = rows[0].group_id;
  const btn = (type) => ({ text: TYPE_LABEL[type], callback_data: `m:${type}:${gid}` });
  const row = [];
  if (rows.length > 1) row.push(btn('carousel'));
  else if (rows[0].kind === 'video') row.push(btn('reel'), btn('story'));
  else row.push(btn('image'), btn('story'));
  return [row, [{ text: 'שמור לאחר כך 📥', callback_data: `m:keep:${gid}` }]];
}
const MEDIA_HINT = '\n\n<i>↩️ השב להודעה הזו כדי לשנות את הכיתוב</i>';

async function sendMediaCard(groupId) {
  const rows = media.groupMedia(groupId);
  if (!rows.length) return;
  const msg = await notify(mediaBody(rows) + MEDIA_HINT, { reply_markup: { inline_keyboard: mediaKeyboard(rows) } });
  if (msg?.message_id) db.prepare('UPDATE media_files SET tg_message_id = ? WHERE group_id = ?').run(msg.message_id, groupId);
}

// ---------- incoming media (upload channel) ----------

async function downloadTelegramFile(fileId) {
  let file;
  try {
    file = await tg('getFile', { file_id: fileId });
  } catch (e) {
    if (/too big/i.test(e.message)) {
      throw new UserError('הקובץ גדול מ-20MB – בוט טלגרם לא יכול להוריד אותו. אפשר להעלות דרך upload_from_url בצ׳אט של Claude.');
    }
    throw e;
  }
  const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`telegram file download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function mediaFromMessage(msg) {
  if (msg.photo?.length) return { fileId: msg.photo.at(-1).file_id, mime: 'image/jpeg' };
  if (msg.video) return { fileId: msg.video.file_id, mime: msg.video.mime_type || 'video/mp4' };
  if (msg.document && /^(image|video)\//.test(msg.document.mime_type || '')) {
    return { fileId: msg.document.file_id, mime: msg.document.mime_type };
  }
  return null;
}

const albums = new Map(); // media_group_id -> { items, timer }
const ALBUM_WAIT_MS = Number(process.env.ALBUM_WAIT_MS ?? 1500);

async function ingest(items) {
  const groupId = crypto.randomBytes(4).toString('hex');
  const caption = items.map((i) => i.caption).find(Boolean) || null;
  let saved = 0;
  for (const item of items) {
    try {
      const buffer = await downloadTelegramFile(item.fileId);
      await media.saveUpload(buffer, { mime: item.mime, source: 'telegram', caption, groupId });
      saved++;
    } catch (e) {
      await notify(`❌ ${esc(e instanceof UserError ? e.message : `ההעלאה נכשלה: ${safeErr(e)}`)}`);
    }
  }
  if (saved) await sendMediaCard(groupId);
}

function onMediaMessage(msg, item) {
  item.caption = msg.caption;
  if (!msg.media_group_id) return ingest([item]);
  // Albums arrive as separate messages; collect them briefly, then make one card.
  const album = albums.get(msg.media_group_id) || { items: [] };
  album.items.push(item);
  clearTimeout(album.timer);
  album.timer = setTimeout(() => {
    albums.delete(msg.media_group_id);
    ingest(album.items).catch((e) => log('album ingest failed:', safeErr(e)));
  }, ALBUM_WAIT_MS);
  albums.set(msg.media_group_id, album);
  return album;
}

export async function flushAlbums() {
  const pending = [...albums.values()];
  albums.clear();
  for (const a of pending) {
    clearTimeout(a.timer);
    await ingest(a.items);
  }
}

// ---------- commands ----------

const ago = (ms) => (ms ? `לפני ${humanDuration(Date.now() - ms)}` : 'אף פעם');

function statusText() {
  const s = statusInfo();
  return [
    `<b>סטטוס</b>`,
    `אינסטגרם: ${s.connected ? `מחובר (@${esc(s.username)})` : `לא מחובר – ${config.publicUrl}/auth/login`}`,
    `מצב: ${s.paused ? '⏸ מושהה' : '▶️ פעיל'}`,
    `טיוטות ממתינות: ${s.pending_drafts}`,
    `פוסטים מתוזמנים: ${s.scheduled_posts}`,
    `טוקן: ${s.token_days_remaining == null ? '—' : `${s.token_days_remaining} ימים`}`,
    `סנכרון אחרון: ${ago(s.last_poll_ok)}`,
    `Webhook אחרון: ${ago(s.last_webhook_at)}`,
  ].join('\n');
}

const HELP = [
  '<b>פקודות</b>',
  '/status – מצב המערכת',
  '/today – סיכום היום (הודעות, תגובות, פרסומים, עוקבים)',
  '/campaigns – קמפיינים של תגובה → הודעה פרטית',
  '/pending – טיוטות שממתינות לאישור',
  '/queue – פוסטים מתוזמנים',
  '/pause – עצירת כל השליחות והטיוטות',
  '/resume – חזרה לפעילות',
  '',
  'שליחת תמונה/וידאו/אלבום לבוט = העלאה לפרסום.',
  'תשובה (Reply) לכרטיס טיוטה = עריכת הטקסט. /re + הנחיה = ניסוח מחדש.',
].join('\n');

async function onCommand(cmd, arg, msg) {
  switch (cmd) {
    case '/start':
    case '/help':
      return notify(HELP);
    case '/status':
      return notify(statusText());
    case '/today':
      await snapshotInsights({ maxAgeMs: 10 * 60_000 });
      return notify(summaryText());
    case '/campaigns': {
      const list = campaigns.listCampaigns();
      if (!list.length) return notify('אין קמפיינים. יוצרים אותם דרך הצ׳אט של Claude ("צור קמפיין: מי שמגיב לינק מקבל…").');
      const label = { active: '🟢 פעיל', paused: '⏸ מושהה', draft: '📝 ממתין לאישור' };
      for (const c of list.slice(0, 10)) {
        const buttons =
          c.status === 'draft'
            ? campaigns.cardFor(c.id).keyboard
            : [[c.status === 'active' ? { text: 'השהה ⏸', callback_data: `c:pause:${c.id}` } : { text: 'הפעל ▶️', callback_data: `c:resume:${c.id}` }]];
        await notify(
          `🎯 <b>#${c.id} ${esc(c.name)}</b> · ${label[c.status] || c.status}\n` +
            `מילים: ${esc(c.keywords.join(', '))}\n` +
            `נשלחו ${c.sent} · בתור ${c.queued} · קליקים ${c.clicked}${c.ctr != null ? ` (${c.ctr}%)` : ''}${c.failed ? ` · נכשלו ${c.failed}` : ''}`,
          { reply_markup: { inline_keyboard: buttons } },
        );
      }
      return null;
    }
    case '/pending': {
      const drafts = pendingDrafts().slice(0, 10);
      if (!drafts.length) return notify('אין טיוטות ממתינות 🎉');
      for (const d of drafts) await sendDraftCard(d);
      return null;
    }
    case '/queue': {
      const posts = listScheduled();
      if (!posts.length) return notify('אין פוסטים מתוזמנים.');
      return notify(
        `<b>פוסטים מתוזמנים</b>\n` +
          posts.map((p) => `#${p.id} · ${TYPE_LABEL[p.type]} · ${p.run_at}\n${esc(clip(p.caption || '', 80))}`).join('\n\n'),
      );
    }
    case '/pause':
      setPaused(true);
      agent.stopAgent();
      return notify('⏸ הסוכן מושהה. לא נוצרות טיוטות, לא נשלח ולא מתפרסם דבר עד /resume. הודעות נכנסות ממשיכות להישמר.');
    case '/resume': {
      setPaused(false);
      const n = agent.recoverPending();
      return notify(`▶️ הסוכן חזר לפעילות.${n ? ` ${n} שיחות ממתינות לטיוטה.` : ''}`);
    }
    case '/re': {
      const draft = msg.reply_to_message && draftByMessage(msg.reply_to_message.message_id);
      if (!draft) return notify('כדי לנסח מחדש: השב (Reply) לכרטיס הטיוטה עם /re והנחיה, למשל: /re קצר יותר');
      return agent.regenerateDraft(draft.id, arg);
    }
    default:
      return notify(HELP);
  }
}

const draftByMessage = (messageId) => db.prepare('SELECT * FROM drafts WHERE tg_message_id = ?').get(messageId);

// ---------- update handling ----------

async function onMessage(msg) {
  const chatId = String(msg.chat?.id ?? '');
  if (!config.telegramChatId) {
    // Setup mode only: tell whoever writes how to finish configuration.
    if (msg.text?.startsWith('/start')) {
      await tg('sendMessage', { chat_id: chatId, text: `ה-Chat ID שלך: ${chatId}\nהגדר TELEGRAM_CHAT_ID בקובץ .env והפעל מחדש.` });
    }
    return;
  }
  if (chatId !== String(config.telegramChatId)) return; // strangers get silence

  const item = mediaFromMessage(msg);
  if (item) return onMediaMessage(msg, item);

  const text = (msg.text || '').trim();
  if (!text) return;

  if (text.startsWith('/')) {
    const [raw, ...rest] = text.split(/\s+/);
    return onCommand(raw.split('@')[0].toLowerCase(), rest.join(' '), msg);
  }

  const repliedTo = msg.reply_to_message?.message_id;
  if (repliedTo) {
    const draft = draftByMessage(repliedTo);
    if (draft) return agent.editDraft(draft.id, text);
    const group = db.prepare('SELECT group_id FROM media_files WHERE tg_message_id = ? LIMIT 1').get(repliedTo);
    if (group) {
      db.prepare("UPDATE media_files SET caption = ? WHERE group_id = ? AND status != 'published'").run(text, group.group_id);
      const rows = media.groupMedia(group.group_id);
      return editCard(repliedTo, mediaBody(rows) + MEDIA_HINT, mediaKeyboard(rows));
    }
  }
  return notify('כדי לערוך טיוטה או כיתוב – השב (Reply) על הכרטיס המתאים. /help לרשימת הפקודות.');
}

const publishing = new Set(); // group ids being published (double-tap guard)

async function onMediaCallback(action, groupId, messageId) {
  const rows = media.groupMedia(groupId).filter((r) => r.status !== 'published');
  if (!rows.length) return 'המדיה כבר פורסמה או נמחקה.';
  if (action === 'keep') {
    await editCard(messageId, `${mediaBody(rows)}\n\n— <b>נשמר. אפשר לפרסם או לתזמן דרך הצ׳אט של Claude (list_media).</b>`);
    return 'נשמר';
  }
  if (publishing.has(groupId)) return 'כבר בתהליך פרסום…';
  publishing.add(groupId);
  try {
    await editCard(messageId, `${mediaBody(rows)}\n\n— <b>מפרסם ${TYPE_LABEL[action]}…</b>`);
    const res = await media.publishMedia({ type: action, ids: rows.map((r) => r.id) });
    await editCard(
      messageId,
      `${mediaBody(rows)}\n\n— <b>פורסם ✅ (${TYPE_LABEL[action]})</b>${res.permalink ? `\n${esc(res.permalink)}` : ''}`,
    );
    return 'פורסם ✅';
  } catch (e) {
    const reason = e instanceof UserError ? e.message : `הפרסום נכשל: ${safeErr(e)}`;
    await editCard(messageId, `${mediaBody(rows)}\n\n⚠️ ${esc(reason)}${MEDIA_HINT}`, mediaKeyboard(rows));
    return clip(reason, 190);
  } finally {
    publishing.delete(groupId);
  }
}

async function onCallback(q) {
  if (!config.telegramChatId || String(q.message?.chat?.id) !== String(config.telegramChatId)) return;
  const [scope, action, ref] = String(q.data || '').split(':');
  let answer = '';
  let alert = false;
  try {
    if (scope === 'd') {
      const id = Number(ref);
      if (action === 'send') {
        await agent.sendDraft(id, { via: 'telegram' });
        answer = 'נשלח ✅';
      } else if (action === 'skip') {
        await agent.skipDraft(id);
        answer = 'דולג';
      } else if (action === 'regen') {
        // Answer first: generating a new draft can outlive the callback timeout.
        await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'מנסח מחדש…' }).catch(() => {});
        await agent.regenerateDraft(id);
        return;
      }
    } else if (scope === 'c') {
      const id = Number(ref);
      if (action === 'on') {
        campaigns.approveCampaign(id);
        await editCard(q.message.message_id, `${campaigns.cardFor(id).text}\n\n— <b>פעיל 🟢</b>`);
        campaigns.processQueue().catch(() => {});
        answer = 'הקמפיין פעיל';
      } else if (action === 'del') {
        campaigns.setStatus(id, 'deleted');
        await editCard(q.message.message_id, `${campaigns.cardFor(id).text}\n\n— <b>נמחק</b>`);
        answer = 'נמחק';
      } else if (action === 'pause' || action === 'resume') {
        campaigns.setStatus(id, action === 'pause' ? 'paused' : 'active');
        answer = action === 'pause' ? 'הקמפיין הושהה' : 'הקמפיין פעיל';
        if (action === 'resume') campaigns.processQueue().catch(() => {});
      }
    } else if (scope === 'm') {
      if (action !== 'keep') await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'מפרסם…' }).catch(() => {});
      answer = await onMediaCallback(action, ref, q.message.message_id);
      if (action !== 'keep') return;
    }
  } catch (e) {
    alert = true;
    answer = e instanceof UserError ? e.message : `שגיאה: ${safeErr(e)}`;
    log('telegram callback error:', safeErr(e));
    if (scope === 'd' && action === 'regen') return void notify(`❌ ${esc(answer)}`);
  }
  await tg('answerCallbackQuery', { callback_query_id: q.id, text: clip(answer, 190), show_alert: alert }).catch(() => {});
}

export async function handleUpdate(update) {
  try {
    if (update.callback_query) await onCallback(update.callback_query);
    else if (update.message) await onMessage(update.message);
  } catch (e) {
    log('telegram update error:', safeErr(e));
    if (e instanceof UserError) await notify(`❌ ${esc(e.message)}`);
  }
}

// ---------- long polling ----------

let running = false;
let abort = null;

async function pollLoop() {
  let offset = Number(getSetting('tg_offset', 0)) || 0;
  while (running) {
    try {
      abort = new AbortController();
      const updates = await tg(
        'getUpdates',
        { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] },
        { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(65_000)]) },
      );
      for (const u of updates || []) {
        offset = u.update_id + 1;
        setSetting('tg_offset', offset); // persist first: a crashing update is not replayed forever
        await handleUpdate(u);
      }
    } catch (e) {
      if (!running) break;
      log('telegram polling error:', safeErr(e));
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export function startTelegram() {
  if (running || !config.telegramToken) return;
  running = true;
  pollLoop();
}

export function stopTelegram() {
  running = false;
  abort?.abort();
}
