import { route, resetMock, callsTo, calls, connect, telegramTexts, json } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const { db, setPaused } = await import('../src/db.js');
const { config, parseLocal, formatLocal } = await import('../src/config.js');
const media = await import('../src/media.js');
const scheduler = await import('../src/scheduler.js');
const telegram = await import('../src/telegram.js');
const mcp = await import('../src/mcp.js');
await connect();

const image = (width, height, format = 'png') =>
  sharp({ create: { width, height, channels: 4, background: { r: 200, g: 80, b: 40, alpha: 1 } } })
    .withMetadata({ exif: { IFD0: { Copyright: 'secret-location-data' } } })
    [format]()
    .toBuffer();

// Mocks the whole container -> status -> publish -> permalink sequence.
function mockPublish({ failTimes = 0 } = {}) {
  let n = 0;
  let failures = failTimes;
  route(/\/me\/media$/, ({ method }) => (method === 'POST' ? { id: `container-${++n}` } : { data: [] }));
  route(/\/container-\d+\?/, () => ({ status_code: 'FINISHED' }));
  route('/me/media_publish', () => (failures-- > 0 ? json({ error: { message: 'publish failed', code: 9007 } }, 400) : { id: 'published-1' }));
  route('/published-1?', () => ({ permalink: 'https://www.instagram.com/p/abc/' }));
  route('content_publishing_limit', () => ({ data: [{ quota_usage: 3, config: { quota_total: 100 } }] }));
}

test('images are converted to JPEG, EXIF is stripped, the file is served from an unguessable name', async () => {
  const row = await media.saveUpload(await image(1080, 1350), { mime: 'image/png', source: 'mcp', caption: 'שלום' });
  assert.deepEqual([row.kind, row.mime, row.width, row.height], ['image', 'image/jpeg', 1080, 1350]);
  assert.match(row.filename, /^[0-9a-f]{32}\.jpg$/);
  const file = fs.readFileSync(path.join(config.mediaDir, row.filename));
  const meta = await sharp(file).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.exif, undefined);
  assert.equal(file.includes('secret-location-data'), false);
  assert.equal(media.mediaUrl(row), `https://agent.test/media/${row.filename}`);

  const webp = await media.saveUpload(await image(800, 800, 'webp'), {});
  assert.equal(webp.mime, 'image/jpeg');
  await assert.rejects(media.saveUpload(Buffer.from('not an image at all'), { mime: 'image/png' }), /לא הצלחתי לקרוא/);
});

test('aspect ratio limits are enforced before Instagram is called', async () => {
  resetMock();
  mockPublish();
  const tall = await media.saveUpload(await image(1080, 1920), {}); // 9:16
  const wide = await media.saveUpload(await image(2000, 800), {}); // 2.5:1
  const ok = await media.saveUpload(await image(1080, 1080), {});

  await assert.rejects(media.publishMedia({ type: 'image', ids: [tall.id] }), /4:5/);
  await assert.rejects(media.publishMedia({ type: 'image', ids: [wide.id] }), /1\.91:1/);
  await assert.rejects(media.publishMedia({ type: 'story', ids: [ok.id] }), /9:16/);
  await assert.rejects(media.publishMedia({ type: 'reel', ids: [ok.id] }), /וידאו/);
  await assert.rejects(media.publishMedia({ type: 'carousel', ids: [ok.id] }), /בין 2 ל-10/);
  await assert.rejects(media.publishMedia({ type: 'image', ids: [99999] }), /לא נמצא/);
  assert.equal(callsTo('graph.instagram.com').length, 0);

  await media.publishMedia({ type: 'story', ids: [tall.id] });
  assert.equal(callsTo(/\/me\/media$/)[0].body.media_type, 'STORIES');
});

