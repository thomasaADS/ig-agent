// Shared test setup: isolated data dir, dummy env, and a routed fetch mock.
// Import this BEFORE anything from src/ (env is read at import time).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-agent-test-'));
Object.assign(process.env, {
  DATA_DIR: dir,
  NO_BACKGROUND: '1',
  PUBLIC_URL: 'https://agent.test',
  IG_APP_ID: 'app-id',
  IG_APP_SECRET: 'ig-secret',
  META_APP_SECRET: '',
  WEBHOOK_VERIFY_TOKEN: 'verify-me',
  MCP_SECRET: 'mcp-secret',
  DASHBOARD_SECRET: 'dash-secret',
  DAILY_SUMMARY_HOUR: '-1',
  CAMPAIGN_MAX_PER_HOUR: process.env.CAMPAIGN_MAX_PER_HOUR || '100',
  ANTHROPIC_API_KEY: 'test-key',
  TELEGRAM_BOT_TOKEN: '123:abc',
  TELEGRAM_CHAT_ID: '777',
  DEBOUNCE_SECONDS: '3600', // tests flush explicitly
  RETRY_BASE_MS: '1',
  PUBLISH_POLL_MS: '1',
  ALBUM_WAIT_MS: '5',
  AUTO_SEND_DM: process.env.AUTO_SEND_DM || '',
  AUTO_SEND_COMMENTS: '',
});
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const calls = []; // { url, method, body }
let routes = [];
let draftCounter = 0;
let tgMessageId = 100;

// Register a handler for requests whose URL matches. Latest registration wins.
export function route(match, handler) {
  routes.unshift({ match, handler });
}

export function resetMock() {
  routes = [];
  calls.length = 0;
}

export const callsTo = (match) => calls.filter((c) => (match instanceof RegExp ? match.test(c.url) : c.url.includes(match)));

globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url ?? input);
  const method = init.method || 'GET';
  let body = init.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      /* keep raw */
    }
  }
  const call = { url, method, body };
  calls.push(call);

  for (const r of routes) {
    if (r.match instanceof RegExp ? r.match.test(url) : url.includes(r.match)) {
      const out = await r.handler(call);
      return out instanceof Response ? out : json(out);
    }
  }
  if (url.includes('api.telegram.org')) return json({ ok: true, result: { message_id: ++tgMessageId } });
  if (url.includes('api.anthropic.com')) {
    return json({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'test',
      content: [{ type: 'text', text: `טיוטה ${++draftCounter}` }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }
  throw new Error(`unmocked fetch: ${method} ${url}`);
};

// Pretend the OAuth flow already happened.
export async function connect() {
  const { setSetting } = await import('../src/db.js');
  setSetting('access_token', 'tok');
  setSetting('token_expires_at', Date.now() + 50 * 86_400_000);
  setSetting('token_refreshed_at', Date.now());
  setSetting('ig_id', 'me-app-scoped');
  setSetting('ig_user_id', 'me-ig');
  setSetting('ig_username', 'ben');
}

export const sign = (raw, secret = 'ig-secret') =>
  `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;

// A webhook payload with one incoming (or echoed) DM.
export function dmEvent({ from = 'user-1', mid = `mid-${crypto.randomUUID()}`, text = 'היי', ts = Date.now(), echo = false, extra = {} } = {}) {
  return {
    object: 'instagram',
    entry: [
      {
        id: 'me-ig',
        time: ts,
        messaging: [
          {
            sender: { id: echo ? 'me-ig' : from },
            recipient: { id: echo ? from : 'me-ig' },
            timestamp: ts,
            message: { mid, text, ...(echo ? { is_echo: true } : {}), ...extra },
          },
        ],
      },
    ],
  };
}

export const telegramTexts = () => callsTo('api.telegram.org').map((c) => c.body?.text || '');
