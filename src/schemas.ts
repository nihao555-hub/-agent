import { z } from 'zod';
import {
  RECALL_SEGMENTS,
  REVIEW_CHANNELS,
  SHOP_CATEGORIES,
  SOCIAL_PLATFORMS,
  TONES,
} from './types';

export const shopProfileSchema = z.object({
  name: z.string().min(1, '店名不能为空'),
  category: z.enum(SHOP_CATEGORIES),
  city: z.string().optional(),
  address: z.string().optional(),
  perCapita: z.number().positive().optional(),
  highlights: z.array(z.string()).max(20).optional(),
  targetCustomers: z.string().optional(),
  tone: z.enum(TONES).optional(),
  contact: z.string().optional(),
});

export const reviewSchema = z.object({
  id: z.string().optional(),
  rating: z.number().int().min(1).max(5),
  content: z.string().min(1, '评价内容不能为空'),
  author: z.string().optional(),
  channel: z.enum(REVIEW_CHANNELS).optional(),
  date: z.string().optional(),
});

export const reviewReplyRequestSchema = z.object({
  shop: shopProfileSchema,
  reviews: z.array(reviewSchema).min(1, '至少需要一条评价').max(50),
});

export const recallRequestSchema = z.object({
  shop: shopProfileSchema,
  segments: z.array(z.enum(RECALL_SEGMENTS)).max(10).optional(),
  channel: z.enum(['短信', '微信']).optional(),
});

export const promotionRequestSchema = z.object({
  shop: shopProfileSchema,
  count: z.number().int().min(1).max(5).optional(),
});

export const contentRequestSchema = z.object({
  shop: shopProfileSchema,
  platforms: z.array(z.enum(SOCIAL_PLATFORMS)).max(2).optional(),
  topic: z.string().max(200).optional(),
});

export const analyzeRequestSchema = z.object({
  shop: shopProfileSchema,
  reviews: z.array(reviewSchema).max(50).optional(),
});
