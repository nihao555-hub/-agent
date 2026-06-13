import { HttpError } from '../errors';
import type {
  ChangeRepository,
  ChunkRepository,
  ClaimRepository,
  CommitmentRepository,
  DeviationRepository,
  DocumentRepository,
  EvidenceRepository,
  LinkRepository,
  ProjectEventRepository,
  ProjectRepository,
  RequirementRepository,
} from '../db/factbase';
import type { TenderDocParser } from '../doc/parser';
import { chunkText } from '../doc/chunker';
import type { Logger } from '../logger';
import { cosineSimilarity } from '../utils/vector';
import type { EmbeddingClient } from './embeddings';
import type { FactExtractor } from './extractor';
import type {
  Change,
  Chunk,
  ChunkHit,
  Claim,
  Commitment,
  Deviation,
  DocumentType,
  Evidence,
  Link,
  Project,
  ProjectDocument,
  ProjectEvent,
  ProjectStatus,
  Requirement,
} from './types';

export interface FactBaseRepos {
  projects: ProjectRepository;
  documents: DocumentRepository;
  chunks: ChunkRepository;
  requirements: RequirementRepository;
  commitments: CommitmentRepository;
  deviations: DeviationRepository;
  evidences: EvidenceRepository;
  changes: ChangeRepository;
  claims: ClaimRepository;
  links: LinkRepository;
  events: ProjectEventRepository;
}

export interface CreateProjectInput {
  name: string;
  status?: ProjectStatus;
  tenderer?: string;
  client?: string;
}

export interface IngestDocumentInput {
  type: DocumentType;
  title?: string;
  source?: string;
  text?: string;
  fileBase64?: string;
  fileName?: string;
}

export interface IngestResult {
  document: ProjectDocument;
  chunkCount: number;
  chunks: Chunk[];
}

export interface ExtractResult {
  engine: string;
  requirements: Requirement[];
}

export interface CommitmentExtractResult {
  engine: string;
  commitments: Commitment[];
}

export interface DeviationResult {
  engine: string;
  deviations: Deviation[];
}

export interface SearchResult {
  engine: string;
  query: string;
  hits: ChunkHit[];
}

export interface ProjectGraph {
  project: Project;
  documents: ProjectDocument[];
  requirements: Requirement[];
  commitments: Commitment[];
  deviations: Deviation[];
  evidences: Evidence[];
  changes: Change[];
  claims: Claim[];
  links: Link[];
  events: ProjectEvent[];
  stats: {
    documents: number;
    chunks: number;
    requirements: number;
    commitments: number;
    deviations: number;
    changes: number;
    claims: number;
  };
}

/**
 * 事实底座服务：把文档沉淀为「项目 → 文档 → 片段 → 要求/承诺/偏离/证据/变更/索赔」的可追溯图谱。
 * 智能（抽取/比对）来自注入的 FactExtractor（大模型优先，失败回退薄兜底）；
 * 本服务只负责把结果落库并连成图（写 node + link + 事件），每条结论都带原文出处(chunk)。
 */
export class FactBaseService {
  constructor(
    private readonly repos: FactBaseRepos,
    private readonly extractor: FactExtractor,
    private readonly parser: TenderDocParser,
    private readonly embedder: EmbeddingClient,
    private readonly logger?: Logger,
  ) {}

  createProject(input: CreateProjectInput): Project {
    const project = this.repos.projects.create(input);
    this.repos.events.create(project.id, 'project_created', { name: project.name });
    return project;
  }

  getProject(id: string): Project {
    const project = this.repos.projects.get(id);
    if (!project) throw new HttpError(404, `项目不存在: ${id}`);
    return project;
  }

  listProjects(): Project[] {
    return this.repos.projects.list();
  }

  setStatus(id: string, status: ProjectStatus): Project {
    this.getProject(id);
    this.repos.projects.setStatus(id, status);
    this.repos.events.create(id, 'status_changed', { status });
    return this.getProject(id);
  }

