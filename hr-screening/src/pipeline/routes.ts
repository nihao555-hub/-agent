import { Router } from 'express';
import {
  createApplicationRequestSchema,
  feedbackRequestSchema,
  jobPostingSchema,
  transitionRequestSchema,
} from '../schemas';
import { asyncHandler } from '../utils/asyncHandler';
import { parseBody } from '../utils/validate';
import { APPLICATION_STATUSES, type ApplicationStatus } from './status';
import type { PipelineService } from './service';
import type { ApplicationListFilter } from '../db/repositories';

const STATUS_SET = new Set<string>(APPLICATION_STATUSES);

/**
 * 候选人流水线路由：岗位持久化 + 投递 + 状态机受控流转 + 自动初筛 + 实时反馈通知。
 * 响应带 `engine` 字段，标注反馈/打分由大模型(llm)还是规则引擎(rule-based)生成。
 */
export function createPipelineRouter(service: PipelineService): Router {
  const router = Router();
  const engine = service.engineName;

  // 持久化岗位（设硬性条件），返回 jobId
  router.post(
    '/jobs',
    asyncHandler(async (req, res) => {
      const job = parseBody(jobPostingSchema, req.body);
      res.status(201).json(service.createJob(job));
    }),
  );

  // 列出岗位
  router.get(
    '/jobs',
    asyncHandler(async (_req, res) => {
      res.json({ jobs: service.listJobs() });
    }),
  );

  // 新建投递（建档：候选人 + 投递记录 applied）
  router.post(
    '/applications',
    asyncHandler(async (req, res) => {
      const data = parseBody(createApplicationRequestSchema, req.body);
      const application = service.createApplication(data);
      res.status(201).json({ application });
    }),
  );

  // 列出投递（可按 jobId / status 过滤），看板视图
  router.get(
    '/applications',
    asyncHandler(async (req, res) => {
      const filter: ApplicationListFilter = {};
      const jobId = req.query.jobId;
      const status = req.query.status;
      if (typeof jobId === 'string' && jobId) filter.jobId = jobId;
      if (typeof status === 'string' && STATUS_SET.has(status)) {
        filter.status = status as ApplicationStatus;
      }
      res.json({ applications: service.listApplications(filter) });
    }),
  );

  // 流程漏斗统计
  router.get(
    '/stats',
    asyncHandler(async (req, res) => {
      const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : undefined;
      res.json({ stats: service.stats(jobId) });
    }),
  );

  // 投递详情（含岗位 + 候选人 + 事件历史 + 通知历史）
  router.get(
    '/applications/:id',
    asyncHandler(async (req, res) => {
      res.json(service.getApplicationDetail(req.params.id));
    }),
  );

  // 事件历史
  router.get(
    '/applications/:id/events',
    asyncHandler(async (req, res) => {
      const { events } = service.getApplicationDetail(req.params.id);
      res.json({ events });
    }),
  );

  // 自动初筛打分（硬性过滤 + 多维打分，结果写回投递）
  router.post(
    '/applications/:id/screen',
    asyncHandler(async (req, res) => {
      const application = await service.screen(req.params.id);
      res.json({ engine, application });
    }),
  );

  // 受控状态流转（投递→初筛中→约面/淘汰/人才库），可选发送反馈通知
  router.post(
    '/applications/:id/transition',
    asyncHandler(async (req, res) => {
      const data = parseBody(transitionRequestSchema, req.body);
      const result = await service.transition(req.params.id, data.toStatus, {
        reason: data.reason,
        notify: data.notify,
      });
      res.json({ engine, ...result });
    }),
  );

  // 生成并发送（或预览）反馈通知（AI 拒信/约面通知，实时反馈应聘结果）
  router.post(
    '/applications/:id/feedback',
    asyncHandler(async (req, res) => {
      const data = parseBody(feedbackRequestSchema, req.body);
      const notification = await service.sendFeedback(req.params.id, {
        reason: data.reason,
        preview: data.preview,
      });
      res.json({ engine, notification });
    }),
  );

  return router;
}