test('publish container flow: create -> wait for FINISHED -> publish -> permalink', async () => {
  resetMock();
  mockPublish();
  let polls = 0;
  route(/\/container-1\?/, () => ({ status_code: ++polls < 3 ? 'IN_PROGRESS' : 'FINISHED' }));
  const row = await media.saveUpload(await image(1080, 1080), {});
  const res = await media.publishMedia({ type: 'image', ids: [row.id], caption: 'כיתוב' });

  assert.deepEqual(res, { id: 'published-1', permalink: 'https://www.instagram.com/p/abc/' });
  const order = calls.filter((c) => c.url.includes('graph.instagram.com')).map((c) => `${c.method} ${new URL(c.url).pathname.split('/').slice(2).join('/')}`);
  assert.deepEqual(order, ['GET me/content_publishing_limit', 'POST me/media', 'GET container-1', 'GET container-1', 'GET container-1', 'POST me/media_publish', 'GET published-1']);
  assert.deepEqual(callsTo(/\/me\/media$/)[0].body, { image_url: media.mediaUrl(row), caption: 'כיתוב' });
  assert.deepEqual(callsTo('media_publish')[0].body, { creation_id: 'container-1' });
  assert.equal(media.getMedia(row.id).status, 'published');
});

test('publishing quota: a full 24h quota blocks the publish with a clear message', async () => {
  resetMock();
  mockPublish();
  route('content_publishing_limit', () => ({ data: [{ quota_usage: 100, config: { quota_total: 100 } }] }));
  const row = await media.saveUpload(await image(1080, 1080), {});
  await assert.rejects(media.publishMedia({ type: 'image', ids: [row.id] }), /מכסת הפרסום/);
  assert.equal(callsTo(/\/me\/media$/).length, 0);
});

test('carousel: one child container per item, then the parent with children ids', async () => {
  resetMock();
  mockPublish();
  const a = await media.saveUpload(await image(1080, 1080), {});
  const b = await media.saveUpload(await image(1080, 1350), {});
  await media.publishMedia({ type: 'carousel', ids: [a.id, b.id], caption: 'אלבום' });
  const creates = callsTo(/\/me\/media$/).map((c) => c.body);
  assert.equal(creates.length, 3);
  assert.deepEqual([creates[0].is_carousel_item, creates[1].is_carousel_item], [true, true]);
  assert.deepEqual(creates[2], { media_type: 'CAROUSEL', children: 'container-1,container-2', caption: 'אלבום' });
});

test('a container that ends in ERROR fails the publish and nothing is marked published', async () => {
  resetMock();
  mockPublish();
  route(/\/container-1\?/, () => ({ status_code: 'ERROR', status: 'bad media' }));
  const row = await media.saveUpload(await image(1080, 1080), {});
  await assert.rejects(media.publishMedia({ type: 'image', ids: [row.id] }), /ERROR/);
  assert.equal(callsTo('media_publish').length, 0);
  assert.equal(media.getMedia(row.id).status, 'new');
});

test('Jerusalem time parsing handles winter and summer offsets', () => {
  assert.equal(new Date(parseLocal('2026-12-15 18:30')).toISOString(), '2026-12-15T16:30:00.000Z'); // UTC+2
  assert.equal(new Date(parseLocal('2026-07-15 18:30')).toISOString(), '2026-07-15T15:30:00.000Z'); // UTC+3
  assert.equal(formatLocal(parseLocal('2027-01-01 00:05')), '2027-01-01 00:05');
  assert.throws(() => parseLocal('tomorrow at 5'), /פורמט זמן/);
});

