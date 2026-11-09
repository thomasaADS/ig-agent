// Express app: /webhook, /health, /media, /auth/*, /mcp/<secret>. Starts pollers.
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { config, log, safeErr } from './config.js';
import { closeDb, getSetting, setSetting } from './db.js';
import * as ig from './instagram.js';
import * as inbox from './inbox.js';
import * as agent from './agent.js';
import * as telegram from './telegram.js';
import * as scheduler from './scheduler.js';
import { handleMcpRequest } from './mcp.js';
import { statusInfo } from './store.js';

export const app = express();
app.disable('x-powered-by');

// ---- webhook (raw body needed for the signature) ----
app.get('/webhook', (req, res) => {
  const challenge = inbox.verifyChallenge(req.query);
  if (challenge == null) return res.sendStatus(403);
  res.type('text/plain').send(challenge);
});

app.post('/webhook', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  if (!inbox.verifySignature(req.body, req.get('x-hub-signature-256'))) return res.sendStatus(401);
  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }
  res.sendStatus(200); // acknowledge fast; Meta retries slow endpoints
  inbox.processWebhook(payload).catch((e) => log('webhook processing failed:', safeErr(e)));
});

// ---- health ----
app.get('/health', (_req, res) => {
  const s = statusInfo();
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  res.json({ ok: true, ...s, last_poll_ok: iso(s.last_poll_ok), last_webhook_at: iso(s.last_webhook_at) });
});

// ---- uploaded media (Instagram downloads from here; names are unguessable) ----
app.use('/media', express.static(config.mediaDir, { index: false, dotfiles: 'deny', maxAge: '1h' }));

// ---- OAuth ----
app.get('/auth/login', (_req, res) => {
  if (!config.igAppId || !config.igAppSecret) return res.status(500).send('IG_APP_ID / IG_APP_SECRET חסרים בקובץ .env');
  res.redirect(ig.loginUrl());
});

app.get('/auth/callback', async (req, res) => {
  try {
    const profile = await ig.handleCallback(req.query.code, req.query.state);
    await telegram.notify(`✅ אינסטגרם חובר: @${telegram.esc(profile.username)}`);
    res.type('text/plain').send(`מחובר כ-@${profile.username}. אפשר לסגור את החלון.`);
    inbox.pollOnce().catch(() => {});
  } catch (e) {
    log('oauth callback failed:', safeErr(e));
    res.status(400).type('text/plain').send('ההתחברות נכשלה או שהקישור פג תוקף. נסה שוב דרך /auth/login');
  }
});

// ---- MCP (secret lives in the path; never logged) ----
function mcpAuthorised(given) {
  if (!config.mcpSecret || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(config.mcpSecret).digest();
  return crypto.timingSafeEqual(a, b);
}

app.post('/mcp/:secret', express.json({ limit: '4mb' }), (req, res) => {
  if (!mcpAuthorised(req.params.secret)) return res.sendStatus(404);
  return handleMcpRequest(req, res);
});
// Stateless mode: no SSE stream to resume and no session to delete.
app.all('/mcp/:secret', (req, res) => {
  if (!mcpAuthorised(req.params.secret)) return res.sendStatus(404);
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
});

app.use((_req, res) => res.sendStatus(404));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  log('request error:', safeErr(err));
  if (!res.headersSent) res.sendStatus(err.status || 500);
});

// ---- lifecycle ----
export async function start() {
  // Tell the owner once when the token dies, with the re-login link.
  ig.onTokenInvalid(() => {
    if (getSetting('token_alert_sent') === '1') return;
    setSetting('token_alert_sent', '1');
    telegram.notify(`🔑 הטוקן של אינסטגרם לא תקף יותר. התחבר מחדש:\n${config.publicUrl}/auth/login`);
  });

  const server = app.listen(config.port, () => log(`ig-agent listening on :${config.port}`));

  if (config.background) {
    telegram.startTelegram();
    inbox.startPolling();
    scheduler.startScheduler();
    await agent.recoverStuckSends().catch((e) => log('recover sends failed:', safeErr(e)));
    const n = agent.recoverPending();
    if (n) log(`rescheduled drafts for ${n} thread(s) after restart`);
  }

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    log(`${signal} received, shutting down`);
    telegram.stopTelegram();
    inbox.stopPolling();
    scheduler.stopScheduler();
    agent.stopAgent();
    const done = () => {
      closeDb();
      process.exit(0);
    };
    server.close(done);
    setTimeout(done, 8000).unref(); // do not hang on keep-alive sockets
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) start();
