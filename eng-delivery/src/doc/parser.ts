import { z } from 'zod';
import type { DocServiceConfig } from '../config';
import { HttpError } from '../errors';
import type { Logger } from '../logger';

export type DocSource = 'text' | 'doc-service';

export interface ExtractInput {
  /** 直接提交的纯文本（离线可用）。 */
  text?: string;
  /** 上传的文件（PDF/Word/扫描件），base64 编码；需配置 DOC_SERVICE_URL。 */
  fileBase64?: string;
  fileName?: string;
}

export interface ExtractOutput {
  source: DocSource;
  text: string;
}

/** 文档解析微服务（如 MinerU）返回的宽松结构，取出可用的文本字段。 */
const docServiceSchema = z.object({
  error: z.string().optional(),
  text: z.string().optional(),
  markdown: z.string().optional(),
  content: z.string().optional(),
});

/**
 * 招标文件文本提取器。
 * - 纯文本：直接透传（无需任何服务，离线可测）。
 * - 文件（PDF/Word/扫描件）：转发到 MinerU 风格的解析微服务（需配 DOC_SERVICE_URL）；
 *   未配置时给出明确 503，提示改用 text 字段或部署解析服务。
 *
 * 注意：本模块只负责「把文件变成文本」，把文本结构化成招标要点是引擎(parseTender)的职责。
 */
export class TenderDocParser {
  constructor(
    private readonly config: DocServiceConfig,
    private readonly logger?: Logger,
  ) {}

  async extract(input: ExtractInput): Promise<ExtractOutput> {
    if (input.text && input.text.trim()) {
      return { source: 'text', text: input.text };
    }
    if (input.fileBase64) {
      const text = await this.extractFile(input.fileBase64, input.fileName ?? 'tender.pdf');
      return { source: 'doc-service', text };
    }
    throw new HttpError(400, '请提供 text（招标文件纯文本）或 fileBase64（PDF/Word 文件）之一');
  }

  private async extractFile(fileBase64: string, fileName: string): Promise<string> {
    if (!this.config.url) {
      throw new HttpError(
        503,
        '未配置文档解析服务（DOC_SERVICE_URL），无法解析文件。请先部署解析微服务（如 MinerU），或改用 text 字段提交招标文件纯文本。',
      );
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(fileBase64, 'base64');
    } catch {
      throw new HttpError(400, 'fileBase64 不是合法的 base64 字符串');
    }
    const form = new FormData();
    form.append('file', new Blob([buffer]), fileName);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const resp = await fetch(`${this.config.url}/parse`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`文档解析服务返回 ${resp.status}`);
      const raw = docServiceSchema.parse(await resp.json());
      if (raw.error) throw new Error(`文档解析失败：${raw.error}`);
      const text = (raw.text ?? raw.markdown ?? raw.content ?? '').trim();
      if (!text) throw new Error('文档解析服务未返回可用文本');
      return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.error({ err: msg }, '调用文档解析服务失败');
      throw new HttpError(502, `文档解析服务不可用：${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