test('scheduler: publishes when due, reports the permalink, retries twice then alerts', async () => {
  resetMock();
  mockPublish();
  const row = await media.saveUpload(await image(1080, 1080), {});
  const future = formatLocal(Date.now() + 3600_000);
  const post = await mcp.callTool('schedule_post', { type: 'image', media_ids: [row.id], caption: 'מתוזמן', when: future });
  assert.deepEqual([post.status, post.run_at], ['pending', future]);
  assert.equal(media.getMedia(row.id).status, 'scheduled');
  await assert.rejects(mcp.callTool('schedule_post', { type: 'image', media_ids: [row.id], when: '2020-01-01 10:00' }), /כבר עבר/);

  assert.equal(await scheduler.runDuePosts(), 0, 'not due yet');
  assert.equal(callsTo('media_publish').length, 0);

  // Paused: due posts wait.
  setPaused(true);
  assert.equal(await scheduler.runDuePosts(Date.now() + 2 * 3600_000), 0);
  setPaused(false);

  assert.equal(await scheduler.runDuePosts(Date.now() + 2 * 3600_000), 1);
  assert.equal((await mcp.callTool('list_scheduled', { all: true })).find((p) => p.id === post.id).status, 'done');
  assert.ok(telegramTexts().some((t) => t.includes(`#${post.id}`) && t.includes('instagram.com/p/abc')));
  assert.equal(await scheduler.runDuePosts(Date.now() + 3 * 3600_000), 0, 'never published twice');

  // Failure path: 3 attempts in total, then a failure alert.
  resetMock();
  mockPublish({ failTimes: 99 });
  const row2 = await media.saveUpload(await image(1080, 1080), {});
  const p2 = scheduler.schedulePost({ type: 'image', mediaIds: [row2.id], when: future });
  const far = Date.now() + 10 * 86_400_000;
  for (let i = 0; i < 5; i++) await scheduler.runDuePosts(far);
  const final = db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(p2.id);
  assert.deepEqual([final.status, final.attempts], ['failed', 3]);
  assert.equal(callsTo('media_publish').length, 3);
  assert.equal(telegramTexts().filter((t) => t.includes('נכשל 3 פעמים')).length, 1);
});

test('cancel and reschedule', async () => {
  const row = await media.saveUpload(await image(1080, 1080), {});
  const p = scheduler.schedulePost({ type: 'image', mediaIds: [row.id], when: formatLocal(Date.now() + 3600_000) });
  const later = formatLocal(Date.now() + 2 * 86_400_000);
  assert.equal(scheduler.reschedule(p.id, later).run_at, later);
  assert.equal(scheduler.cancelScheduled(p.id).status, 'cancelled');
  assert.equal(media.getMedia(row.id).status, 'new');
  assert.throws(() => scheduler.cancelScheduled(p.id), /כבר פורסם/);
});

test('Telegram upload: photo -> stored -> card -> caption edit by reply -> button publishes once', async () => {
  resetMock();
  mockPublish();
  const png = await image(1080, 1080);
  route('getFile', () => ({ ok: true, result: { file_path: 'photos/1.png' } }));
  route('/file/bot', () => new Response(png));

  await telegram.handleUpdate({ message: { chat: { id: 777 }, caption: 'כיתוב מטלגרם', photo: [{ file_id: 'small' }, { file_id: 'big' }] } });
  const row = db.prepare("SELECT * FROM media_files WHERE source = 'telegram' ORDER BY id DESC").get();
  assert.deepEqual([row.caption, row.status, row.mime], ['כיתוב מטלגרם', 'new', 'image/jpeg']);
  assert.equal(callsTo('getFile')[0].body.file_id, 'big');
  const card = callsTo('sendMessage').at(-1).body;
  assert.deepEqual(card.reply_markup.inline_keyboard[0].map((b) => b.text), ['פוסט', 'סטורי']);
  assert.equal(callsTo('graph.instagram.com').length, 0, 'uploading alone publishes nothing');

  await telegram.handleUpdate({ message: { chat: { id: 777 }, text: 'כיתוב חדש', reply_to_message: { message_id: row.tg_message_id } } });
  assert.equal(media.getMedia(row.id).caption, 'כיתוב חדש');

  const tap = { callback_query: { id: 'c', data: `m:image:${row.group_id}`, message: { message_id: row.tg_message_id, chat: { id: 777 } } } };
  await telegram.handleUpdate(tap);
  await telegram.handleUpdate(tap);
  assert.equal(callsTo('media_publish').length, 1);
  assert.equal(callsTo(/\/me\/media$/)[0].body.caption, 'כיתוב חדש');
  assert.ok(callsTo('editMessageText').some((c) => c.body.text.includes('פורסם ✅')));
});

