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
import type { FlowRunRepository, FlowStepRepository } from '../db/flow';
import { summarizeBimModel } from '../bim/client';
import type { BimAnalyzer } from '../bim/client';
import { chunkBlocks } from '../doc/chunker';
import type { DocAnalyzer } from '../doc/structured';
import { FlowOrchestrator } from '../flow/orchestrator';
import type { FlowStepDefinition } from '../flow/orchestrator';
import type { FlowRun, FlowStep } from '../flow/types';
import type { Logger } from '../logger';
import { cosineSimilarity } from '../utils/vector';
import type { ClaimAssembler } from './claim/assembler';
import { buildClaimFlow, CLAIM_FLOW_KIND } from './claim/flow';
import type { EmbeddingClient } from './embeddings';
import type { FactExtractor } from './extractor';
import type { RagRetriever } from './ragflow';
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
  flowRuns: FlowRunRepository;
  flowSteps: FlowStepRepository;
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

export interface IngestBimInput {
  title?: string;
  source?: string;
  fileBase64: string;
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

/** 一次长流程（变更→索赔组卷）的运行视图：run + 各步审计 + 产出的索赔（若已组卷）。 */
export interface ClaimFlowResult {
  run: FlowRun;
  steps: FlowStep[];
  claim?: Claim;
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
  private readonly orchestrator: FlowOrchestrator;

  constructor(
    private readonly repos: FactBaseRepos,
    private readonly extractor: FactExtractor,
    private readonly docAnalyzer: DocAnalyzer,
    private readonly embedder: EmbeddingClient,
    private readonly bim: BimAnalyzer,
    private readonly assembler: ClaimAssembler,
    private readonly logger?: Logger,
    private readonly retriever?: RagRetriever,
  ) {
    this.orchestrator = new FlowOrchestrator(repos.flowRuns, repos.flowSteps, logger);
  }

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

  /** 录入并解析一份文档：文档理解（页码/条款定位）→ 切片 → 向量化 → 落库为可引用 chunk。 */
  async ingestDocument(projectId: string, input: IngestDocumentInput): Promise<IngestResult> {
    this.getProject(projectId);
    const analyzed = await this.docAnalyzer.analyze({
      text: input.text,
      fileBase64: input.fileBase64,
      fileName: input.fileName,
    });
    const document = this.repos.documents.create({
      projectId,
      type: input.type,
      title: input.title,
      source: input.source ?? analyzed.source,
    });
    const chunks = this.persistChunks(document.id, projectId, analyzed.chunks);
    await this.embedChunks(chunks);
    await this.indexInRetriever(projectId, document.id, input.title, chunks);
    this.repos.documents.markParsed(document.id, pageCountOf(analyzed.chunks));
    const saved = this.repos.documents.get(document.id) ?? document;
    this.repos.events.create(projectId, 'document_ingested', {
      documentId: document.id,
      type: input.type,
      chunks: chunks.length,
      source: analyzed.source,
    });
    return { document: saved, chunkCount: chunks.length, chunks };
  }

  /** 录入一份 BIM(IFC) 模型：解析成空间/构件/工程量事实 → 切片 → 向量化，纳入可检索事实底座。 */
  async ingestBim(projectId: string, input: IngestBimInput): Promise<IngestResult> {
    this.getProject(projectId);
    const model = await this.bim.analyze(input.fileBase64, input.fileName);
    const blocks = summarizeBimModel(model);
    const document = this.repos.documents.create({
      projectId,
      type: 'bim',
      title: input.title,
      source: input.source ?? input.fileName ?? 'bim',
    });
    const raw = chunkBlocks(blocks);
    const chunks = this.persistChunks(document.id, projectId, raw);
    await this.embedChunks(chunks);
    await this.indexInRetriever(projectId, document.id, input.title, chunks);
    this.repos.documents.markParsed(document.id, chunks.length);
    const saved = this.repos.documents.get(document.id) ?? document;
    this.repos.events.create(projectId, 'bim_ingested', {
      documentId: document.id,
      spaces: model.spaces?.length ?? 0,
      elements: model.elements?.length ?? 0,
      quantities: model.quantities?.length ?? 0,
    });
    return { document: saved, chunkCount: chunks.length, chunks };
  }

