import { describe, expect, it } from 'vitest';
import { chunkBlocks, chunkText } from '../src/doc/chunker';

describe('chunkText 纯文本机械切片', () => {
  it('按空行分段并连续编号', () => {
    const chunks = chunkText('第一段内容。\n\n第二段内容。\n\n第三段内容。');
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
    expect(chunks[1].text).toBe('第二段内容。');
  });

  it('识别点分条款编号与「第N条」', () => {
    const chunks = chunkText('3.2.1 投标人须具备二级资质。\n\n第十二条 合同价款支付方式如下。');
    expect(chunks[0].clause).toBe('3.2.1');
    expect(chunks[1].clause).toBe('第十二条');
  });

  it('过长段落按句进一步切分', () => {
    const long = Array.from({ length: 40 }, (_, i) => `这是第${i}句较长的说明文字。`).join('');
    const chunks = chunkText(long, { maxChars: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 120)).toBe(true);
  });

  it('无空行的整篇文本至少返回一个片段', () => {
    const chunks = chunkText('一句话没有空行。');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].ordinal).toBe(0);
  });

  it('空白文本返回空数组', () => {
    expect(chunkText('   \n\n  ')).toHaveLength(0);
  });
});

describe('chunkBlocks 结构化块切片（保留页码/条款）', () => {
  it('保留页码，连续编号，跳过空块', () => {
    const chunks = chunkBlocks([
      { text: '第一页内容', page: 1 },
      { text: '   ', page: 2 },
      { text: '第三页内容', page: 3, clause: '5.1' },
    ]);
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1]);
    expect(chunks[0].page).toBe(1);
    expect(chunks[1]).toMatchObject({ page: 3, clause: '5.1' });
  });

  it('块未给条款时从文本识别，过长块按句切分仍保留页码', () => {
    const long = Array.from({ length: 40 }, (_, i) => `这是第${i}句较长的说明文字。`).join('');
    const chunks = chunkBlocks([{ text: `3.2 ${long}`, page: 7 }], { maxChars: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.page === 7)).toBe(true);
    expect(chunks[0].clause).toBe('3.2');
  });
});
