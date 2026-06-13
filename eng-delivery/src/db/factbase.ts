import { randomUUID } from 'node:crypto';
import type {
  Change,
  Chunk,
  Claim,
  Commitment,
  Deviation,
  Evidence,
  Link,
  Project,
  ProjectDocument,
  ProjectEvent,
  Requirement,
} from '../factbase/types';
import type { Db } from './index';

function now(): string {
  return new Date().toISOString();
}

interface IdDataRow {
  id: string;
  data: string;
}

/** 项目仓储：贯穿投标→交付→结算全生命周期的顶层结点。 */
export class ProjectRepository {
  constructor(private readonly db: Db) {}

  create(input: { name: string; status?: Project['status']; tenderer?: string; client?: string }): Project {
    const project: Project = {
      id: randomUUID(),
      name: input.name,
      status: input.status ?? 'bidding',
      tenderer: input.tenderer,
      client: input.client,
      createdAt: now(),
    };
    this.db
      .prepare(
        'INSERT INTO projects (id, name, status, tenderer, client, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        project.id,
        project.name,
        project.status,
        project.tenderer ?? null,
        project.client ?? null,
        JSON.stringify(project),
        project.createdAt,
      );
    return project;
  }

  get(id: string): Project | undefined {
    const row = this.db.prepare('SELECT id, data FROM projects WHERE id = ?').get(id) as
      | IdDataRow
      | undefined;
    return row ? (JSON.parse(row.data) as Project) : undefined;
  }

  list(): Project[] {
    const rows = this.db
      .prepare('SELECT id, data FROM projects ORDER BY created_at DESC')
      .all() as IdDataRow[];
    return rows.map((r) => JSON.parse(r.data) as Project);
  }

  setStatus(id: string, status: Project['status']): void {
    const project = this.get(id);
    if (!project) return;
    const updated: Project = { ...project, status };
    this.db
      .prepare('UPDATE projects SET status = ?, data = ? WHERE id = ?')
      .run(status, JSON.stringify(updated), id);
  }
}

/** 文档仓储。 */
export class DocumentRepository {
  constructor(private readonly db: Db) {}

  create(input: {
    projectId: string;
    type: ProjectDocument['type'];
    title?: string;
    source?: string;
    pageCount?: number;
    parsed?: boolean;
  }): ProjectDocument {
    const doc: ProjectDocument = {
      id: randomUUID(),
      projectId: input.projectId,
      type: input.type,
      title: input.title,
      source: input.source,
      pageCount: input.pageCount,
      parsed: input.parsed ?? false,
      createdAt: now(),
    };
    this.db
      .prepare(
        'INSERT INTO documents (id, project_id, type, title, source, page_count, parsed, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        doc.id,
        doc.projectId,
        doc.type,
        doc.title ?? null,
        doc.source ?? null,
        doc.pageCount ?? null,
        doc.parsed ? 1 : 0,
        JSON.stringify(doc),
        doc.createdAt,
      );
    return doc;
  }

  get(id: string): ProjectDocument | undefined {
    const row = this.db.prepare('SELECT id, data FROM documents WHERE id = ?').get(id) as
      | IdDataRow
      | undefined;
    return row ? (JSON.parse(row.data) as ProjectDocument) : undefined;
  }

  markParsed(id: string, pageCount?: number): void {
    const doc = this.get(id);
    if (!doc) return;
    const updated: ProjectDocument = { ...doc, parsed: true, pageCount: pageCount ?? doc.pageCount };
    this.db
      .prepare('UPDATE documents SET parsed = 1, page_count = ?, data = ? WHERE id = ?')
      .run(updated.pageCount ?? null, JSON.stringify(updated), id);
  }

