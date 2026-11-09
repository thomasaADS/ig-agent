import { route, resetMock, callsTo, connect, telegramTexts } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { db, getNum, setSetting } = await import('../src/db.js');
const inbox = await import('../src/inbox.js');
const agent = await import('../src/agent.js');
await connect();

const iso = (ms) => new Date(ms).toISOString();
const conv = (id, user, updated) => ({ id, updated_time: iso(updated), participants: { data: [{ id: 'me-app-scoped', username: 'ben' }, { id: user, username: `name_${user}` }] } });
const msg = (id, from, text, at) => ({ id, created_time: iso(at), from: { id: from, username: from === 'me-app-scoped' ? 'ben' : `name_${from}` }, message: text });

test('last_sync is the time the sync STARTED minus 60s, so mid-sync updates are not lost', async () => {
  resetMock();
  const t0 = Date.now();
  route('/me/media', () => ({ data: [] }));
  route('/me/conversations', async () => {
    await new Promise((r) => setTimeout(r, 40)); // the sync takes a while
    return { data: [conv('c1', 'p1', t0)] };
  });
  route('/c1?', () => ({ messages: { data: [msg('m1', 'p1', 'ראשונה', t0 - 1000)] } }));
  await inbox.syncInbox();
  const finished = Date.now();
  const stored = getNum('last_sync');
  assert.ok(stored <= t0 + 20 - 60_000 + 20, 'based on the start time, with a 60s overlap');
  assert.ok(stored < finished - 60_000, 'never the end-of-loop clock');

  // A message that arrived while the first sync was running (older than "finished").
  const during = t0 + 10;
  route('/me/conversations', () => ({ data: [conv('c1', 'p1', during)] }));
  route('/c1?', () => ({ messages: { data: [msg('m2', 'p1', 'הגיעה באמצע הסנכרון', during), msg('m1', 'p1', 'ראשונה', t0 - 1000)] } }));
  const res = await inbox.syncInbox();
  assert.equal(res.newMessages, 1, 'picked up on the next sync; the old one is deduped');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = 'p1'").get().n, 2);
  agent.stopAgent();
});

test('conversations older than the sync window stop the walk; pages are followed', async () => {
  resetMock();
  const now = Date.now();
  setSetting('last_sync', now - 10 * 60_000);
  route('/me/media', () => ({ data: [] }));
  route('/me/conversations', ({ url }) => {
    const after = new URL(url).searchParams.get('after');
    if (!after) return { data: [conv('c10', 'p10', now - 1000)], paging: { cursors: { after: 'page2' }, next: 'x' } };
    if (after === 'page2') return { data: [conv('c11', 'p11', now - 2000), conv('c-old', 'p-old', now - 3600_000)], paging: { cursors: { after: 'page3' }, next: 'x' } };
    throw new Error('should have stopped before page 3');
  });
  route('/c10?', () => ({ messages: { data: [msg('m10', 'p10', 'א', now - 1000)] } }));
  route('/c11?', () => ({ messages: { data: [msg('m11', 'p11', 'ב', now - 2000)] } }));
  const res = await inbox.syncInbox();
  assert.deepEqual([res.conversations, res.newMessages], [2, 2]);
  assert.equal(callsTo('/c-old').length, 0);
  agent.stopAgent();
});

test('polling sees the owner reply in the app and supersedes the pending draft', async () => {
  resetMock();
  const now = Date.now();
  route('/me/media', () => ({ data: [] }));
  route('/me/conversations', () => ({ data: [conv('c20', 'p20', now)] }));
  route('/c20?', () => ({ messages: { data: [msg('m20', 'p20', 'שאלה', now - 5000)] } }));
  await inbox.syncInbox();
  await agent.flushDebounce();
  const d = db.prepare("SELECT * FROM drafts WHERE thread_id = 'p20'").get();
  assert.equal(d.status, 'pending');

  route('/c20?', () => ({ messages: { data: [msg('m21', 'me-app-scoped', 'עניתי מהאפליקציה', now + 1000), msg('m20', 'p20', 'שאלה', now - 5000)] } }));
  await inbox.syncInbox();
  assert.equal(db.prepare('SELECT status FROM drafts WHERE id = ?').get(d.id).status, 'superseded');
  assert.equal(db.prepare("SELECT direction FROM messages WHERE id = 'm21'").get().direction, 'out');
});

test('comments: captions cached per media, pagination followed, only fresh top-level comments drafted', async () => {
  resetMock();
  const now = Date.now();
  route('/me/media', () => ({ data: [{ id: 'post1', caption: 'כיתוב הפוסט', permalink: 'https://ig/p/1', timestamp: iso(now - 3600_000), comments_count: 3 }] }));
  route('/post1/comments', ({ url }) => {
    if (!new URL(url).searchParams.get('after')) {
      return { data: [{ id: 'c1', text: 'מהמם!', username: 'fan1', timestamp: iso(now - 60_000) }, { id: 'c-own', text: 'תודה', username: 'ben', timestamp: iso(now) }], paging: { cursors: { after: 'p2' }, next: 'x' } };
    }
    return {
      data: [
        { id: 'c2', text: 'ישן', username: 'fan2', timestamp: iso(now - 10 * 86_400_000) },
        { id: 'c3', text: 'כבר נענה', username: 'fan3', timestamp: iso(now - 60_000), replies: { data: [{ id: 'r1', username: 'ben', text: 'תודה!' }] } },
      ],
    };
  });
  const res = await inbox.syncComments();
  assert.equal(res.newComments, 1);
  const status = Object.fromEntries(db.prepare('SELECT id, status FROM comments').all().map((r) => [r.id, r.status]));
  assert.deepEqual(status, { c1: 'new', c2: 'old', c3: 'replied' });

  const d = db.prepare("SELECT * FROM drafts WHERE comment_id = 'c1'").get();
  assert.equal(d.status, 'pending');
  assert.ok(callsTo('api.anthropic.com')[0].body.messages[0].content.includes('כיתוב הפוסט'));
  assert.ok(telegramTexts().some((t) => t.includes('מהמם!') && t.includes('@fan1')));
  assert.equal(callsTo('/replies').length, 0, 'no comment reply without approval');

  // Unchanged comment count -> no refetch on the next cycle.
  const before = callsTo('/post1/comments').length;
  await inbox.syncComments();
  assert.equal(callsTo('/post1/comments').length, before);

  route('/c1/replies', () => ({ id: 'reply-1' }));
  await agent.sendDraft(d.id);
  assert.deepEqual(callsTo('/c1/replies')[0].body, { message: d.text });
  assert.equal(db.prepare("SELECT status FROM comments WHERE id = 'c1'").get().status, 'replied');
});

test('five consecutive poll failures alert Telegram once', async () => {
  resetMock();
  route('/me/conversations', () => new Response('{"error":{"message":"down"}}', { status: 400 }));
  for (let i = 0; i < 6; i++) await inbox.pollOnce().catch(() => {});
  assert.equal(telegramTexts().filter((t) => t.includes('5 פעמים ברצף')).length, 1);
});
