// SQLite schema + idempotent migrations + small query helpers.
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.mediaDir, { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Each migration runs once; PRAGMA user_version records how far we got.
// Never edit a shipped migration - append a new one.
const migrations = [
  // 1: base schema
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        username TEXT,
        name TEXT,
        conversation_id TEXT,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        text TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        media_id TEXT,
        parent_id TEXT,
        from_id TEXT,
        username TEXT,
        text TEXT,
        created_at INTEGER,
        status TEXT NOT NULL DEFAULT 'new'
      );
      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        thread_id TEXT,
        comment_id TEXT,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        tg_message_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
    `);
  },
  // 2: hardening columns (24h window, message types, draft outcomes, auto-send counters)
  () => {
    addColumn('threads', 'last_incoming_at', 'INTEGER');
    addColumn('threads', 'last_message_at', 'INTEGER');
    addColumn('threads', 'auto_day', 'TEXT');
    addColumn('threads', 'auto_count', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('messages', 'type', "TEXT NOT NULL DEFAULT 'text'");
    addColumn('messages', 'source', 'TEXT');
    addColumn('drafts', 'original_text', 'TEXT');
    addColumn('drafts', 'outcome', 'TEXT');
    addColumn('drafts', 'regen_of', 'INTEGER');
    addColumn('drafts', 'auto', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('drafts', 'error', 'TEXT');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_drafts_thread ON drafts(thread_id, status);
      CREATE TABLE IF NOT EXISTS media_cache (
        id TEXT PRIMARY KEY,
        caption TEXT,
        permalink TEXT,
        timestamp INTEGER,
        comments_count INTEGER,
        fetched_at INTEGER
      );
    `);
  },
  // 3: uploaded media + scheduling
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS media_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        mime TEXT,
        width INTEGER,
        height INTEGER,
        size INTEGER,
        caption TEXT,
        source TEXT,
        group_id TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        tg_message_id INTEGER,
        created_at INTEGER NOT NULL,
        published_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS scheduled_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        media TEXT NOT NULL,
        caption TEXT,
        run_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sched_due ON scheduled_posts(status, run_at);
    `);
  },
];

function addColumn(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

export function migrate() {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      migrations[v]();
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
migrate();

// ---- settings ----
const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);
const delStmt = db.prepare('DELETE FROM settings WHERE key = ?');

export const getSetting = (key, fallback = null) => getStmt.get(key)?.value ?? fallback;
export const setSetting = (key, value) => setStmt.run(key, value == null ? null : String(value));
export const delSetting = (key) => delStmt.run(key);
export const getNum = (key, fallback = 0) => {
  const n = Number(getSetting(key));
  return Number.isFinite(n) && getSetting(key) != null ? n : fallback;
};

export const isPaused = () => getSetting('paused') === '1';
export const setPaused = (on) => setSetting('paused', on ? '1' : '0');

export function closeDb() {
  if (db.open) db.close();
}
