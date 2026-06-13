import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { AppConfig } from './config';
import { createEngine } from './engine';
import { logger as defaultLogger, type Logger } from './logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { createRouter } from './routes';

/**
 * 构建 Express 应用（不监听端口）。
 * 抽成工厂函数便于单测用 supertest 直接驱动，无需真正起服务。
 */
export function createApp(config: AppConfig, logger: Logger = defaultLogger): Express {
  const engine = createEngine(config, logger);

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'dianxiaoer-agent',
      engine: engine.name,
      model: config.llm.enabled ? config.llm.model : null,
    });
  });

  app.use('/api', createRouter(engine));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}
