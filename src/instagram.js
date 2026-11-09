// Instagram API with Instagram Login (graph.instagram.com, no Facebook Page):
// OAuth, long-lived token + refresh, inbox/comment reads, sending, publishing.
import crypto from 'node:crypto';
import { config, log, safeErr } from './config.js';
import { getSetting, setSetting, delSetting, getNum } from './db.js';

const SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
  'instagram_business_content_publish',
].join(',');

const STATE_TTL_MS = 10 * 60_000;
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS ?? 1000);
const PUBLISH_POLL_MS = Number(process.env.PUBLISH_POLL_MS ?? 3000);

const base = () => `https://graph.instagram.com/${config.graphVersion}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class IgError extends Error {
  constructor(message, { status, code, subcode } = {}) {
    super(message);
    this.name = 'IgError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
  }
}

// server.js registers a listener so a dead token alerts Telegram (once).
let tokenInvalidHandler = null;
export const onTokenInvalid = (fn) => (tokenInvalidHandler = fn);

export const redirectUri = () => `${config.publicUrl}/auth/callback`;
export const isConnected = () => !!getSetting('access_token');
export const me = () => ({
  id: getSetting('ig_id'),
  userId: getSetting('ig_user_id'),
  username: getSetting('ig_username'),
});

// True if an id / username belongs to the connected account. Webhooks and the
// conversations API may use different ids for it, so we accept both + username.
export function isMe({ id, username } = {}) {
  const m = me();
  if (id && (String(id) === m.id || String(id) === m.userId)) return true;
  return !!username && !!m.username && username.toLowerCase() === m.username.toLowerCase();
}

export function tokenDaysLeft() {
  const exp = getNum('token_expires_at', 0);
  return exp ? Math.floor((exp - Date.now()) / 86_400_000) : null;
}

// ---------- low-level request with retry ----------

export async function api(path, { method = 'GET', params = {}, body, auth = true, absolute = false } = {}) {
  const token = getSetting('access_token');
  if (auth && !token) throw new IgError('Instagram is not connected', { status: 401 });

  const url = new URL(absolute ? path : `${base()}${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));

  const headers = {};
  if (auth) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof URLSearchParams) payload = body;
  else if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  // A POST that failed with 5xx may still have been applied (message sent,
  // media published), so only GETs retry on 5xx. 429 is safe for both.
  const maxAttempts = 4;
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      if (method === 'GET' && attempt < maxAttempts) {
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      throw new IgError(`network error: ${safeErr(e)}`);
    }

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    if (res.ok && !json.error) return json;

    const err = json.error || {};
    const code = err.code ?? json.code;
    const retryable = res.status === 429 || (res.status >= 500 && method === 'GET');
    if (retryable && attempt < maxAttempts) {
      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      continue;
    }
    if (code === 190) tokenInvalidHandler?.();
    throw new IgError(err.message || json.error_message || `HTTP ${res.status}`, {
      status: res.status,
      code,
      subcode: err.error_subcode,
    });
  }
}

// Cursor pagination. `stop(item)` returning true ends the walk early.
export async function paginate(path, params = {}, { max = 500, stop } = {}) {
  const out = [];
  let after;
  for (let page = 0; page < 50; page++) {
    const res = await api(path, { params: { ...params, after } });
    for (const item of res.data || []) {
      if (stop?.(item)) return out;
      out.push(item);
      if (out.length >= max) return out;
    }
    after = res.paging?.cursors?.after;
    if (!after || !res.paging?.next) break;
  }
  return out;
}

// ---------- OAuth ----------

export function loginUrl() {
  const state = crypto.randomBytes(24).toString('hex');
  setSetting('oauth_state', state);
  setSetting('oauth_state_at', Date.now());
  const u = new URL('https://www.instagram.com/oauth/authorize');
  u.searchParams.set('client_id', config.igAppId);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('state', state);
  return u.toString();
}