  /** 录入并解析一份文档：抽取文本 → 机械切片 → 落库为可引用的 chunk。 */
  async ingestDocument(projectId: string, input: IngestDocumentInput): Promise<IngestResult> {
    this.getProject(projectId);
    const extracted = await this.parser.extract({
      text: input.text,
      fileBase64: input.fileBase64,
      fileName: input.fileName,
    });
    const document = this.repos.documents.create({
      projectId,
      type: input.type,
      title: input.title,
      source: input.source ?? extracted.source,
    });
    const raw = chunkText(extracted.text);
    const chunks = this.repos.chunks.createMany(
      raw.map((c) => ({
        documentId: document.id,
        projectId,
        ordinal: c.ordinal,
        text: c.text,
        page: c.page,
        clause: c.clause,
      })),
    );
    await this.embedChunks(chunks);
    this.repos.documents.markParsed(document.id, raw.length);
    const saved = this.repos.documents.get(document.id) ?? document;
    this.repos.events.create(projectId, 'document_ingested', {
      documentId: document.id,
      type: input.type,
      chunks: chunks.length,
      source: extracted.source,
    });
    return { document: saved, chunkCount: chunks.length, chunks };
  }

  /** 从（指定文档或全项目的）片段中抽取「要求基线」，每条挂上原文出处。 */
  async extractRequirements(projectId: string, documentId?: string): Promise<ExtractResult> {
    this.getProject(projectId);
    const chunks = this.chunksFor(projectId, documentId);
    const extracted = await this.extractor.extractRequirements(chunks);
    const requirements = extracted.map((e) => {
      const sourceChunk = chunks[e.chunkIndex];
      const req = this.repos.requirements.create({
        projectId,
        sourceChunkId: sourceChunk?.id,
        kind: e.kind,
        category: e.category,
        text: e.text,
        mandatory: e.mandatory,
        severity: e.severity,
      });
      if (sourceChunk) {
        this.repos.links.create({
          projectId,
          fromType: 'requirement',
          fromId: req.id,
          toType: 'chunk',
          toId: sourceChunk.id,
          relation: 'cited_from',
        });
      }
      return req;
    });
    this.repos.events.create(projectId, 'requirements_extracted', {
      engine: this.extractor.name,
      count: requirements.length,
      documentId,
    });
    return { engine: this.extractor.name, requirements };
  }

  /** 从（指定文档或全项目的）片段中抽取「我方承诺」，每条挂上原文出处。 */
  async extractCommitments(projectId: string, documentId?: string): Promise<CommitmentExtractResult> {
    this.getProject(projectId);
    const chunks = this.chunksFor(projectId, documentId);
    const extracted = await this.extractor.extractCommitments(chunks);
    const commitments = extracted.map((e) => {
      const sourceChunk = chunks[e.chunkIndex];
      const c = this.repos.commitments.create({
        projectId,
        sourceChunkId: sourceChunk?.id,
        kind: e.kind,
        text: e.text,
      });
      if (sourceChunk) {
        this.repos.links.create({
          projectId,
          fromType: 'commitment',
          fromId: c.id,
          toType: 'chunk',
          toId: sourceChunk.id,
          relation: 'cited_from',
        });
      }
      return c;
    });
    this.repos.events.create(projectId, 'commitments_extracted', {
      engine: this.extractor.name,
      count: commitments.length,
      documentId,
    });
    return { engine: this.extractor.name, commitments };
  }

  /** 比对要求↔承诺，沉淀「偏离」并连边；命中的要求状态置为 at_risk。 */
  async detectDeviations(projectId: string): Promise<DeviationResult> {
    this.getProject(projectId);
    const requirements = this.repos.requirements.listByProject(projectId);
    const commitments = this.repos.commitments.listByProject(projectId);
    const extracted = await this.extractor.detectDeviations(
      requirements.map((r) => ({ text: r.text, kind: r.kind, mandatory: r.mandatory })),
      commitments.map((c) => ({ text: c.text })),
    );
    const deviations = extracted.map((e) => {
      const requirement = requirements[e.requirementIndex];
      const commitment =
        e.commitmentIndex != null ? commitments[e.commitmentIndex] : undefined;
      const dev = this.repos.deviations.create({
        projectId,
        requirementId: requirement?.id,
        commitmentId: commitment?.id,
        type: e.type,
        severity: e.severity,
        description: e.description,
        detectedBy: this.extractor.name,
      });
      if (requirement) {
        this.repos.links.create({
          projectId,
          fromType: 'deviation',
          fromId: dev.id,
          toType: 'requirement',
          toId: requirement.id,
          relation: 'about',
        });
        this.repos.requirements.setStatus(requirement.id, 'at_risk');
      }
      if (commitment) {
        this.repos.links.create({
          projectId,
          fromType: 'deviation',
          fromId: dev.id,
          toType: 'commitment',
          toId: commitment.id,
          relation: 'about',
        });
      }
      return dev;
    });
    this.repos.events.create(projectId, 'deviations_detected', {
      engine: this.extractor.name,
      count: deviations.length,
    });
    return { engine: this.extractor.name, deviations };
  }