  listByProject(projectId: string): ProjectDocument[] {
    const rows = this.db
      .prepare('SELECT id, data FROM documents WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as IdDataRow[];
    return rows.map((r) => JSON.parse(r.data) as ProjectDocument);
  }
}

interface ChunkRow {
  id: string;
  document_id: string;
  project_id: string;
  ordinal: number;
  page: number | null;
  clause: string | null;
  text: string;
  embedding: string | null;
  created_at: string;
}

function rowToChunk(r: ChunkRow): Chunk {
  return {
    id: r.id,
    documentId: r.document_id,
    projectId: r.project_id,
    ordinal: r.ordinal,
    page: r.page ?? undefined,
    clause: r.clause ?? undefined,
    text: r.text,
    embedding: r.embedding ? (JSON.parse(r.embedding) as number[]) : undefined,
    createdAt: r.created_at,
  };
}

/** 片段仓储：原文出处最小单元 + RAG 检索单元。 */
export class ChunkRepository {
  constructor(private readonly db: Db) {}

  create(input: {
    documentId: string;
    projectId: string;
    ordinal: number;
    text: string;
    page?: number;
    clause?: string;
    embedding?: number[];
  }): Chunk {
    const chunk: Chunk = {
      id: randomUUID(),
      documentId: input.documentId,
      projectId: input.projectId,
      ordinal: input.ordinal,
      page: input.page,
      clause: input.clause,
      text: input.text,
      embedding: input.embedding,
      createdAt: now(),
    };
    this.db
      .prepare(
        'INSERT INTO chunks (id, document_id, project_id, ordinal, page, clause, text, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        chunk.id,
        chunk.documentId,
        chunk.projectId,
        chunk.ordinal,
        chunk.page ?? null,
        chunk.clause ?? null,
        chunk.text,
        chunk.embedding ? JSON.stringify(chunk.embedding) : null,
        chunk.createdAt,
      );
    return chunk;
  }

  createMany(
    inputs: Array<{
      documentId: string;
      projectId: string;
      ordinal: number;
      text: string;
      page?: number;
      clause?: string;
      embedding?: number[];
    }>,
  ): Chunk[] {
    const tx = this.db.transaction((items: typeof inputs) => items.map((i) => this.create(i)));
    return tx(inputs);
  }

  get(id: string): Chunk | undefined {
    const row = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(id) as ChunkRow | undefined;
    return row ? rowToChunk(row) : undefined;
  }

  setEmbedding(id: string, embedding: number[]): void {
    this.db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?').run(JSON.stringify(embedding), id);
  }

  listByProject(projectId: string): Chunk[] {
    const rows = this.db
      .prepare('SELECT * FROM chunks WHERE project_id = ? ORDER BY ordinal ASC')
      .all(projectId) as ChunkRow[];
    return rows.map(rowToChunk);
  }

  listByDocument(documentId: string): Chunk[] {
    const rows = this.db
      .prepare('SELECT * FROM chunks WHERE document_id = ? ORDER BY ordinal ASC')
      .all(documentId) as ChunkRow[];
    return rows.map(rowToChunk);
  }
}

/** 要求基线仓储。 */
export class RequirementRepository {
  constructor(private readonly db: Db) {}

  create(input: {
    projectId: string;
    kind: Requirement['kind'];
    text: string;
    sourceChunkId?: string;
    category?: string;
    mandatory?: boolean;
    status?: Requirement['status'];
    severity?: Requirement['severity'];
  }): Requirement {
    const req: Requirement = {
      id: randomUUID(),
      projectId: input.projectId,
      sourceChunkId: input.sourceChunkId,
      kind: input.kind,
      category: input.category,
      text: input.text,
      mandatory: input.mandatory ?? false,
      status: input.status ?? 'open',
      severity: input.severity,
      createdAt: now(),
    };
    this.db
      .prepare(
        'INSERT INTO requirements (id, project_id, source_chunk_id, kind, category, text, mandatory, status, severity, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        req.id,
        req.projectId,
        req.sourceChunkId ?? null,
        req.kind,
        req.category ?? null,
        req.text,
        req.mandatory ? 1 : 0,
        req.status,
        req.severity ?? null,
        JSON.stringify(req),
        req.createdAt,
      );
    return req;
  }

