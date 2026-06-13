import { Router } from 'express';
import {
  analyzeRequestSchema,
  backgroundPlanRequestSchema,
  backgroundProfileRequestSchema,
  batchScoreRequestSchema,
  osintCollectRequestSchema,
  outreachRequestSchema,
  parseJobRequestSchema,
  parseResumeRequestSchema,
  scoreRequestSchema,
} from './schemas';
import type { HrService } from './service';
import { asyncHandler } from './utils/asyncHandler';
import { parseBody } from './utils/validate';

/**
 * HR 初筛后端路由，覆盖完整初筛流程 + 授权式合规背调。
 * 所有结果默认带 `engine` 字段，标注本次由大模型(llm)还是规则引擎(rule-based)生成。
 */
export function createRouter(service: HrService): Router {
  const router = Router();
  const engine = service.engineName;

  // JD 结构化解析
  router.post(
    '/jobs/parse',
    asyncHandler(async (req, res) => {
      const data = parseBody(parseJobRequestSchema, req.body);
      const job = await service.parseJob(data);
      res.json({ engine, job });
    }),
  );

  // 简历解析（文件走 SmartResume 微服务，纯文本走大模型/正则兜底）
  router.post(
    '/resume/parse',
    asyncHandler(async (req, res) => {
      const data = parseBody(parseResumeRequestSchema, req.body);
      const result = await service.parseResume(data);
      res.json({ source: result.source, resume: result.resume });
    }),
  );

  // 单份简历初筛打分（硬性过滤 + 多维评分 + 风险点 + 建议追问）
  router.post(
    '/screening/score',
    asyncHandler(async (req, res) => {
      const data = parseBody(scoreRequestSchema, req.body);
      const result = await service.score(data);
      res.json({ engine, ...result });
    }),
  );

  // 批量打分并排序
  router.post(
    '/screening/batch',
    asyncHandler(async (req, res) => {
      const data = parseBody(batchScoreRequestSchema, req.body);
      const result = await service.batchScore(data);
      res.json({ engine, ...result });
    }),
  );

  // 初步触达话术（电话/短信/微信）
  router.post(
    '/outreach',
    asyncHandler(async (req, res) => {
      const data = parseBody(outreachRequestSchema, req.body);
      const result = await service.outreach(data);
      res.json({ engine, ...result });
    }),
  );

  // 授权式合规背调：核验计划（consent 闸门）
  router.post(
    '/background-check/plan',
    asyncHandler(async (req, res) => {
      const data = parseBody(backgroundPlanRequestSchema, req.body);
      const plan = service.buildBackgroundCheckPlan(data);
      res.json({ plan });
    }),
  );

  // 授权式 OSINT 公开信息收集（maigret/sherlock/spiderfoot，强制 consent + 本人标识）
  router.post(
    '/background-check/osint',
    asyncHandler(async (req, res) => {
      const data = parseBody(osintCollectRequestSchema, req.body);
      const report = await service.collectOsint(data);
      res.json({ report });
    }),
  );

  // 授权式合规背调：基于已授权核验结论（+可选 OSINT 线索）整合候选人画像
  router.post(
    '/background-check/profile',
    asyncHandler(async (req, res) => {
      const data = parseBody(backgroundProfileRequestSchema, req.body);
      const profile = await service.backgroundProfile(data);
      res.json({ engine, profile });
    }),
  );

  // 端到端：打分 + 触达 + 背调计划（授权且有核验结论时附画像）
  router.post(
    '/analyze',
    asyncHandler(async (req, res) => {
      const data = parseBody(analyzeRequestSchema, req.body);
      const result = await service.analyze(data);
      res.json({ engine, ...result });
    }),
  );

  return router;
}
