/**
 * 极简文本相似度工具，仅供规则引擎做「粗估」比对（非语义理解）。
 * 用字符二元组(bigram)的 Jaccard 相似度，对中文短文本足够稳健且零依赖。
 */

function bigrams(s: string): Set<string> {
  const clean = s.replace(/\s+/g, '');
  const grams = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) {
    grams.add(clean.slice(i, i + 2));
  }
  if (clean.length === 1) grams.add(clean);
  return grams;
}

/** 返回 0~1 的相似度。 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

/** 在候选文本里找与 query 最相似的一条及其相似度。 */
export function bestMatch(query: string, candidates: string[]): { text: string; score: number } {
  let best = { text: '', score: 0 };
  for (const c of candidates) {
    const score = similarity(query, c);
    if (score > best.score) best = { text: c, score };
  }
  return best;
}
