/**
 * 领域类型定义：AI 店小二
 * 面向长尾实体小店（餐饮/美业/零售/生活服务）的口碑与复购自动化。
 */

export const SHOP_CATEGORIES = [
  '餐饮',
  '咖啡饮品',
  '烘焙甜品',
  '美业丽人',
  '健身运动',
  '零售',
  '教育培训',
  '休闲娱乐',
  '医疗健康',
  '酒店民宿',
  '其他',
] as const;
export type ShopCategory = (typeof SHOP_CATEGORIES)[number];

export const TONES = ['亲切', '专业', '活泼', '简洁'] as const;
export type Tone = (typeof TONES)[number];

export interface ShopProfile {
  /** 店名 */
  name: string;
  /** 业态分类 */
  category: ShopCategory;
  /** 城市 */
  city?: string;
  /** 地址/商圈 */
  address?: string;
  /** 人均消费(元) */
  perCapita?: number;
  /** 招牌/卖点 */
  highlights?: string[];
  /** 目标客群描述 */
  targetCustomers?: string;
  /** 语气风格 */
  tone?: Tone;
  /** 联系方式/微信/小程序，用于召回与引流话术中的 CTA */
  contact?: string;
}

export const REVIEW_CHANNELS = ['大众点评', '美团', '抖音', '小红书', '高德', '其他'] as const;
export type ReviewChannel = (typeof REVIEW_CHANNELS)[number];

export type Sentiment = 'positive' | 'neutral' | 'negative';

export interface Review {
  /** 业务方可选传入的评价 id；缺省时由服务端按序号补齐 */
  id?: string;
  /** 星级 1..5 */
  rating: number;
  /** 评价正文 */
  content: string;
  /** 顾客昵称 */
  author?: string;
  /** 来源渠道 */
  channel?: ReviewChannel;
  /** 评价时间(任意字符串) */
  date?: string;
}

export interface ReviewReply {
  reviewId: string;
  rating: number;
  sentiment: Sentiment;
  /** 面向顾客的公开回复文案 */
  reply: string;
  /** 给店主的内部跟进建议 */
  actions: string[];
}

export const RECALL_SEGMENTS = ['lapsed', 'sleeping', 'new_to_repeat', 'birthday', 'vip'] as const;
export type RecallSegmentKey = (typeof RECALL_SEGMENTS)[number];

export type RecallChannel = '短信' | '微信';

export interface RecallScript {
  segment: RecallSegmentKey;
  segmentLabel: string;
  channel: RecallChannel;
  /** 召回文案 */
  message: string;
  /** 建议发送时机 */
  bestSendTime: string;
  /** 建议搭配的优惠钩子 */
  offer?: string;
}

export interface PromotionPackage {
  /** 套餐名 */
  name: string;
  /** 套餐包含项 */
  items: string[];
  /** 原价(元) */
  originalPrice: number;
  /** 团购价(元) */
  dealPrice: number;
  /** 折扣(0-1)，0.78 表示约 7.8 折 */
  discount: number;
  /** 适用场景 */
  targetScenario: string;
  /** 定价逻辑说明 */
  rationale: string;
}

export const SOCIAL_PLATFORMS = ['小红书', '抖音'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export interface SocialContent {
  platform: SocialPlatform;
  /** 标题/钩子 */
  title: string;
  /** 正文 */
  body: string;
  /** 话题标签(不含 # 号) */
  hashtags: string[];
  /** 拍摄/发布建议 */
  tips?: string;
}
