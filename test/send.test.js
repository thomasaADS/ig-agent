import { route, resetMock, callsTo, connect, dmEvent, telegramTexts, json } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { db, setPaused } = await import('../src/db.js');
const inbox = await import('../src/inbox.js');
const agent = await import('../src/agent.js');
const telegram = await import('../src/telegram.js');
const { getDraft } = await import('../src/store.js');
await connect();

let n = 0;
// Creates a thread with one incoming message and a pending draft for it.
async function pendingDraft(text = 'היי') {
  const from = `user-s${++n}`;
  route(new RegExp(`/${from}\\?`), () => ({ username: `u${n}` }));
  await inbox.processWebhook(dmEvent({ from, text }));
  await agent.flushDebounce();
  const d = db.prepare("SELECT * FROM drafts WHERE thread_id = ? AND status = 'pending'").get(from);
  assert.ok(d, 'draft created');
  return d;
}
const sendRoute = (delayMs = 0) =>
  route('/me/messages', async () => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return { message_id: `sent-${Math.random()}` };
  });

test('atomic claim: Telegram and MCP approving at the same moment send exactly once', async () => {
  resetMock();
  const d = await pendingDraft();
  sendRoute(20);
  const results = await Promise.allSettled([agent.sendDraft(d.id, { via: 'telegram' }), agent.sendDraft(d.id, { via: 'mcp' })]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /כבר טופלה/);
  assert.equal(callsTo('/me/messages').length, 1);
  assert.deepEqual([getDraft(d.id).status, getDraft(d.id).outcome], ['sent', 'as_is']);
  await assert.rejects(agent.sendDraft(d.id), /כבר טופלה/);
  assert.equal(callsTo('/me/messages').length, 1);
});

test('failed send returns the draft to pending so it can be retried', async () => {
  resetMock();
  const d = await pendingDraft();
  route('/me/messages', () => json({ error: { message: 'boom', code: 100 } }, 400));
  await assert.rejects(agent.sendDraft(d.id));
  assert.equal(getDraft(d.id).status, 'pending');
  sendRoute();
  await agent.sendDraft(d.id);
  assert.equal(getDraft(d.id).status, 'sent');
});

test('24h window: expired thread refuses to send with a Hebrew error and marks the draft expired', async () => {
  resetMock();
  const d = await pendingDraft();
  sendRoute();
  db.prepare('UPDATE threads SET last_incoming_at = ? WHERE id = ?').run(Date.now() - 25 * 3600_000, d.thread_id);
  await assert.rejects(agent.sendDraft(d.id), /24 השעות/);
  assert.equal(getDraft(d.id).status, 'expired');
  await assert.rejects(agent.sendDm(d.thread_id, 'טקסט'), /24 השעות/);
  assert.equal(callsTo('/me/messages').length, 0);

  // Just inside the window still works.
  db.prepare('UPDATE threads SET last_incoming_at = ? WHERE id = ?').run(Date.now() - 23 * 3600_000, d.thread_id);
  await agent.sendDm(d.thread_id, 'טקסט');
  assert.equal(callsTo('/me/messages').length, 1);
});

test('pause is a kill switch: no sending, no drafting; resume drafts what was missed', async () => {
  resetMock();
  const d = await pendingDraft();
  sendRoute();
  setPaused(true);
  await assert.rejects(agent.sendDraft(d.id), /מושהה/);
  assert.equal(getDraft(d.id).status, 'pending', 'draft survives the pause');

  route(/user-paused\?/, () => ({ username: 'paused_user' }));
  const before = callsTo('api.anthropic.com').length;
  await inbox.processWebhook(dmEvent({ from: 'user-paused', text: 'יש מישהו?' }));
  await agent.flushDebounce();
  assert.equal(callsTo('api.anthropic.com').length, before, 'no drafting while paused');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = 'user-paused'").get().n, 1, 'message still stored');

  await telegram.handleUpdate({ message: { chat: { id: 777 }, text: '/resume' } });
  await agent.flushDebounce();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE thread_id = 'user-paused' AND status = 'pending'").get().n, 1);
  assert.equal(callsTo('/me/messages').length, 0);
});

test('Telegram: reply edits the draft, button sends it, outcome is logged as edited', async () => {
  resetMock();
  const d = await pendingDraft('מתי אתם פתוחים?');
  const card = getDraft(d.id).tg_message_id;
  sendRoute();

  await telegram.handleUpdate({ message: { chat: { id: 777 }, text: 'הנוסח שלי', reply_to_message: { message_id: card } } });
  assert.deepEqual([getDraft(d.id).text, getDraft(d.id).status], ['הנוסח שלי', 'pending']);
  assert.equal(callsTo('/me/messages').length, 0, 'editing never sends');

  await telegram.handleUpdate({ callback_query: { id: 'cb1', data: `d:send:${d.id}`, message: { message_id: card, chat: { id: 777 } } } });
  const sent = callsTo('/me/messages');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { recipient: { id: d.thread_id }, message: { text: 'הנוסח שלי' } });
  const row = getDraft(d.id);
  assert.deepEqual([row.status, row.outcome, row.original_text !== row.text], ['sent', 'edited', true]);

  // Second tap on the same button is harmless.
  await telegram.handleUpdate({ callback_query: { id: 'cb2', data: `d:send:${d.id}`, message: { message_id: card, chat: { id: 777 } } } });
  assert.equal(callsTo('/me/messages').length, 1);
  assert.ok(callsTo('answerCallbackQuery').at(-1).body.text.includes('כבר טופלה'));
});

test('regenerate passes the previous draft and the /re instruction, and produces a new draft', async () => {
  resetMock();
  const d = await pendingDraft('ספר לי עוד');
  const card = getDraft(d.id).tg_message_id;
  await telegram.handleUpdate({ message: { chat: { id: 777 }, text: '/re קצר יותר', reply_to_message: { message_id: card } } });

  const old = getDraft(d.id);
  assert.deepEqual([old.status, old.outcome], ['superseded', 'regenerated']);
  const next = db.prepare("SELECT * FROM drafts WHERE regen_of = ?").get(d.id);
  assert.equal(next.status, 'pending');
  assert.notEqual(next.text, old.text);
  const prompt = callsTo('api.anthropic.com').at(-1).body.messages[0].content;
  assert.ok(prompt.includes(`<previous_draft>\n${old.text}`) && prompt.includes('קצר יותר') && prompt.includes('meaningfully different'));
});

test('Telegram ignores strangers once TELEGRAM_CHAT_ID is set', async () => {
  resetMock();
  await telegram.handleUpdate({ message: { chat: { id: 999 }, text: '/start' } });
  await telegram.handleUpdate({ message: { chat: { id: 999 }, text: '/status' } });
  await telegram.handleUpdate({ callback_query: { id: 'x', data: 'd:send:1', message: { message_id: 1, chat: { id: 999 } } } });
  assert.equal(callsTo('api.telegram.org').length, 0);
  await telegram.handleUpdate({ message: { chat: { id: 777 }, text: '/status' } });
  assert.ok(telegramTexts().at(-1).includes('סטטוס'));
});

test('interrupted send is handed back to the owner with a warning after restart', async () => {
  resetMock();
  const d = await pendingDraft();
  db.prepare("UPDATE drafts SET status = 'sending' WHERE id = ?").run(d.id);
  await agent.recoverStuckSends();
  assert.equal(getDraft(d.id).status, 'pending');
  assert.ok(telegramTexts().some((t) => t.includes('נקטעה באמצע שליחה')));
});
