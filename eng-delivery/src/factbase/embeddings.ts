import OpenAI from 'openai';
import type { AppConfig } from '../config';
import type { Logger } from '../logger';
import { l2normalize } from '../utils/vector';

/**
 * Embedding 客户端：把文本向量化，供带引用的语义检索使用。
 *
 * - 配了 LLM_API_KEY：走 OpenAI 兼容 /embeddings（grsai 等），失败自动回退哈希兜底。
 * - 没配 key / 调用失败：用确定性哈希向量兜底，保证离线可跑、测试可复现。
 *   兜底质量有限（近似词袋），仅保证管线连通；要做准必须配真实 embedding 模型。
 */
export interface EmbeddingClient {
  readonly name: 'openai' | 'hash';
  embed(texts: string[]): Promise<number[][]>;
}

/** 兜底向量维度。取一个不太小、便于区分文本的固定维度。 */
const HASH_DIM = 256;

/** FNV-1a 32 位哈希，确定性。 */
function fnv1a(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 把文本切成字符 bigram + 单字 token（中文友好，无需分词器）。 */
function tokenize(text: string): string[] {
  const cleaned = text.toLowerCase().replace(/\s+/g, '');
  if (cleaned.length === 0) return [];
  const tokens: string[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    tokens.push(cleaned[i]);
    if (i + 1 < cleaned.length) tokens.push(cleaned[i] + cleaned[i + 1]);
  }
  return tokens;
}

/**
 * 确定性哈希向量：把 token 哈希到固定维度的桶里累加，再 L2 归一化。
 * 同一文本永远得到同一向量；语义相近的文本（共享字/词）向量更接近。
 */
export class HashEmbeddingClient implements EmbeddingClient {
  readonly name = 'hash' as const;

  embed(texts: string[]): Promise<number[][]> {
    const vectors = texts.map((text) => {
      const vec = new Array<number>(HASH_DIM).fill(0);
      for (const token of tokenize(text)) {
        const bucket = fnv1a(token) % HASH_DIM;
        // 第二个哈希决定符号，减少桶冲突的相互抵消偏差。
        const sign = (fnv1a(`s:${token}`) & 1) === 0 ? 1 : -1;
        vec[bucket] += sign;
      }
      return l2normalize(vec);
    });
    return Promise.resolve(vectors);
  }
}

/** OpenAI 兼容 embeddings；任何失败都回退到注入的兜底客户端。 */
export class OpenAiEmbeddingClient implements EmbeddingClient {
  readonly name = 'openai' as const;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly fallback: EmbeddingClient;
  private readonly logger?: Logger;

  constructor(opts: {
    apiKey: string;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    fallback: EmbeddingClient;
    logger?: Logger;
  }) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl,
      timeout: opts.timeoutMs,
      maxRetries: 0,
    });
    this.model = opts.model;
    this.fallback = opts.fallback;
    this.logger = opts.logger;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    try {
      const resp = await this.client.embeddings.create({ model: this.model, input: texts });
      const sorted = [...resp.data].sort((a, b) => a.index - b.index);
      if (sorted.length !== texts.length) throw new Error('embedding 数量与输入不一致');
      return sorted.map((d) => d.embedding as number[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn({ model: this.model, err: msg }, 'embedding 调用失败，回退哈希兜底');
      return this.fallback.embed(texts);
    }
  }
}

/**
 * 工厂：配了 key 走 OpenAI 兼容 embeddings（失败回退）；否则确定性哈希兜底。
 */
export function createEmbeddingClient(config: AppConfig, logger?: Logger): EmbeddingClient {
  const fallback = new HashEmbeddingClient();
  if (!config.llm.enabled || !config.llm.apiKey) {
    logger?.info('未配置 LLM_API_KEY，语义检索使用确定性哈希向量兜底(hash)');
    return fallback;
  }
  return new OpenAiEmbeddingClient({
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
    model: config.llm.embeddingModel,
    timeoutMs: config.llm.timeoutMs,
    fallback,
    logger,
  });
}
