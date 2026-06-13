import {
  EDUCATION_LEVELS,
  type EducationLevel,
  type HardCheck,
  type HardFilterResult,
  type JobPosting,
  type ResumeProfile,
} from '../types';

/** 把任意学历文本归一化到标准学历层级。 */
export function normalizeEducationLevel(raw?: string): EducationLevel | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  if (/(博士|phd|doctor|d\.?phil)/i.test(s)) return '博士';
  if (/(硕士|研究生|master|mba|emba|m\.?s|m\.?eng)/i.test(s)) return '硕士';
  if (/(本科|学士|bachelor|b\.?s|b\.?eng|本科生|大学本科)/i.test(s)) return '本科';
  if (/(大专|专科|高职|associate|college diploma)/i.test(s)) return '大专';
  if (/(高中|中专|技校|职高|初中|high school|secondary)/i.test(s)) return '高中及以下';
  return undefined;
}

export function educationRank(level?: EducationLevel): number {
  if (!level) return -1;
  return EDUCATION_LEVELS.indexOf(level);
}

/** 取简历最高学历：优先显式字段，否则从教育经历推导。 */
export function highestEducationOf(resume: ResumeProfile): EducationLevel | undefined {
  if (resume.highestEducation) return resume.highestEducation;
  let best: EducationLevel | undefined;
  for (const edu of resume.education) {
    const level = normalizeEducationLevel(edu.degreeLevel);
    if (level && educationRank(level) > educationRank(best)) best = level;
  }
  return best;
}

interface YearMonth {
  year: number;
  month: number;
}

/** 解析简历里的起止日期：返回年月、或 'present'(至今)、或 undefined。 */
export function parseYearMonth(s?: string): YearMonth | 'present' | undefined {
  if (!s) return undefined;
  if (/(至今|现在|now|present|在职|今)/i.test(s)) return 'present';
  const ym = s.match(/(\d{4})\s*[年./\-\s]?\s*(\d{1,2})?/);
  if (!ym) return undefined;
  const year = Number(ym[1]);
  const month = ym[2] ? Math.min(12, Math.max(1, Number(ym[2]))) : 1;
  if (!Number.isFinite(year) || year < 1950 || year > 2100) return undefined;
  return { year, month };
}

function toMonths(ym: YearMonth): number {
  return ym.year * 12 + (ym.month - 1);
}

function nowMonths(): number {
  const d = new Date();
  return d.getFullYear() * 12 + d.getMonth();
}

/** 计算一段经历的月数（含 'present'）。无法解析则返回 undefined。 */
export function spanMonths(start?: string, end?: string): number | undefined {
  const a = parseYearMonth(start);
  if (!a || a === 'present') return undefined;
  const b = parseYearMonth(end);
  const endM = b === 'present' || b === undefined ? nowMonths() : toMonths(b);
  const months = endM - toMonths(a);
  return months >= 0 ? months : undefined;
}

/** 累计工作年限：优先显式字段，否则按各段工作时长求和（保留 1 位小数）。 */
export function totalYearsOf(resume: ResumeProfile): number | undefined {
  if (typeof resume.totalYears === 'number') return resume.totalYears;
  let months = 0;
  let counted = 0;
  for (const w of resume.workExperience) {
    const m = spanMonths(w.startDate, w.endDate);
    if (typeof m === 'number') {
      months += m;
      counted += 1;
    }
  }
  if (counted === 0) return undefined;
  return Math.round((months / 12) * 10) / 10;
}

/** 平均在职时长（月）。无法计算时返回 undefined。 */
export function avgTenureMonths(resume: ResumeProfile): number | undefined {
  let months = 0;
  let counted = 0;
  for (const w of resume.workExperience) {
    const m = spanMonths(w.startDate, w.endDate);
    if (typeof m === 'number') {
      months += m;
      counted += 1;
    }
  }
  if (counted === 0) return undefined;
  return Math.round(months / counted);
}

/** 在简历的技能/正文/经历描述中检索某个关键词（不区分大小写）。 */
export function skillFoundIn(resume: ResumeProfile, skill: string): boolean {
  const needle = skill.trim().toLowerCase();
  if (!needle) return false;
  const haystack = [
    (resume.skills ?? []).join(' '),
    resume.rawText ?? '',
    resume.selfEvaluation ?? '',
    ...resume.workExperience.map((w) => `${w.position ?? ''} ${w.description ?? ''}`),
    ...resume.education.map((e) => `${e.major ?? ''} ${e.description ?? ''}`),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

function candidateLocations(resume: ResumeProfile): string[] {
  return [resume.currentLocation ?? '', ...(resume.desiredLocations ?? [])].filter(Boolean);
}

/** 地点匹配：任一候选人地点与任一岗位地点互为包含即视为匹配。 */
function locationMatches(jobLocations: string[], resume: ResumeProfile): boolean {
  const cand = candidateLocations(resume);
  if (cand.length === 0) return false;
  return jobLocations.some((jl) =>
    cand.some((cl) => jl && cl && (jl.includes(cl) || cl.includes(jl))),
  );
}

/**
 * 确定性硬性条件过滤：学历 / 工作年限 / 工作地点 / 必备技能。
 * 仅对 JD 中明确给出的硬性条件做检查；无法从简历核实的必备条件会判为「不通过-需人工确认」（保守）。
 */
export function evaluateHardFilter(job: JobPosting, resume: ResumeProfile): HardFilterResult {
  const checks: HardCheck[] = [];

  if (job.minEducation) {
    const highest = highestEducationOf(resume);
    if (!highest) {
      checks.push({
        label: `${job.minEducation}及以上`,
        passed: false,
        detail: '简历未能识别到明确学历，需人工确认',
      });
    } else {
      const passed = educationRank(highest) >= educationRank(job.minEducation);
      checks.push({
        label: `${job.minEducation}及以上`,
        passed,
        detail: passed ? `候选人最高学历：${highest}` : `候选人最高学历仅为 ${highest}，低于要求`,
      });
    }
  }

  if (typeof job.minYears === 'number') {
    const years = totalYearsOf(resume);
    if (years === undefined) {
      checks.push({
        label: `工作经验≥${job.minYears}年`,
        passed: false,
        detail: '简历未能识别到可计算的工作年限，需人工确认',
      });
    } else {
      const passed = years >= job.minYears;
      checks.push({
        label: `工作经验≥${job.minYears}年`,
        passed,
        detail: `候选人累计约 ${years} 年` + (passed ? '' : '，低于要求'),
      });
    }
  }

  if (job.locations && job.locations.length > 0) {
    const passed = locationMatches(job.locations, resume);
    const cand = candidateLocations(resume);
    checks.push({
      label: `工作地点：${job.locations.join('/')}`,
      passed,
      detail:
        cand.length === 0
          ? '简历未提供现居地/期望地点，需人工确认'
          : passed
            ? `匹配（候选人：${cand.join('、')}）`
            : `候选人地点（${cand.join('、')}）与岗位地点不匹配`,
    });
  }

  if (job.requiredSkills && job.requiredSkills.length > 0) {
    const missing = job.requiredSkills.filter((s) => !skillFoundIn(resume, s));
    const passed = missing.length === 0;
    checks.push({
      label: `必备技能：${job.requiredSkills.join('、')}`,
      passed,
      detail: passed ? '必备技能全部具备' : `缺失：${missing.join('、')}`,
    });
  }

  return { passed: checks.every((c) => c.passed), checks };
}