  get(id: string): Requirement | undefined {
    const row = this.db.prepare('SELECT id, data FROM requirements WHERE id = ?').get(id) as
      | IdDataRow
      | undefined;
    return row ? (JSON.parse(row.data) as Requirement) : undefined;
  }

  setStatus(id: string, status: Requirement['status']): void {
    const req = this.get(id);
    if (!req) return;
    const updated: Requirement = { ...req, status };
    this.db
      .prepare('UPDATE requirements SET status = ?, data = ? WHERE id = ?')
      .run(status, JSON.stringify(updated), id);
  }

  listByProject(projectId: string): Requirement[] {
    const rows = this.db
      .prepare('SELECT id, data FROM requirements WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as IdDataRow[];
    return rows.map((r) => JSON.parse(r.data) as Requirement);
  }
}

/** 承诺仓储。 */
export class CommitmentRepository {
  constructor(private readonly db: Db) {}

  create(input: {
    projectId: string;
    text: string;
    sourceChunkId?: string;
    requirementId?: string;
    kind?: string;
  }): Commitment {
    const c: Commitment = {
      id: randomUUID(),
      projectId: input.projectId,
      sourceChunkId: input.sourceChunkId,
      requirementId: input.requirementId,
      kind: input.kind,
      text: input.text,
      createdAt: now(),
    };
    this.db
      .prepare(
        'INSERT INTO commitments (id, project_id, source_chunk_id, requirement_id, kind, text, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        c.id,
        c.projectId,
        c.sourceChunkId ?? null,
        c.requirementId ?? null,
        c.kind ?? null,
        c.text,
        JSON.stringify(c),
        c.createdAt,
      );
    return c;
  }

  get(id: string): Commitment | undefined {
    const row = this.db.prepare('SELECT id, data FROM commitments WHERE id = ?').get(id) as
      | IdDataRow
      | undefined;
    return row ? (JSON.parse(row.data) as Commitment) : undefined;
  }

  listByProject(projectId: string): Commitment[] {
    const rows = this.db
      .prepare('SELECT id, data FROM commitments WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as IdDataRow[];
    return rows.map((r) => JSON.parse(r.data) as Commitment);
  }
}

/** 偏离仓储。 */
export class DeviationRepository {
  constructor(private readonly db: Db) {}

  create(input: {
    projectId: string;
    type: Deviation['type'];
    description: string;
    requirementId?: string;
    commitmentId?: string;
    severity?: Deviation['severity'];
    status?: string;
    detectedBy?: string;
  }): Deviation {
    const d: Deviation = {
      id: randomUUID(),
      projectId: input.projectId,
      requirementId: input.requirementId,
      commitmentId: input.commitmentId,
      type: input.type,
      severity: input.severity,
      status: input.status ?? 'open',
      description: input.description,
      detectedBy: input.detectedBy ?? 'llm',
      createdAt: now(),
    };
    this.db
      .prepare(
        'INSERT INTO deviations (id, project_id, requirement_id, commitment_id, type, severity, status, description, detected_by, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        d.id,
        d.projectId,
        d.requirementId ?? null,
        d.commitmentId ?? null,
        d.type,
        d.severity ?? null,
        d.status,
        d.description,
        d.detectedBy,
        JSON.stringify(d),
        d.createdAt,
      );
    return d;
  }

  listByProject(projectId: string): Deviation[] {
    const rows = this.db
      .prepare('SELECT id, data FROM deviations WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as IdDataRow[];
    return rows.map((r) => JSON.parse(r.data) as Deviation);
  }
}

/** 证据仓储。 */
export class EvidenceRepository {
  constructor(private readonly db: Db) {}

