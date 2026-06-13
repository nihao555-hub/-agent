import { z } from 'zod';
import type { AppConfig } from '../config';
import { LlmClient } from '../llm/client';
import type { Logger } from '../logger';
import { similarity } from '../utils/textMatch';
import {
  buildDetectDeviationsPrompt,
  buildExtractCommitmentsPrompt,
  buildExtractRequirementsPrompt,
  FACTBASE_SYSTEM_PROMPT,
} from './prompts';
import {
  DEVIATION_TYPES,
  REQUIREMENT_KINDS,
  SEVERITY,
  type Chunk,
  type DeviationType,
  type RequirementKind,
  type Severity,
} from './types';

export interface ExtractedRequirement {
  chunkIndex: number;
  kind: RequirementKind;
  category?: string;
  text: string;
  mandatory: boolean;
  severity?: Severity;
}

export interface ExtractedCommitment {
  chunkIndex: number;
  kind?: string;
  text: string;
}

export interface ExtractedDeviation {
  requirementIndex: number;
  commitmentIndex?: number;
  type: DeviationType;
  severity?: Severity;
  description: string;
}

export interface RequirementBrief {
  text: string;
  kind: string;
  mandatory: boolean;
}

export interface CommitmentBrief {
  text: string;
}

/**
 * 事实抽取器抽象。智能来自大模型（激活其招投标/合同交付专家判断），失败自动回退薄兜底。
 * 关键：每条结论都带 chunkIndex / requirementIndex，保证可溯源到原文。
 */
export interface FactExtractor {
  readonly name: string;
  extractRequirements(chunks: Chunk[]): Promise<ExtractedRequirement[]>;
  extractCommitments(chunks: Chunk[]): Promise<ExtractedCommitment[]>;
  detectDeviations(
    requirements: RequirementBrief[],
    commitments: CommitmentBrief[],
  ): Promise<ExtractedDeviation[]>;
}

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const trimmed = z
  .string()
  .optional()
  .transform((v) => (v ?? '').trim());

function enumOr<T extends readonly [string, ...string[]]>(values: T, def: T[number]) {
  return z
    .string()
    .optional()
    .transform((v) => (v && (values as readonly string[]).includes(v) ? (v as T[number]) : def));
}

const requirementsSchema = z.object({
  items: z
    .array(
      z.object({
        chunkIndex: z.coerce.number().int().min(0),
        kind: enumOr(REQUIREMENT_KINDS, 'technical'),
        category: optionalString,
        text: trimmed,
        mandatory: z.coerce.boolean().optional().transform((v) => Boolean(v)),
        severity: enumOr(SEVERITY, 'low'),
      }),
    )
    .default([]),
});

const commitmentsSchema = z.object({
  items: z
    .array(
      z.object({
        chunkIndex: z.coerce.number().int().min(0),
        kind: optionalString,
        text: trimmed,
      }),
    )
    .default([]),
});

const deviationsSchema = z.object({
  items: z
    .array(
      z.object({
        requirementIndex: z.coerce.number().int().min(0),
        commitmentIndex: z.coerce.number().int().min(0).optional(),
        type: enumOr(DEVIATION_TYPES, 'missing'),
        severity: enumOr(SEVERITY, 'medium'),
        description: trimmed,
      }),
    )
    .default([]),
});

/** 大模型抽取器：激活专家判断做语义抽取与比对；任何失败回退薄兜底。 */
export class LlmFactExtractor implements FactExtractor {
  readonly name = 'llm';

  constructor(
    private readonly client: LlmClient,
    private readonly fallback: FactExtractor,
    private readonly logger?: Logger,
  ) {}

  async extractRequirements(chunks: Chunk[]): Promise<ExtractedRequirement[]> {
    if (chunks.length === 0) return [];
    try {
      const data = await this.client.chatJson({
        system: FACTBASE_SYSTEM_PROMPT,
        user: buildExtractRequirementsPrompt(chunks),
        schema: requirementsSchema,
        temperature: 0.2,
      });
      return data.items
        .filter((i) => i.text && i.chunkIndex < chunks.length)
        .map((i) => ({
          chunkIndex: i.chunkIndex,
          kind: i.kind,
          category: i.category,
          text: i.text,
          mandatory: i.mandatory,
          severity: i.severity,
        }));
    } catch (err) {
      this.degrade('extractRequirements', err);
      return this.fallback.extractRequirements(chunks);
    }
  }

