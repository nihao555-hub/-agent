import type { AppConfig } from '../config';
import { LlmClient } from '../llm/client';
import type { Logger } from '../logger';
import { LlmEngine } from './llm';
import { RuleBasedEngine } from './ruleBased';
import type { TenderEngine } from './types';

export * from './types';
export { RuleBasedEngine } from './ruleBased';
export { LlmEngine } from './llm';

/**
 * 引擎工厂：配了 LLM_API_KEY 走大模型（失败自动回退规则引擎）；没配则直接用规则引擎。
 */
export function createEngine(config: AppConfig, logger?: Logger): TenderEngine {
  const fallback = new RuleBasedEngine();
  if (!config.llm.enabled || !config.llm.apiKey) {
    logger?.info('未配置 LLM_API_KEY，使用规则引擎(rule-based)');
    return fallback;
  }
  const client = new LlmClient({
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    timeoutMs: config.llm.timeoutMs,
    maxRetries: config.llm.maxRetries,
    logger,
  });
  logger?.info({ model: config.llm.model, baseUrl: config.llm.baseUrl }, '已启用 LLM 引擎');
  return new LlmEngine(client, fallback, logger);
}
