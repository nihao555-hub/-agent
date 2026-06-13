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

-- ===== 事实底座（System of Record）=====
-- 项目：一个工程标的，贯穿投标→交付→结算全生命周期。
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL,
  tenderer   TEXT,
  client     TEXT,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 文档：招标/合同/规范/BOQ/图纸/变更单/函件等任意来源。
CREATE TABLE IF NOT EXISTS documents (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  type       TEXT NOT NULL,
  title      TEXT,
  source     TEXT,
  page_count INTEGER,
  parsed     INTEGER NOT NULL DEFAULT 0,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 片段：文档解析后的可检索单元（带页码/条款定位）= 原文出处最小单元，也是 RAG 检索单元。
CREATE TABLE IF NOT EXISTS chunks (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  project_id  TEXT NOT NULL REFERENCES projects(id),
  ordinal     INTEGER NOT NULL,
  page        INTEGER,
  clause      TEXT,
  text        TEXT NOT NULL,
  embedding   TEXT,
  created_at  TEXT NOT NULL
);

-- 要求基线：招标/合同"要求我们什么"。
CREATE TABLE IF NOT EXISTS requirements (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  source_chunk_id TEXT REFERENCES chunks(id),
  kind            TEXT NOT NULL,
  category        TEXT,
  text            TEXT NOT NULL,
  mandatory       INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'open',
  severity        TEXT,
  data            TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

-- 承诺：我方投标/方案/合同中"承诺了什么"。
CREATE TABLE IF NOT EXISTS commitments (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  source_chunk_id TEXT REFERENCES chunks(id),
  requirement_id  TEXT REFERENCES requirements(id),
  kind            TEXT,
  text            TEXT NOT NULL,
  data            TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

-- 偏离：要求↔承诺↔现状 的偏差。
CREATE TABLE IF NOT EXISTS deviations (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  requirement_id TEXT REFERENCES requirements(id),
  commitment_id  TEXT REFERENCES commitments(id),
  type           TEXT NOT NULL,
  severity       TEXT,
  status         TEXT NOT NULL DEFAULT 'open',
  description    TEXT NOT NULL,
  detected_by    TEXT NOT NULL DEFAULT 'llm',
  data           TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- 证据：支撑判断/偏离/索赔的片段引用。
CREATE TABLE IF NOT EXISTS evidences (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  chunk_id   TEXT NOT NULL REFERENCES chunks(id),
  note       TEXT,
  created_at TEXT NOT NULL
);

-- 变更/签证。
CREATE TABLE IF NOT EXISTS changes (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  title          TEXT NOT NULL,
  description    TEXT,
  in_scope       TEXT NOT NULL DEFAULT 'uncertain',
  basis_chunk_id TEXT REFERENCES chunks(id),
  cost_impact    TEXT,
  time_impact    TEXT,
  status         TEXT NOT NULL DEFAULT 'proposed',
  data           TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- 索赔。
CREATE TABLE IF NOT EXISTS claims (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  change_id  TEXT REFERENCES changes(id),
  type       TEXT NOT NULL,
  basis      TEXT,
  amount     TEXT,
  days       INTEGER,
  narrative  TEXT,
  status     TEXT NOT NULL DEFAULT 'draft',
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 关联图谱边：把上述结点连成可追溯的事实图。
CREATE TABLE IF NOT EXISTS links (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  from_type  TEXT NOT NULL,
  from_id    TEXT NOT NULL,
  to_type    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  relation   TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 项目级事件流留痕。
CREATE TABLE IF NOT EXISTS project_events (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  type       TEXT NOT NULL,
  detail     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenders_created ON tenders(created_at);
CREATE INDEX IF NOT EXISTS idx_analyses_tender ON analyses(tender_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_tender ON events(tender_id, created_at);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(project_id);
CREATE INDEX IF NOT EXISTS idx_requirements_project ON requirements(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_commitments_project ON commitments(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deviations_project ON deviations(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_evidences_project ON evidences(project_id);
CREATE INDEX IF NOT EXISTS idx_changes_project ON changes(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_claims_project ON claims(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_links_project ON links(project_id);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_project_events_project ON project_events(project_id, created_at);
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
