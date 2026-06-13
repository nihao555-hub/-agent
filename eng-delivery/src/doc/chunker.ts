/**
 * 纯文本切片：把一段文本机械地切成可检索/可引用的片段（chunk）。
 * 只做结构性切分（按空行分段、识别条款编号），不做任何领域语义判断。
 * 真正的页码/版式定位由文档解析微服务（MinerU，见 layer C）提供；纯文本场景页码未知。
 */

export interface RawChunk {
  ordinal: number;
  text: string;
  page?: number;
  clause?: string;
}

/** 识别段首的条款编号（点分编号如 3.2.1，或「第N条」），用作引用定位。纯结构识别，非领域规则。 */
function detectClause(text: string): string | undefined {
  const dotted = text.match(/^\s*(\d+(?:\.\d+){1,})/);
  if (dotted) return dotted[1];
  const article = text.match(/^\s*(第\s*[0-9一二三四五六七八九十百零]+\s*条)/);
  if (article) return article[1].replace(/\s+/g, '');
  return undefined;
}

export interface ChunkOptions {
  /** 超过该长度的段落会被进一步按句切分，避免单片过大影响检索/引用粒度。 */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 1200;

function splitLongParagraph(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  // 按中英文句末标点切句，再贪心合并到 maxChars 以内。
  const sentences = text.split(/(?<=[。！？；!?;])\s*/).filter((s) => s.trim().length > 0);
  const out: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (buf.length + s.length > maxChars && buf.length > 0) {
      out.push(buf.trim());
      buf = '';
    }
    buf += s;
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out.length > 0 ? out : [text];
}

/** 把纯文本切成片段。按空行分段；过长段落再按句切分。 */
export function chunkText(text: string, options: ChunkOptions = {}): RawChunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const chunks: RawChunk[] = [];
  let ordinal = 0;
  for (const para of paragraphs) {
    const clause = detectClause(para);
    for (const piece of splitLongParagraph(para, maxChars)) {
      chunks.push({ ordinal, text: piece, clause });
      ordinal += 1;
    }
  }
  // 整篇没有空行时，至少把全文作为一个片段返回。
  if (chunks.length === 0 && text.trim().length > 0) {
    chunks.push({ ordinal: 0, text: text.trim(), clause: detectClause(text) });
  }
  return chunks;
}
