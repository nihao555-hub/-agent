import { Router } from 'express';
import { HttpError } from './errors';
import {
  analyzeRequestSchema,
  capabilityProfileSchema,
  complianceRequestSchema,
  gapRequestSchema,
  parseTenderSchema,
} from './schemas';
import type { EngDeliveryService } from './service';
import { asyncHandler } from './utils/asyncHandler';
import { parseBody } from './utils/validate';

/**
 * 工程交付大脑 REST 路由。
 * 所有结果默认带 `engine` 字段，标注本次结果由大模型(llm)还是规则引擎(rule-based)生成。
 */
export function createRouter(service: EngDeliveryService): Router {
  const router = Router();

  // 解析招标文件 → 结构化要点并落库
  router.post(
    '/tenders/parse',
    asyncHandler(async (req, res) => {
      const data = parseBody(parseTenderSchema, req.body);
      const result = await service.parseTender(data);
      res.json(result);
    }),
  );

  // 招标文件列表
  router.get(
    '/tenders',
    asyncHandler(async (_req, res) => {
      res.json({ tenders: service.listTenders() });
    }),
  );

  // 单份招标要点
  router.get(
    '/tenders/:id',
    asyncHandler(async (req, res) => {
      const tender = service.getTender(req.params.id);
      if (!tender) throw new HttpError(404, `招标文件不存在: ${req.params.id}`);
      res.json({ id: req.params.id, tender });
    }),
  );

  // 招标文件的分析与事件留痕
  router.get(
    '/tenders/:id/analyses',
    asyncHandler(async (req, res) => {
      res.json({ id: req.params.id, ...service.getAnalyses(req.params.id) });
    }),
  );

  // 登记我方能力档案
  router.post(
    '/capabilities',
    asyncHandler(async (req, res) => {
      const data = parseBody(capabilityProfileSchema, req.body);
      const id = service.createCapability(data);
      res.status(201).json({ id });
    }),
  );

  // 读取我方能力档案
  router.get(
    '/capabilities/:id',
    asyncHandler(async (req, res) => {
      const capability = service.getCapability(req.params.id);
      if (!capability) throw new HttpError(404, `我方能力档案不存在: ${req.params.id}`);
      res.json({ id: req.params.id, capability });
    }),
  );

  // 范围/资格缺口检测
  router.post(
    '/gap-analysis',
    asyncHandler(async (req, res) => {
      const data = parseBody(gapRequestSchema, req.body);
      const result = await service.detectGaps(data);
      res.json(result);
    }),
  );

  // 合规 / 废标风险自检
  router.post(
    '/compliance-check',
    asyncHandler(async (req, res) => {
      const data = parseBody(complianceRequestSchema, req.body);
      const result = await service.checkCompliance(data);
      res.json(result);
    }),
  );

  // 端到端：解析 + 缺口 + 合规一次完成
  router.post(
    '/analyze',
    asyncHandler(async (req, res) => {
      const data = parseBody(analyzeRequestSchema, req.body);
      const result = await service.analyze(data);
      res.json(result);
    }),
  );

  return router;
}
