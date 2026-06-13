import { Router } from 'express';
import type { ContentEngine } from './engine';
import {
  analyzeRequestSchema,
  contentRequestSchema,
  promotionRequestSchema,
  recallRequestSchema,
  reviewReplyRequestSchema,
} from './schemas';
import { analyzeShop } from './service';
import { asyncHandler } from './utils/asyncHandler';
import { parseBody } from './utils/validate';

/**
 * 业务路由：AI 店小二的四个核心能力 + 一次性综合分析。
 * 所有响应都带 `engine` 字段，标注本次结果由大模型(llm)还是规则引擎(rule-based)生成。
 */
export function createRouter(engine: ContentEngine): Router {
  const router = Router();

  // 差评/好评逐条智能回复
  router.post(
    '/reviews/reply',
    asyncHandler(async (req, res) => {
      const data = parseBody(reviewReplyRequestSchema, req.body);
      const result = await engine.reviewReplies(data);
      res.json({ engine: engine.name, ...result });
    }),
  );

  // 老顾客召回话术（短信/微信）
  router.post(
    '/recall',
    asyncHandler(async (req, res) => {
      const data = parseBody(recallRequestSchema, req.body);
      const result = await engine.recall(data);
      res.json({ engine: engine.name, ...result });
    }),
  );

  // 团购套餐 + 定价建议
  router.post(
    '/promotions',
    asyncHandler(async (req, res) => {
      const data = parseBody(promotionRequestSchema, req.body);
      const result = await engine.promotions(data);
      res.json({ engine: engine.name, ...result });
    }),
  );

  // 小红书/抖音引流文案
  router.post(
    '/content',
    asyncHandler(async (req, res) => {
      const data = parseBody(contentRequestSchema, req.body);
      const result = await engine.socialContent(data);
      res.json({ engine: engine.name, ...result });
    }),
  );

  // 一次性综合分析：四个模块全出
  router.post(
    '/analyze',
    asyncHandler(async (req, res) => {
      const data = parseBody(analyzeRequestSchema, req.body);
      const result = await analyzeShop(engine, data);
      res.json({ engine: engine.name, ...result });
    }),
  );

  return router;
}
