process.env.CAMPAIGN_MAX_PER_HOUR = '3';
const { route, resetMock, callsTo, connect, telegramTexts, json } = await import('./helpers.js');
const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const http = await import('node:http');

const { db, setPaused } = await import('../src/db.js');
const inbox = await import('../src/inbox.js');
const campaigns = await import('../src/campaigns.js');
const telegram = await import('../src/telegram.js');
const mcp = await import('../src/mcp.js');
const stats = await import('../src/stats.js');
const { app } = await import('../src/server.js');
await connect();

let n = 0;
const commentEvent = (text, { user = `fan${++n}`, media = 'post1', id = `cm-${++n}` } = {}) => ({
  object: 'instagram',
  entry: [{ id: 'me-ig', time: Math.floor(Date.now() / 1000), changes: [{ field: 'comments', value: { id, text, from: { id: `id-${user}`, username: user }, media: { id: media } } }] }],
});
const mocks = () => {
  route(/\/post\d\?/, () => ({ id: 'post1', caption: 'פוסט' }));
  route('/me/messages', () => ({ recipient_id: 'r', message_id: `pm-${Math.random()}` }));
};
const settle = () => new Promise((r) => setTimeout(r, 20));
const sends = (where = '1=1') => db.prepare(`SELECT * FROM campaign_sends WHERE ${where} ORDER BY id`).all();
const tap = (data, messageId = 1) => telegram.handleUpdate({ callback_query: { id: 'cb', data, message: { message_id: messageId, chat: { id: 777 } } } });

test('keyword matching: whole word vs contains, punctuation and case ignored', () => {
  const word = { keywords: '["לינק","guide"]', match: 'word' };
  assert.equal(campaigns.matches(word, 'לינק!!'), true);
  assert.equal(campaigns.matches(word, 'אפשר GUIDE בבקשה?'), true);
  assert.equal(campaigns.matches(word, 'הלינקים שלך מעולים'), false);
  assert.equal(campaigns.matches({ ...word, match: 'contains' }, 'הלינקים שלך מעולים'), true);
  assert.equal(campaigns.matches(word, '🔥🔥'), false);
});

test('a campaign sends nothing until the owner approves it in Telegram; MCP cannot activate it', async () => {
  resetMock();
  mocks();
  const c = await mcp.callTool('create_campaign', { name: 'מדריך', keywords: ['לינק'], dm_text: 'היי {username}! הנה: {link}', link_url: 'https://example.com/guide?utm=ig', public_reply: 'שלחתי לך בפרטי 🙌' });
  assert.equal(c.status, 'draft');
  const card = callsTo('sendMessage').at(-1).body;
  assert.ok(card.text.includes('היי username! הנה:') && card.text.includes('example.com/guide'));
  assert.equal(card.reply_markup.inline_keyboard[0][0].callback_data, `c:on:${c.id}`);

  await assert.rejects(mcp.callTool('set_campaign_status', { id: c.id, status: 'active' }), /עוד לא אושר/);
  await inbox.processWebhook(commentEvent('לינק'));
  await settle();
  assert.equal(callsTo('/me/messages').length, 0, 'draft campaign never sends');
  assert.equal(sends().length, 0);

  await tap(`c:on:${c.id}`);
  assert.equal(campaigns.getCampaign(c.id).status, 'active');
});

test('matching comment -> one private reply with the approved text and a tracked link; no AI draft', async () => {
  resetMock();
  mocks();
  route('/replies', () => ({ id: 'pub-1' }));
  await inbox.processWebhook(commentEvent('אפשר לינק?', { user: 'dana', id: 'cm-dana' }));
  await settle();

  const [dm] = callsTo('/me/messages');
  assert.deepEqual(dm.body.recipient, { comment_id: 'cm-dana' });
  const [row] = sends("comment_id = 'cm-dana'");
  assert.equal(dm.body.message.text, `היי dana! הנה: https://agent.test/l/${row.token}`);
  assert.equal(row.status, 'sent');
  assert.deepEqual(callsTo('/cm-dana/replies')[0].body, { message: 'שלחתי לך בפרטי 🙌' });
  assert.equal(callsTo('api.anthropic.com').length, 0, 'campaign comments are not sent to the AI');
  assert.equal(db.prepare("SELECT status FROM comments WHERE id = 'cm-dana'").get().status, 'campaign');

  // Same person comments again: logged as skipped, no second DM.
  await inbox.processWebhook(commentEvent('לינק', { user: 'dana', id: 'cm-dana-2' }));
  await settle();
  assert.equal(callsTo('/me/messages').length, 1);
  assert.deepEqual([sends("comment_id = 'cm-dana-2'")[0].status, sends("comment_id = 'cm-dana-2'")[0].reason], ['skipped', 'already_sent_to_user']);

  // A comment without the keyword goes to the normal AI draft flow.
  await inbox.processWebhook(commentEvent('איזה יופי', { user: 'other', id: 'cm-other' }));
  assert.equal(callsTo('api.anthropic.com').length, 1);
  assert.equal(callsTo('/me/messages').length, 1);
});

