import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from '../logger';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidates (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id),
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  status       TEXT NOT NULL,
  summary      TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id),
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at);
`;

/**
 * 打开（或新建）SQLite 数据库并执行幂等迁移（CREATE TABLE IF NOT EXISTS）。
 * `:memory:` 用于测试（每个连接独立、进程退出即销毁）；文件库会自动创建所在目录。
 */
export function openDatabase(path: string, logger?: Logger): Db {
  const isMemory = path === ':memory:';
  if (!isMemory) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  if (!isMemory) {
    // WAL 提升并发读写表现；内存库不支持 WAL，跳过。
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  logger?.info({ path }, 'SQLite 持久化已就绪');
  return db;
}
