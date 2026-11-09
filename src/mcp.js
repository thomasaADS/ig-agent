// MCP tools so the owner can run the account from a Claude chat.
// Stateless Streamable HTTP: a fresh server + transport per request.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { config, log, safeErr, UserError, formatLocal, humanDuration } from './config.js';
import { db, setPaused } from './db.js';
import * as ig from './instagram.js';
import { getThread, threadMessages, windowRemaining, pendingDrafts, statusInfo, hasUserText } from './store.js';
import * as agent from './agent.js';
import * as inbox from './inbox.js';
import * as media from './media.js';
import * as scheduler from './scheduler.js';
import { generateCaption, NEEDS_ME } from './ai.js';

const when = (ms) => (ms ? formatLocal(ms) : null);
const mediaView = (r) => ({
  id: r.id,
  kind: r.kind,
  url: media.mediaUrl(r),
  width: r.width,
  height: r.height,
  size_kb: Math.round((r.size || 0) / 1024),
  caption: r.caption,
  status: r.status,
  group: r.group_id,
  uploaded: when(r.created_at),
});
const draftView = (d) => {
  const thread = d.thread_id ? getThread(d.thread_id) : null;
  const comment = d.comment_id ? db.prepare('SELECT * FROM comments WHERE id = ?').get(d.comment_id) : null;
  return {
    id: d.id,
    kind: d.kind,
    status: d.status,
    to: thread?.username || comment?.username || d.thread_id,
    thread_id: d.thread_id,
    comment_id: d.comment_id,
    replying_to: comment?.text ?? threadMessages(d.thread_id, 5).filter((m) => m.direction === 'in').at(-1)?.text,
    text: d.text,
    window_remaining: thread ? humanDuration(windowRemaining(thread)) : undefined,
    created: when(d.created_at),
  };
};

const TOOLS = [];
const tool = (name, description, shape, handler) => TOOLS.push({ name, description, shape, handler });

// ---- status & sync ----
tool('status', 'Connection, pause state, pending drafts, token days left, last sync times.', {}, () => ({
  ...statusInfo(),
  last_poll_ok: when(statusInfo().last_poll_ok),
  last_webhook_at: when(statusInfo().last_webhook_at),
  auto_send: { dm: config.autoSendDm, comments: config.autoSendComments },
}));

tool('sync', 'Pull new DMs and comments from Instagram right now (polling fallback).', {}, async () => ({
  inbox: await inbox.syncInbox(),
  comments: await inbox.syncComments(),
}));

tool('set_paused', 'Global kill switch. paused=true stops all drafting, sending and publishing.', { paused: z.boolean() }, ({ paused }) => {
  setPaused(paused);
  if (paused) agent.stopAgent();
  else agent.recoverPending();
  return { paused };
});

// ---- threads ----
tool('list_threads', 'Recent DM conversations, newest first.', { limit: z.number().int().min(1).max(100).default(20) }, ({ limit }) =>
  db
    .prepare('SELECT * FROM threads ORDER BY COALESCE(last_message_at, 0) DESC LIMIT ?')
    .all(limit)
    .map((t) => {
      const last = threadMessages(t.id, 1).at(-1);
      return {
        thread_id: t.id,
        username: t.username,
        name: t.name,
        last_message: last ? { from: last.direction === 'out' ? 'me' : 'them', text: last.text, at: when(last.created_at) } : null,
        can_reply: windowRemaining(t) > 0,
        window_remaining: humanDuration(windowRemaining(t)),
      };
    }),
);

tool('get_thread', 'Full message history of one DM conversation.', { thread_id: z.string(), limit: z.number().int().min(1).max(200).default(50) }, ({ thread_id, limit }) => {
  const t = getThread(thread_id);
  if (!t) throw new UserError('השיחה לא נמצאה.');
  return {
    thread_id: t.id,
    username: t.username,
    window_remaining: humanDuration(windowRemaining(t)),
    messages: threadMessages(t.id, limit).map((m) => ({ from: m.direction === 'out' ? 'me' : 'them', type: m.type, text: m.text, at: when(m.created_at) })),
  };
});

// ---- drafts ----
tool('list_drafts', 'Drafts waiting for approval.', {}, () => pendingDrafts().map(draftView));

