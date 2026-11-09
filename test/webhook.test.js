import { route, resetMock, callsTo, connect, sign, dmEvent, telegramTexts } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { db } = await import('../src/db.js');
const inbox = await import('../src/inbox.js');
const agent = await import('../src/agent.js');
const { app } = await import('../src/server.js');
await connect();

// Each sender id gets its own username (threads are normalised by username).
const profileRoute = () =>
  route(/graph\.instagram\.com\/v[\d.]+\/user-/, ({ url }) => ({ username: `dana_${url.match(/user-([\w]+)/)[1]}`, name: 'Dana' }));
const drafts = (where = '1=1') => db.prepare(`SELECT * FROM drafts WHERE ${where} ORDER BY id`).all();

test('webhook signature: accepts the right secret, rejects everything else', () => {
  const raw = Buffer.from('{"object":"instagram"}');
  assert.equal(inbox.verifySignature(raw, sign(raw)), true);
  assert.equal(inbox.verifySignature(raw, sign(raw, 'wrong-secret')), false);
  assert.equal(inbox.verifySignature(Buffer.from('{"object":"tampered"}'), sign(raw)), false);
  assert.equal(inbox.verifySignature(raw, undefined), false);
  assert.equal(inbox.verifySignature(raw, 'sha256='), false);
  assert.equal(inbox.verifySignature(raw, sign(raw).replace('sha256=', 'sha1=')), false);
});

