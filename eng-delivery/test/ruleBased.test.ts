import { describe, expect, it } from 'vitest';
import { RuleBasedEngine } from '../src/engine/ruleBased';
import type { CapabilityProfile, TenderSpec } from '../src/types';

const engine = new RuleBasedEngine();

const TENDER_TEXT = [
  '投标人须具备市政公用工程施工总承包二级及以上资质。',
  '投标人应提供近三年类似工程业绩。',
  '本项目评审采用综合评分法，技术分满分40分。',
  '投标截止时间为2025年7月1日9:30。',
  '未按要求提交投标保证金的按废标处理。',
].join('');

describe('RuleBasedEngine', () => {
  it('name 为 rule-based', () => {
    expect(engine.name).toBe('rule-based');
  });

  it('parseTender 机械抽取要求/废标/节点/评分', async () => {
    const spec = await engine.parseTender({ text: TENDER_TEXT });
    expect(spec.requirements.length).toBeGreaterThan(0);
    expect(spec.disqualifications.length).toBeGreaterThan(0);
    expect(spec.milestones.length).toBeGreaterThan(0);
    expect(spec.scoringItems.length).toBeGreaterThan(0);
    // 要求编号稳定
    expect(spec.requirements[0].id).toBe('R1');
    expect(spec.summary).toContain('规则');
  });

  it('detectGaps 无我方资料时一律「需人工确认」', async () => {
    const tender: TenderSpec = {
      requirements: [{ id: 'R1', category: '资质', text: '需要二级资质', mandatory: true }],
      scoringItems: [],
      disqualifications: [],
      milestones: [],
    };
    const cap: CapabilityProfile = {};
    const report = await engine.detectGaps({ tender, capability: cap });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].coverage).toBe('需人工确认');
  });

  it('detectGaps 有相似能力时判为已/部分覆盖', async () => {
    const tender: TenderSpec = {
      requirements: [
        { id: 'R1', category: '资质', text: '市政公用工程施工总承包二级资质', mandatory: true },
      ],
      scoringItems: [],
      disqualifications: [],
      milestones: [],
    };
    const cap: CapabilityProfile = {
      qualifications: ['市政公用工程施工总承包一级资质'],
    };
    const report = await engine.detectGaps({ tender, capability: cap });
    expect(report.findings[0].coverage).not.toBe('需人工确认');
    expect(report.readiness).toBeGreaterThanOrEqual(0);
    expect(report.readiness).toBeLessThanOrEqual(100);
  });

  it('checkCompliance 把废标项与强制要求列为需人工确认', async () => {
    const tender: TenderSpec = {
      requirements: [{ id: 'R1', category: '资质', text: '强制项', mandatory: true }],
      scoringItems: [],
      disqualifications: [{ text: '未交保证金按废标处理' }],
      milestones: [],
    };
    const report = await engine.checkCompliance({ tender });
    expect(report.findings.length).toBe(2);
    expect(report.findings.every((f) => f.status === '需人工确认')).toBe(true);
    expect(report.disqualificationRisks).toHaveLength(1);
  });
});
