import { describe, expect, it } from 'vitest';
import { HashEmbeddingClient } from '../src/factbase/embeddings';
import { cosineSimilarity, l2normalize } from '../src/utils/vector';

describe('向量基础运算', () => {
  it('cosineSimilarity：同向=1，正交=0，维度不一致=0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('l2normalize：归一化后模为 1；零向量原样返回', () => {
    const v = l2normalize([3, 4]);
    const norm = Math.sqrt(v[0] ** 2 + v[1] ** 2);
    expect(norm).toBeCloseTo(1, 6);
    expect(l2normalize([0, 0])).toEqual([0, 0]);
  });
});

describe('HashEmbeddingClient 确定性哈希向量', () => {
  const client = new HashEmbeddingClient();

  it('确定性：同一文本两次向量完全一致', async () => {
    const [a] = await client.embed(['市政公用工程施工总承包二级资质']);
    const [b] = await client.embed(['市政公用工程施工总承包二级资质']);
    expect(a).toEqual(b);
    expect(a.length).toBe(256);
  });

  it('语义近似：相关文本相似度高于无关文本', async () => {
    const [q] = await client.embed(['类似工程业绩要求']);
    const [related] = await client.embed(['投标人应提供近三年类似工程业绩不少于三项']);
    const [unrelated] = await client.embed(['今天的天气很适合去公园散步']);
    expect(cosineSimilarity(q, related)).toBeGreaterThan(cosineSimilarity(q, unrelated));
  });

  it('空输入返回空数组', async () => {
    expect(await client.embed([])).toEqual([]);
  });
});