  create(input: { projectId: string; chunkId: string; note?: string }): Evidence {
    const e: Evidence = {
      id: randomUUID(),
      projectId: input.projectId,
      chunkId: input.chunkId,
      note: input.note,
      createdAt: now(),
    };
    this.db
      .prepare('INSERT INTO evidences (id, project_id, chunk_id, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(e.id, e.projectId, e.chunkId, e.note ?? null, e.createdAt);
    return e;
  }

  listByProject(projectId: string): Evidence[] {
    const rows = this.db
      .prepare('SELECT id, project_id, chunk_id, note, created_at FROM evidences WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as Array<{
      id: string;
      project_id: string;
      chunk_id: string;
      note: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      chunkId: r.chunk_id,
      note: r.note ?? undefined,
      createdAt: r.created_at,
    }));
  }
}

/** 变更/签证仓储。 */
export class ChangeRepository {
  constructor(private readonly db: Db) {}

  create(input: {
    projectId: string;
    title: string;
    description?: string;
    inScope?: Change['inScope'];
    basisChunkId?: string;
    costImpact?: string;
    timeImpact?: string;
    status?: string;
  }): Change {
    const c: Change = {
      id: randomUUID(),
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      inScope: input.inScope ?? 'uncertain',
      basisChunkId: input.basisChunkId,
      costImpact: input.costImpact,
      timeImpact: input.timeImpact,
      status: input.status ?? 'proposed',
      createdAt: now(),
    };
    this.db
      .prepare(
        'INSERT INTO changes (id, project_id, title, description, in_scope, basis_chunk_id, cost_impact, time_impact, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        c.id,
        c.projectId,
        c.title,
        c.description ?? null,
        c.inScope,
        c.basisChunkId ?? null,
        c.costImpact ?? null,
        c.timeImpact ?? null,
        c.status,
        JSON.stringify(c),
        c.createdAt,
      );
    return c;
  }

  get(id: string): Change | undefined {
    const row = this.db.prepare('SELECT id, data FROM changes WHERE id = ?').get(id) as
      | IdDataRow
      | undefined;
    return row ? (JSON.parse(row.data) as Change) : undefined;
  }

  update(id: string, patch: Partial<Omit<Change, 'id' | 'projectId' | 'createdAt'>>): Change | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const updated: Change = { ...existing, ...patch };
    this.db
      .prepare(
        'UPDATE changes SET title = ?, description = ?, in_scope = ?, basis_chunk_id = ?, cost_impact = ?, time_impact = ?, status = ?, data = ? WHERE id = ?',
      )
      .run(
        updated.title,
        updated.description ?? null,
        updated.inScope,
        updated.basisChunkId ?? null,
        updated.costImpact ?? null,
        updated.timeImpact ?? null,
        updated.status,
        JSON.stringify(updated),
        id,
      );
    return updated;
  }

  listByProject(projectId: string): Change[] {
    const rows = this.db
      .prepare('SELECT id, data FROM changes WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as IdDataRow[];
    return rows.map((r) => JSON.parse(r.data) as Change);
  }
}

/** 索赔仓储。 */
export class ClaimRepository {
  constructor(private readonly db: Db) {}

  create(input: {
    projectId: string;
    type: Claim['type'];
    changeId?: string;
    basis?: string;
    amount?: string;
    days?: number;
    narrative?: string;
    status?: string;
  }): Claim {
    const c: Claim = {
      id: randomUUID(),
      projectId: input.projectId,
      changeId: input.changeId,
      type: input.type,
      basis: input.basis,
      amount: input.amount,
      days: input.days,
      narrative: input.narrative,
      status: input.status ?? 'draft',
      createdAt: now(),
    };
    this.db
      .prepare(
        'INSERT INTO claims (id, project_id, change_id, type, basis, amount, days, narrative, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        c.id,
        c.projectId,
        c.changeId ?? null,
        c.type,
        c.basis ?? null,
        c.amount ?? null,
        c.days ?? null,
        c.narrative ?? null,
        c.status,
        JSON.stringify(c),
        c.createdAt,
      );
    return c;
  }

