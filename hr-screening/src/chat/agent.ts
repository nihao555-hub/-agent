import { z } from 'zod';
import type { AppConfig } from '../config';
import { LlmClient } from '../llm/client';
import type { Logger } from '../logger';
import { RISK_TYPES, type Recommendation } from '../types';
import {
  buildChatSystemPrompt,
  buildSummaryPrompt,
  OPENING_INSTRUCTION,
  toLlmHistory,
} from './prompts';
import type { ChatContext, ChatMessage, ChatScreeningSummary } from './types';

/**
 * 对话式初筛 Agent 抽象。两种实现：
 * - RuleBasedChatAgent：脚本化追问，离线、确定性，无需 key；
 * - LlmChatAgent：调 grsai 多轮对话，失败自动回退规则引擎。
 */
export interface ChatAgent {
  /** 引擎标识，便于在响应里标注本次由谁生成 */
  readonly name: string;
  /** 开场白（HR 主动开启对话） */
  opening(ctx: ChatContext): Promise<string>;
  /** 基于上下文与完整历史，给出下一句回复 */
  reply(ctx: ChatContext, history: ChatMessage[]): Promise<string>;
  /** 基于上下文与完整历史，产出结构化初筛小结 */
  summarize(ctx: ChatContext, history: ChatMessage[]): Promise<ChatScreeningSummary>;
}

const summarySchema = z.object({
  fitAssessment: z.string().default(''),
  confirmedInfo: z.array(z.string()).default([]),
  pendingInfo: z.array(z.string()).default([]),
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
  nextQuestions: z.array(z.string()).default([]),
});

function candidateName(ctx: ChatContext): string {
  return ctx.resume.name ?? '您好';
}

function countAssistant(history: ChatMessage[]): number {
  return history.filter((m) => m.role === 'assistant').length;
}

/**
 * 规则引擎：脚本化的初筛追问。无需联网/无需 key，作为离线主引擎与 LLM 失败兜底。
 * 通过历史中 assistant 消息条数推进脚本，保证无状态调用下顺序可复现。
 */
export class RuleBasedChatAgent implements ChatAgent {
  readonly name = 'rule-based';

  private script(ctx: ChatContext): string[] {
    const city = ctx.job.city ?? ctx.job.locations?.[0];
    return [
      '先和您确认一下：您目前的求职状态是怎样的？是在职看机会还是已经离职了？大概什么时候方便到岗呢？',
      '方便同步一下您的期望薪资范围吗？这样我好评估和岗位是否匹配。',
      `请挑选您最近、与「${ctx.job.title}」最相关的一段经历，简单说说您具体负责的工作和取得的成果。`,
      city
        ? `这个岗位的工作地点在${city}，可能也会有一定的出差或加班，您这边方便接受吗？`
        : '这个岗位可能会有一定的出差或加班安排，您这边方便接受吗？',
      '基本情况我了解得差不多了。最后您还有什么想了解的吗？比如团队、业务方向或后续面试流程。',
    ];
  }

  async opening(ctx: ChatContext): Promise<string> {
    const company = ctx.job.company ?? '我司';
    return `${candidateName(ctx)}，您好！我是${company}负责「${ctx.job.title}」岗位招聘的同事，看到您投递了这个职位，想用几分钟和您简单沟通、确认一下基本情况，现在方便吗？`;
  }

  async reply(ctx: ChatContext, history: ChatMessage[]): Promise<string> {
    const script = this.script(ctx);
    // opening 是第 1 条 assistant 消息；候选人每回应一次，推进到下一条脚本问题。
    const nextIndex = Math.max(0, countAssistant(history) - 1);
    if (nextIndex < script.length) return script[nextIndex];
    return '好的，您的信息我已经记录下来了，非常感谢您抽时间沟通！后续我们会通过正式渠道尽快向您反馈结果，祝您求职顺利～';
  }

  async summarize(ctx: ChatContext, history: ChatMessage[]): Promise<ChatScreeningSummary> {
    const candidateTurns = history.filter((m) => m.role === 'candidate');
    const confirmedInfo = candidateTurns.map(
      (m) => `候选人回应：${m.content.slice(0, 60)}${m.content.length > 60 ? '…' : ''}`,
    );
    const answered = Math.max(0, countAssistant(history) - 1);
    const pendingInfo = this.script(ctx).slice(answered);
    const recommendation: Recommendation = 'hold';
    return {
      fitAssessment: `已完成 ${candidateTurns.length} 轮候选人回应的脚本化初筛沟通，需结合简历由人工综合判断匹配度。`,
      confirmedInfo,
      pendingInfo,
      risks: [],
      recommendation,
      reason:
        '当前为规则引擎（未接入大模型）的脚本化初筛小结，仅整理对话要点，建议人工复核对话记录后再下结论。',
      nextQuestions: pendingInfo,
    };
  }
}

/**
 * 大模型引擎：以「顶级 HR 专家」系统提示词驱动多轮对话与结构化小结；
 * 任何失败（网络/限流/解析）都自动回退到规则引擎，保证接口始终可用。
 */
export class LlmChatAgent implements ChatAgent {
  readonly name = 'llm';

  constructor(
    private readonly client: LlmClient,
    private readonly fallback: ChatAgent,
    private readonly logger?: Logger,
  ) {}

  async opening(ctx: ChatContext): Promise<string> {
    try {
      return await this.client.chatText({
        messages: [
          { role: 'system', content: buildChatSystemPrompt(ctx.job, ctx.resume) },
          { role: 'user', content: OPENING_INSTRUCTION },
        ],
      });
    } catch (err) {
      this.degrade('opening', err);
      return this.fallback.opening(ctx);
    }
  }

  async reply(ctx: ChatContext, history: ChatMessage[]): Promise<string> {
    try {
      return await this.client.chatText({
        messages: [
          { role: 'system', content: buildChatSystemPrompt(ctx.job, ctx.resume) },
          ...toLlmHistory(history),
        ],
      });
    } catch (err) {
      this.degrade('reply', err);
      return this.fallback.reply(ctx, history);
    }
  }

  async summarize(ctx: ChatContext, history: ChatMessage[]): Promise<ChatScreeningSummary> {
    try {
      const data = await this.client.chatJson({
        system: buildChatSystemPrompt(ctx.job, ctx.resume),
        user: buildSummaryPrompt(ctx.job, ctx.resume, history),
        schema: summarySchema,
        temperature: 0.2,
      });
      return data;
    } catch (err) {
      this.degrade('summarize', err);
      return this.fallback.summarize(ctx, history);
    }
  }

  private degrade(op: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger?.warn({ op, err: msg }, '对话 Agent LLM 降级到规则引擎');
  }
}

/**
 * 按配置选择对话 Agent：配置了可用 key → LlmChatAgent（失败回退规则引擎）；否则 → RuleBasedChatAgent。
 */
export function createChatAgent(config: AppConfig, logger?: Logger): ChatAgent {
  const fallback = new RuleBasedChatAgent();
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
  return new LlmChatAgent(client, fallback, logger);
}
