import { describe, expect, it } from 'vitest';
import {
  evaluateHardFilter,
  highestEducationOf,
  normalizeEducationLevel,
  skillFoundIn,
  spanMonths,
  totalYearsOf,
} from '../src/engine/hardFilter';
import type { JobPosting, ResumeProfile } from '../src/types';

function resume(p: Partial<ResumeProfile> = {}): ResumeProfile {
  return { education: [], workExperience: [], ...p };
}

describe('normalizeEducationLevel', () => {
  it('识别各类学历表述', () => {
    expect(normalizeEducationLevel('硕士研究生')).toBe('硕士');
    expect(normalizeEducationLevel('全日制本科')).toBe('本科');
    expect(normalizeEducationLevel('Bachelor of Science')).toBe('本科');
    expect(normalizeEducationLevel('大专')).toBe('大专');
    expect(normalizeEducationLevel('PhD')).toBe('博士');
    expect(normalizeEducationLevel('随便写写')).toBeUndefined();
  });
});

describe('spanMonths / totalYearsOf', () => {
  it('计算一段经历的月数', () => {
    expect(spanMonths('2018.01', '2020.01')).toBe(24);
    expect(spanMonths('2020-03', '2020-03')).toBe(0);
  });
  it('累计工作年限优先显式字段', () => {
    expect(totalYearsOf(resume({ totalYears: 6 }))).toBe(6);
  });
  it('无显式字段时按各段求和', () => {
    const r = resume({
      workExperience: [
        { companyName: 'A', startDate: '2018.01', endDate: '2020.01' },
        { companyName: 'B', startDate: '2020.01', endDate: '2022.01' },
      ],
    });
    expect(totalYearsOf(r)).toBe(4);
  });
});

describe('highestEducationOf', () => {
  it('从教育经历推导最高学历', () => {
    const r = resume({
      education: [
        { school: '某专科', degreeLevel: '大专' },
        { school: '某大学', degreeLevel: '本科' },
      ],
    });
    expect(highestEducationOf(r)).toBe('本科');
  });
});

describe('skillFoundIn', () => {
  it('在技能/正文/经历中检索关键词（不区分大小写）', () => {
    const r = resume({ skills: ['Node.js', 'TypeScript'], rawText: '熟悉 PostgreSQL' });
    expect(skillFoundIn(r, 'typescript')).toBe(true);
    expect(skillFoundIn(r, 'postgresql')).toBe(true);
    expect(skillFoundIn(r, 'Rust')).toBe(false);
  });
});

describe('evaluateHardFilter', () => {
  const job: JobPosting = {
    title: '后端工程师',
    minEducation: '本科',
    minYears: 3,
    requiredSkills: ['Node.js'],
    locations: ['上海'],
  };

  it('全部满足时通过', () => {
    const r = resume({
      highestEducation: '本科',
      totalYears: 5,
      skills: ['Node.js'],
      currentLocation: '上海',
    });
    const res = evaluateHardFilter(job, r);
    expect(res.passed).toBe(true);
    expect(res.checks).toHaveLength(4);
  });

  it('学历不达标时不通过', () => {
    const r = resume({
      highestEducation: '大专',
      totalYears: 5,
      skills: ['Node.js'],
      currentLocation: '上海',
    });
    expect(evaluateHardFilter(job, r).passed).toBe(false);
  });

  it('无法核实的必备条件保守判为不通过', () => {
    const r = resume({ highestEducation: '本科', totalYears: 5, skills: ['Node.js'] });
    const res = evaluateHardFilter(job, r);
    // 缺少地点信息 → 需人工确认 → 不通过
    expect(res.passed).toBe(false);
    expect(res.checks.find((c) => c.label.includes('工作地点'))?.detail).toContain('需人工确认');
  });
});
