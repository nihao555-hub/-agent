import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { createChatAgent } from './chat/agent';
import { createChatRouter } from './chat/routes';
import { ChatService } from './chat/service';
import type { AppConfig } from './config';
import { openDatabase } from './db';
import {
  ApplicationRepository,
  CandidateRepository,
  ChatRepository,
  JobRepository,
  NotificationRepository,
} from './db/repositories';
import { createEngine } from './engine';
import { ImapEmailSource } from './intake/email';
import { createIntakeRouter } from './intake/routes';
import { IntakeService } from './intake/service';
import { LlmClient } from './llm/client';
import { logger as defaultLogger, type Logger } from './logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { createNotifier } from './notify/channels';
import { createFeedbackComposer } from './notify/composer';
import { OsintCollector } from './osint/collector';
import { createPipelineRouter } from './pipeline/routes';
import { PipelineService } from './pipeline/service';
import { ResumeParser } from './resume/parser';
import { createRouter } from './routes';
import { HrService } from './service';

/**
 * 构建 Express 应用（不监听端口）。
 * 抽成工厂函数便于单测用 supertest 直接驱动，无需真正起服务。
 */
export function createApp(config: AppConfig, logger: Logger = defaultLogger): Express {
  const engine = createEngine(config, logger);
  const parserLlm =
    config.llm.enabled && config.llm.apiKey
      ? new LlmClient({
          apiKey: config.llm.apiKey,
          baseUrl: config.llm.baseUrl,
          model: config.llm.model,
          timeoutMs: config.llm.timeoutMs,
          maxRetries: config.llm.maxRetries,
          logger,
        })
      : undefined;
  const parser = new ResumeParser(config.resumeService, parserLlm, logger);
  const osint = new OsintCollector(config.osintService, logger);
  const service = new HrService(engine, parser, osint);

  const db = openDatabase(config.db.path, logger);
  const jobs = new JobRepository(db);
  const candidates = new CandidateRepository(db);
  const chatService = new ChatService(
    jobs,
    candidates,
    new ChatRepository(db),
    createChatAgent(config, logger),
  );

  // 候选人流水线（状态机 + 反馈通知）与简历自动归集层共享同一引擎/解析器/数据库。
  const pipelineService = new PipelineService(
    jobs,
    candidates,
    new ApplicationRepository(db),
    new NotificationRepository(db),
    engine,
    createFeedbackComposer(config, logger),
    createNotifier(config, logger),
    logger,
  );
  const emailSource = config.imap.enabled ? new ImapEmailSource(config.imap, logger) : undefined;
  const intakeService = new IntakeService(
    parser,
    pipelineService,
    config.intake,
    emailSource,
    logger,
  );
  // 配齐归集目录 + 绑定岗位时，启动文件夹实时监听（新简历落地自动入库）。
  if (config.intake.watchDir && config.intake.watchJobId) {
    intakeService.startFolderWatch(config.intake.watchJobId);
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors());
  // 简历文件以 base64 提交，放宽 body 体积上限。
  app.use(express.json({ limit: '8mb' }));
  app.use(pinoHttp({ logger }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'hr-screening-agent',
      engine: engine.name,
      model: config.llm.enabled ? config.llm.model : null,
      resumeService: config.resumeService.url ? 'configured' : 'text-only',
      osintService: config.osintService.url ? 'configured' : 'disabled',
      storage: config.db.path === ':memory:' ? 'memory' : 'sqlite',
      notifyChannel: config.notify.defaultChannel,
      emailIntake: config.imap.enabled ? 'configured' : 'disabled',
      folderIntake: config.intake.watchDir ? 'configured' : 'disabled',
    });
  });

  app.use('/api', createRouter(service));
  app.use('/api/chat', createChatRouter(chatService));
  app.use('/api/pipeline', createPipelineRouter(pipelineService));
  app.use('/api/intake', createIntakeRouter(intakeService, pipelineService.engineName));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}