tool('approve_draft', 'Send a pending draft as-is. Only call when the owner explicitly approved this draft.', { draft_id: z.number().int() }, async ({ draft_id }) =>
  draftView(await agent.sendDraft(draft_id, { via: 'mcp' })),
);

tool('edit_draft', 'Replace the text of a pending draft (does not send it).', { draft_id: z.number().int(), text: z.string().min(1) }, async ({ draft_id, text }) =>
  draftView(await agent.editDraft(draft_id, text)),
);

tool('skip_draft', 'Dismiss a pending draft without replying.', { draft_id: z.number().int() }, async ({ draft_id }) => draftView(await agent.skipDraft(draft_id)));

tool(
  'regenerate_draft',
  'Write a new, different draft. Optional instruction such as "shorter" or "more formal".',
  { draft_id: z.number().int(), instruction: z.string().optional() },
  async ({ draft_id, instruction }) => {
    const next = await agent.regenerateDraft(draft_id, instruction);
    return next ? draftView(next) : { result: 'no new draft: the message needs the owner personally, or the conversation moved on' };
  },
);

tool(
  'send_dm',
  'Send a DM with the exact text the owner dictated. Only inside the 24h window; cannot open new conversations.',
  { thread_id: z.string(), text: z.string().min(1) },
  async ({ thread_id, text }) => ({ sent: true, message_id: await agent.sendDm(thread_id, text) }),
);

// ---- comments ----
tool(
  'list_comments',
  'Comments on recent posts. status: new (unanswered) | replied | skipped | old | thread | all.',
  { status: z.enum(['new', 'replied', 'skipped', 'old', 'thread', 'all']).default('new'), limit: z.number().int().min(1).max(100).default(30) },
  ({ status, limit }) =>
    db
      .prepare(`SELECT c.*, m.caption, m.permalink FROM comments c LEFT JOIN media_cache m ON m.id = c.media_id ${status === 'all' ? '' : 'WHERE c.status = ?'} ORDER BY c.created_at DESC LIMIT ?`)
      .all(...(status === 'all' ? [limit] : [status, limit]))
      .map((c) => ({ comment_id: c.id, username: c.username, text: c.text, status: c.status, at: when(c.created_at), post: c.permalink, post_caption: c.caption?.slice(0, 120) })),
);

tool('reply_comment', 'Reply publicly to a comment with the exact text the owner dictated.', { comment_id: z.string(), text: z.string().min(1) }, async ({ comment_id, text }) => ({
  replied: true,
  reply_id: await agent.replyComment(comment_id, text),
}));

tool('recent_media', 'Recent posts on the account with permalinks and comment counts.', { limit: z.number().int().min(1).max(50).default(10) }, async ({ limit }) => ig.recentMedia(limit));

// ---- media upload ----
tool(
  'upload_media',
  'Upload a SMALL file as base64 (under ~200KB). For real photos/videos send them to the Telegram bot or use upload_from_url.',
  { base64: z.string().min(1), mime: z.string().optional(), caption: z.string().optional() },
  async ({ base64, mime, caption }) => {
    if (base64.length > 400_000) throw new UserError('הקובץ גדול מדי להעלאה כ-base64. שלח אותו לבוט בטלגרם או השתמש ב-upload_from_url.');
    return mediaView(await media.saveUpload(Buffer.from(base64, 'base64'), { mime, caption, source: 'mcp' }));
  },
);

tool('upload_from_url', 'Download an image or video from a public URL to the server so it can be published.', { url: z.string().url(), caption: z.string().optional() }, async ({ url, caption }) =>
  mediaView(await media.fetchFromUrl(url, { caption })),
);

tool('list_media', 'Uploaded files not yet published (from Telegram, URL or base64), with public URLs.', {}, () => media.listUnpublished().map(mediaView));

tool(
  'generate_caption',
  "Draft an Instagram caption in the owner's voice from a short brief. Returns text only; nothing is published.",
  { brief: z.string().min(1), previous: z.string().optional().describe('A caption to move away from when asking for another version') },
  async ({ brief, previous }) => {
    const caption = await generateCaption(brief, { previous });
    if (caption === NEEDS_ME) throw new UserError('לא הצלחתי לנסח כיתוב לבריף הזה.');
    return { caption };
  },
);

// ---- publish & schedule ----
const TYPE = z.enum(['image', 'carousel', 'story', 'reel']);
const MEDIA_IDS = z.array(z.number().int()).min(1).max(10).describe('ids from list_media, in display order');

