import { route, resetMock, callsTo, connect, dmEvent } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { db } = await import('../src/db.js');
const inbox = await import('../src/inbox.js');
const agent = await import('../src/agent.js');
const assistant = await import('../src/assistant.js');
const { app } = await import('../src/server.js');
await connect();

const msg = (content, stop_reason = 'end_turn') => ({ id: 'm', type: 'message', role: 'assistant', model: 't', content, stop_reason, usage: { input_tokens: 1, output_tokens: 1 } });
// Scripted model: each call to the API returns the next response in the list.
function script(...responses) {
  let i = 0;
  route('api.anthropic.com', () => responses[Math.min(i++, responses.length - 1)]);
}

test('NOVA looks things up with read-only tools and answers from the result', async () => {
  resetMock();
  route(/user-n1\?/, () => ({ username: 'dana' }));
  await inbox.processWebhook(dmEvent({ from: 'user-n1', text: 'יש עוד מקום בסדנה?' }));
  agent.stopAgent();

  script(
    msg([{ type: 'text', text: 'בודקת…' }, { type: 'tool_use', id: 'tu1', name: 'list_leads', input: { waiting_only: true } }, { type: 'tool_use', id: 'tu2', name: 'get_overview', input: {} }], 'tool_use'),
    msg([{ type: 'text', text: 'dana מחכה לתשובה על הסדנה.' }]),
  );
  const out = await assistant.ask([{ role: 'user', text: 'מי מחכה לי?' }]);
  assert.equal(out.reply, 'dana מחכה לתשובה על הסדנה.');
  assert.deepEqual(out.tools_used, ['list_leads', 'get_overview']);

  const [first, second] = callsTo('api.anthropic.com').map((c) => c.body);
  assert.ok(first.tools.length >= 8 && first.tools.every((t) => t.input_schema && !t.run));
  assert.match(JSON.stringify(first.system), /NOVA/);
  // Both tool results go back in ONE user message, after the full assistant turn.
  assert.equal(second.messages.at(-2).role, 'assistant');
  const results = second.messages.at(-1).content;
  assert.deepEqual(results.map((r) => [r.type, r.tool_use_id]), [['tool_result', 'tu1'], ['tool_result', 'tu2']]);
  const leads = JSON.parse(results[0].content);
  assert.deepEqual([leads[0].username, leads[0].waiting_for_reply, leads[0].last_message.text], ['dana', true, 'יש עוד מקום בסדנה?']);
});

test('NOVA has no tool that can send, approve, publish or change anything', async () => {
  resetMock();
  script(msg([{ type: 'tool_use', id: 'x', name: 'send_dm', input: { thread_id: 'user-n1', text: 'hi' } }], 'tool_use'), msg([{ type: 'text', text: 'את זה עושים בטלגרם.' }]));
  const before = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  const out = await assistant.ask([{ role: 'user', text: 'שלחי לה הודעה' }]);
  assert.equal(out.reply, 'את זה עושים בטלגרם.');
  assert.equal(callsTo('graph.instagram.com').length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, before);
  const result = callsTo('api.anthropic.com')[1].body.messages.at(-1).content[0];
  assert.equal(result.is_error, true, 'an unknown tool is reported back as an error');
  const names = callsTo('api.anthropic.com')[0].body.tools.map((t) => t.name);
  assert.equal(names.some((n) => /send|approve|publish|schedule|update|create|delete|hide|set_/.test(n)), false);
});

test('NOVA: tool loop is bounded, input is validated, requests are rate limited', async () => {
  resetMock();
  assistant._resetRateLimit();
  script(msg([{ type: 'tool_use', id: 'loop', name: 'get_overview', input: {} }], 'tool_use'));
  const out = await assistant.ask([{ role: 'user', text: 'לופ' }]);
  assert.match(out.reply, /יותר מדי צעדים/);
  assert.equal(callsTo('api.anthropic.com').length, 6);

  await assert.rejects(assistant.ask([]), /לא התקבלה שאלה/);
  await assert.rejects(assistant.ask([{ role: 'assistant', text: 'x' }]), /לא התקבלה שאלה/);
  await assert.rejects(assistant.ask('not an array'), /לא התקבלה שאלה/);

  resetMock();
  script(msg([{ type: 'text', text: 'ok' }]));
  assistant._resetRateLimit();
  for (let i = 0; i < 30; i++) await assistant.ask([{ role: 'user', text: 'x'.repeat(5000) }]);
  assert.equal(callsTo('api.anthropic.com')[0].body.messages[0].content.length, 2000, 'long input is cut');
  await assert.rejects(assistant.ask([{ role: 'user', text: 'עוד אחת' }]), /יותר מדי שאלות/);
  assert.equal(callsTo('api.anthropic.com').length, 30);
});

test('assistant endpoint sits behind the dashboard secret', async (t) => {
  resetMock();
  assistant._resetRateLimit();
  script(msg([{ type: 'text', text: 'שלום' }]));
  const server = app.listen(0);
  t.after(() => server.close());
  const post = (path, body) =>
    new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  assert.equal((await post('/dash/wrong/assistant', { messages: [{ role: 'user', text: 'hi' }] })).status, 404);
  assert.equal(callsTo('api.anthropic.com').length, 0);
  const ok = await post('/dash/dash-secret/assistant', { messages: [{ role: 'user', text: 'היי' }] });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { name: 'NOVA', reply: 'שלום', tools_used: [] });
  assert.equal((await post('/dash/dash-secret/assistant', { messages: [] })).status, 429);
});
