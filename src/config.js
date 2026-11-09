// Central env parsing. Everything else imports from here so tests can set
// process.env before the first import.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};

const dataDir = path.resolve(root, env.DATA_DIR || 'data');

export const config = {
  root,
  port: int(env.PORT, 3000),
  publicUrl: (env.PUBLIC_URL || `http://localhost:${int(env.PORT, 3000)}`).replace(/\/+$/, ''),
  dataDir,
  mediaDir: path.join(dataDir, 'media'),
  backupDir: path.join(dataDir, 'backups'),
  dbPath: path.join(dataDir, 'agent.db'),
  stylePath: path.resolve(root, env.STYLE_PATH || 'style.md'),

  igAppId: env.IG_APP_ID || '',
  igAppSecret: env.IG_APP_SECRET || '',
  // Optional: the Meta app secret, if webhook signatures turn out to be signed
  // with it instead of the Instagram app secret (see docs/api-validation.md).
  metaAppSecret: env.META_APP_SECRET || '',
  graphVersion: env.GRAPH_VERSION || 'v23.0',
  webhookVerifyToken: env.WEBHOOK_VERIFY_TOKEN || '',

  anthropicModel: env.ANTHROPIC_MODEL || 'claude-opus-5-5',

  telegramToken: env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: env.TELEGRAM_CHAT_ID || '',

  mcpSecret: env.MCP_SECRET || '',

  autoSendDm: bool(env.AUTO_SEND_DM),
  autoSendComments: bool(env.AUTO_SEND_COMMENTS),
  autoSendMaxPerThread: int(env.AUTO_SEND_MAX_PER_THREAD, 3),

  debounceMs: int(env.DEBOUNCE_SECONDS, 45) * 1000,
  pollIntervalMs: int(env.POLL_INTERVAL_SECONDS, 120) * 1000,
  pollingEnabled: bool(env.POLLING_ENABLED, true),
  commentMaxAgeMs: int(env.COMMENT_MAX_AGE_HOURS, 48) * 3600_000,

  // Timers (pollers, scheduler, Telegram long polling) are disabled in tests.
  background: !bool(env.NO_BACKGROUND),
};

export const WINDOW_MS = 24 * 3600_000; // Instagram's 24h messaging window
export const TZ = 'Asia/Jerusalem';

export function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Error text safe for logs: strips anything that looks like a token.
export function safeErr(e) {
  const s = String(e?.message || e);
  return s
    .replace(/access_token=[^&\s"]+/g, 'access_token=***')
    .replace(/client_secret=[^&\s"]+/g, 'client_secret=***')
    .replace(/bot\d+:[\w-]+/g, 'bot***')
    .replace(/\/mcp\/[^\s/"]+/g, '/mcp/***');
}

// An error whose (Hebrew) message is safe and meant to be shown to the owner.
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

// ---- Asia/Jerusalem time helpers (no date library needed) ----
const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function localParts(ms) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

// "2026-11-10 18:30" (Jerusalem wall clock)
export function formatLocal(ms) {
  const p = localParts(ms);
  const z = (n) => String(n).padStart(2, '0');
  return `${p.y}-${z(p.mo)}-${z(p.d)} ${z(p.h)}:${z(p.mi)}`;
}
export const localDay = (ms = Date.now()) => formatLocal(ms).slice(0, 10);
export const localHour = (ms = Date.now()) => localParts(ms).h;

// Parses "YYYY-MM-DD HH:mm" (or with T) as Jerusalem wall-clock time -> epoch ms.
export function parseLocal(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(String(str).trim());
  if (!m) throw new UserError('פורמט זמן לא תקין. יש להשתמש ב-YYYY-MM-DD HH:mm (שעון ישראל)');
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wanted;
  // Two passes settle the UTC offset, including around DST changes.
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess);
    guess += wanted - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  }
  return guess;
}

// "3:20" style remaining time, in Hebrew.
export function humanDuration(ms) {
  if (ms <= 0) return 'פג';
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return h ? `${h} שע׳ ${m} דק׳` : `${m} דק׳`;
}