  /** 记录一笔变更/签证（in_scope 判定与索赔组卷在 layer D 编排里完成）。 */
  recordChange(
    projectId: string,
    input: {
      title: string;
      description?: string;
      inScope?: Change['inScope'];
      basisChunkId?: string;
      costImpact?: string;
      timeImpact?: string;
    },
  ): Change {
    this.getProject(projectId);
    const change = this.repos.changes.create({ projectId, ...input });
    if (input.basisChunkId) {
      this.repos.links.create({
        projectId,
        fromType: 'change',
        fromId: change.id,
        toType: 'chunk',
        toId: input.basisChunkId,
        relation: 'basis',
      });
    }
    this.repos.events.create(projectId, 'change_recorded', { changeId: change.id, title: input.title });
    return change;
  }

  /** 返回项目的完整事实图谱（结点 + 边 + 事件 + 统计）。 */
  getGraph(projectId: string): ProjectGraph {
    const project = this.getProject(projectId);
    const documents = this.repos.documents.listByProject(projectId);
    const requirements = this.repos.requirements.listByProject(projectId);
    const commitments = this.repos.commitments.listByProject(projectId);
    const deviations = this.repos.deviations.listByProject(projectId);
    const evidences = this.repos.evidences.listByProject(projectId);
    const changes = this.repos.changes.listByProject(projectId);
    const claims = this.repos.claims.listByProject(projectId);
    const links = this.repos.links.listByProject(projectId);
    const events = this.repos.events.listByProject(projectId);
    const chunkCount = this.repos.chunks.listByProject(projectId).length;
    return {
      project,
      documents,
      requirements,
      commitments,
      deviations,
      evidences,
      changes,
      claims,
      links,
      events,
      stats: {
        documents: documents.length,
        chunks: chunkCount,
        requirements: requirements.length,
        commitments: commitments.length,
        deviations: deviations.length,
        changes: changes.length,
        claims: claims.length,
      },
    };
  }

  /**
   * 带引用的语义检索：把 query 向量化，在项目片段上做余弦检索，
   * 返回带页码/条款定位与分数的命中，作为「可溯源证据」。
   */
  async search(
    projectId: string,
    query: string,
    topK = 5,
    documentId?: string,
  ): Promise<SearchResult> {
    this.getProject(projectId);
    const chunks = this.chunksFor(projectId, documentId).filter((c) => c.embedding?.length);
    if (chunks.length === 0) {
      return { engine: this.embedder.name, query, hits: [] };
    }
    const [queryVec] = await this.embedder.embed([query]);
    const hits: ChunkHit[] = chunks
      .map((c) => ({
        id: c.id,
        documentId: c.documentId,
        page: c.page,
        clause: c.clause,
        text: c.text,
        score: cosineSimilarity(queryVec, c.embedding ?? []),
      }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, topK));
    return { engine: this.embedder.name, query, hits };
  }

  /** 为片段计算并持久化向量；失败只记日志，不阻断录入（检索时自然跳过无向量片段）。 */
  private async embedChunks(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;
    try {
      const vectors = await this.embedder.embed(chunks.map((c) => c.text));
      chunks.forEach((c, i) => {
        const vec = vectors[i];
        if (vec?.length) this.repos.chunks.setEmbedding(c.id, vec);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn({ err: msg }, '片段向量化失败，检索将跳过这些片段');
    }
  }

  private chunksFor(projectId: string, documentId?: string): Chunk[] {
    if (documentId) {
      const doc = this.repos.documents.get(documentId);
      if (!doc || doc.projectId !== projectId) {
        throw new HttpError(404, `文档不存在或不属于该项目: ${documentId}`);
      }
      return this.repos.chunks.listByDocument(documentId);
    }
    return this.repos.chunks.listByProject(projectId);
  }
}
