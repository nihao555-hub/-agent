import { describe, expect, it } from 'vitest';
import { bestMatch, similarity } from '../src/utils/textMatch';

describe('textMatch 文本相似度工具', () => {
  it('相同文本相似度为 1，无关文本接近 0', () => {
    expect(similarity('市政公用工程', '市政公用工程')).toBe(1);
    expect(similarity('市政公用工程', 'abcdef')).toBe(0);
  });

  it('空输入返回 0', () => {
    expect(similarity('', 'x')).toBe(0);
    expect(similarity('x', '')).toBe(0);
  });

  it('相似文本相似度在 0~1 之间', () => {
    const s = similarity('市政公用工程施工总承包二级', '市政公用工程施工总承包一级');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  it('bestMatch 返回最相似候选', () => {
    const { text, score } = bestMatch('二级资质', ['一级资质要求', '无关内容', '二级资质证书']);
    expect(text).toBe('二级资质证书');
    expect(score).toBeGreaterThan(0);
  });

  it('bestMatch 候选为空返回零分', () => {
    expect(bestMatch('x', [])).toEqual({ text: '', score: 0 });
  });
});
