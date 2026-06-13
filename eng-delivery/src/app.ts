import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { AppConfig } from './config';
import { openDatabase } from './db';
import {
  AnalysisRepository,
  CapabilityRepository,
  EventRepository,
  TenderRepository,
} from './db/repositories';
import { TenderDocParser } from './doc/parser';
import { createEngine } from './engine';
import { logger as defaultLogger, type Logger } from './logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { createRouter } from './routes';
import { EngDeliveryService } from './service';

/**
 * 构建 Express 应用（不监听端口）。
 * 抽成工厂函数便于单测用 supertest 直接驱动，无需真正起服务。
 */
export function createApp(config: AppConfig, logger: Logger = defaultLogger): Express {
  const engine = createEngine(config, logger);
  const parser = new TenderDocParser(config.docService, logger);

  const db = openDatabase(config.db.path, logger);
  const service = new EngDeliveryService(
    engine,
    parser,
    {
      tenders: new TenderRepository(db),
      capabilities: new CapabilityRepository(db),
      analyses: new AnalysisRepository(db),
      events: new EventRepository(db),
    },
    logger,
  );

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors());
  // 招标文件可以 base64 文件形式提交，放宽 body 体积上限。
  app.use(express.json({ limit: '12mb' }));
  app.use(pinoHttp({ logger }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'eng-delivery-agent',
      engine: engine.name,
      model: config.llm.enabled ? config.llm.model : null,
      docService: config.docService.url ? 'configured' : 'text-only',
      storage: config.db.path === ':memory:' ? 'memory' : 'sqlite',
    });
  });

  app.use('/api', createRouter(service));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}
