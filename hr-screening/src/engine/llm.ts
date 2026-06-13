import { z } from 'zod';
import type { LlmClient } from '../llm/client';
import type { Logger } from '../logger';
import {
  buildOutreachPrompt,
  buildParseJobPrompt,
  buildProfilePrompt,
  buildScorePrompt,
  SYSTEM_PROMPT,
} from '../llm/prompts';
import {
  BG_CATEGORIES,
  EDUCATION_LEVELS,
  OUTREACH_CHANNELS,
  RISK_TYPES,
  SCORE_DIMENSIONS,
  VERIFY_STATUS,
  type CandidateProfile,
  type DimensionScore,
  type JobPosting,
  type OutreachChannel,
  type OutreachScript,
  type Recommendation,
  type ScreeningResult,
} from '../types';
import { evaluateHardFilter, normalizeEducationLevel } from './hardFilter';
import type {
  BackgroundProfileRequest,
  OutreachRequest,
  ParseJobRequest,
  ScoreRequest,
  ScreeningEngine,
} from './types';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const jobSchema = z.object({
  title: optionalString,
  company: optionalString,
  city: optionalString,
  minEducation: z
    .string()
    .optional()
    .transform((v) => normalizeEducationLevel(v))
    .pipe(z.enum(EDUCATION_LEVELS).optional()),
  minYears: z.coerce.number().min(0).max(50).optional(),
  requiredSkills: z.array(z.string()).default([]),
  preferredSkills: z.array(z.string()).default([]),
  responsibilities: z.array(z.string()).default([]),
  locations: z.array(z.string()).default([]),
  salaryRange: optionalString,
  headcount: z.coerce.number().int().positive().optional(),
});

const scoreSchema = z.object({
  matchScore: z.coerce.number().min(0).max(100),
  dimensions: z
    .array(
      z.object({
        dimension: z.enum(SCORE_DIMENSIONS),
        score: z.coerce.number().min(0).max(100),
        reason: z.string().default(''),
      }),
    )
    .default([]),
  highlights: z.array(z.string()).default([]),
  risks: z
    .array(
      z.object({
        type: z.enum(RISK_TYPES),
        severity: z.enum(['low', 'medium', 'high']),
        detail: z.string().default(''),
      }),
    )
    .default([]),
  recommendation: z.enum(['advance', 'hold', 'reject']),
  reason: z.string().default(''),
  suggestedQuestions: z.array(z.string()).default([]),
});

const outreachSchema = z.object({
  channel: z.enum(OUTREACH_CHANNELS).optional(),
  message: z.string().min(1),
  screeningQuestions: z.array(z.string()).default([]),
});

const profileSchema = z.object({
  summary: z.string().min(1),
  strengths: z.array(z.string()).default([]),
  concerns: z.array(z.string()).default([]),
  verifiedItems: z
    .array(
      z.object({
        category: z.enum(BG_CATEGORIES),
        status: z.enum(VERIFY_STATUS),
        detail: z.string().default(''),
      }),
    )
    .default([]),
  riskLevel: z.enum(['low', 'medium', 'high']),
  recommendation: z.string().default(''),
});

/**
 * 大模型引擎：调用 grsai(OpenAI 兼容) 做 JD 解析、初筛打分、触达话术与背调画像合成；
 * 任何失败（网络/限流/解析）都自动回退到规则引擎，保证接口永远返回可用结果。
 * 注意：硬性条件过滤始终由确定性规则计算，不交给大模型，保证可解释、可复现。
 */
export class LlmEngine implements ScreeningEngine {
  readonly name = 'llm';

  constructor(
    private readonly client: LlmClient,
    private readonly fallback: ScreeningEngine,
    private readonly logger?: Logger,
  ) {}

  async parseJob(req: ParseJobRequest): Promise<JobPosting> {
    try {
      const data = await this.client.chatJson({
        system: SYSTEM_PROMPT,
        user: buildParseJobPrompt(req),
        schema: jobSchema,
      });
      return {
        title: data.title || req.title || '未命名岗位',
        company: data.company ?? req.company,
        city: data.city ?? req.city,
        description: req.description,
        minEducation: data.minEducation,
        minYears: data.minYears,
        requiredSkills: data.requiredSkills.length ? data.requiredSkills : undefined,
        preferredSkills: data.preferredSkills.length ? data.preferredSkills : undefined,
        responsibilities: data.responsibilities.length ? data.responsibilities : undefined,
        locations: data.locations.length ? data.locations : req.city ? [req.city] : undefined,
        salaryRange: data.salaryRange,
        headcount: data.headcount,
      };
    } catch (err) {
      this.degrade('parseJob', err);
      return this.fallback.parseJob(req);
    }
  }

  async scoreCandidate(req: ScoreRequest): Promise<ScreeningResult> {
    const hardFilter = evaluateHardFilter(req.job, req.resume);
    try {
      const data = await this.client.chatJson({
        system: SYSTEM_PROMPT,
        user: buildScorePrompt(req.job, req.resume, hardFilter),
        schema: scoreSchema,
      });
      const dimensions: DimensionScore[] = data.dimensions.map((d) => ({
        dimension: d.dimension,
        score: Math.round(d.score),
        reason: d.reason,
      }));
      // 硬性条件不通过时，统一压低综合分并淘汰，保持与规则引擎一致、可解释。
      const passed = hardFilter.passed;
      const matchScore = passed
        ? Math.round(data.matchScore)
        : Math.min(Math.round(data.matchScore), 45);
      const recommendation: Recommendation = passed ? data.recommendation : 'reject';
      const reason = passed
        ? data.reason
        : `未通过硬性条件：${hardFilter.checks
            .filter((c) => !c.passed)
            .map((c) => c.label)
            .join('、')}。${data.reason}`;
      return {
        candidateName: req.resume.name,
        hardFilter,
        matchScore,
        dimensions,
        highlights: data.highlights,
        risks: data.risks,
        recommendation,
        reason,
        suggestedQuestions: data.suggestedQuestions,
      };
    } catch (err) {
      this.degrade('scoreCandidate', err);
      return this.fallback.scoreCandidate(req);
    }
  }

  async outreach(req: OutreachRequest): Promise<OutreachScript> {
    const channel: OutreachChannel = req.channel ?? '电话';
    try {
      const data = await this.client.chatJson({
        system: SYSTEM_PROMPT,
        user: buildOutreachPrompt(req.job, req.resume, channel),
        schema: outreachSchema,
      });
      return {
        channel: data.channel ?? channel,
        message: data.message,
        screeningQuestions: data.screeningQuestions,
      };
    } catch (err) {
      this.degrade('outreach', err);
      return this.fallback.outreach(req);
    }
  }

  async backgroundProfile(req: BackgroundProfileRequest): Promise<CandidateProfile> {
    const osintLeads = (req.osintAccounts ?? []).map((a) => `[${a.tool}] ${a.site}：${a.url}`);
    try {
      const data = await this.client.chatJson({
        system: SYSTEM_PROMPT,
        user: buildProfilePrompt(req.resume, req.findings, osintLeads),
        schema: profileSchema,
      });
      return {
        summary: data.summary,
        strengths: data.strengths,
        concerns: data.concerns,
        verifiedItems: data.verifiedItems,
        riskLevel: data.riskLevel,
        recommendation: data.recommendation,
      };
    } catch (err) {
      this.degrade('backgroundProfile', err);
      return this.fallback.backgroundProfile(req);
    }
  }

  private degrade(op: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger?.warn({ op, err: msg }, 'LLM 引擎降级到规则引擎');
  }
}
