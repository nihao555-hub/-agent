/**
 * 向量基础运算。用于带引用的语义检索（layer B）。
 */

/** 余弦相似度。维度不一致时返回 0（例如 embedding 模型在不同会话间切换）。 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** L2 归一化，返回新数组；零向量原样返回。 */
export function l2normalize(v: readonly number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return [...v];
  return v.map((x) => x / norm);
}
