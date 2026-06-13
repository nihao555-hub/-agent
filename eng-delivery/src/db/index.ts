import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from '../logger';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenders (
  id           TEXT PRIMARY KEY,
  project_name TEXT,
  engine       TEXT,
  data         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capabilities (
  id           TEXT PRIMARY KEY,
  company_name TEXT,
  data         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analyses (
  id            TEXT PRIMARY KEY,
  tender_id     TEXT NOT NULL REFERENCES tenders(id),
  capability_id TEXT REFERENCES capabilities(id),
  kind          TEXT NOT NULL,
  engine        TEXT NOT NULL,
  data          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  tender_id  TEXT NOT NULL REFERENCES tenders(id),
  type       TEXT NOT NULL,
  detail     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenders_created ON tenders(created_at);
CREATE INDEX IF NOT EXISTS idx_analyses_tender ON analyses(tender_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_tender ON events(tender_id, created_at);
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
