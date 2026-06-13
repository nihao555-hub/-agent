import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatRole, ChatScreeningSummary, ChatSessionStatus } from '../chat/types';
import type { JobPosting, ResumeProfile } from '../types';
import type { Db } from './index';

function now(): string {
  return new Date().toISOString();
}

interface JobRow {
  id: string;
  data: string;
}

/** 岗位仓储：以 JSON 形式整存岗位结构，title 冗余出来便于列表展示。 */
export class JobRepository {
  constructor(private readonly db: Db) {}

  create(job: JobPosting): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO jobs (id, title, data, created_at) VALUES (?, ?, ?, ?)')
      .run(id, job.title, JSON.stringify(job), now());
    return id;
  }

  get(id: string): JobPosting | undefined {
    const row = this.db.prepare('SELECT id, data FROM jobs WHERE id = ?').get(id) as
      | JobRow
      | undefined;
    return row ? (JSON.parse(row.data) as JobPosting) : undefined;
  }
}

interface CandidateRow {
  id: string;
  data: string;
}

/** 候选人仓储：以 JSON 形式整存简历画像，name 冗余出来便于列表展示。 */
export class CandidateRepository {
  constructor(private readonly db: Db) {}

  create(resume: ResumeProfile): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO candidates (id, name, data, created_at) VALUES (?, ?, ?, ?)')
      .run(id, resume.name ?? null, JSON.stringify(resume), now());
    return id;
  }

  get(id: string): ResumeProfile | undefined {
    const row = this.db.prepare('SELECT id, data FROM candidates WHERE id = ?').get(id) as
      | CandidateRow
      | undefined;
    return row ? (JSON.parse(row.data) as ResumeProfile) : undefined;
  }
}

export interface ChatSessionRow {
  id: string;
  jobId: string;
  candidateId: string;
  status: ChatSessionStatus;
  summary?: ChatScreeningSummary;
  createdAt: string;
  updatedAt: string;
}

interface RawSessionRow {
  id: string;
  job_id: string;
  candidate_id: string;
  status: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

interface RawMessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: string;
  content: string;
  created_at: string;
}

export interface ChatSessionListRow extends ChatSessionRow {
  messageCount: number;
}

interface RawSessionListRow extends RawSessionRow {
  message_count: number;
}

function toSessionRow(raw: RawSessionRow): ChatSessionRow {
  return {
    id: raw.id,
    jobId: raw.job_id,
    candidateId: raw.candidate_id,
    status: raw.status as ChatSessionStatus,
    summary: raw.summary ? (JSON.parse(raw.summary) as ChatScreeningSummary) : undefined,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function toMessage(raw: RawMessageRow): ChatMessage {
  return {
    id: raw.id,
    sessionId: raw.session_id,
    seq: raw.seq,
    role: raw.role as ChatRole,
    content: raw.content,
    createdAt: raw.created_at,
  };
}

/** 对话仓储：管理会话与消息（自增 seq、状态、结构化小结）。 */
export class ChatRepository {
  constructor(private readonly db: Db) {}

  createSession(jobId: string, candidateId: string): ChatSessionRow {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO chat_sessions (id, job_id, candidate_id, status, summary, created_at, updated_at)
         VALUES (?, ?, ?, 'active', NULL, ?, ?)`,
      )
      .run(id, jobId, candidateId, ts, ts);
    return {
      id,
      jobId,
      candidateId,
      status: 'active',
      createdAt: ts,
      updatedAt: ts,
    };
  }

  getSession(id: string): ChatSessionRow | undefined {
    const raw = this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as
      | RawSessionRow
      | undefined;
    return raw ? toSessionRow(raw) : undefined;
  }

  listSessions(): ChatSessionListRow[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS message_count
         FROM chat_sessions s
         ORDER BY s.updated_at DESC`,
      )
      .all() as RawSessionListRow[];
    return rows.map((raw) => ({ ...toSessionRow(raw), messageCount: raw.message_count }));
  }

  addMessage(sessionId: string, role: ChatRole, content: string): ChatMessage {
    const id = randomUUID();
    const ts = now();
    const seqRow = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM chat_messages WHERE session_id = ?')
      .get(sessionId) as { next: number };
    const seq = seqRow.next;
    this.db
      .prepare(
        'INSERT INTO chat_messages (id, session_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, sessionId, seq, role, content, ts);
    return { id, sessionId, seq, role, content, createdAt: ts };
  }

  listMessages(sessionId: string): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as RawMessageRow[];
    return rows.map(toMessage);
  }

  touch(sessionId: string): void {
    this.db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId);
  }

  setSummary(sessionId: string, summary: ChatScreeningSummary, status: ChatSessionStatus): void {
    this.db
      .prepare('UPDATE chat_sessions SET summary = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(summary), status, now(), sessionId);
  }
}
