import { z } from 'zod';
import type { LlmClient } from '../llm/client';
import type { Logger } from '../logger';
import { contentUser, promotionUser, recallUser, reviewReplyUser, SYSTEM_PROMPT } from '../llm/prompts';
import type {
  PromotionPackage,
  RecallChannel,
  RecallScript,
  RecallSegmentKey,
  Review,
  ReviewReply,
  Sentiment,
  SocialContent,
  SocialPlatform,
} from '../types';
import { perCapitaOf, SEGMENT_LABELS } from './ruleBased';
import type {
  ContentEngine,
  ContentRequest,
  ContentResult,
  PromotionRequest,
  PromotionResult,
  RecallRequest,
  RecallResult,
  ReviewReplyRequest,
  ReviewReplyResult,
} from './types';

function sentimentOf(rating: number): Sentiment {
  if (rating >= 4) return 'positive';
  if (rating === 3) return 'neutral';
  return 'negative';
}

const replySchema = z.object({
  replies: z.array(
    z.object({
      reviewId: z.string().optional(),
      reply: z.string().min(1),
      actions: z.array(z.string()).default([]),
    }),
  ),
});

const recallSchema = z.object({
  scripts: z.array(
    z.object({
      message: z.string().min(1),
      bestSendTime: z.string().optional().default(''),
      offer: z.string().optional(),
    }),
  ),
});

const promoSchema = z.object({
  packages: z.array(
    z.object({
      name: z.string().min(1),
      items: z.array(z.string()).min(1),
      originalPrice: z.number().positive(),
      dealPrice: z.number().positive(),
      targetScenario: z.string().optional().default(''),
      rationale: z.string().optional().default(''),
    }),
  ),
});

const contentSchema = z.object({
  posts: z.array(
    z.object({
      title: z.string().min(1),
      body: z.string().min(1),
      hashtags: z.array(z.string()).default([]),
      tips: z.string().optional(),
    }),
  ),
});

/**
 * 大模型引擎：调用 grsai(OpenAI 兼容) 生成内容；任何失败（网络/限流/解析）都自动回退到规则引擎，
 * 保证接口永远返回可用结果。
 */
export class LlmEngine implements ContentEngine {
  readonly name = 'llm';

  constructor(
    private readonly client: LlmClient,
    private readonly fallback: ContentEngine,
    private readonly logger?: Logger,
  ) {}

  async reviewReplies(req: ReviewReplyRequest): Promise<ReviewReplyResult> {
    const reviews: Review[] = req.reviews.map((r, i) => ({ ...r, id: r.id ?? `r${i + 1}` }));
    try {
      const data = await this.client.chatJson({
        system: SYSTEM_PROMPT,
        user: reviewReplyUser(req.shop, reviews),
        schema: replySchema,
      });
      if (data.replies.length < reviews.length) throw new Error('回复数量少于评价数量');
      const replies: ReviewReply[] = reviews.map((r, i) => ({
        reviewId: r.id ?? `r${i + 1}`,
        rating: r.rating,
        sentiment: sentimentOf(r.rating),
        reply: data.replies[i].reply,
        actions: data.replies[i].actions,
      }));
      return { replies };
    } catch (err) {
      this.degrade('reviewReplies', err);
      return this.fallback.reviewReplies(req);
    }
  }

  async recall(req: RecallRequest): Promise<RecallResult> {
    const segments: RecallSegmentKey[] =
      req.segments && req.segments.length ? req.segments : ['lapsed', 'sleeping', 'new_to_repeat'];
    const channel: RecallChannel = req.channel ?? '微信';
    try {
      const data = await this.client.chatJson({
        system: SYSTEM_PROMPT,
        user: recallUser(
          req.shop,
          segments.map((s) => ({ key: s, label: SEGMENT_LABELS[s] })),
          channel,
        ),
        schema: recallSchema,
      });
      if (data.scripts.length < segments.length) throw new Error('召回文案数量不足');
      const scripts: RecallScript[] = segments.map((seg, i) => ({
        segment: seg,
        segmentLabel: SEGMENT_LABELS[seg],
        channel,
        message: data.scripts[i].message,
        bestSendTime: data.scripts[i].bestSendTime || '建议非高峰时段发送',
        offer: data.scripts[i].offer,
      }));
      return { scripts };
    } catch (err) {
      this.degrade('recall', err);
      return this.fallback.recall(req);
    }
  }

  async promotions(req: PromotionRequest): Promise<PromotionResult> {
    const count = req.count ?? 3;
    try {
      const data = await this.client.chatJson({
        system: SYSTEM_PROMPT,
        user: promotionUser(req.shop, count, perCapitaOf(req.shop)),
        schema: promoSchema,
      });
      const packages: PromotionPackage[] = data.packages.slice(0, count).map((p) => ({
        name: p.name,
        items: p.items,
        originalPrice: Math.round(p.originalPrice),
        dealPrice: Math.round(p.dealPrice),
        discount: Math.round((p.dealPrice / p.originalPrice) * 100) / 100,
        targetScenario: p.targetScenario,
        rationale: p.rationale,
      }));
      if (!packages.length) throw new Error('套餐为空');
      return { packages };
    } catch (err) {
      this.degrade('promotions', err);
      return this.fallback.promotions(req);
    }
  }

  async socialContent(req: ContentRequest): Promise<ContentResult> {
    const platforms: SocialPlatform[] =
      req.platforms && req.platforms.length ? req.platforms : ['小红书', '抖音'];
    try {
      const data = await this.client.chatJson({
        system: SYSTEM_PROMPT,
        user: contentUser(req.shop, platforms, req.topic),
        schema: contentSchema,
      });
      if (data.posts.length < platforms.length) throw new Error('内容数量不足');
      const posts: SocialContent[] = platforms.map((platform, i) => ({
        platform,
        title: data.posts[i].title,
        body: data.posts[i].body,
        hashtags: data.posts[i].hashtags,
        tips: data.posts[i].tips,
      }));
      return { posts };
    } catch (err) {
      this.degrade('socialContent', err);
      return this.fallback.socialContent(req);
    }
  }

  private degrade(op: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger?.warn({ op, err: msg }, 'LLM 引擎降级到规则引擎');
  }
}
