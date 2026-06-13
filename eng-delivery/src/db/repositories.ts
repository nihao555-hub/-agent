import { randomUUID } from 'node:crypto';
import type { CapabilityProfile, ComplianceReport, GapReport, TenderSpec } from '../types';
import type { Db } from './index';

function now(): string {
  return new Date().toISOString();
}

export type AnalysisKind = 'gap' | 'compliance' | 'analyze';

export interface TenderSummary {
  id: string;
  projectName?: string;
  engine?: string;
  createdAt: string;
}

interface DataRow {
  id: string;
  data: string;
}

interface TenderSummaryRow {
  id: string;
  project_name: string | null;
  engine: string | null;
  created_at: string;
}

/** 招标文件仓储：整存结构化要点(TenderSpec) 为 JSON，project_name/engine 冗余出来便于列表。 */
export class TenderRepository {
  constructor(private readonly db: Db) {}

  create(tender: TenderSpec, engine: string): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO tenders (id, project_name, engine, data, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, tender.projectName ?? null, engine, JSON.stringify(tender), now());
    return id;
  }

  get(id: string): TenderSpec | undefined {
    const row = this.db.prepare('SELECT id, data FROM tenders WHERE id = ?').get(id) as
      | DataRow
      | undefined;
    return row ? (JSON.parse(row.data) as TenderSpec) : undefined;
  }

  list(): TenderSummary[] {
    const rows = this.db
      .prepare('SELECT id, project_name, engine, created_at FROM tenders ORDER BY created_at DESC')
      .all() as TenderSummaryRow[];
    return rows.map((r) => ({
      id: r.id,
      projectName: r.project_name ?? undefined,
      engine: r.engine ?? undefined,
      createdAt: r.created_at,
    }));
  }
}

/** 我方能力档案仓储。 */
export class CapabilityRepository {
  constructor(private readonly db: Db) {}

  create(capability: CapabilityProfile): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO capabilities (id, company_name, data, created_at) VALUES (?, ?, ?, ?)')
      .run(id, capability.companyName ?? null, JSON.stringify(capability), now());
    return id;
  }

  get(id: string): CapabilityProfile | undefined {
    const row = this.db.prepare('SELECT id, data FROM capabilities WHERE id = ?').get(id) as
      | DataRow
      | undefined;
    return row ? (JSON.parse(row.data) as CapabilityProfile) : undefined;
  }
}

export interface AnalysisRecord {
  id: string;
  tenderId: string;
  capabilityId?: string;
  kind: AnalysisKind;
  engine: string;
  /** 结果对象（GapReport / ComplianceReport / 二者组合）。 */
  result: GapReport | ComplianceReport | Record<string, unknown>;
  createdAt: string;
}

interface AnalysisRow {
  id: string;
  tender_id: string;
  capability_id: string | null;
  kind: string;
  engine: string;
  data: string;
  created_at: string;
}

/** 分析结果仓储：缺口检测/合规自检/端到端分析的结果留痕。 */
export class AnalysisRepository {
  constructor(private readonly db: Db) {}

  create(input: {
    tenderId: string;
    capabilityId?: string;
    kind: AnalysisKind;
    engine: string;
    result: GapReport | ComplianceReport | Record<string, unknown>;
  }): string {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO analyses (id, tender_id, capability_id, kind, engine, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.tenderId,
        input.capabilityId ?? null,
        input.kind,
        input.engine,
        JSON.stringify(input.result),
        now(),
      );
    return id;
  }

  listByTender(tenderId: string): AnalysisRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM analyses WHERE tender_id = ? ORDER BY created_at DESC')
      .all(tenderId) as AnalysisRow[];
    return rows.map((r) => ({
      id: r.id,
      tenderId: r.tender_id,
      capabilityId: r.capability_id ?? undefined,
      kind: r.kind as AnalysisKind,
      engine: r.engine,
      result: JSON.parse(r.data),
      createdAt: r.created_at,
    }));
  }
}

export interface EventRecord {
  id: string;
  tenderId: string;
  type: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

interface EventRow {
  id: string;
  tender_id: string;
  type: string;
  detail: string;
  created_at: string;
}

/** 事件流仓储：记录解析/分析等关键动作，形成可追溯的事件链。 */
export class EventRepository {
  constructor(private readonly db: Db) {}

  create(tenderId: string, type: string, detail: Record<string, unknown> = {}): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO events (id, tender_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, tenderId, type, JSON.stringify(detail), now());
    return id;
  }

  listByTender(tenderId: string): EventRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE tender_id = ? ORDER BY created_at ASC')
      .all(tenderId) as EventRow[];
    return rows.map((r) => ({
      id: r.id,
      tenderId: r.tender_id,
      type: r.type,
      detail: JSON.parse(r.detail),
      createdAt: r.created_at,
    }));
  }
}