  async extractCommitments(chunks: Chunk[]): Promise<ExtractedCommitment[]> {
    if (chunks.length === 0) return [];
    try {
      const data = await this.client.chatJson({
        system: FACTBASE_SYSTEM_PROMPT,
        user: buildExtractCommitmentsPrompt(chunks),
        schema: commitmentsSchema,
        temperature: 0.2,
      });
      return data.items
        .filter((i) => i.text && i.chunkIndex < chunks.length)
        .map((i) => ({ chunkIndex: i.chunkIndex, kind: i.kind, text: i.text }));
    } catch (err) {
      this.degrade('extractCommitments', err);
      return this.fallback.extractCommitments(chunks);
    }
  }

  async detectDeviations(
    requirements: RequirementBrief[],
    commitments: CommitmentBrief[],
  ): Promise<ExtractedDeviation[]> {
    if (requirements.length === 0) return [];
    try {
      const data = await this.client.chatJson({
        system: FACTBASE_SYSTEM_PROMPT,
        user: buildDetectDeviationsPrompt(
          requirements.map((r, index) => ({ index, text: r.text, kind: r.kind, mandatory: r.mandatory })),
          commitments.map((c, index) => ({ index, text: c.text })),
        ),
        schema: deviationsSchema,
        temperature: 0.3,
      });
      return data.items
        .filter((i) => i.description && i.requirementIndex < requirements.length)
        .map((i) => ({
          requirementIndex: i.requirementIndex,
          commitmentIndex:
            i.commitmentIndex != null && i.commitmentIndex < commitments.length
              ? i.commitmentIndex
              : undefined,
          type: i.type,
          severity: i.severity,
          description: i.description,
        }));
    } catch (err) {
      this.degrade('detectDeviations', err);
      return this.fallback.detectDeviations(requirements, commitments);
    }
  }

  private degrade(op: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger?.warn({ op, err: msg }, '事实抽取大模型降级到规则兜底');
  }
}

/**
 * 薄兜底抽取器：不做语义推理，只做机械切分与通用文本相似度比对。
 * 抽取结果一律标注需人工确认；存在仅为「断网/无 key 也能跑通管线」。
 */
export class RuleFactExtractor implements FactExtractor {
  readonly name = 'rule-based';

  async extractRequirements(chunks: Chunk[]): Promise<ExtractedRequirement[]> {
    return chunks
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.text.trim().length > 0)
      .map(({ i }) => ({
        chunkIndex: i,
        kind: 'technical' as RequirementKind,
        category: '需人工确认',
        text: chunks[i].text.trim(),
        mandatory: false,
        severity: 'low' as Severity,
      }));
  }

  async extractCommitments(chunks: Chunk[]): Promise<ExtractedCommitment[]> {
    return chunks
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.text.trim().length > 0)
      .map(({ i }) => ({ chunkIndex: i, text: chunks[i].text.trim() }));
  }

  async detectDeviations(
    requirements: RequirementBrief[],
    commitments: CommitmentBrief[],
  ): Promise<ExtractedDeviation[]> {
    const deviations: ExtractedDeviation[] = [];
    requirements.forEach((req, requirementIndex) => {
      let bestScore = 0;
      let bestIndex = -1;
      commitments.forEach((c, ci) => {
        const s = similarity(req.text, c.text);
        if (s > bestScore) {
          bestScore = s;
          bestIndex = ci;
        }
      });
      // 纯机械相似度兜底：完全无相近承诺→缺失；相近但不充分→部分；其余不报。
      if (bestScore < 0.15) {
        deviations.push({
          requirementIndex,
          type: 'missing',
          severity: req.mandatory ? 'high' : 'medium',
          description: '薄兜底未找到相近的我方承诺，疑似未响应，需人工确认',
        });
      } else if (bestScore < 0.5) {
        deviations.push({
          requirementIndex,
          commitmentIndex: bestIndex >= 0 ? bestIndex : undefined,
          type: 'partial',
          severity: req.mandatory ? 'medium' : 'low',
          description: '薄兜底判断响应可能不充分（文本相似度偏低），需人工确认',
        });
      }
    });
    return deviations;
  }
}

/**
 * 抽取器工厂：配了 LLM_API_KEY 走大模型（失败自动回退）；否则用薄兜底。
 */
export function createFactExtractor(config: AppConfig, logger?: Logger): FactExtractor {
  const fallback = new RuleFactExtractor();
  if (!config.llm.enabled || !config.llm.apiKey) {
    logger?.info('未配置 LLM_API_KEY，事实抽取使用规则兜底(rule-based)');
    return fallback;
  }
  const client = new LlmClient({
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    timeoutMs: config.llm.timeoutMs,
    maxRetries: config.llm.maxRetries,
    logger,
  });
  return new LlmFactExtractor(client, fallback, logger);
}
