import 'dotenv/config';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const NOTIFY_CHANNELS = ['email', 'sms', 'wecom', 'none'] as const;

/** 把环境变量字符串解析为布尔（未设置时用默认值），用于 *_SECURE/*_TLS 这类开关。 */
const boolEnv = (def: boolean) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v)));

const optionalStr = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));

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
  DB_PATH: z.string().trim().min(1).default('./data/hr.db'),
  // 简历归集层：文件夹扫描/监听目录、是否在批量归集后自动初筛打分
  INTAKE_WATCH_DIR: optionalStr,
  INTAKE_WATCH_JOB_ID: optionalStr,
  INTAKE_AUTO_SCREEN: boolEnv(true),
  // 企业邮箱 IMAP 收件（配齐 HOST/USER/PASSWORD 才启用；否则安全禁用）
  IMAP_HOST: optionalStr,
  IMAP_PORT: z.coerce.number().int().positive().default(993),
  IMAP_USER: optionalStr,
  IMAP_PASSWORD: optionalStr,
  IMAP_TLS: boolEnv(true),
  IMAP_MAILBOX: z.string().trim().min(1).default('INBOX'),
  // 通知反馈渠道：默认 none（dry-run 落库不外发）；email 走 SMTP（nodemailer）
  NOTIFY_DEFAULT_CHANNEL: z.enum(NOTIFY_CHANNELS).default('none'),
  SMTP_HOST: optionalStr,
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_SECURE: boolEnv(true),
  SMTP_USER: optionalStr,
  SMTP_PASSWORD: optionalStr,
  SMTP_FROM: optionalStr,
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

export interface DbConfig {
  /** SQLite 文件路径；`:memory:` 表示内存库（测试用）。用于持久化对话式初筛的会话与消息。 */
  path: string;
}

export interface IntakeConfig {
  /** 文件夹归集目录：扫描/监听此目录中的简历文件自动入库；未配置则禁用。 */
  watchDir?: string;
  /** 文件夹实时监听绑定的岗位 ID（配齐 watchDir + 此项才启动实时监听）。 */
  watchJobId?: string;
  /** 批量归集后是否自动跑硬筛+打分。 */
  autoScreen: boolean;
}

export interface ImapConfig {
  /** 配齐 host/user/password 时启用，否则邮箱收件安全禁用。 */
  enabled: boolean;
  host?: string;
  port: number;
  user?: string;
  password?: string;
  tls: boolean;
  mailbox: string;
}

export interface SmtpConfig {
  /** 配齐 host + from（或 user）时启用。 */
  enabled: boolean;
  host?: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from?: string;
}

export interface NotifyConfig {
  /** 默认通知渠道；none 表示 dry-run（仅落库不外发）。 */
  defaultChannel: (typeof NOTIFY_CHANNELS)[number];
  smtp: SmtpConfig;
}

export interface AppConfig {
  port: number;
  logLevel: LogLevel;
  llm: LlmConfig;
  resumeService: ResumeServiceConfig;
  osintService: OsintServiceConfig;
  db: DbConfig;
  intake: IntakeConfig;
  imap: ImapConfig;
  notify: NotifyConfig;
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
    db: {
      path: parsed.DB_PATH,
    },
    intake: {
      watchDir: parsed.INTAKE_WATCH_DIR,
      watchJobId: parsed.INTAKE_WATCH_JOB_ID,
      autoScreen: parsed.INTAKE_AUTO_SCREEN,
    },
    imap: {
      enabled: Boolean(parsed.IMAP_HOST && parsed.IMAP_USER && parsed.IMAP_PASSWORD),
      host: parsed.IMAP_HOST,
      port: parsed.IMAP_PORT,
      user: parsed.IMAP_USER,
      password: parsed.IMAP_PASSWORD,
      tls: parsed.IMAP_TLS,
      mailbox: parsed.IMAP_MAILBOX,
    },
    notify: {
      defaultChannel: parsed.NOTIFY_DEFAULT_CHANNEL,
      smtp: {
        enabled: Boolean(parsed.SMTP_HOST && (parsed.SMTP_FROM || parsed.SMTP_USER)),
        host: parsed.SMTP_HOST,
        port: parsed.SMTP_PORT,
        secure: parsed.SMTP_SECURE,
        user: parsed.SMTP_USER,
        password: parsed.SMTP_PASSWORD,
        from: parsed.SMTP_FROM,
      },
    },
  };
}