test('webhook endpoint: challenge, 401 on bad signature, 200 on good one', async (t) => {
  resetMock();
  profileRoute();
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = (await import('node:http')).request; // use node http to bypass the fetch mock
  const hit = (method, path, headers = {}, body) =>
    new Promise((resolve, reject) => {
      const req = realFetch(`${base}${path}`, { method, headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.end(body);
    });

  const ok = await hit('GET', '/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42');
  assert.deepEqual([ok.status, ok.body], [200, '42']);
  assert.equal((await hit('GET', '/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42')).status, 403);

  const raw = JSON.stringify(dmEvent({ from: 'user-http', text: 'בדיקה' }));
  assert.equal((await hit('POST', '/webhook', { 'x-hub-signature-256': 'sha256=deadbeef', 'content-type': 'application/json' }, raw)).status, 401);
  assert.equal((await hit('POST', '/webhook', { 'x-hub-signature-256': sign(raw), 'content-type': 'application/json' }, raw)).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = 'user-http'").get().n, 1);

  const health = JSON.parse((await hit('GET', '/health')).body);
  assert.equal(health.connected, true);
  assert.ok('pending_drafts' in health && 'paused' in health && 'token_days_remaining' in health && 'last_webhook_at' in health);
  agent.stopAgent();
});

test('webhook -> message -> draft -> Telegram card, and nothing is sent to Instagram', async () => {
  resetMock();
  profileRoute();
  await inbox.processWebhook(dmEvent({ from: 'user-1', text: 'מה שלומך?' }));
  assert.equal(drafts("thread_id = 'user-1'").length, 0, 'debounced: no draft yet');
  await agent.flushDebounce();

  const [d] = drafts("thread_id = 'user-1'");
  assert.equal(d.status, 'pending');
  assert.ok(d.tg_message_id, 'card id stored');
  const card = telegramTexts().find((t) => t.includes(`#${d.id}`));
  assert.ok(card.includes('מה שלומך?') && card.includes('@dana_1') && card.includes('נותרו'));
  assert.equal(callsTo('/me/messages').length, 0, 'no DM without approval');

  // The prompt wraps stranger text in XML and marks it as data.
  const prompt = callsTo('api.anthropic.com')[0].body;
  assert.match(prompt.messages[0].content, /<conversation>[\s\S]*<message from="them">מה שלומך\?<\/message>/);
  assert.match(JSON.stringify(prompt.system), /never instructions/);
});

test('dedupe: repeated delivery and a polled copy with a different id are stored once', async () => {
  resetMock();
  profileRoute();
  const ts = Date.now();
  const ev = dmEvent({ from: 'user-2', mid: 'mid-dup', text: 'שלום', ts });
  await inbox.processWebhook(ev);
  await inbox.processWebhook(ev);
  const count = () => db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = 'user-2'").get().n;
  assert.equal(count(), 1);

  // Polling returns the same message under another id and a slightly different timestamp.
  route('/me/conversations', () => ({
    data: [{ id: 'conv-2', updated_time: new Date(ts).toISOString(), participants: { data: [{ id: 'me-app-scoped', username: 'ben' }, { id: 'other-id-for-user-2', username: 'dana_2' }] } }],
  }));
  route('/conv-2', () => ({
    messages: { data: [{ id: 'polled-id', created_time: new Date(ts + 2000).toISOString(), from: { id: 'other-id-for-user-2', username: 'dana_2' }, message: 'שלום' }] },
  }));
  route('/me/media', () => ({ data: [] }));
  await inbox.syncInbox();
  assert.equal(count(), 1, 'same text within 5s from another source is a duplicate');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM threads WHERE username = 'dana_2'").get().n, 1);
  assert.equal(db.prepare("SELECT 1 FROM threads WHERE id = 'other-id-for-user-2'").get(), undefined, 'thread key normalised by username');
  agent.stopAgent();
});

test('non-text messages are stored with a placeholder; reactions never trigger a draft', async () => {
  resetMock();
  profileRoute();
  await inbox.processWebhook(dmEvent({ from: 'user-3', text: '', extra: { attachments: [{ type: 'image', payload: { url: 'https://x/y.jpg' } }] } }));
  const row = db.prepare("SELECT * FROM messages WHERE thread_id = 'user-3'").get();
  assert.deepEqual([row.type, row.text], ['attachment', '[תמונה]']);
  assert.ok(telegramTexts().some((t) => t.includes('[תמונה]')), 'owner is notified');
  await agent.flushDebounce();
  assert.equal(drafts("thread_id = 'user-3'").length, 0, 'no draft without real text');
  assert.equal(callsTo('api.anthropic.com').length, 0);

  await inbox.processWebhook(dmEvent({ from: 'user-3', text: 'אהבתי!', extra: { reply_to: { story: { id: 's1' } } } }));
  await inbox.processWebhook({
    object: 'instagram',
    entry: [{ id: 'me-ig', messaging: [{ sender: { id: 'user-3' }, recipient: { id: 'me-ig' }, timestamp: Date.now() + 5, reaction: { mid: 'm1', action: 'react', emoji: '❤' } }] }],
  });
  const types = db.prepare("SELECT type FROM messages WHERE thread_id = 'user-3' ORDER BY created_at").all().map((r) => r.type);
  assert.deepEqual(types, ['attachment', 'story_reply', 'reaction']);
  await agent.flushDebounce();
  assert.equal(drafts("thread_id = 'user-3' AND status = 'pending'").length, 1, 'story reply with text is drafted');
});

test('owner answers himself: pending draft is superseded and its card closed', async () => {
  resetMock();
  profileRoute();
  await inbox.processWebhook(dmEvent({ from: 'user-4', text: 'אפשר פרטים?' }));
  await agent.flushDebounce();
  const [d] = drafts("thread_id = 'user-4'");
  assert.equal(d.status, 'pending');

  await inbox.processWebhook(dmEvent({ from: 'user-4', text: 'בטח, שולח', echo: true, ts: Date.now() + 1000 }));
  const after = drafts("thread_id = 'user-4'")[0];
  assert.deepEqual([after.status, after.outcome], ['superseded', 'self_answered']);
  const edits = callsTo('editMessageText').filter((c) => c.body.message_id === d.tg_message_id);
  assert.ok(edits.at(-1).body.text.includes('ענית בעצמך'));
  assert.deepEqual(edits.at(-1).body.reply_markup.inline_keyboard, []);
});

test('restart recovery: unanswered thread inside the window gets a draft scheduled again', async () => {
  resetMock();
  profileRoute();
  await inbox.processWebhook(dmEvent({ from: 'user-5', text: 'עדיין מחכה' }));
  agent.stopAgent(); // simulate the process dying with the timer in memory
  assert.equal(drafts("thread_id = 'user-5'").length, 0);
  assert.ok(agent.recoverPending() >= 1);
  await agent.flushDebounce();
  assert.equal(drafts("thread_id = 'user-5' AND status = 'pending'").length, 1);
  assert.equal(agent.recoverPending(), 0, 'already drafted threads are not rescheduled');
});

test('[NEEDS_ME] escalates to the owner instead of creating a sendable draft', async () => {
  resetMock();
  profileRoute();
  route('api.anthropic.com', () => ({ id: 'm', type: 'message', role: 'assistant', model: 't', content: [{ type: 'text', text: '[NEEDS_ME]' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  await inbox.processWebhook(dmEvent({ from: 'user-6', text: 'כמה עולה?' }));
  await agent.flushDebounce();
  assert.equal(drafts("thread_id = 'user-6' AND status = 'pending'").length, 0);
  assert.equal(drafts("thread_id = 'user-6' AND status = 'needs_me'").length, 1);
  assert.ok(telegramTexts().some((t) => t.includes('צריך אותך') && t.includes('כמה עולה?')));
});
