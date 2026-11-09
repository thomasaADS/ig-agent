import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// Build a database the way the first version of the schema left it.
const file = path.join(process.env.DATA_DIR, 'agent.db');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
const old = new Database(file);
old.exec(`
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE threads (id TEXT PRIMARY KEY, username TEXT, name TEXT, conversation_id TEXT, updated_at INTEGER);
  CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, direction TEXT NOT NULL, text TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE comments (id TEXT PRIMARY KEY, media_id TEXT, parent_id TEXT, from_id TEXT, username TEXT, text TEXT, created_at INTEGER, status TEXT NOT NULL DEFAULT 'new');
  CREATE TABLE drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, thread_id TEXT, comment_id TEXT, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', tg_message_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  INSERT INTO settings VALUES ('access_token', 'keep-me');
  INSERT INTO threads VALUES ('t1', 'dana', 'Dana', NULL, 1);
  INSERT INTO messages VALUES ('m1', 't1', 'in', 'ישן', 1000);
  INSERT INTO drafts (kind, thread_id, text, created_at, updated_at) VALUES ('dm', 't1', 'טיוטה ישנה', 1, 1);
`);
old.close();

test('an existing agent.db is migrated in place and keeps its data; migrating twice is a no-op', async () => {
  const { db, migrate, getSetting } = await import('../src/db.js');
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(cols('threads').includes('last_incoming_at'));
  assert.ok(cols('messages').includes('type') && cols('messages').includes('source'));
  assert.ok(cols('drafts').includes('original_text') && cols('drafts').includes('outcome'));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'scheduled_posts'").get());

  assert.equal(getSetting('access_token'), 'keep-me');
  assert.equal(db.prepare("SELECT type FROM messages WHERE id = 'm1'").get().type, 'text');
  assert.equal(db.prepare('SELECT text FROM drafts').get().text, 'טיוטה ישנה');

  const version = db.pragma('user_version', { simple: true });
  migrate();
  migrate();
  assert.equal(db.pragma('user_version', { simple: true }), version);
});
