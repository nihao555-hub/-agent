import { describe, expect, it } from 'vitest';
import { RuleBasedEngine } from '../src/engine/ruleBased';
import type { JobPosting, ResumeProfile } from '../src/types';

const engine = new RuleBasedEngine();

const job: JobPosting = {
  title: '后端工程师',
  company: '某科技',
  minEducation: '本科',
  minYears: 3,
  requiredSkills: ['Node.js', 'TypeScript'],
  preferredSkills: ['Kubernetes'],
  locations: ['上海'],
};

function resume(p: Partial<ResumeProfile> = {}): ResumeProfile {
  return { education: [], workExperience: [], ...p };
}

describe('RuleBasedEngine.parseJob', () => {
  it('从 JD 文本抽取学历与年限', async () => {
    const jp = await engine.parseJob({
      description: '岗位职责：负责后端开发。任职要求：本科及以上，3年以上工作经验，熟悉 Node.js。',
      title: '后端工程师',
      city: '上海',
    });
    expect(jp.minEducation).toBe('本科');
    expect(jp.minYears).toBe(3);
    expect(jp.locations).toEqual(['上海']);
  });
});

describe('RuleBasedEngine.scoreCandidate', () => {
  it('优秀匹配候选人 → advance，硬性条件全通过', async () => {
    const r = resume({
      name: '张三',
      highestEducation: '本科',
      currentLocation: '上海',
      skills: ['Node.js', 'TypeScript', 'Kubernetes'],
      workExperience: [
        { companyName: 'A', position: '后端工程师', startDate: '2017.07', endDate: '2021.07' },
        { companyName: 'B', position: '高级后端工程师', startDate: '2021.07', endDate: '至今' },
      ],
    });
    const res = await engine.scoreCandidate({ job, resume: r });
    expect(res.hardFilter.passed).toBe(true);
    expect(res.dimensions).toHaveLength(5);
    expect(res.matchScore).toBeGreaterThanOrEqual(72);
    expect(res.recommendation).toBe('advance');
    expect(res.candidateName).toBe('张三');
  });

  it('硬性条件不通过 → reject 且分数被压到 ≤45', async () => {
    const r = resume({ highestEducation: '大专', currentLocation: '北京', skills: [] });
    const res = await engine.scoreCandidate({ job, resume: r });
    expect(res.hardFilter.passed).toBe(false);
    expect(res.matchScore).toBeLessThanOrEqual(45);
    expect(res.recommendation).toBe('reject');
  });

  it('频繁跳槽触发风险点', async () => {
    const r = resume({
      highestEducation: '本科',
      currentLocation: '上海',
      skills: ['Node.js', 'TypeScript'],
      workExperience: [
        { companyName: 'A', startDate: '2021.01', endDate: '2021.08' },
        { companyName: 'B', startDate: '2021.09', endDate: '2022.04' },
        { companyName: 'C', startDate: '2022.05', endDate: '2022.12' },
      ],
    });
    const res = await engine.scoreCandidate({ job, resume: r });
    expect(res.risks.some((x) => x.type === '跳槽频繁')).toBe(true);
  });
});

describe('RuleBasedEngine.outreach', () => {
  it('按渠道生成话术', async () => {
    const res = await engine.outreach({ job, resume: resume({ name: '李四' }), channel: '短信' });
    expect(res.channel).toBe('短信');
    expect(res.message).toContain('李四');
    expect(res.screeningQuestions.length).toBeGreaterThan(0);
  });
});

describe('RuleBasedEngine.backgroundProfile', () => {
  it('已核实信息 → 低风险', async () => {
    const res = await engine.backgroundProfile({
      resume: resume({ name: '王五' }),
      findings: [
        { category: '学历核验', source: '学信网', result: '学历信息一致，本科已核实' },
        { category: '任职经历', source: '原雇主', result: '任职时间与职位一致' },
      ],
    });
    expect(res.riskLevel).toBe('low');
    expect(res.verifiedItems).toHaveLength(2);
  });

  it('命中失信/虚假关键词 → 高风险', async () => {
    const res = await engine.backgroundProfile({
      resume: resume({ name: '赵六' }),
      findings: [
        { category: '司法与失信', source: '执行信息公开网', result: '存在失信被执行人记录' },
      ],
    });
    expect(res.riskLevel).toBe('high');
  });

  it('OSINT 线索计入摘要但不下结论', async () => {
    const res = await engine.backgroundProfile({
      resume: resume({ name: '钱七' }),
      findings: [{ category: '学历核验', source: '学信网', result: '学历一致' }],
      osintAccounts: [{ tool: 'maigret', site: 'GitHub', url: 'https://github.com/x' }],
    });
    expect(res.summary).toContain('公开足迹线索');
  });
});