  private persistChunks(
    documentId: string,
    projectId: string,
    raw: { ordinal: number; text: string; page?: number; clause?: string }[],
  ): Chunk[] {
    return this.repos.chunks.createMany(
      raw.map((c) => ({
        documentId,
        projectId,
        ordinal: c.ordinal,
        text: c.text,
        page: c.page,
        clause: c.clause,
      })),
    );
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
  async extractCommitments(
    projectId: string,
    documentId?: string,
  ): Promise<CommitmentExtractResult> {
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
      const commitment = e.commitmentIndex != null ? commitments[e.commitmentIndex] : undefined;
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
    this.repos.events.create(projectId, 'change_recorded', {
      changeId: change.id,
      title: input.title,
    });
    return change;
  }

  /**
   * 启动「变更→索赔自动组卷」长流程：建 run + 各步落库，随后执行到完成或在失败处停下（可续跑）。
   * 全流程：范围认定→归集合同依据(RAG)→影响量化→起草正文→组卷连边。每步状态持久化，崩溃可恢复。
   */
  async assembleClaim(changeId: string): Promise<ClaimFlowResult> {
    const change = this.repos.changes.get(changeId);
    if (!change) throw new HttpError(404, `变更不存在: ${changeId}`);
    const steps = this.claimFlowDefs();
    const run = this.orchestrator.start({
      projectId: change.projectId,
      kind: CLAIM_FLOW_KIND,
      subjectType: 'change',
      subjectId: change.id,
      engine: this.assembler.name,
      steps,
    });
    const finished = await this.orchestrator.resume(run.id, steps);
    return this.flowResult(finished);
  }

  /** 断点续跑一次已存在的流程（从落库 cursor 继续，已完成步骤不重跑，幂等不产生重复索赔）。 */
  async resumeFlow(runId: string): Promise<ClaimFlowResult> {
    const run = this.repos.flowRuns.get(runId);
    if (!run) throw new HttpError(404, `流程不存在: ${runId}`);
    if (run.kind !== CLAIM_FLOW_KIND) {
      throw new HttpError(400, `暂不支持续跑该类型流程: ${run.kind}`);
    }
    const finished = await this.orchestrator.resume(runId, this.claimFlowDefs());
    return this.flowResult(finished);
  }

  /** 查询一次流程的运行态与各步审计（含已组卷的索赔）。 */
  getFlow(runId: string): ClaimFlowResult {
    const run = this.repos.flowRuns.get(runId);
    if (!run) throw new HttpError(404, `流程不存在: ${runId}`);
    return this.flowResult(run);
  }

  /** 用当前注入的组卷器与检索能力构造「变更→索赔」流程定义。 */
  private claimFlowDefs(): FlowStepDefinition[] {
    return buildClaimFlow({
      changes: this.repos.changes,
      claims: this.repos.claims,
      evidences: this.repos.evidences,
      links: this.repos.links,
      events: this.repos.events,
      assembler: this.assembler,
      retrieve: (projectId, query, topK) => this.search(projectId, query, topK).then((r) => r.hits),
    });
  }

  private flowResult(run: FlowRun): ClaimFlowResult {
    const steps = this.repos.flowSteps.listByRun(run.id);
    const claimId = (run.state as { claimId?: string }).claimId;
    const claim = claimId ? this.repos.claims.get(claimId) : undefined;
    return { run, steps, claim };
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
    // 优先用 RAGFlow（多模态/更强排序），命中回链到本地 chunk 以保证证据链；失败回退内置向量检索。
    if (this.retriever) {
      try {
        const ragHits = await this.searchWithRetriever(projectId, query, topK, documentId);
        if (ragHits.length > 0) {
          return { engine: this.retriever.name, query, hits: ragHits };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger?.warn({ err: msg }, 'RAGFlow 检索失败，回退内置向量检索');
      }
    }
    return this.searchInProcess(projectId, query, topK, documentId);
  }

  /** 内置向量检索：把 query 向量化，在项目片段上做余弦检索。 */
  private async searchInProcess(
    projectId: string,
    query: string,
    topK: number,
    documentId?: string,
  ): Promise<SearchResult> {
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

  /**
   * 用外部 RAG 检索器（RAGFlow）检索，并把命中回链到本地 chunk：
   * 优先用命中里编码的本地 chunk id，缺失时按原文文本回退匹配，保证 ChunkHit.id 始终是本地 id。
   */
  private async searchWithRetriever(
    projectId: string,
    query: string,
    topK: number,
    documentId?: string,
  ): Promise<ChunkHit[]> {
    const retriever = this.retriever;
    if (!retriever) return [];
    const hits = await retriever.retrieve({ projectId, documentId, query, topK });
    if (hits.length === 0) return [];
    const localChunks = this.chunksFor(projectId, documentId);
    const byId = new Map(localChunks.map((c) => [c.id, c]));
    const byText = new Map(localChunks.map((c) => [c.text.trim(), c]));
    const mapped: ChunkHit[] = [];
    for (const h of hits) {
      const local =
        (h.localChunkId ? byId.get(h.localChunkId) : undefined) ?? byText.get(h.text.trim());
      if (!local) continue;
      mapped.push({
        id: local.id,
        documentId: local.documentId,
        page: local.page,
        clause: local.clause,
        text: local.text,
        score: h.score,
      });
    }
    return mapped.slice(0, Math.max(1, topK));
  }

  /** 把本地 chunk 推入外部 RAG 索引（尽力而为；失败只记日志，不阻断录入）。 */
  private async indexInRetriever(
    projectId: string,
    documentId: string,
    documentTitle: string | undefined,
    chunks: Chunk[],
  ): Promise<void> {
    if (!this.retriever || chunks.length === 0) return;
    try {
      await this.retriever.index({ projectId, documentId, documentTitle, chunks });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn({ err: msg }, 'RAGFlow 入库失败，检索将回退内置向量检索');
    }
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

/** 文档页数：取片段里最大的页码；无页码（纯文本）时退化为片段数。 */
function pageCountOf(chunks: { page?: number }[]): number {
  const maxPage = chunks.reduce((max, c) => (c.page && c.page > max ? c.page : max), 0);
  return maxPage > 0 ? maxPage : chunks.length;
}
