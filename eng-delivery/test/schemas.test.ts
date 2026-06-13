import { describe, expect, it } from 'vitest';
import {
  analyzeRequestSchema,
  capabilityProfileSchema,
  complianceRequestSchema,
  gapRequestSchema,
  parseTenderSchema,
  tenderSpecSchema,
} from '../src/schemas';

describe('请求校验 schemas', () => {
  it('parseTenderSchema 必须含 text 或 fileBase64', () => {
    expect(parseTenderSchema.safeParse({ projectName: 'x' }).success).toBe(false);
    expect(parseTenderSchema.safeParse({ text: '招标文件正文' }).success).toBe(true);
    expect(parseTenderSchema.safeParse({ fileBase64: 'AAAA' }).success).toBe(true);
  });

  it('tenderSpecSchema 数组字段默认空、id/category/mandatory 可省略', () => {
    const parsed = tenderSpecSchema.parse({ requirements: [{ text: '某要求' }] });
    expect(parsed.requirements).toHaveLength(1);
    expect(parsed.scoringItems).toEqual([]);
    expect(parsed.disqualifications).toEqual([]);
    expect(parsed.milestones).toEqual([]);
    // 空 text 被拒绝
    expect(tenderSpecSchema.safeParse({ requirements: [{ text: '' }] }).success).toBe(false);
  });

  it('capabilityProfileSchema 全可选', () => {
    expect(capabilityProfileSchema.safeParse({}).success).toBe(true);
    expect(
      capabilityProfileSchema.safeParse({ companyName: '示例建工', qualifications: ['一级'] })
        .success,
    ).toBe(true);
  });

  it('gapRequestSchema 需要 tender(或id) 且 capability(或id)', () => {
    expect(
      gapRequestSchema.safeParse({ tender: { requirements: [{ text: 'x' }] } }).success,
    ).toBe(false);
    expect(
      gapRequestSchema.safeParse({
        tender: { requirements: [{ text: 'x' }] },
        capability: { companyName: 'a' },
      }).success,
    ).toBe(true);
    expect(gapRequestSchema.safeParse({ tenderId: 't1', capabilityId: 'c1' }).success).toBe(true);
  });

  it('complianceRequestSchema 仅需 tender，capability 可选', () => {
    expect(
      complianceRequestSchema.safeParse({ tender: { requirements: [{ text: 'x' }] } }).success,
    ).toBe(true);
    expect(complianceRequestSchema.safeParse({}).success).toBe(false);
  });

  it('analyzeRequestSchema 必须含 text 或 fileBase64', () => {
    expect(analyzeRequestSchema.safeParse({ capability: {} }).success).toBe(false);
    expect(analyzeRequestSchema.safeParse({ text: '正文' }).success).toBe(true);
  });
});
