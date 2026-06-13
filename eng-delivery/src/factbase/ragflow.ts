import type { RagflowConfig } from '../config';
import type { Logger } from '../logger';
import type { Chunk } from './types';

/** RAG 检索命中：尽量带回本地 chunk id（用于证据链溯源），否则回退按原文匹配。 */
export interface RetrievedHit {
  localChunkId?: string;
  documentId?: string;
  text: string;
  page?: number;
  clause?: string;
  score: number;
}

export interface IndexInput {
  projectId: string;
  documentId: string;
  documentTitle?: string;
  chunks: Chunk[];
}

export interface RetrieveInput {
  projectId: string;
  documentId?: string;
  query: string;
  topK: number;
}

/** 外部 RAG 引擎（如 RAGFlow）的最小契约：入库 + 检索。失败应由调用方回退到内置检索。 */
export interface RagRetriever {
  readonly name: string;
  /** 把本地 chunk 推入 RAG 索引（尽力而为；标识/页码/条款编码进 keywords 以便回链）。 */
  index(input: IndexInput): Promise<void>;
  /** 在项目（或指定文档）范围内检索，返回带本地 chunk id 的命中。 */
  retrieve(input: RetrieveInput): Promise<RetrievedHit[]>;
}

const KW_LOCAL_ID = 'lcid:';
const KW_PAGE = 'pg:';
const KW_CLAUSE = 'cl:';

/** 把 projectId/documentId 编码进 RAGFlow 文档名，便于检索时按项目/文档过滤。 */
function docName(projectId: string, documentId: string, title?: string): string {
  const safeTitle = (title ?? 'doc').replace(/[^\w\u4e00-\u9fa5.-]/g, '_').slice(0, 40);
  return `${projectId}__${documentId}__${safeTitle}.txt`;
}

function docNamePrefix(projectId: string, documentId?: string): string {
  return documentId ? `${projectId}__${documentId}__` : `${projectId}__`;
}

function chunkKeywords(chunk: Chunk): string[] {
  const kws = [`${KW_LOCAL_ID}${chunk.id}`];
  if (chunk.page != null) kws.push(`${KW_PAGE}${chunk.page}`);
  if (chunk.clause) kws.push(`${KW_CLAUSE}${chunk.clause}`);
  return kws;
}

function parseKeywords(keywords: string[] | undefined): {
  localChunkId?: string;
  page?: number;
  clause?: string;
} {
  const out: { localChunkId?: string; page?: number; clause?: string } = {};
  for (const kw of keywords ?? []) {
    if (kw.startsWith(KW_LOCAL_ID)) out.localChunkId = kw.slice(KW_LOCAL_ID.length);
    else if (kw.startsWith(KW_PAGE)) {
      const n = Number(kw.slice(KW_PAGE.length));
      if (Number.isFinite(n)) out.page = n;
    } else if (kw.startsWith(KW_CLAUSE)) out.clause = kw.slice(KW_CLAUSE.length);
  }
  return out;
}

interface RagflowDoc {
  id: string;
  name: string;
}

interface RagflowRetrievalChunk {
  content?: string;
  document_id?: string;
  important_keywords?: string[];
  similarity?: number;
  vector_similarity?: number;
}

/**
 * RAGFlow 检索客户端：基于 HTTP API（/api/v1）。
 * - 入库：每个本地 chunk 1:1 推成 RAGFlow chunk，把本地 id/页码/条款编码进 important_keywords。
 * - 检索：按项目（或文档）名前缀缩小 document 范围，命中后从 keywords 还原本地 chunk id，保证证据链可回链。
 */
export class RagflowRetriever implements RagRetriever {
  readonly name = 'ragflow' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly datasetId: string;
  private readonly timeoutMs: number;
  private readonly logger?: Logger;

