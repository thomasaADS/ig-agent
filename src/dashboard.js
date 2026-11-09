// Read-only web dashboard at /dash/<DASHBOARD_SECRET>.
// It only shows data. Every action (approve, send, publish) stays in Telegram
// and MCP, so a leaked dashboard link can read but never act.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, formatLocal } from './config.js';
import { db } from './db.js';
import { statusInfo, getThread, threadMessages, windowRemaining, pendingDrafts, parseTags } from './store.js';
import * as stats from './stats.js';
import { listCampaigns } from './campaigns.js';
import { listScheduled } from './scheduler.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(HERE, 'dashboard.html');
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');

export function dashboardData() {
  const today = stats.dayStats();
  const yesterday = stats.dayStats(stats.dayOffset(-1));
  const insights = stats.getInsights(today.day);
  const insightsPrev = stats.getInsights(yesterday.day);
  const status = statusInfo();

  const pending = pendingDrafts().map((d) => {
    const thread = d.thread_id ? getThread(d.thread_id) : null;
    const comment = d.comment_id ? db.prepare('SELECT * FROM comments WHERE id = ?').get(d.comment_id) : null;
    const lastIn = thread ? threadMessages(thread.id, 10).filter((m) => m.direction === 'in').at(-1) : null;
    return {
      id: d.id,
      kind: d.kind,
      who: thread?.username || comment?.username || '?',
      incoming: clip(comment?.text ?? lastIn?.text, 220),
      draft: clip(d.text, 320),
      window_ms: thread ? Math.max(0, windowRemaining(thread)) : null,
      created: formatLocal(d.created_at),
    };
  });

  const threads = db
    .prepare('SELECT * FROM threads ORDER BY COALESCE(last_message_at, 0) DESC LIMIT 12')
    .all()
    .map((t) => {
      const last = threadMessages(t.id, 1).at(-1);
      return {
        who: t.username || t.name || t.id,
        stage: t.stage,
        tags: parseTags(t),
        last: clip(last?.text, 90),
        from_me: last?.direction === 'out',
        at: last ? formatLocal(last.created_at) : null,
        waiting: last?.direction === 'in' && windowRemaining(t) > 0,
        window_ms: Math.max(0, windowRemaining(t)),
      };
    });

  // CRM view: every conversation as a lead card.
  const counts = Object.fromEntries(
    db
      .prepare("SELECT thread_id, SUM(direction = 'in') AS n_in, SUM(direction = 'out') AS n_out, MIN(created_at) AS first_at FROM messages WHERE type != 'reaction' GROUP BY thread_id")
      .all()
      .map((r) => [r.thread_id, r]),
  );
  const leads = db
    .prepare('SELECT * FROM threads ORDER BY COALESCE(last_message_at, 0) DESC LIMIT 200')
    .all()
    .map((t) => {
      const last = threadMessages(t.id, 1).at(-1);
      const c = counts[t.id] || {};
      return {
        id: t.id,
        who: t.username || t.name || t.id,
        name: t.username && t.name ? t.name : null,
        stage: t.stage,
        tags: parseTags(t),
        notes: clip(t.notes, 180),
        last: clip(last?.text, 110),
        from_me: last?.direction === 'out',
        at: last ? formatLocal(last.created_at) : null,
        waiting: last?.direction === 'in' && windowRemaining(t) > 0,
        window_ms: Math.max(0, windowRemaining(t)),
        msgs_in: c.n_in || 0,
        msgs_out: c.n_out || 0,
        first_at: c.first_at ? formatLocal(c.first_at).slice(0, 10) : null,
      };
    });

  const posts = db
    .prepare('SELECT * FROM media_cache ORDER BY COALESCE(timestamp, 0) DESC LIMIT 6')
    .all()
    .map((m) => ({ caption: clip(m.caption, 90), permalink: m.permalink, comments: m.comments_count, at: m.timestamp ? formatLocal(m.timestamp) : null }));

  return {
    generated_at: formatLocal(Date.now()),
    account: { username: status.username, connected: status.connected, paused: status.paused, followers: insights?.followers ?? null, followers_delta: insights?.followers != null && insightsPrev?.followers != null ? insights.followers - insightsPrev.followers : null },
    health: {
      token_days: status.token_days_remaining,
      last_poll: status.last_poll_ok ? formatLocal(status.last_poll_ok) : null,
      last_webhook: status.last_webhook_at ? formatLocal(status.last_webhook_at) : null,
      poll_age_min: status.last_poll_ok ? Math.round((Date.now() - status.last_poll_ok) / 60_000) : null,
      auto_send_dm: config.autoSendDm,
      auto_send_comments: config.autoSendComments,
    },
    game: stats.gameState(),
    today,
    yesterday,
    insights,
    series: stats.series(14),
    follower_trend: stats.followerTrend(14),
    pending,
    waiting_threads: stats.waitingThreads().length,
    threads,
    leads,
    campaigns: listCampaigns().slice(0, 8),
    scheduled: listScheduled().slice(0, 8),
    unpublished_media: db.prepare("SELECT COUNT(*) AS n FROM media_files WHERE status = 'new'").get().n,
    posts,
  };
}

function authorised(given) {
  if (!config.dashboardSecret || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(config.dashboardSecret).digest();
  return crypto.timingSafeEqual(a, b);
}

export const dashboardRouter = express.Router();

dashboardRouter.use('/:secret', (req, res, next) => {
  if (!authorised(req.params.secret)) return res.sendStatus(404);
  res.set({
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
  });
  next();
});

// Artwork (header backgrounds, icon, empty-state illustration).
dashboardRouter.use('/:secret/assets', express.static(path.join(HERE, 'assets'), { index: false, maxAge: '7d' }));

dashboardRouter.get('/:secret/data.json', (_req, res) => res.json(dashboardData()));

// One conversation for the lead drawer.
dashboardRouter.get('/:secret/thread/:id.json', (req, res) => {
  const t = getThread(req.params.id);
  if (!t) return res.sendStatus(404);
  res.json({
    id: t.id,
    who: t.username || t.name || t.id,
    name: t.name,
    stage: t.stage,
    tags: parseTags(t),
    notes: t.notes || '',
    window_ms: Math.max(0, windowRemaining(t)),
    messages: threadMessages(t.id, 60).map((m) => ({ me: m.direction === 'out', type: m.type, text: m.text || '', at: formatLocal(m.created_at), ai: m.source === 'agent' })),
    drafts: db.prepare("SELECT id, text FROM drafts WHERE thread_id = ? AND status = 'pending'").all(t.id),
  });
});

dashboardRouter.get('/:secret', (req, res) => {
  // Relative fetch("data.json") needs the trailing slash.
  if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(302, `${req.baseUrl}/${encodeURIComponent(req.params.secret)}/`);
  res.type('html').send(fs.readFileSync(HTML_PATH, 'utf8'));
});
