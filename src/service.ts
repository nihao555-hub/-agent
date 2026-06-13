import type { AnalyzeRequest, AnalyzeResult, ContentEngine } from './engine';

/**
 * 综合分析：一次性产出「差评回复 + 老客召回 + 团购套餐 + 引流内容」四个模块。
 * 顺序执行而非并发，以降低对上游大模型代理的并发压力（高并发时易触发限流）。
 * 引擎内部对单模块失败会自动降级到规则引擎，因此本函数总能返回完整结果。
 */
export async function analyzeShop(
  engine: ContentEngine,
  req: AnalyzeRequest,
): Promise<AnalyzeResult> {
  const replies =
    req.reviews && req.reviews.length > 0
      ? (await engine.reviewReplies({ shop: req.shop, reviews: req.reviews })).replies
      : [];
  const recall = (await engine.recall({ shop: req.shop })).scripts;
  const promotions = (await engine.promotions({ shop: req.shop })).packages;
  const content = (await engine.socialContent({ shop: req.shop })).posts;

  return { replies, recall, promotions, content };
}