test('tracked link counts clicks and redirects; unknown tokens are 404', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const get = (path) => new Promise((resolve, reject) => http.get(`http://127.0.0.1:${server.address().port}${path}`, (res) => (res.resume(), resolve(res))).on('error', reject));
  const token = sends("comment_id = 'cm-dana'")[0].token;
  const res = await get(`/l/${token}`);
  assert.deepEqual([res.statusCode, res.headers.location], [302, 'https://example.com/guide?utm=ig']);
  await get(`/l/${token}`);
  assert.equal(sends("comment_id = 'cm-dana'")[0].clicks, 2);
  assert.equal((await get('/l/nope')).statusCode, 404);
  const [c] = await mcp.callTool('list_campaigns');
  assert.deepEqual([c.sent, c.clicked, c.ctr], [1, 1, 100]);

  // Dashboard: closed without the secret, read-only JSON with it.
  assert.equal((await get('/dash/wrong/')).statusCode, 404);
  assert.equal((await get('/dash/wrong/data.json')).statusCode, 404);
  const page = await get('/dash/dash-secret/');
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(page.headers['cache-control'], 'no-store');
  const data = await new Promise((resolve) => http.get(`http://127.0.0.1:${server.address().port}/dash/dash-secret/data.json`, (r) => { let b = ''; r.on('data', (x) => (b += x)); r.on('end', () => resolve(JSON.parse(b))); }));
  assert.equal(data.account.username, 'ben');
  assert.equal(data.campaigns[0].sent, 1);
  assert.equal(data.series.length, 14);
  assert.ok(data.game.level >= 1 && data.game.missions.length === 3);
  assert.equal(/access_token|"tok"|ig-secret|mcp-secret/.test(JSON.stringify(data)), false, 'no secrets in dashboard data');
});

test('hourly cap queues the overflow instead of dropping it; pause stops sending', async () => {
  resetMock();
  mocks();
  route('/replies', () => ({ id: 'x' }));
  for (let i = 0; i < 5; i++) await inbox.processWebhook(commentEvent('לינק'));
  await settle();
  // cap is 3/hour and one was already sent in an earlier test
  assert.equal(sends("status = 'sent'").length, 3);
  assert.equal(sends("status = 'queued'").length, 3);

  db.prepare("UPDATE campaign_sends SET sent_at = sent_at - 2 * 3600000 WHERE status = 'sent'").run();
  setPaused(true);
  assert.equal(await campaigns.processQueue(), 0, 'kill switch covers campaigns');
  setPaused(false);
  assert.equal(await campaigns.processQueue(), 3);
  assert.equal(sends("status = 'queued'").length, 0);
});

test('old comments are skipped, failures are logged and never retried, paused campaigns hold the queue', async () => {
  resetMock();
  mocks();
  db.prepare("UPDATE campaign_sends SET sent_at = sent_at - 2 * 3600000 WHERE status = 'sent'").run();
  const id = campaigns.listCampaigns()[0].id;

  await mcp.callTool('set_campaign_status', { id, status: 'paused' });
  await inbox.processWebhook(commentEvent('לינק', { id: 'cm-held' }));
  await settle();
  assert.equal(sends("comment_id = 'cm-held'").length, 0, 'paused campaign does not claim comments');

  await mcp.callTool('set_campaign_status', { id, status: 'active' }); // allowed: it was approved before
  route('/me/messages', () => json({ error: { message: 'user blocked', code: 551 } }, 400));
  await inbox.processWebhook(commentEvent('לינק', { id: 'cm-fail' }));
  await settle();
  const failed = sends("comment_id = 'cm-fail'")[0];
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason, /user blocked/);
  const before = callsTo('/me/messages').length;
  await campaigns.processQueue();
  assert.equal(callsTo('/me/messages').length, before, 'failed sends are not retried');

  mocks();
  // A comment that waited in the queue past Meta's 7-day limit.
  db.prepare("INSERT INTO comments (id, media_id, username, text, created_at, status) VALUES ('cm-old', 'post1', 'late_user', 'לינק', ?, 'campaign')").run(Date.now() - 8 * 86_400_000);
  db.prepare("INSERT INTO campaign_sends (campaign_id, comment_id, username, token, status, created_at) VALUES (?, 'cm-old', 'late_user', 'tok-old', 'queued', ?)").run(id, Date.now());
  const sentBefore = callsTo('/me/messages').length;
  await campaigns.processQueue();
  assert.equal(callsTo('/me/messages').length, sentBefore);
  assert.equal(sends("comment_id = 'cm-old'")[0].reason, 'comment_older_than_7_days');

  db.prepare("INSERT INTO campaign_sends (campaign_id, comment_id, status, created_at) VALUES (?, 'cm-crash', 'sending', ?)").run(id, Date.now());
  assert.equal(campaigns.recoverInterrupted(), 1);
  assert.equal(sends("comment_id = 'cm-crash'")[0].status, 'failed');
});

