import 'dotenv/config';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
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
  RESUME_SERVICE_URL: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v.replace(/\/$/, '') : undefined)),
  RESUME_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  OSINT_SERVICE_URL: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v.replace(/\/$/, '') : undefined)),
  OSINT_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
});

export interface LlmConfig {
  /** 是否配置了可用的大模型 key；未配置时全程走规则引擎 */
  enabled: boolean;
  apiKey?: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface ResumeServiceConfig {
  /** SmartResume 解析微服务地址；未配置时仅支持纯文本简历解析 */
  url?: string;
  timeoutMs: number;
}

export interface OsintServiceConfig {
  /** OSINT 收集微服务地址（maigret/sherlock/spiderfoot）；未配置时背调仅产出授权核验计划，不做公开信息收集 */
  url?: string;
  timeoutMs: number;
}

export interface AppConfig {
  port: number;
  logLevel: LogLevel;
  llm: LlmConfig;
  resumeService: ResumeServiceConfig;
  osintService: OsintServiceConfig;
}

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
      timeoutMs: parsed.LLM_TIMEOUT_MS,
      maxRetries: parsed.LLM_MAX_RETRIES,
    },
    resumeService: {
      url: parsed.RESUME_SERVICE_URL,
      timeoutMs: parsed.RESUME_SERVICE_TIMEOUT_MS,
    },
    osintService: {
      url: parsed.OSINT_SERVICE_URL,
      timeoutMs: parsed.OSINT_SERVICE_TIMEOUT_MS,
    },
  };
}