  get(id: string): Claim | undefined {
    const row = this.db.prepare('SELECT id, data FROM claims WHERE id = ?').get(id) as
      | IdDataRow
      | undefined;
    return row ? (JSON.parse(row.data) as Claim) : undefined;
  }

  update(id: string, patch: Partial<Omit<Claim, 'id' | 'projectId' | 'createdAt'>>): Claim | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const updated: Claim = { ...existing, ...patch };
    this.db
      .prepare(
        'UPDATE claims SET change_id = ?, type = ?, basis = ?, amount = ?, days = ?, narrative = ?, status = ?, data = ? WHERE id = ?',
      )
      .run(
        updated.changeId ?? null,
        updated.type,
        updated.basis ?? null,
        updated.amount ?? null,
        updated.days ?? null,
        updated.narrative ?? null,
        updated.status,
        JSON.stringify(updated),
        id,
      );
    return updated;
  }

  listByProject(projectId: string): Claim[] {
    const rows = this.db
      .prepare('SELECT id, data FROM claims WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as IdDataRow[];
    return rows.map((r) => JSON.parse(r.data) as Claim);
  }
}

interface LinkRow {
  id: string;
  project_id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  relation: string;
  created_at: string;
}

function rowToLink(r: LinkRow): Link {
  return {
    id: r.id,
    projectId: r.project_id,
    fromType: r.from_type,
    fromId: r.from_id,
    toType: r.to_type,
    toId: r.to_id,
    relation: r.relation,
    createdAt: r.created_at,
  };
}

/** 关联图谱边仓储：把要求/承诺/偏离/证据/变更/索赔/片段连成可追溯的事实图。 */
export class LinkRepository {
  constructor(private readonly db: Db) {}

  create(input: {
    projectId: string;
    fromType: string;
    fromId: string;
    toType: string;
    toId: string;
    relation: string;
  }): Link {
    const l: Link = {
      id: randomUUID(),
      projectId: input.projectId,
      fromType: input.fromType,
      fromId: input.fromId,
      toType: input.toType,
      toId: input.toId,
      relation: input.relation,
      createdAt: now(),
    };
    this.db
      .prepare(
        'INSERT INTO links (id, project_id, from_type, from_id, to_type, to_id, relation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(l.id, l.projectId, l.fromType, l.fromId, l.toType, l.toId, l.relation, l.createdAt);
    return l;
  }

  listByProject(projectId: string): Link[] {
    const rows = this.db
      .prepare('SELECT * FROM links WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as LinkRow[];
    return rows.map(rowToLink);
  }

  listFrom(fromType: string, fromId: string): Link[] {
    const rows = this.db
      .prepare('SELECT * FROM links WHERE from_type = ? AND from_id = ? ORDER BY created_at ASC')
      .all(fromType, fromId) as LinkRow[];
    return rows.map(rowToLink);
  }
}

/** 项目级事件流仓储。 */
export class ProjectEventRepository {
  constructor(private readonly db: Db) {}

  create(projectId: string, type: string, detail: Record<string, unknown> = {}): ProjectEvent {
    const e: ProjectEvent = {
      id: randomUUID(),
      projectId,
      type,
      detail,
      createdAt: now(),
    };
    this.db
      .prepare(
        'INSERT INTO project_events (id, project_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(e.id, e.projectId, e.type, JSON.stringify(e.detail), e.createdAt);
    return e;
  }

  listByProject(projectId: string): ProjectEvent[] {
    const rows = this.db
      .prepare('SELECT id, project_id, type, detail, created_at FROM project_events WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as Array<{
      id: string;
      project_id: string;
      type: string;
      detail: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      type: r.type,
      detail: JSON.parse(r.detail) as Record<string, unknown>,
      createdAt: r.created_at,
    }));
  }
}