test('daily summary and /today report real numbers', async () => {
  resetMock();
  route('/me?', () => ({ username: 'ben', followers_count: 1200, media_count: 40 }));
  route('/me/insights', () => ({ data: [{ name: 'reach', total_value: { value: 950 } }, { name: 'views', total_value: { value: 4100 } }] }));
  await telegram.handleUpdate({ message: { chat: { id: 777 }, text: '/today' } });
  const text = telegramTexts().at(-1);
  assert.ok(text.includes('סיכום') && text.includes('1200 עוקבים') && text.includes('חשיפה 950') && text.includes('קמפיינים'));
  const s = stats.dayStats();
  assert.ok(s.campaign_clicks === 1 && s.comments_in >= 8);
  assert.ok((await mcp.callTool('daily_summary', {})).instagram.followers === 1200);
});

test('insights fall back to single metrics when Instagram rejects the combined request', async () => {
  resetMock();
  route('/me/insights', ({ url }) => {
    const metric = new URL(url).searchParams.get('metric');
    if (metric.includes(',') || metric === 'views') return json({ error: { message: 'invalid metric', code: 100 } }, 400);
    return { data: [{ name: metric, total_value: { value: 7 } }] };
  });
  route('/me?', () => ({ username: 'ben', followers_count: 1 }));
  const out = await mcp.callTool('account_insights', { days: 7 });
  assert.equal(out.totals.reach, 7);
  assert.equal('views' in out.totals, false);
});

test('lead card: notes reach the prompt as trusted context, spam silences the thread', async () => {
  resetMock();
  const agent = await import('../src/agent.js');
  const dm = (from, text) => ({ object: 'instagram', entry: [{ id: 'me-ig', messaging: [{ sender: { id: from }, recipient: { id: 'me-ig' }, timestamp: Date.now(), message: { mid: `mid-${Math.random()}`, text } }] }] });
  route(/user-lead\?/, () => ({ username: 'lead_user' }));
  await inbox.processWebhook(dm('user-lead', 'היי'));
  await mcp.callTool('update_lead', { thread_id: 'user-lead', stage: 'customer', tags: ['קורס', 'קורס', ' '], notes: 'קנתה את הקורס בינואר' });
  await agent.flushDebounce();
  const prompt = callsTo('api.anthropic.com').at(-1).body.messages[0].content;
  assert.match(prompt, /<owner_notes>\nstage: customer\ntags: קורס\nקנתה את הקורס בינואר\n<\/owner_notes>/);
  assert.deepEqual((await mcp.callTool('get_thread', { thread_id: 'user-lead' })).tags, ['קורס']);

  await mcp.callTool('update_lead', { thread_id: 'user-lead', stage: 'spam' });
  const drafted = callsTo('api.anthropic.com').length;
  await inbox.processWebhook(dm('user-lead', 'קנו עוקבים בזול!!!'));
  await agent.flushDebounce();
  assert.equal(callsTo('api.anthropic.com').length, drafted, 'no drafts for spam');
});

test('hide_comment hides on Instagram and closes the open draft', async () => {
  resetMock();
  route('/cm-other', () => ({ success: true }));
  const d = db.prepare("SELECT * FROM drafts WHERE comment_id = 'cm-other'").get();
  assert.equal(d.status, 'pending');
  await mcp.callTool('hide_comment', { comment_id: 'cm-other' });
  assert.deepEqual(callsTo('/cm-other')[0].body, { hide: true });
  assert.equal(db.prepare('SELECT status FROM drafts WHERE id = ?').get(d.id).status, 'superseded');
});
