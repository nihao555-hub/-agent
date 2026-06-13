import { z } from 'zod';
import type { OsintServiceConfig } from '../config';
import type { Logger } from '../logger';

export const OSINT_TOOLS = ['maigret', 'sherlock', 'spiderfoot'] as const;
export type OsintTool = (typeof OSINT_TOOLS)[number];

/** 候选人本人提供/确认的标识符（授权前提下用于公开信息收集）。 */
export interface OsintHandles {
  usernames?: string[];
  emails?: string[];
  phones?: string[];
  domains?: string[];
}

/** 一条公开账号/足迹线索（需人工核实归属，不得据此臆断）。 */
export interface OsintAccount {
  tool: OsintTool;
  site: string;
  url: string;
  category?: string;
}

export interface OsintReport {
  /** 是否实际执行了收集（未配置服务/调用失败时为 false） */
  available: boolean;
  tools: OsintTool[];
  accounts: OsintAccount[];
  notes: string[];
}

const accountSchema = z.object({
  tool: z.enum(OSINT_TOOLS),
  site: z.string(),
  url: z.string(),
  category: z.string().optional(),
});

const responseSchema = z.object({
  tools: z.array(z.enum(OSINT_TOOLS)).default([]),
  accounts: z.array(accountSchema).default([]),
  notes: z.array(z.string()).default([]),
});

function hasAnyHandle(h: OsintHandles): boolean {
  return Boolean(h.usernames?.length || h.emails?.length || h.phones?.length || h.domains?.length);
}

/**
 * OSINT 收集器：调用 maigret/sherlock/spiderfoot 微服务，按候选人本人提供的标识收集公开足迹。
 * 严格前提：调用方（service 层）必须已校验候选人书面授权；本类不负责 consent，但未配置服务或失败时安全降级。
 */
export class OsintCollector {
  constructor(
    private readonly config: OsintServiceConfig,
    private readonly logger?: Logger,
  ) {}

  get configured(): boolean {
    return Boolean(this.config.url);
  }

  async collect(handles: OsintHandles): Promise<OsintReport> {
    if (!this.config.url) {
      return {
        available: false,
        tools: [],
        accounts: [],
        notes: [
          '未配置 OSINT 收集服务（OSINT_SERVICE_URL），仅返回授权核验计划，未做公开信息收集。',
        ],
      };
    }
    if (!hasAnyHandle(handles)) {
      return {
        available: false,
        tools: [],
        accounts: [],
        notes: ['未提供任何候选人标识（用户名/邮箱/手机号/域名），无法收集。'],
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const resp = await fetch(`${this.config.url}/collect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(handles),
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`OSINT 服务返回 ${resp.status}`);
      const data = responseSchema.parse(await resp.json());
      return {
        available: true,
        tools: data.tools,
        accounts: data.accounts,
        notes: data.notes,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.error({ err: msg }, '调用 OSINT 服务失败');
      return {
        available: false,
        tools: [],
        accounts: [],
        notes: [`OSINT 收集服务调用失败：${msg}`],
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