  constructor(opts: {
    baseUrl: string;
    apiKey: string;
    datasetId: string;
    timeoutMs: number;
    logger?: Logger;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.datasetId = opts.datasetId;
    this.timeoutMs = opts.timeoutMs;
    this.logger = opts.logger;
  }

  private async api<T>(path: string, init: RequestInit): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await resp.json()) as { code?: number; message?: string; data?: T };
    if (!resp.ok || (body.code != null && body.code !== 0)) {
      throw new Error(`RAGFlow ${path} 失败: code=${body.code} ${body.message ?? resp.statusText}`);
    }
    return body.data as T;
  }

  private async listDocs(prefix: string): Promise<RagflowDoc[]> {
    // RAGFlow 单页上限 100，按名称前缀（项目/文档）筛选，逐页翻到取尽为止。
    const pageSize = 100;
    const matched: RagflowDoc[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const data = await this.api<{ docs?: RagflowDoc[] }>(
        `/api/v1/datasets/${this.datasetId}/documents?page=${page}&page_size=${pageSize}`,
        { method: 'GET' },
      );
      const docs = data.docs ?? [];
      matched.push(...docs.filter((d) => d.name.startsWith(prefix)));
      if (docs.length < pageSize) break;
    }
    return matched;
  }

  private async createDoc(name: string): Promise<string> {
    const form = new FormData();
    // 仅作占位：不触发解析，真正的可检索内容由 addChunks 1:1 写入。
    form.append('file', new Blob([' '], { type: 'text/plain' }), name);
    const data = await this.api<RagflowDoc[]>(`/api/v1/datasets/${this.datasetId}/documents`, {
      method: 'POST',
      body: form,
    });
    const doc = data?.[0];
    if (!doc?.id) throw new Error('RAGFlow 创建文档未返回 id');
    return doc.id;
  }

  async index(input: IndexInput): Promise<void> {
    const name = docName(input.projectId, input.documentId, input.documentTitle);
    // 幂等：同名文档若已存在先删除，避免重复入库。
    const existing = await this.listDocs(docNamePrefix(input.projectId, input.documentId));
    if (existing.length > 0) {
      await this.api(`/api/v1/datasets/${this.datasetId}/documents`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: existing.map((d) => d.id) }),
      });
    }
    const docId = await this.createDoc(name);
    for (const chunk of input.chunks) {
      if (!chunk.text.trim()) continue;
      await this.api(`/api/v1/datasets/${this.datasetId}/documents/${docId}/chunks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: chunk.text, important_keywords: chunkKeywords(chunk) }),
      });
    }
  }

  async retrieve(input: RetrieveInput): Promise<RetrievedHit[]> {
    const docs = await this.listDocs(docNamePrefix(input.projectId, input.documentId));
    if (docs.length === 0) return [];
    const data = await this.api<{ chunks?: RagflowRetrievalChunk[] }>(`/api/v1/retrieval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: input.query,
        dataset_ids: [this.datasetId],
        document_ids: docs.map((d) => d.id),
        top_k: Math.max(1, input.topK),
        page_size: Math.max(1, input.topK),
        similarity_threshold: 0.0,
      }),
    });
    return (data.chunks ?? []).map((c) => {
      const meta = parseKeywords(c.important_keywords);
      return {
        localChunkId: meta.localChunkId,
        documentId: c.document_id,
        text: c.content ?? '',
        page: meta.page,
        clause: meta.clause,
        score: c.similarity ?? c.vector_similarity ?? 0,
      };
    });
  }
}

/** 工厂：三者齐备才返回 RAGFlow 检索器；否则返回 undefined（调用方回退内置检索）。 */
export function createRagRetriever(
  config: { ragflow: RagflowConfig },
  logger?: Logger,
): RagRetriever | undefined {
  const r = config.ragflow;
  if (!r.enabled || !r.baseUrl || !r.apiKey || !r.datasetId) {
    logger?.info('未配置 RAGFlow（需 BASE_URL+API_KEY+DATASET_ID），语义检索走内置向量检索');
    return undefined;
  }
  logger?.info({ datasetId: r.datasetId }, 'RAGFlow 检索已启用');
  return new RagflowRetriever({
    baseUrl: r.baseUrl,
    apiKey: r.apiKey,
    datasetId: r.datasetId,
    timeoutMs: r.timeoutMs,
    logger,
  });
}
