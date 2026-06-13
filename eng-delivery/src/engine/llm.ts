import { z } from 'zod';
import type { LlmClient } from '../llm/client';
import {
  buildCompliancePrompt,
  buildGapPrompt,
  buildParseTenderPrompt,
  SYSTEM_PROMPT,
} from '../llm/prompts';
import type { Logger } from '../logger';
import {
  COMPLIANCE_STATUS,
  COVERAGE_STATUS,
  SEVERITY,
  type ComplianceReport,
  type GapReport,
  type TenderSpec,
} from '../types';
import { assignRequirementIds } from './normalize';
import type {
  ComplianceRequest,
  GapRequest,
  ParseTenderRequest,
  TenderEngine,
} from './types';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const trimmed = z
  .string()
  .optional()
  .transform((v) => (v ?? '').trim());

/** 把模型给的字符串稳健地收敛到枚举；非法/缺失时回退到默认值（不抛错、不触发降级）。 */
function enumOr<T extends readonly [string, ...string[]]>(values: T, def: T[number]) {
  return z
    .string()
    .optional()
    .transform((v) => (v && (values as readonly string[]).includes(v) ? (v as T[number]) : def));
}

const tenderSchema = z.object({
  projectName: optionalString,
  tenderer: optionalString,
  agent: optionalString,
  method: optionalString,
  budget: optionalString,
  bidSecurity: optionalString,
  requirements: z
    .array(
      z.object({
        id: optionalString,
        category: trimmed,
        text: trimmed,
        mandatory: z.coerce.boolean().optional().transform((v) => Boolean(v)),
        source: optionalString,
      }),
    )
    .default([]),
  scoringItems: z
    .array(
      z.object({
        name: trimmed,
        maxScore: z.coerce.number().min(0).max(1000).optional(),
        criteria: optionalString,
        category: optionalString,
        source: optionalString,
      }),
    )
    .default([]),
  disqualifications: z
    .array(
      z.object({
        text: trimmed,
        trigger: optionalString,
        source: optionalString,
      }),
    )
    .default([]),
  milestones: z
    .array(
      z.object({
        name: trimmed,
        date: optionalString,
        note: optionalString,
        source: optionalString,
      }),
    )
    .default([]),
  summary: optionalString,
});

const gapSchema = z.object({
  findings: z
    .array(
      z.object({
        requirementId: trimmed,
        requirement: trimmed,
        category: trimmed,
        mandatory: z.coerce.boolean().optional().transform((v) => Boolean(v)),
        coverage: enumOr(COVERAGE_STATUS, '需人工确认'),
        matched: optionalString,
        gap: optionalString,
        severity: enumOr(SEVERITY, 'low'),
        suggestion: optionalString,
        source: optionalString,
      }),
    )
    .default([]),
  summary: trimmed,
  readiness: z.coerce.number().min(0).max(100).optional(),
  blockers: z.array(z.string()).default([]),
});

const complianceSchema = z.object({
  findings: z
    .array(
      z.object({
        clause: trimmed,
        status: enumOr(COMPLIANCE_STATUS, '需人工确认'),
        risk: enumOr(SEVERITY, 'low'),
        evidence: optionalString,
        action: optionalString,
        source: optionalString,
      }),
    )
    .default([]),
  summary: trimmed,
  disqualificationRisks: z.array(z.string()).default([]),
  passLikelihood: z.coerce.number().min(0).max(100).optional(),
});

/**
 * 大模型引擎：调用 grsai(OpenAI 兼容)，激活模型的招投标专家知识做招标要点抽取、范围缺口检测与合规自检。
 * 任何失败（网络/限流/解析）都自动回退到规则引擎，保证接口永远返回可用结果。
 */
export class LlmEngine implements TenderEngine {
  readonly name = 'llm';

  constructor(
    private readonly client: LlmClient,
    private readonly fallback: TenderEngine,
    private readonly logger?: Logger,
  ) {}

  async parseTender(req: ParseTenderRequest): Promise<TenderSpec> {
    try {
      const data = await this.client.chatJson({
        system: SYSTEM_PROMPT,
        user: buildParseTenderPrompt(req),
        schema: tenderSchema,
        temperature: 0.2,
      });
      const requirements = assignRequirementIds(
        data.requirements
          .filter((r) => r.text)
          .map((r) => ({
            id: r.id,
            category: r.category,
            text: r.text,
            mandatory: r.mandatory,
            source: r.source,
          })),
      );
      return {
        projectName: data.projectName ?? req.projectName,
        tenderer: data.tenderer,
        agent: data.agent,
        method: data.method,
        budget: data.budget,
        bidSecurity: data.bidSecurity,
        requirements,
        scoringItems: data.scoringItems.filter((s) => s.name),
        disqualifications: data.disqualifications.filter((d) => d.text),
        milestones: data.milestones.filter((m) => m.name),
        summary: data.summary,
      };
    } catch (err) {
      this.degrade('parseTender', err);
      return this.fallback.parseTender(req);
    }
  }

  async detectGaps(req: GapRequest): Promise<GapReport> {
    try {
      const data = await this.client.chatJson({
        system: SYSTEM_PROMPT,
        user: buildGapPrompt(req.tender, req.capability),
        schema: gapSchema,
        temperature: 0.3,
      });
      return {
        findings: data.findings.map((f) => ({
          requirementId: f.requirementId,
          requirement: f.requirement,
          category: f.category,
          mandatory: f.mandatory,
          coverage: f.coverage,
          matched: f.matched,
          gap: f.gap,
          severity: f.severity,
          suggestion: f.suggestion,
          source: f.source,
        })),
        summary: data.summary,
        readiness: data.readiness,
        blockers: data.blockers,
      };
    } catch (err) {
      this.degrade('detectGaps', err);
      return this.fallback.detectGaps(req);
    }
  }

  async checkCompliance(req: ComplianceRequest): Promise<ComplianceReport> {
    try {
      const data = await this.client.chatJson({
        system: SYSTEM_PROMPT,
        user: buildCompliancePrompt(req.tender, req.capability),
        schema: complianceSchema,
        temperature: 0.2,
      });
      return {
        findings: data.findings.map((f) => ({
          clause: f.clause,
          status: f.status,
          risk: f.risk,
          evidence: f.evidence,
          action: f.action,
          source: f.source,
        })),
        summary: data.summary,
        disqualificationRisks: data.disqualificationRisks,
        passLikelihood: data.passLikelihood,
      };
    } catch (err) {
      this.degrade('checkCompliance', err);
      return this.fallback.checkCompliance(req);
    }
  }

  private degrade(op: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger?.warn({ op, err: msg }, 'LLM 引擎降级到规则引擎');
  }
}
