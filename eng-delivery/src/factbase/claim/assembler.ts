import { z } from 'zod';
import type { AppConfig } from '../../config';
import { LlmClient } from '../../llm/client';
import type { Logger } from '../../logger';
import { CLAIM_TYPES, IN_SCOPE, type ClaimType, type InScope } from '../types';
import {
  buildClassifyInScopePrompt,
  buildDraftNarrativePrompt,
  buildQuantifyImpactPrompt,
  CLAIM_SYSTEM_PROMPT,
} from './prompts';

/** 变更摘要（喂给模型判断的最小信息）。 */
export interface ChangeBrief {
  title: string;
  description?: string;
}

/** 一条可引用的依据（来自 RAG 检索，带页码/条款定位）。 */
export interface BasisCitation {
  chunkId: string;
  page?: number;
  clause?: string;
  text: string;
  score: number;
}

export interface InScopeJudgment {
  inScope: InScope;
  reason: string;
}

export interface ImpactEstimate {
  claimType: ClaimType;
  days?: number;
  amount?: string;
  reason: string;
}

/**
 * 索赔组卷智能体抽象：智能来自大模型（激活其合同/计量/索赔专家判断），失败自动回退薄兜底。
 * 三步专业判断：范围认定 → 影响量化 → 起草正文。每步都基于检索到的依据片段，保证可溯源。
 */
export interface ClaimAssembler {
  readonly name: string;
  classifyInScope(change: ChangeBrief, basis: BasisCitation[]): Promise<InScopeJudgment>;
  quantifyImpact(change: ChangeBrief, basis: BasisCitation[]): Promise<ImpactEstimate>;
  draftNarrative(input: {
    change: ChangeBrief;
    judgment: InScopeJudgment;
    impact: ImpactEstimate;
    basis: BasisCitation[];
  }): Promise<string>;
}

const trimmed = z
  .string()
  .optional()
  .transform((v) => (v ?? '').trim());

const optionalString = z
  .string()
  .nullish()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

function enumOr<T extends readonly [string, ...string[]]>(values: T, def: T[number]) {
  return z
    .string()
    .optional()
    .transform((v) => (v && (values as readonly string[]).includes(v) ? (v as T[number]) : def));
}

const inScopeSchema = z.object({
  inScope: enumOr(IN_SCOPE, 'uncertain'),
  reason: trimmed,
});

const impactSchema = z.object({
  claimType: enumOr(CLAIM_TYPES, 'cost'),
  days: z.coerce.number().int().min(0).nullish().transform((v) => (v == null ? undefined : v)),
  amount: optionalString,
  reason: trimmed,
});

/** 大模型组卷器：激活专家判断做范围认定/影响量化/正文起草；任何失败回退薄兜底。 */
export class LlmClaimAssembler implements ClaimAssembler {
  readonly name = 'llm';

  constructor(
    private readonly client: LlmClient,
    private readonly fallback: ClaimAssembler,
    private readonly logger?: Logger,
  ) {}

  async classifyInScope(change: ChangeBrief, basis: BasisCitation[]): Promise<InScopeJudgment> {
    try {
      const data = await this.client.chatJson({
        system: CLAIM_SYSTEM_PROMPT,
        user: buildClassifyInScopePrompt(change, basis),
        schema: inScopeSchema,
        temperature: 0.2,
      });
      return {
        inScope: data.inScope,
        reason: data.reason || '（模型未给出理由，需人工确认）',
      };
    } catch (err) {
      this.degrade('classifyInScope', err);
      return this.fallback.classifyInScope(change, basis);
    }
  }

  async quantifyImpact(change: ChangeBrief, basis: BasisCitation[]): Promise<ImpactEstimate> {
    try {
      const data = await this.client.chatJson({
        system: CLAIM_SYSTEM_PROMPT,
        user: buildQuantifyImpactPrompt(change, basis),
        schema: impactSchema,
        temperature: 0.2,
      });
      return {
        claimType: data.claimType,
        days: data.days,
        amount: data.amount,
        reason: data.reason || '（模型未给出理由，需人工确认）',
      };
    } catch (err) {
      this.degrade('quantifyImpact', err);
      return this.fallback.quantifyImpact(change, basis);
    }
  }

  async draftNarrative(input: {
    change: ChangeBrief;
    judgment: InScopeJudgment;
    impact: ImpactEstimate;
    basis: BasisCitation[];
  }): Promise<string> {
    try {
      const text = await this.client.chatText({
        messages: [
          { role: 'system', content: CLAIM_SYSTEM_PROMPT },
          { role: 'user', content: buildDraftNarrativePrompt(input) },
        ],
        temperature: 0.4,
      });
      const trimmedText = text.trim();
      if (trimmedText) return trimmedText;
      return this.fallback.draftNarrative(input);
    } catch (err) {
      this.degrade('draftNarrative', err);
      return this.fallback.draftNarrative(input);
    }
  }

  private degrade(op: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger?.warn({ op, err: msg }, '索赔组卷大模型降级到规则兜底');
  }
}

/**
 * 薄兜底组卷器：不做语义推理，只把检索到的依据机械地组装成可人工接管的草稿。
 * 一律保守标注「需人工确认」，存在仅为「断网/无 key 也能跑通长流程」。
 */
export class RuleClaimAssembler implements ClaimAssembler {
  readonly name = 'rule-based';

  async classifyInScope(_change: ChangeBrief, _basis: BasisCitation[]): Promise<InScopeJudgment> {
    return {
      inScope: 'uncertain',
      reason: '薄兜底未做语义判断，是否超出合同范围需人工确认',
    };
  }

  async quantifyImpact(_change: ChangeBrief, _basis: BasisCitation[]): Promise<ImpactEstimate> {
    return {
      claimType: 'cost',
      reason: '薄兜底未做量化，工期/费用影响需人工据实计量',
    };
  }

  async draftNarrative(input: {
    change: ChangeBrief;
    judgment: InScopeJudgment;
    impact: ImpactEstimate;
    basis: BasisCitation[];
  }): Promise<string> {
    const { change, basis } = input;
    const cites = basis.length
      ? basis
          .map((b) => {
            const loc = [b.page != null ? `p.${b.page}` : null, b.clause ? `§${b.clause}` : null]
              .filter(Boolean)
              .join(' ');
            return `- ${loc ? `[${loc}] ` : ''}${b.text}`;
          })
          .join('\n')
      : '- （未检索到可引用依据，需人工补充合同/规范条款）';
    return [
      `【变更说明（薄兜底草稿，需人工确认）】${change.title}`,
      change.description ? change.description : '',
      '',
      '【范围认定】是否超出合同范围需人工确认。',
      '【影响评估】工期/费用影响需人工据实计量。',
      '',
      '【引用依据】',
      cites,
    ]
      .filter((l) => l !== '')
      .join('\n');
  }
}

/**
 * 组卷器工厂：配了 LLM_API_KEY 走大模型（失败自动回退）；否则用薄兜底。
 */
export function createClaimAssembler(config: AppConfig, logger?: Logger): ClaimAssembler {
  const fallback = new RuleClaimAssembler();
  if (!config.llm.enabled || !config.llm.apiKey) {
    logger?.info('未配置 LLM_API_KEY，索赔组卷使用规则兜底(rule-based)');
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
  return new LlmClaimAssembler(client, fallback, logger);
}
