import 'dotenv/config';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3002),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  LLM_API_KEY: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined)),
  LLM_BASE_URL: z.string().url().default('https://grsaiapi.com/v1'),
  LLM_MODEL: z.string().min(1).default('gemini-2.5-flash'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  // 向量检索用的 embedding 模型（OpenAI 兼容）。配了 LLM_API_KEY 时用它把片段/查询向量化；
  // 没配则用确定性哈希向量兜底（离线可测，质量有限，仅保证管线可跑）。
  EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
  // 招标文件解析微服务（如 MinerU）。配了才会把上传的 PDF/Word 送去解析；
  // 不配则只支持直接提交纯文本（离线可用）。
  DOC_SERVICE_URL: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v.replace(/\/$/, '') : undefined)),
  DOC_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  // 持久化（SQLite）。文件库路径目录会自动创建；测试用 :memory: 内存库。
  DB_PATH: z.string().trim().min(1).default('./data/eng-delivery.db'),
});

export interface LlmConfig {
  /** 是否配置了可用的大模型 key；未配置时全程走规则引擎。 */
  enabled: boolean;
  apiKey?: string;
  baseUrl: string;
  model: string;
  embeddingModel: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface DocServiceConfig {
  url?: string;
  timeoutMs: number;
}

export interface DbConfig {
  path: string;
}

export interface AppConfig {
  port: number;
  logLevel: LogLevel;
  llm: LlmConfig;
  docService: DocServiceConfig;
  db: DbConfig;
}

/** 从环境变量（或传入的对象）加载配置，校验失败会抛出可读错误。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  return {
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    llm: {
      enabled: Boolean(parsed.LLM_API_KEY),
      apiKey: parsed.LLM_API_KEY,
      baseUrl: parsed.LLM_BASE_URL,
      model: parsed.LLM_MODEL,
      embeddingModel: parsed.EMBEDDING_MODEL,
      timeoutMs: parsed.LLM_TIMEOUT_MS,
      maxRetries: parsed.LLM_MAX_RETRIES,
    },
    docService: {
      url: parsed.DOC_SERVICE_URL,
      timeoutMs: parsed.DOC_SERVICE_TIMEOUT_MS,
    },
    db: { path: parsed.DB_PATH },
  };
}
