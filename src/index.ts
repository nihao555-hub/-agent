import { createApp } from './app';
import { loadConfig } from './config';
import { logger } from './logger';

function main(): void {
  const config = loadConfig();
  const app = createApp(config, logger);

  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, engine: config.llm.enabled ? 'llm' : 'rule-based' },
      'AI 店小二后端已启动',
    );
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, '收到关闭信号，正在优雅退出');
    server.close(() => process.exit(0));
    // 兜底：5s 内未正常关闭则强制退出
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
