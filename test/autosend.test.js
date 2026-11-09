process.env.AUTO_SEND_DM = '1';
process.env.AUTO_SEND_MAX_PER_THREAD = '2';
const { route, resetMock, callsTo, connect, dmEvent, telegramTexts } = await import('./helpers.js');
const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');

const { db } = await import('../src/db.js');
const inbox = await import('../src/inbox.js');
const agent = await import('../src/agent.js');
const mcp = await import('../src/mcp.js');
await connect();

const reply = (text) =>
  route('api.anthropic.com', () => ({ id: 'm', type: 'message', role: 'assistant', model: 't', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
let ts = 0;
const nextTs = () => (ts = Math.max(ts + 1, Date.now())); // always after anything already stored
async function incoming(from, text) {
  route(new RegExp(`/${from}\\?`), () => ({ username: `name_${from}` }));
  route('/me/messages', () => ({ message_id: `sent-${Math.random()}` }));
  await new Promise((r) => setTimeout(r, 3)); // strictly after the previous (auto-sent) reply
  await inbox.processWebhook(dmEvent({ from, text, ts: nextTs() }));
  await agent.flushDebounce();
  return db.prepare('SELECT * FROM drafts WHERE thread_id = ? ORDER BY id DESC').get(from);
}
// Marks the thread as one the owner has already replied in.
const knownPerson = (from) => {
  db.prepare("INSERT OR IGNORE INTO threads (id, username, updated_at) VALUES (?, ?, 0)").run(from, `name_${from}`);
  db.prepare("INSERT INTO messages (id, thread_id, direction, text, created_at, source) VALUES (?, ?, 'out', 'היי', ?, 'poll')").run(`seed-${from}`, from, Date.now() - 3600_000);
};

test('never auto-sends the first reply to a new person', async () => {
  resetMock();
  reply('תודה רבה!');
  const d = await incoming('user-new', 'היי, אהבתי את הפוסט');
  assert.equal(d.status, 'pending');
  assert.equal(callsTo('/me/messages').length, 0);
});

test('auto-sends a safe reply to a known person and tells the owner', async () => {
  resetMock();
  reply('תודה רבה!');
  knownPerson('user-known');
  const d = await incoming('user-known', 'אהבתי את הפוסט');
  assert.deepEqual([d.status, d.auto], ['sent', 1]);
  assert.equal(callsTo('/me/messages').length, 1);
  assert.ok(telegramTexts().some((t) => t.includes('נשלח אוטומטית')));
});

test('links, phone numbers, prices, dates and times always go to approval', async () => {
  const risky = [
    ['בטח, הנה: https://example.com/x', 'תודה'],
    ['תתקשר 0501234567', 'תודה'],
    ['זה עולה 200 ש"ח', 'תודה'],
    ['נפגש מחר בבוקר', 'תודה'],
    ['תודה!', 'כמה עולה?'], // risk in the incoming message
    ['בשמחה', 'אפשר ביום שלישי?'],
  ];
  for (const [i, [draftText, incomingText]] of risky.entries()) {
    resetMock();
    reply(draftText);
    knownPerson(`user-risk${i}`);
    const d = await incoming(`user-risk${i}`, incomingText);
    assert.equal(d.status, 'pending', `"${draftText}" / "${incomingText}" must wait for approval`);
    assert.equal(callsTo('/me/messages').length, 0);
  }
  assert.equal(agent.looksRisky('תודה רבה, שמח שאהבת'), false);
});

test('AUTO_SEND_MAX_PER_THREAD caps auto-replies per thread per day', async () => {
  resetMock();
  reply('תודה!');
  knownPerson('user-cap');
  const statuses = [];
  for (const text of ['אחת', 'שתיים', 'שלוש']) statuses.push((await incoming('user-cap', text)).status);
  assert.deepEqual(statuses, ['sent', 'sent', 'pending']);
});

test('style_report counts outcomes and export_my_replies pairs handwritten replies with their question', async () => {
  resetMock();
  const report = await mcp.callTool('style_report');
  assert.ok(report.outcomes.as_is >= 3);
  assert.equal(typeof report.edit_rate, 'string');

  db.prepare("INSERT INTO messages (id, thread_id, direction, text, created_at, source) VALUES ('q1', 'user-cap', 'in', 'מה נשמע?', ?, 'webhook')").run(ts + 5000);
  db.prepare("INSERT INTO messages (id, thread_id, direction, text, created_at, source) VALUES ('a1', 'user-cap', 'out', 'הכל טוב אחי', ?, 'webhook')").run(ts + 6000);
  const pairs = await mcp.callTool('export_my_replies', {});
  assert.deepEqual(pairs[0].them === 'מה נשמע?' && pairs[0].me === 'הכל טוב אחי', true);
  assert.equal(pairs.some((p) => p.me === 'תודה!'), false, 'unedited AI replies are excluded by default');
});
