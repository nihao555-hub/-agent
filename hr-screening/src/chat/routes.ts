import { Router } from 'express';
import { chatMessageRequestSchema, createChatSessionRequestSchema } from '../schemas';
import { asyncHandler } from '../utils/asyncHandler';
import { parseBody } from '../utils/validate';
import type { ChatService } from './service';

/**
 * 对话式初筛路由：建会话 / 发消息（带历史）/ 取上下文 / 出小结 / 列会话。
 * 响应带 `engine` 字段，标注本次由大模型(llm)还是规则引擎(rule-based)生成。
 */
export function createChatRouter(service: ChatService): Router {
  const router = Router();
  const engine = service.engineName;

  // 新建对话式初筛会话（绑定岗位 + 候选人，返回开场白）
  router.post(
    '/sessions',
    asyncHandler(async (req, res) => {
      const data = parseBody(createChatSessionRequestSchema, req.body);
      const { session, messages } = await service.createSession(data);
      res.status(201).json({ engine, session, messages });
    }),
  );

  // 列出全部会话（元信息）
  router.get(
    '/sessions',
    asyncHandler(async (_req, res) => {
      res.json({ sessions: service.listSessions() });
    }),
  );

  // 取单个会话上下文（岗位 + 简历 + 完整历史 + 小结）
  router.get(
    '/sessions/:id',
    asyncHandler(async (req, res) => {
      const { session, messages } = service.getSession(req.params.id);
      res.json({ session, messages });
    }),
  );

  // 候选人发一条消息，返回 AI 回复与最新历史
  router.post(
    '/sessions/:id/messages',
    asyncHandler(async (req, res) => {
      const data = parseBody(chatMessageRequestSchema, req.body);
      const { reply, messages } = await service.postMessage(req.params.id, data.message);
      res.json({ engine, reply, messages });
    }),
  );

  // 出结构化初筛小结（回填会话并标记完成）
  router.post(
    '/sessions/:id/summary',
    asyncHandler(async (req, res) => {
      const summary = await service.summarize(req.params.id);
      res.json({ engine, summary });
    }),
  );

  return router;
}
