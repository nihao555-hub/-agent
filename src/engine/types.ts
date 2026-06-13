import type {
  PromotionPackage,
  RecallChannel,
  RecallScript,
  RecallSegmentKey,
  Review,
  ReviewReply,
  ShopProfile,
  SocialContent,
  SocialPlatform,
} from '../types';

export interface ReviewReplyRequest {
  shop: ShopProfile;
  reviews: Review[];
}
export interface ReviewReplyResult {
  replies: ReviewReply[];
}

export interface RecallRequest {
  shop: ShopProfile;
  segments?: RecallSegmentKey[];
  channel?: RecallChannel;
}
export interface RecallResult {
  scripts: RecallScript[];
}

export interface PromotionRequest {
  shop: ShopProfile;
  /** 期望生成的套餐数量，默认 3 */
  count?: number;
}
export interface PromotionResult {
  packages: PromotionPackage[];
}

export interface ContentRequest {
  shop: ShopProfile;
  platforms?: SocialPlatform[];
  /** 本次内容的主题/活动，可选 */
  topic?: string;
}
export interface ContentResult {
  posts: SocialContent[];
}

export interface AnalyzeRequest {
  shop: ShopProfile;
  reviews?: Review[];
}
export interface AnalyzeResult {
  replies: ReviewReply[];
  recall: RecallScript[];
  promotions: PromotionPackage[];
  content: SocialContent[];
}

/**
 * 内容生成引擎抽象。
 * 两种实现：RuleBasedEngine（确定性、无需联网）与 LlmEngine（接大模型，失败自动回退）。
 */
export interface ContentEngine {
  /** 引擎标识，便于在响应里标注本次结果由谁生成 */
  readonly name: string;
  reviewReplies(req: ReviewReplyRequest): Promise<ReviewReplyResult>;
  recall(req: RecallRequest): Promise<RecallResult>;
  promotions(req: PromotionRequest): Promise<PromotionResult>;
  socialContent(req: ContentRequest): Promise<ContentResult>;
}
