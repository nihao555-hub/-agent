import { Router } from 'express';
import { batchIntakeRequestSchema, sourceIntakeRequestSchema } from '../schemas';
import { asyncHandler } from '../utils/asyncHandler';
import { parseBody } from '../utils/validate';
import type { IntakeService } from './service';

/**
 * 简历自动归集路由：批量上传 / 邮箱收件 / 文件夹扫描 → 自动解析建档 + 初筛打分。
 * 响应带 `engine` 字段，标注自动初筛由大模型(llm)还是规则引擎(rule-based)生成。
 */
export function createIntakeRouter(service: IntakeService, engineName: string): Router {
  const router = Router();

  // 批量上传归集：多份简历（文本/文件）→ 解析 → 建档 → 自动硬筛+打分 → 入库
  router.post(
    '/batch',
    asyncHandler(async (req, res) => {
      const data = parseBody(batchIntakeRequestSchema, req.body);
      const summary = await service.ingestBatch(data.jobId, data.resumes, 'batch');
      res.json({ engine: engineName, ...summary });
    }),
  );

  // 企业邮箱 IMAP 收件归集（未配置凭据时 400 安全禁用）
  router.post(
    '/email/poll',
    asyncHandler(async (req, res) => {
      const data = parseBody(sourceIntakeRequestSchema, req.body);
      const summary = await service.pollEmail(data.jobId);
      res.json({ engine: engineName, ...summary });
    }),
  );

  // 文件夹扫描归集（未配置 INTAKE_WATCH_DIR 时 400 安全禁用）
  router.post(
    '/folder/scan',
    asyncHandler(async (req, res) => {
      const data = parseBody(sourceIntakeRequestSchema, req.body);
      const summary = await service.scanFolder(data.jobId);
      res.json({ engine: engineName, ...summary });
    }),
  );

  return router;
}
