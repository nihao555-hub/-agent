import { describe, expect, it } from 'vitest';
import { RuleBasedEngine } from '../src/engine/ruleBased';
import { HttpError } from '../src/errors';
import { OsintCollector } from '../src/osint/collector';
import { ResumeParser } from '../src/resume/parser';
import { HrService } from '../src/service';
import type { JobPosting, ResumeProfile } from '../src/types';

function makeService(): HrService {
  const engine = new RuleBasedEngine();
  const parser = new ResumeParser({ timeoutMs: 1000 }); // 无 LLM、无解析服务
  const osint = new OsintCollector({ timeoutMs: 1000 }); // 无 OSINT 服务
  return new HrService(engine, parser, osint);
}

const job: JobPosting = {
  title: '后端工程师',
  minEducation: '本科',
  minYears: 3,
  requiredSkills: ['Node.js'],
  locations: ['上海'],
};

function resume(p: Partial<ResumeProfile> = {}): ResumeProfile {
  return { education: [], workExperience: [], ...p };
}

describe('HrService.buildBackgroundCheckPlan（consent 闸门）', () => {
  it('未授权 → gated，且不产出任何核验事项', () => {
    const svc = makeService();
    const plan = svc.buildBackgroundCheckPlan({ resume: resume(), consentObtained: false });
    expect(plan.gated).toBe(true);
    expect(plan.consentObtained).toBe(false);
    expect(plan.items).toHaveLength(0);
    expect(plan.notice).toContain('授权');
  });

  it('已授权 → 产出合法数据源核验事项与证明人问题', () => {
    const svc = makeService();
    const plan = svc.buildBackgroundCheckPlan({ resume: resume(), job, consentObtained: true });
    expect(plan.gated).toBe(false);
    expect(plan.items.length).toBeGreaterThan(0);
    expect(plan.items.some((i) => i.category === '学历核验')).toBe(true);
    expect(plan.refereeQuestions.length).toBeGreaterThan(0);
  });
});

describe('HrService.collectOsint（consent 闸门）', () => {
  it('未授权 → 抛 403', async () => {
    const svc = makeService();
    await expect(
      svc.collectOsint({ consentObtained: false, handles: { usernames: ['x'] } }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('已授权但未配置服务 → 安全降级（available=false）', async () => {
    const svc = makeService();
    const report = await svc.collectOsint({ consentObtained: true, handles: { usernames: ['x'] } });
    expect(report.available).toBe(false);
    expect(report.accounts).toHaveLength(0);
  });
});

describe('HrService.batchScore（排序）', () => {
  it('按推荐等级与匹配分排序并标 rank', async () => {
    const svc = makeService();
    const strong = resume({
      name: '强',
      highestEducation: '本科',
      currentLocation: '上海',
      skills: ['Node.js'],
      workExperience: [
        { companyName: 'A', position: '后端工程师', startDate: '2016.01', endDate: '至今' },
      ],
    });
    const weak = resume({ name: '弱', highestEducation: '大专', currentLocation: '北京' });
    const res = await svc.batchScore({ job, candidates: [weak, strong] });
    expect(res.ranked[0].rank).toBe(1);
    expect(res.ranked[0].candidateName).toBe('强');
    expect(res.ranked[1].candidateName).toBe('弱');
  });
});

describe('HrService.parseResume（无服务/无 LLM 兜底）', () => {
  it('纯文本走正则兜底', async () => {
    const out = await svc().parseResume({ text: '姓名：测试\n手机：13800000000\n本科 计算机' });
    expect(out.source).toBe('rule-based');
    expect(out.resume.phone).toBe('13800000000');
    expect(out.resume.highestEducation).toBe('本科');
  });

  it('文件但未配置解析服务 → 503', async () => {
    await expect(
      svc().parseResume({ fileBase64: 'AAAA', fileName: 'a.pdf' }),
    ).rejects.toBeInstanceOf(HttpError);
  });
});

function svc(): HrService {
  return makeService();
}