test('Telegram album becomes one carousel card', async () => {
  resetMock();
  const png = await image(1080, 1080);
  route('getFile', () => ({ ok: true, result: { file_path: 'photos/x.png' } }));
  route('/file/bot', () => new Response(png));
  for (const id of ['a', 'b', 'c']) {
    await telegram.handleUpdate({ message: { chat: { id: 777 }, media_group_id: 'album-1', caption: id === 'a' ? 'אלבום' : undefined, photo: [{ file_id: id }] } });
  }
  await telegram.flushAlbums();
  const cards = callsTo('sendMessage');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].body.reply_markup.inline_keyboard[0][0].text, 'קרוסלה');
  assert.ok(cards[0].body.text.includes('3 קבצים'));
});

test('cleanup removes published media after 7 days and unpublished after 30, but keeps scheduled files', async () => {
  const day = 86_400_000;
  const mk = async (patch) => {
    const r = await media.saveUpload(await image(1080, 1080), {});
    db.prepare(`UPDATE media_files SET ${Object.keys(patch).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...patch, id: r.id });
    return r;
  };
  const oldPublished = await mk({ status: 'published', published_at: Date.now() - 8 * day });
  const newPublished = await mk({ status: 'published', published_at: Date.now() - 2 * day });
  const oldDraft = await mk({ created_at: Date.now() - 31 * day });
  const oldScheduled = await mk({ created_at: Date.now() - 31 * day });
  scheduler.schedulePost({ type: 'image', mediaIds: [oldScheduled.id], when: formatLocal(Date.now() + day) });

  media.cleanupMedia();
  const exists = (r) => !!media.getMedia(r.id) && fs.existsSync(path.join(config.mediaDir, r.filename));
  assert.deepEqual([exists(oldPublished), exists(newPublished), exists(oldDraft), exists(oldScheduled)], [false, true, false, true]);
});

test('backup: VACUUM INTO produces a readable copy and only 7 are kept', async () => {
  fs.mkdirSync(config.backupDir, { recursive: true });
  for (let d = 10; d < 20; d++) fs.writeFileSync(path.join(config.backupDir, `agent-2020-01-${d}.db`), 'old');
  const file = scheduler.backupNow();
  const { default: Database } = await import('better-sqlite3');
  const copy = new Database(file, { readonly: true });
  assert.ok(copy.prepare('SELECT COUNT(*) AS n FROM media_files').get().n > 0);
  copy.close();
  const kept = fs.readdirSync(config.backupDir);
  assert.equal(kept.length, 7);
  assert.ok(kept.includes(path.basename(file)));
});

test('upload_from_url refuses private addresses; upload_media refuses large base64', async () => {
  resetMock();
  for (const url of ['http://127.0.0.1/x.jpg', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/a.png', 'http://10.0.0.5/a.png']) {
    await assert.rejects(mcp.callTool('upload_from_url', { url }), /רשת פנימית/);
  }
  await assert.rejects(mcp.callTool('upload_from_url', { url: 'ftp://example.com/a.jpg' }), /http/);
  assert.equal(calls.length, 0);
  await assert.rejects(mcp.callTool('upload_media', { base64: 'A'.repeat(500_000) }), /גדול מדי/);

  const small = (await image(64, 64)).toString('base64');
  const up = await mcp.callTool('upload_media', { base64: small, caption: 'קטן' });
  assert.ok((await mcp.callTool('list_media')).some((m) => m.id === up.id && m.url.startsWith('https://agent.test/media/')));
});
