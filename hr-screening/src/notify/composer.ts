import { z } from 'zod';
import type { AppConfig } from '../config';
import { LlmClient } from '../llm/client';
import type { Logger } from '../logger';
import { STATUS_LABELS, type ApplicationStatus } from '../pipeline/status';
import type { JobPosting, ResumeProfile } from '../types';
import { buildFeedbackSystemPrompt, buildFeedbackUserPrompt } from './prompts';

export interface FeedbackInput {
  job: JobPosting;
  resume: ResumeProfile;
  status: ApplicationStatus;
  /** 内部理由（仅用于把握分寸，不直接写入对外正文） */
  reason?: string;
}

export interface FeedbackLetter {
  subject: string;
  body: string;
  /** 文案由大模型(llm)还是规则模板(rule-based)生成 */
  engine: string;
}

/**
 * 反馈文案 Agent 抽象。两种实现：
 * - RuleBasedFeedbackComposer：模板化文案，离线、确定性，无需 key；
 * - LlmFeedbackComposer：调 grsai 生成有温度的专业文案，失败自动回退模板。
 */
export interface FeedbackComposer {
  readonly name: string;
  compose(input: FeedbackInput): Promise<FeedbackLetter>;
}

const letterSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
});

function company(job: JobPosting): string {
  return job.company ?? '我司';
}

function greeting(resume: ResumeProfile): string {
  return resume.name ? `${resume.name}，您好：` : '您好：';
}

/**
 * 规则引擎：模板化反馈文案。无需联网/无需 key，作为离线主引擎与 LLM 失败兜底。
 * 文案均为中性、专业、反歧视，不含任何与岗位无关的理由。
 */
export class RuleBasedFeedbackComposer implements FeedbackComposer {
  readonly name = 'rule-based';

  async compose(input: FeedbackInput): Promise<FeedbackLetter> {
    const { job, resume, status } = input;
    const head = greeting(resume);
    const co = company(job);
    const title = job.title;
    let subject: string;
    let body: string;
    switch (status) {
      case 'screening':
        subject = `【${co}】您应聘「${title}」的简历已进入初筛`;
        body = `${head}\n感谢您投递${co}的「${title}」岗位。您的简历已通过初步筛选、进入初筛环节，我们会尽快与您进一步沟通，请您留意来电与消息。感谢您的耐心等待。\n\n${co}招聘团队`;
        break;
      case 'interview':
        subject = `【${co}】邀请您参加「${title}」岗位面试`;
        body = `${head}\n经初步评估，我们很高兴邀请您参加${co}「${title}」岗位的面试。请您回复方便的面试时间（可选线上或线下），稍后会有专人与您对接具体安排。期待与您进一步交流！\n\n${co}招聘团队`;
        break;
      case 'rejected':
        subject = `【${co}】关于您应聘「${title}」的反馈`;
        body = `${head}\n首先非常感谢您抽出时间投递${co}的「${title}」岗位，也感谢您对我们的信任。经过综合评估，很遗憾本次未能为您安排进一步的面试。这并非对您能力的否定——岗位匹配受多方面因素影响。我们会保留您的简历，未来如有更合适的机会会再与您联系，也欢迎您继续关注我们。祝您求职顺利、前程似锦！\n\n${co}招聘团队`;
        break;
      case 'talent_pool':
        subject = `【${co}】您的简历已纳入人才库`;
        body = `${head}\n感谢您投递${co}的「${title}」岗位。您的背景已纳入我们的人才库，未来如有更匹配的岗位，我们会优先与您联系。感谢您的关注！\n\n${co}招聘团队`;
        break;
      default:
        subject = `【${co}】您的应聘状态更新：${STATUS_LABELS[status]}`;
        body = `${head}\n您应聘${co}「${title}」岗位的进展已更新为「${STATUS_LABELS[status]}」。如有疑问欢迎与我们联系。\n\n${co}招聘团队`;
    }
    return { subject, body, engine: this.name };
  }
}

/**
 * 大模型引擎：生成专业且有温度的反馈文案；任何失败都自动回退规则模板，保证可用。
 */
export class LlmFeedbackComposer implements FeedbackComposer {
  readonly name = 'llm';

  constructor(
    private readonly client: LlmClient,
    private readonly fallback: FeedbackComposer,
    private readonly logger?: Logger,
  ) {}

  async compose(input: FeedbackInput): Promise<FeedbackLetter> {
    try {
      const data = await this.client.chatJson({
        system: buildFeedbackSystemPrompt(),
        user: buildFeedbackUserPrompt(input),
        schema: letterSchema,
        temperature: 0.6,
      });
      return { subject: data.subject, body: data.body, engine: this.name };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn({ err: msg }, '反馈文案 LLM 降级到规则模板');
      return this.fallback.compose(input);
    }
  }
}

/** 按配置选择反馈文案 Agent：有可用 key → LLM（失败回退模板）；否则 → 规则模板。 */
export function createFeedbackComposer(config: AppConfig, logger?: Logger): FeedbackComposer {
  const fallback = new RuleBasedFeedbackComposer();
  if (!config.llm.enabled || !config.llm.apiKey) {
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
  return new LlmFeedbackComposer(client, fallback, logger);
}
