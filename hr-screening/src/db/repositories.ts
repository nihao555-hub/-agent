import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatRole, ChatScreeningSummary, ChatSessionStatus } from '../chat/types';
import type {
  Application,
  ApplicationEvent,
  ApplicationEventType,
  ApplicationMeta,
  ApplicationSource,
  Notification,
  NotificationChannel,
  NotificationStatus,
} from '../pipeline/types';
import type { ApplicationStatus } from '../pipeline/status';
import type { JobPosting, ResumeProfile, ScreeningResult } from '../types';
import type { Db } from './index';

function now(): string {
  return new Date().toISOString();
}

interface JobRow {
  id: string;
  data: string;
}

export interface JobSummary {
  id: string;
  title: string;
  createdAt: string;
}

interface JobSummaryRow {
  id: string;
  title: string;
  created_at: string;
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

  list(): JobSummary[] {
    const rows = this.db
      .prepare('SELECT id, title, created_at FROM jobs ORDER BY created_at DESC')
      .all() as JobSummaryRow[];
    return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at }));
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

interface RawApplicationRow {
  id: string;
  job_id: string;
  candidate_id: string;
  status: string;
  source: string;
  screening: string | null;
  created_at: string;
  updated_at: string;
}

interface RawApplicationMetaRow extends RawApplicationRow {
  job_title: string;
  candidate_name: string | null;
}

interface RawApplicationEventRow {
  id: string;
  application_id: string;
  type: string;
  from_status: string | null;
  to_status: string | null;
  detail: string;
  created_at: string;
}

function toApplication(raw: RawApplicationRow): Application {
  return {
    id: raw.id,
    jobId: raw.job_id,
    candidateId: raw.candidate_id,
    status: raw.status as ApplicationStatus,
    source: raw.source as ApplicationSource,
    screening: raw.screening ? (JSON.parse(raw.screening) as ScreeningResult) : undefined,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function toEvent(raw: RawApplicationEventRow): ApplicationEvent {
  return {
    id: raw.id,
    applicationId: raw.application_id,
    type: raw.type as ApplicationEventType,
    fromStatus: (raw.from_status as ApplicationStatus | null) ?? undefined,
    toStatus: (raw.to_status as ApplicationStatus | null) ?? undefined,
    detail: raw.detail,
    createdAt: raw.created_at,
  };
}

export interface ApplicationListFilter {
  jobId?: string;
  status?: ApplicationStatus;
}

/** 投递仓储：管理投递记录（状态机当前态 + 初筛结论）与事件历史。 */
export class ApplicationRepository {
  constructor(private readonly db: Db) {}

  create(input: {
    jobId: string;
    candidateId: string;
    source: ApplicationSource;
    status: ApplicationStatus;
    screening?: ScreeningResult;
  }): Application {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO applications (id, job_id, candidate_id, status, source, screening, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.jobId,
        input.candidateId,
        input.status,
        input.source,
        input.screening ? JSON.stringify(input.screening) : null,
        ts,
        ts,
      );
    return {
      id,
      jobId: input.jobId,
      candidateId: input.candidateId,
      status: input.status,
      source: input.source,
      screening: input.screening,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  get(id: string): Application | undefined {
    const raw = this.db.prepare('SELECT * FROM applications WHERE id = ?').get(id) as
      | RawApplicationRow
      | undefined;
    return raw ? toApplication(raw) : undefined;
  }

  updateStatus(id: string, status: ApplicationStatus): void {
    this.db
      .prepare('UPDATE applications SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now(), id);
  }

  setScreening(id: string, screening: ScreeningResult): void {
    this.db
      .prepare('UPDATE applications SET screening = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(screening), now(), id);
  }

  list(filter: ApplicationListFilter = {}): ApplicationMeta[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.jobId) {
      where.push('a.job_id = ?');
      params.push(filter.jobId);
    }
    if (filter.status) {
      where.push('a.status = ?');
      params.push(filter.status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT a.*, j.title AS job_title, c.name AS candidate_name
         FROM applications a
         JOIN jobs j ON j.id = a.job_id
         JOIN candidates c ON c.id = a.candidate_id
         ${clause}
         ORDER BY a.updated_at DESC`,
      )
      .all(...params) as RawApplicationMetaRow[];
    return rows.map((raw) => {
      const screening = raw.screening ? (JSON.parse(raw.screening) as ScreeningResult) : undefined;
      return {
        id: raw.id,
        jobId: raw.job_id,
        jobTitle: raw.job_title,
        candidateId: raw.candidate_id,
        candidateName: raw.candidate_name ?? undefined,
        status: raw.status as ApplicationStatus,
        source: raw.source as ApplicationSource,
        matchScore: screening?.matchScore,
        recommendation: screening?.recommendation,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
      };
    });
  }

  addEvent(input: {
    applicationId: string;
    type: ApplicationEventType;
    fromStatus?: ApplicationStatus;
    toStatus?: ApplicationStatus;
    detail: string;
  }): ApplicationEvent {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO application_events (id, application_id, type, from_status, to_status, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.applicationId,
        input.type,
        input.fromStatus ?? null,
        input.toStatus ?? null,
        input.detail,
        ts,
      );
    return {
      id,
      applicationId: input.applicationId,
      type: input.type,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      detail: input.detail,
      createdAt: ts,
    };
  }

  listEvents(applicationId: string): ApplicationEvent[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM application_events WHERE application_id = ? ORDER BY created_at ASC, rowid ASC',
      )
      .all(applicationId) as RawApplicationEventRow[];
    return rows.map(toEvent);
  }
}

interface RawNotificationRow {
  id: string;
  application_id: string;
  channel: string;
  recipient: string;
  subject: string | null;
  body: string;
  status: string;
  engine: string | null;
  error: string | null;
  created_at: string;
}

function toNotification(raw: RawNotificationRow): Notification {
  return {
    id: raw.id,
    applicationId: raw.application_id,
    channel: raw.channel as NotificationChannel,
    recipient: raw.recipient,
    subject: raw.subject ?? undefined,
    body: raw.body,
    status: raw.status as NotificationStatus,
    engine: raw.engine ?? undefined,
    error: raw.error ?? undefined,
    createdAt: raw.created_at,
  };
}

/** 通知仓储：记录每一次对候选人的反馈通知（含 dry-run）。 */
export class NotificationRepository {
  constructor(private readonly db: Db) {}

  create(input: Omit<Notification, 'id' | 'createdAt'>): Notification {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO notifications (id, application_id, channel, recipient, subject, body, status, engine, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.applicationId,
        input.channel,
        input.recipient,
        input.subject ?? null,
        input.body,
        input.status,
        input.engine ?? null,
        input.error ?? null,
        ts,
      );
    return { id, createdAt: ts, ...input };
  }

  listByApplication(applicationId: string): Notification[] {
    const rows = this.db
      .prepare('SELECT * FROM notifications WHERE application_id = ? ORDER BY created_at ASC')
      .all(applicationId) as RawNotificationRow[];
    return rows.map(toNotification);
  }
}
