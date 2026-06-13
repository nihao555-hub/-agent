import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { parseBody } from '../utils/validate';
import {
  createProjectSchema,
  extractScopeSchema,
  ingestDocumentSchema,
  recordChangeSchema,
  setStatusSchema,
} from './schemas';
import type { FactBaseService } from './service';

/**
 * 事实底座（项目维度）REST 路由：项目 → 文档录入/解析 → 要求/承诺抽取 → 偏离检测 → 图谱。
 * 抽取类结果带 `engine` 字段，标注由大模型(llm)还是规则兜底(rule-based)生成。
 */
export function createFactBaseRouter(service: FactBaseService): Router {
  const router = Router();

  // 新建项目
  router.post(
    '/projects',
    asyncHandler(async (req, res) => {
      const data = parseBody(createProjectSchema, req.body);
      const project = service.createProject(data);
      res.status(201).json({ project });
    }),
  );

  // 项目列表
  router.get(
    '/projects',
    asyncHandler(async (_req, res) => {
      res.json({ projects: service.listProjects() });
    }),
  );

  // 单个项目
  router.get(
    '/projects/:id',
    asyncHandler(async (req, res) => {
      res.json({ project: service.getProject(req.params.id) });
    }),
  );

  // 项目状态流转
  router.post(
    '/projects/:id/status',
    asyncHandler(async (req, res) => {
      const data = parseBody(setStatusSchema, req.body);
      res.json({ project: service.setStatus(req.params.id, data.status) });
    }),
  );

  // 录入并解析一份文档（招标/合同/规范/BOQ/我方投标/变更/函件…）
  router.post(
    '/projects/:id/documents',
    asyncHandler(async (req, res) => {
      const data = parseBody(ingestDocumentSchema, req.body);
      const result = await service.ingestDocument(req.params.id, data);
      res.status(201).json(result);
    }),
  );

  // 抽取要求基线
  router.post(
    '/projects/:id/extract-requirements',
    asyncHandler(async (req, res) => {
      const data = parseBody(extractScopeSchema, req.body ?? {});
      res.json(await service.extractRequirements(req.params.id, data.documentId));
    }),
  );

  // 抽取我方承诺
  router.post(
    '/projects/:id/extract-commitments',
    asyncHandler(async (req, res) => {
      const data = parseBody(extractScopeSchema, req.body ?? {});
      res.json(await service.extractCommitments(req.params.id, data.documentId));
    }),
  );

  // 偏离检测（要求↔承诺）
  router.post(
    '/projects/:id/detect-deviations',
    asyncHandler(async (req, res) => {
      res.json(await service.detectDeviations(req.params.id));
    }),
  );

  // 记录变更/签证
  router.post(
    '/projects/:id/changes',
    asyncHandler(async (req, res) => {
      const data = parseBody(recordChangeSchema, req.body);
      res.status(201).json({ change: service.recordChange(req.params.id, data) });
    }),
  );

  // 项目事实图谱
  router.get(
    '/projects/:id/graph',
    asyncHandler(async (req, res) => {
      res.json(service.getGraph(req.params.id));
    }),
  );

  return router;
}
