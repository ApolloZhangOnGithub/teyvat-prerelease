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

  -- 设备主动上传的 genshin 状态（2026-09-05：本地上传→服务器拉，查看 0.3s 内；不做远程执行）
  CREATE TABLE IF NOT EXISTS device_states (
    device_id   TEXT PRIMARY KEY,
    github_id   INTEGER NOT NULL,
    agents_json TEXT NOT NULL DEFAULT '[]',   -- 设备上 genshin agent 清单（plist 内容）
    version     TEXT NOT NULL DEFAULT '',
    synced_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 设备同步日志（2026-09-05：每次上传记一条；保留“活跃 30 天”=有同步记录的最近 30 个活跃日，非自然 30 天——用户定稿）
  CREATE TABLE IF NOT EXISTS device_sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   TEXT NOT NULL,
    github_id   INTEGER NOT NULL,
    synced_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sync_log ON device_sync_log(github_id, device_id, synced_at);

  -- agent presence（2026-09-05 AgentTableSync：跨设备 agent 索引表——轻量状态，非完整数据）
  CREATE TABLE IF NOT EXISTS agent_presence (
    github_id   INTEGER NOT NULL,
    sid         TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    focus       TEXT NOT NULL DEFAULT 'off',
    version     TEXT NOT NULL DEFAULT '',
    model       TEXT NOT NULL DEFAULT '',
    device_id   TEXT NOT NULL DEFAULT '',
    last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (github_id, sid)
  );
  CREATE INDEX IF NOT EXISTS idx_presence_lastseen ON agent_presence(last_seen);

  -- 临时文件分享（2026-09-08 ISSUE 142：网盘式——上传得 url+密码，24h 过期，单文件上限 1MB）
  CREATE TABLE IF NOT EXISTS share_files (
    id            TEXT PRIMARY KEY,          -- 随机 id（下载路径 /files/<id>）
    github_id     INTEGER NOT NULL,          -- 上传者
    filename      TEXT NOT NULL,             -- 原始文件名（下载 Content-Disposition）
    size          INTEGER NOT NULL,
    password_hash TEXT NOT NULL,             -- 访问密码 sha256（hex）
    expires_at    TEXT NOT NULL,             -- datetime('now', '+24 hours')
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_share_expires ON share_files(expires_at);
  -- update 遥测（2026-09-09：每台 genshin update 自动上报——绑定账号/设备——集中可查"谁/何时/从→到"）
  CREATE TABLE IF NOT EXISTS update_history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    github_id INTEGER NOT NULL,            -- 绑定账号（authMiddleware resolveUser）
    device_id TEXT NOT NULL,               -- X-Device-Id（哪台机器）
    from_ver  TEXT NOT NULL,
    to_ver    TEXT NOT NULL,
    channel   TEXT NOT NULL,
    trigger_by TEXT NOT NULL DEFAULT 'user', -- user/agent（agent env 有 PAIMON_AGENT_ID）
    ts        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_update_history_dev ON update_history(device_id, ts);
  -- 备份事件（2026-09-12 云备份任务：备份成功/失败上报——与 update 遥测同机制）
  CREATE TABLE IF NOT EXISTS backup_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    github_id INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    ok        INTEGER NOT NULL,
    detail    TEXT NOT NULL DEFAULT '',
    host      TEXT NOT NULL DEFAULT '',
    ts        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_backup_events_dev ON backup_events(device_id, ts);
`);

// 迁移（2026-09-05）：devices 表补 created_at（首次绑定时间——存量设备此前未记录，置 NULL 用 last_seen 近似）
try { db.exec("ALTER TABLE devices ADD COLUMN created_at TEXT"); } catch (e) { console.error("[god.backend.services/db.ts] " + ((e as any)?.message || e)); /* 列已存在 = 迁移已做过 */ }

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
  // 只 touch 活跃不覆盖 device_name（保留用户备注名）——2026-09-05
  touchDevice: db.prepare(`
    UPDATE devices SET last_seen_at = datetime('now') WHERE github_id = ? AND device_id = ?
  `),
  getDeviceName: db.prepare(`
    SELECT device_name FROM devices WHERE github_id = ? AND device_id = ?
  `),

  // 2026-09-05：该 GitHub 账号下的所有绑定设备（含首绑时间 created_at——存量设备为 NULL，显示用 COALESCE 近似 last_seen）
  listDevices: db.prepare(`
    SELECT device_id, device_name, created_at, last_seen_at
    FROM devices WHERE github_id = ?
    ORDER BY COALESCE(created_at, last_seen_at) DESC
  `),
  renameDevice: db.prepare(`
    UPDATE devices SET device_name = ? WHERE github_id = ? AND device_id = ?
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

  // 设备状态主动上传/拉取（2026-09-05）
  upsertDeviceState: db.prepare(`
    INSERT INTO device_states (device_id, github_id, agents_json, version, synced_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(device_id) DO UPDATE SET
      agents_json = excluded.agents_json,
      version = excluded.version,
      synced_at = datetime('now')
  `),
  getDeviceStates: db.prepare(`
    SELECT device_id, agents_json, version, synced_at FROM device_states WHERE github_id = ?
  `),

  // 同步日志（2026-09-05：记每次活跃同步；保留最近 30 个活跃日）
  logSync: db.prepare(`
    INSERT INTO device_sync_log (device_id, github_id) VALUES (?, ?)
  `),
  pruneSyncLog: db.prepare(`
    DELETE FROM device_sync_log
    WHERE github_id = ? AND DATE(synced_at) NOT IN (
      SELECT DISTINCT DATE(synced_at) FROM device_sync_log WHERE github_id = ?
      ORDER BY DATE(synced_at) DESC LIMIT 30
    )
  `),
  getSyncLog: db.prepare(`
    SELECT device_id, synced_at FROM device_sync_log
    WHERE github_id = ? AND device_id = ?
    ORDER BY synced_at DESC
  `),

  // agent presence（AgentTableSync 2026-09-05：跨设备 agent 索引表）
  upsertPresence: db.prepare(`
    INSERT INTO agent_presence (github_id, sid, name, focus, version, model, device_id, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(github_id, sid) DO UPDATE SET
      name = excluded.name,
      focus = excluded.focus,
      version = excluded.version,
      model = excluded.model,
      device_id = excluded.device_id,
      last_seen = datetime('now')
  `),
  queryPresence: db.prepare(`
    SELECT sid, name, focus, version, model, device_id, last_seen
    FROM agent_presence WHERE github_id = ?
  `),
  clearPresence: db.prepare(`
    DELETE FROM agent_presence WHERE github_id = ? AND sid = ?
  `),
  expirePresence: db.prepare(`
    DELETE FROM agent_presence WHERE last_seen < datetime('now', '-5 minutes')
  `),

  // 临时文件分享（2026-09-08 ISSUE 142）
  insertShare: db.prepare(`
    INSERT INTO share_files (id, github_id, filename, size, password_hash, expires_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', '+24 hours'))
  `),
  getShare: db.prepare(`
    SELECT id, github_id, filename, size, password_hash, expires_at FROM share_files WHERE id = ?
  `),
  deleteShare: db.prepare(`
    DELETE FROM share_files WHERE id = ?
  `),
  cleanupExpiredShares: db.prepare(`
    DELETE FROM share_files WHERE expires_at < datetime('now')
  `),
  // update 遥测（2026-09-09）
  insertUpdateHistory: db.prepare(`
    INSERT INTO update_history (github_id, device_id, from_ver, to_ver, channel, trigger_by, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  listUpdateHistory: db.prepare(`
    SELECT device_id, from_ver, to_ver, channel, trigger_by, ts FROM update_history
    WHERE github_id = ? ORDER BY id DESC LIMIT ?
  `),
  // 备份事件（2026-09-12）
  insertBackupEvent: db.prepare(`
    INSERT INTO backup_events (github_id, device_id, ok, detail, host, ts)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
};
