import { describe, expect, it } from 'vitest';
import { DocAnalyzer, normalizeDocPayload } from '../src/doc/structured';

describe('normalizeDocPayload 文档解析结果归一化（纯函数）', () => {
  it('顶层数组：保留页码/条款', () => {
    const blocks = normalizeDocPayload([
      { text: '第一段', page: 1, clause: '3.1' },
      { content: '第二段', page: 2 },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ text: '第一段', page: 1, clause: '3.1' });
    expect(blocks[1]).toMatchObject({ text: '第二段', page: 2 });
  });

  it('{pages:[{page_idx, blocks}]}：0-based 页码转 1-based 并下传到块', () => {
    const blocks = normalizeDocPayload({
      pages: [{ page_idx: 0, blocks: [{ text: 'A' }, { text: 'B' }] }],
    });
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.page === 1)).toBe(true);
  });

  it('{pages:[{page, markdown}]}：整页文本归一化', () => {
    const blocks = normalizeDocPayload({ pages: [{ page: 5, markdown: '本页内容' }] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ text: '本页内容', page: 5 });
  });

  it('{markdown}：无版面信息时按空行退化切分', () => {
    const blocks = normalizeDocPayload({ markdown: '第一段\n\n第二段' });
    expect(blocks).toHaveLength(2);
    expect(blocks[0].page).toBeUndefined();
  });

  it('非法/空输入返回空数组', () => {
    expect(normalizeDocPayload(null)).toEqual([]);
    expect(normalizeDocPayload({})).toEqual([]);
  });
});

describe('DocAnalyzer 文档理解', () => {
  it('纯文本：本地切片，source=text，识别条款号', async () => {
    const analyzer = new DocAnalyzer({ timeoutMs: 1000 });
    const result = await analyzer.analyze({ text: '3.1 投标人须具备相应资质。\n\n3.2 应提供业绩证明。' });
    expect(result.source).toBe('text');
    expect(result.chunks.length).toBe(2);
    expect(result.chunks[0].clause).toBe('3.1');
  });

  it('提交文件但未配 DOC_SERVICE_URL → 503', async () => {
    const analyzer = new DocAnalyzer({ timeoutMs: 1000 });
    await expect(analyzer.analyze({ fileBase64: 'AAAA', fileName: 'a.pdf' })).rejects.toMatchObject({
      status: 503,
    });
  });

  it('既无 text 也无文件 → 400', async () => {
    const analyzer = new DocAnalyzer({ timeoutMs: 1000 });
    await expect(analyzer.analyze({})).rejects.toMatchObject({ status: 400 });
  });
});
