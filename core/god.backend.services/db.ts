// 文档: B.docs/Dev.Common/Wiki/Services(God Level Support).WIKI
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.SYNC_DATA_DIR || "./data";
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, "sync.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    github_id    INTEGER PRIMARY KEY,
    github_login TEXT NOT NULL,
    avatar_url   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS devices (
    device_id    TEXT PRIMARY KEY,
    github_id    INTEGER NOT NULL REFERENCES users(github_id),
    device_name  TEXT,
    created_at   TEXT,
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS files (
    github_id  INTEGER NOT NULL,
    path       TEXT NOT NULL,
    hash       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    version    INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (github_id, path)
  );

  CREATE TABLE IF NOT EXISTS locks (
    github_id   INTEGER NOT NULL,
    person_id   TEXT NOT NULL,
    device_id   TEXT NOT NULL,
    acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
    heartbeat   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (github_id, person_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    github_id   INTEGER NOT NULL,
    from_person TEXT NOT NULL,
    from_device TEXT NOT NULL,
    to_person   TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'text',
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    delivered   INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(github_id, to_person, delivered);
  CREATE INDEX IF NOT EXISTS idx_locks_heartbeat ON locks(heartbeat);
`);

// 迁移（2026-09-05）：devices 表补 created_at（首次绑定时间——存量设备此前未记录，置 NULL 用 last_seen 近似）
try { db.exec("ALTER TABLE devices ADD COLUMN created_at TEXT"); } catch { /* 列已存在 = 迁移已做过 */ }

export default db;

export const stmt = {
  upsertUser: db.prepare(`
    INSERT INTO users (github_id, github_login, avatar_url)
    VALUES (?, ?, ?)
    ON CONFLICT(github_id) DO UPDATE SET
      github_login = excluded.github_login,
      avatar_url = excluded.avatar_url,
      last_seen_at = datetime('now')
  `),

  upsertDevice: db.prepare(`
    INSERT INTO devices (device_id, github_id, device_name, created_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(device_id) DO UPDATE SET
      last_seen_at = datetime('now'),
      device_name = excluded.device_name
  `),

  // 2026-09-05：该 GitHub 账号下的所有绑定设备（含首绑时间 created_at——存量设备为 NULL，显示用 COALESCE 近似 last_seen）
  listDevices: db.prepare(`
    SELECT device_id, device_name, created_at, last_seen_at
    FROM devices WHERE github_id = ?
    ORDER BY COALESCE(created_at, last_seen_at) DESC
  `),

  getManifest: db.prepare(`
    SELECT path, hash, size, version, updated_at FROM files WHERE github_id = ?
  `),

  upsertFile: db.prepare(`
    INSERT INTO files (github_id, path, hash, size, version)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(github_id, path) DO UPDATE SET
      hash = excluded.hash,
      size = excluded.size,
      version = version + 1,
      updated_at = datetime('now')
  `),

  acquireLock: db.prepare(`
    INSERT INTO locks (github_id, person_id, device_id)
    VALUES (?, ?, ?)
    ON CONFLICT(github_id, person_id) DO UPDATE SET
      device_id = excluded.device_id,
      acquired_at = datetime('now'),
      heartbeat = datetime('now')
    WHERE heartbeat < datetime('now', '-5 minutes')
       OR device_id = excluded.device_id
  `),

  getLock: db.prepare(`
    SELECT device_id, acquired_at, heartbeat FROM locks
    WHERE github_id = ? AND person_id = ?
  `),

  heartbeatLock: db.prepare(`
    UPDATE locks SET heartbeat = datetime('now')
    WHERE github_id = ? AND person_id = ? AND device_id = ?
  `),

  releaseLock: db.prepare(`
    DELETE FROM locks WHERE github_id = ? AND person_id = ? AND device_id = ?
  `),

  expireLocks: db.prepare(`
    DELETE FROM locks WHERE heartbeat < datetime('now', '-5 minutes')
  `),

  pushMessage: db.prepare(`
    INSERT INTO messages (github_id, from_person, from_device, to_person, type, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `),

  pullMessages: db.prepare(`
    SELECT id, from_person, from_device, type, payload, created_at
    FROM messages
    WHERE github_id = ? AND to_person = ? AND delivered = 0
    ORDER BY id
  `),

  markDelivered: db.prepare(`
    UPDATE messages SET delivered = 1 WHERE id = ?
  `),

  getAllLocks: db.prepare(`
    SELECT person_id, device_id, acquired_at, heartbeat FROM locks WHERE github_id = ?
  `),

  getAllLocks: db.prepare(`
    SELECT person_id, device_id, acquired_at, heartbeat FROM locks WHERE github_id = ?
  `),

  expireMessages: db.prepare(`
    DELETE FROM messages WHERE created_at < datetime('now', '-7 days')
  `),
};