// Single-use, non-empty, constant-time compared, 10 minute lifetime.
export function consumeOAuthState(state) {
  const expected = getSetting('oauth_state');
  const at = getNum('oauth_state_at', 0);
  delSetting('oauth_state');
  delSetting('oauth_state_at');
  if (typeof state !== 'string' || !state || !expected) return false;
  if (Date.now() - at > STATE_TTL_MS) return false;
  const a = Buffer.from(state);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function handleCallback(code, state) {
  if (!consumeOAuthState(state)) throw new IgError('invalid or expired OAuth state', { status: 400 });
  if (!code) throw new IgError('missing code', { status: 400 });

  const short = await api('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    auth: false,
    absolute: true,
    body: new URLSearchParams({
      client_id: config.igAppId,
      client_secret: config.igAppSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(),
      code: String(code).replace(/#_$/, ''),
    }),
  });
  const shortToken = short.access_token || short.data?.[0]?.access_token;
  if (!shortToken) throw new IgError('token exchange returned no access_token');

  const long = await api('https://graph.instagram.com/access_token', {
    auth: false,
    absolute: true,
    params: { grant_type: 'ig_exchange_token', client_secret: config.igAppSecret, access_token: shortToken },
  });
  storeToken(long);

  const profile = await api('/me', { params: { fields: 'user_id,username,name' } });
  setSetting('ig_id', profile.id);
  setSetting('ig_user_id', profile.user_id || profile.id);
  setSetting('ig_username', profile.username);
  delSetting('token_alert_sent');
  log(`instagram connected as @${profile.username}`);
  return profile;
}

function storeToken(res) {
  setSetting('access_token', res.access_token);
  setSetting('token_expires_at', Date.now() + (res.expires_in || 60 * 86_400) * 1000);
  setSetting('token_refreshed_at', Date.now());
}

// Long-lived tokens last 60 days and can be refreshed once they are 24h old.
export async function refreshTokenIfNeeded() {
  if (!isConnected()) return false;
  const days = tokenDaysLeft();
  const ageMs = Date.now() - getNum('token_refreshed_at', 0);
  if (days != null && days > 15) return false;
  if (ageMs < 24 * 3600_000) return false;
  const res = await api('https://graph.instagram.com/refresh_access_token', {
    auth: false,
    absolute: true,
    params: { grant_type: 'ig_refresh_token', access_token: getSetting('access_token') },
  });
  storeToken(res);
  log('instagram token refreshed');
  return true;
}

// ---------- reads ----------

export const conversations = (sinceMs = 0) =>
  paginate(
    '/me/conversations',
    { platform: 'instagram', fields: 'id,updated_time,participants', limit: 25 },
    // Newest first: stop once we reach conversations older than the sync window.
    { max: 200, stop: (c) => c.updated_time && Date.parse(c.updated_time) < sinceMs },
  );

const MSG_FIELDS = 'id,created_time,from,to,message,attachments,story,reactions,is_unsupported';

export async function conversationMessages(conversationId, limit = 20) {
  const res = await api(`/${conversationId}`, { params: { fields: `messages.limit(${limit}){${MSG_FIELDS}}` } });
  const list = res.messages?.data || [];
  // Some API versions return only id + created_time here; fetch details then.
  return Promise.all(list.map((m) => (m.from ? m : api(`/${m.id}`, { params: { fields: MSG_FIELDS } }).catch(() => m))));
}

export const recentMedia = (limit = 10) =>
  api('/me/media', { params: { fields: 'id,caption,permalink,timestamp,comments_count,media_type', limit } }).then(
    (r) => r.data || [],
  );

export const comments = (mediaId) =>
  paginate(
    `/${mediaId}/comments`,
    { fields: 'id,text,username,timestamp,from,replies{id,text,username,timestamp,from}', limit: 50 },
    { max: 300 },
  );

// ---------- writes (callers are responsible for approval checks) ----------

export async function sendMessage(recipientId, text) {
  const res = await api('/me/messages', {
    method: 'POST',
    body: { recipient: { id: recipientId }, message: { text } },
  });
  return res.message_id || res.id || null;
}

export async function replyToComment(commentId, text) {
  const res = await api(`/${commentId}/replies`, { method: 'POST', body: { message: text } });
  return res.id;
}

async function createContainer(params) {
  const res = await api('/me/media', { method: 'POST', body: params });
  if (!res.id) throw new IgError('container creation returned no id');
  return res.id;
}

async function waitForContainer(id, timeoutMs = 5 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api(`/${id}`, { params: { fields: 'status_code,status' } });
    if (res.status_code === 'FINISHED' || res.status_code === 'PUBLISHED') return;
    if (res.status_code === 'ERROR' || res.status_code === 'EXPIRED') {
      throw new IgError(`media container ${res.status_code}: ${res.status || 'unknown'}`);
    }
    if (Date.now() > deadline) throw new IgError('media container timed out');
    await sleep(PUBLISH_POLL_MS);
  }
}

// type: image | carousel | story | reel. media: [{ url, kind: 'image'|'video' }]
export async function publish({ type, media, caption }) {
  if (!media?.length) throw new IgError('no media to publish');
  const first = media[0];
  const srcOf = (m) => (m.kind === 'video' ? { video_url: m.url } : { image_url: m.url });
  let containerId;

  if (type === 'image') {
    containerId = await createContainer({ image_url: first.url, caption });
  } else if (type === 'reel') {
    containerId = await createContainer({ media_type: 'REELS', video_url: first.url, caption });
  } else if (type === 'story') {
    containerId = await createContainer({ media_type: 'STORIES', ...srcOf(first) });
  } else if (type === 'carousel') {
    if (media.length < 2 || media.length > 10) throw new IgError('carousel needs 2-10 items');
    const children = [];
    for (const m of media) {
      const child = await createContainer({
        is_carousel_item: true,
        ...(m.kind === 'video' ? { media_type: 'VIDEO' } : {}),
        ...srcOf(m),
      });
      await waitForContainer(child);
      children.push(child);
    }
    containerId = await createContainer({ media_type: 'CAROUSEL', children: children.join(','), caption });
  } else {
    throw new IgError(`unknown publish type: ${type}`);
  }

  await waitForContainer(containerId);
  const published = await api('/me/media_publish', { method: 'POST', body: { creation_id: containerId } });
  let permalink = null;
  try {
    permalink = (await api(`/${published.id}`, { params: { fields: 'permalink' } })).permalink || null;
  } catch (e) {
    log('could not fetch permalink:', safeErr(e));
  }
  return { id: published.id, permalink };
}

// Best-effort profile lookup for a person who messaged us (webhooks carry ids only).
export const userProfile = (id) => api(`/${id}`, { params: { fields: 'name,username' } });

export const mediaInfo = (id) => api(`/${id}`, { params: { fields: 'id,caption,permalink,timestamp,comments_count' } });