tool(
  'publish',
  'Publish now. Only call when the owner explicitly asked to publish this exact media and caption.',
  { type: TYPE, media_ids: MEDIA_IDS, caption: z.string().optional() },
  async ({ type, media_ids, caption }) => media.publishMedia({ type, ids: media_ids, caption }),
);

tool(
  'schedule_post',
  'Schedule a post. Time is Asia/Jerusalem wall clock, format "YYYY-MM-DD HH:mm".',
  { type: TYPE, media_ids: MEDIA_IDS, caption: z.string().optional(), when: z.string() },
  ({ type, media_ids, caption, when: at }) => scheduler.schedulePost({ type, mediaIds: media_ids, caption, when: at }),
);

tool('list_scheduled', 'Scheduled posts (times in Asia/Jerusalem). all=true includes done/failed/cancelled.', { all: z.boolean().default(false) }, ({ all }) => scheduler.listScheduled({ all }));

tool('cancel_scheduled', 'Cancel a scheduled post.', { id: z.number().int() }, ({ id }) => scheduler.cancelScheduled(id));

tool('reschedule', 'Move a scheduled post. Time is Asia/Jerusalem, "YYYY-MM-DD HH:mm".', { id: z.number().int(), when: z.string() }, ({ id, when: at }) => scheduler.reschedule(id, at));

// ---- voice quality ----
tool(
  'export_my_replies',
  "The owner's own outgoing DMs paired with the message they answered - real examples for style.md.",
  { limit: z.number().int().min(1).max(300).default(60), handwritten_only: z.boolean().default(true).describe('Exclude replies that were sent from an unedited AI draft') },
  ({ limit, handwritten_only }) => {
    const rows = db
      .prepare(`SELECT * FROM messages WHERE direction = 'out' AND type = 'text' ${handwritten_only ? "AND COALESCE(source, '') != 'agent'" : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(limit);
    const before = db.prepare("SELECT text, type FROM messages WHERE thread_id = ? AND direction = 'in' AND created_at <= ? ORDER BY created_at DESC LIMIT 1");
    return rows
      .map((m) => ({ them: before.get(m.thread_id, m.created_at), me: m.text, at: when(m.created_at) }))
      .filter((p) => p.them && hasUserText(p.them))
      .map((p) => ({ them: p.them.text, me: p.me, at: p.at }));
  },
);

tool('style_report', 'How drafts ended up (sent as-is / edited / skipped / regenerated ...) and the 20 latest edits - the best new examples for style.md.', {}, () => {
  const outcomes = Object.fromEntries(
    db.prepare('SELECT outcome, COUNT(*) AS n FROM drafts WHERE outcome IS NOT NULL GROUP BY outcome').all().map((r) => [r.outcome, r.n]),
  );
  const sent = (outcomes.as_is || 0) + (outcomes.edited || 0);
  const edits = db
    .prepare("SELECT * FROM drafts WHERE outcome = 'edited' ORDER BY updated_at DESC LIMIT 20")
    .all()
    .map((d) => ({ ...draftView(d), ai_draft: d.original_text, sent_text: d.text, text: undefined, status: undefined, window_remaining: undefined }));
  return {
    outcomes,
    edit_rate: sent ? `${Math.round(((outcomes.edited || 0) / sent) * 100)}%` : null,
    note: 'self_answered = the owner replied in the Instagram app instead of using the draft; see export_my_replies for those texts.',
    recent_edits: edits,
  };
});

export const toolNames = () => TOOLS.map((t) => t.name);

// Runs one tool the same way the MCP transport does (also used by tests).
export async function callTool(name, args = {}) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`unknown tool ${name}`);
  return t.handler(z.object(t.shape).parse(args));
}

function buildServer() {
  const server = new McpServer({ name: 'ig-agent', version: '1.0.0' });
  for (const t of TOOLS) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.shape }, async (args) => {
      try {
        const result = await t.handler(args);
        return { content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }] };
      } catch (e) {
        if (!(e instanceof UserError)) log(`mcp tool ${t.name} failed:`, safeErr(e));
        return { isError: true, content: [{ type: 'text', text: e instanceof UserError ? e.message : `Error: ${safeErr(e)}` }] };
      }
    });
  }
  return server;
}

export async function handleMcpRequest(req, res) {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    log('mcp request failed:', safeErr(e));
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
}
