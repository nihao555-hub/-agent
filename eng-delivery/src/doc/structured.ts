import type { DocServiceConfig } from '../config';
import { HttpError } from '../errors';
import type { Logger } from '../logger';
import { chunkBlocks, chunkText, type RawChunk, type StructuredBlock } from './chunker';

export type DocSource = 'text' | 'mineru';

export interface AnalyzeInput {
  text?: string;
  fileBase64?: string;
  fileName?: string;
  maxChars?: number;
}

export interface AnalyzeResult {
  source: DocSource;
  chunks: RawChunk[];
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 从一个块对象里取文本（兼容 text/content/markdown）。 */
function blockText(item: Record<string, unknown>): string | undefined {
  return asString(item.text) ?? asString(item.content) ?? asString(item.markdown);
}

/** 从一个块/页对象里取页码（兼容 page/page_idx/page_number/index，0-based 时 +1）。 */
function blockPage(item: Record<string, unknown>): number | undefined {
  const oneBased = asNumber(item.page) ?? asNumber(item.page_number);
  if (oneBased != null) return oneBased;
  const zeroBased = asNumber(item.page_idx) ?? asNumber(item.index);
  return zeroBased != null ? zeroBased + 1 : undefined;
}

function toBlock(item: unknown, fallbackPage?: number): StructuredBlock | undefined {
  if (!isRecord(item)) {
    const text = asString(item);
    return text ? { text, page: fallbackPage } : undefined;
  }
  const text = blockText(item);
  if (!text) return undefined;
  return { text, page: blockPage(item) ?? fallbackPage, clause: asString(item.clause) };
}

/**
 * 把 MinerU 风格的宽松解析结果归一化为带页码/条款的结构块。纯函数，便于离线测试。
 * 兼容多种返回形态：
 * - 顶层数组：[{text,page,clause}, ...]
 * - { blocks: [...] }
 * - { pages: [{ page/page_idx, text|markdown|content | blocks:[...] }] }
 * - { markdown|content|text: "..." }（无版面信息时退化为按空行切分）
 */
export function normalizeDocPayload(payload: unknown): StructuredBlock[] {
  if (Array.isArray(payload)) {
    return payload.map((b) => toBlock(b)).filter((b): b is StructuredBlock => Boolean(b));
  }
  if (!isRecord(payload)) return [];

  if (Array.isArray(payload.blocks)) {
    return payload.blocks.map((b) => toBlock(b)).filter((b): b is StructuredBlock => Boolean(b));
  }

  if (Array.isArray(payload.pages)) {
    const out: StructuredBlock[] = [];
    for (const page of payload.pages) {
      if (!isRecord(page)) continue;
      const pageNo = blockPage(page);
      if (Array.isArray(page.blocks)) {
        for (const b of page.blocks) {
          const block = toBlock(b, pageNo);
          if (block) out.push(block);
        }
      } else {
        const text = blockText(page);
        if (text) out.push({ text, page: pageNo, clause: asString(page.clause) });
      }
    }
    return out;
  }

  const flat = asString(payload.markdown) ?? asString(payload.content) ?? asString(payload.text);
  if (flat) return chunkText(flat).map((c) => ({ text: c.text, clause: c.clause }));
  return [];
}

/**
 * 文档理解：把文档变成带页码/条款定位的可引用片段（layer C）。
 * - 纯文本：本地按结构切分（离线可用，页码未知）。
 * - 文件（PDF/图纸/扫描件）：转发到 MinerU 风格解析微服务，保留版面页码/条款。
 *   未配 DOC_SERVICE_URL 时对文件给出明确 503，提示改用 text 或部署解析服务。
 */
export class DocAnalyzer {
  constructor(
    private readonly config: DocServiceConfig,
    private readonly logger?: Logger,
  ) {}

  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    if (input.text && input.text.trim()) {
      return { source: 'text', chunks: chunkText(input.text, { maxChars: input.maxChars }) };
    }
    if (input.fileBase64) {
      const blocks = await this.parseFile(input.fileBase64, input.fileName ?? 'document.pdf');
      return { source: 'mineru', chunks: chunkBlocks(blocks, { maxChars: input.maxChars }) };
    }
    throw new HttpError(400, '请提供 text（文档纯文本）或 fileBase64（PDF/Word/图纸文件）之一');
  }

  private async parseFile(fileBase64: string, fileName: string): Promise<StructuredBlock[]> {
    if (!this.config.url) {
      throw new HttpError(
        503,
        '未配置文档解析服务（DOC_SERVICE_URL），无法解析文件。请先部署解析微服务（如 MinerU），或改用 text 字段提交纯文本。',
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
      const json: unknown = await resp.json();
      if (isRecord(json) && asString(json.error)) throw new Error(`文档解析失败：${String(json.error)}`);
      const blocks = normalizeDocPayload(json);
      if (blocks.length === 0) throw new Error('文档解析服务未返回可用内容');
      return blocks;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.error({ err: msg }, '调用文档解析服务失败');
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `文档解析服务不可用：${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
