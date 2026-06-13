import {
  type AuthorizedFinding,
  type BackgroundCategory,
  type CandidateProfile,
  type DimensionScore,
  type EducationLevel,
  type JobPosting,
  type OutreachChannel,
  type OutreachScript,
  type Recommendation,
  type ResumeProfile,
  type RiskFlag,
  type ScreeningResult,
  type Severity,
  type VerifiedItem,
  type VerifyStatus,
} from '../types';
import {
  avgTenureMonths,
  educationRank,
  evaluateHardFilter,
  highestEducationOf,
  normalizeEducationLevel,
  skillFoundIn,
  spanMonths,
  totalYearsOf,
} from './hardFilter';
import type {
  BackgroundProfileRequest,
  OutreachRequest,
  ParseJobRequest,
  ScoreRequest,
  ScreeningEngine,
} from './types';

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.map((s) => s.trim()).filter(Boolean))];
}

function titleMatches(job: JobPosting, resume: ResumeProfile): boolean {
  const title = job.title.trim();
  if (!title) return false;
  const hay = [resume.rawText ?? '', ...resume.workExperience.map((w) => w.position ?? '')].join(
    ' ',
  );
  return hay.includes(title);
}

function jobHopCount(resume: ResumeProfile): number {
  return resume.workExperience.filter((w) => w.companyName || w.startDate).length;
}

/** 检测工作经历中的明显空窗期（相邻两段间隔 > 6 个月）。 */
function hasEmploymentGap(resume: ResumeProfile): number | undefined {
  const segs = resume.workExperience
    .map((w) => ({ s: w.startDate, e: w.endDate }))
    .map((w) => ({
      start: w.s,
      months: spanMonths(w.s, w.e),
    }))
    .filter((w) => w.start);
  if (segs.length < 2) return undefined;
  // 这里只做粗略检测：若总经历段数较多但累计年限明显偏短，提示可能存在空窗
  const total = totalYearsOf(resume);
  const avg = avgTenureMonths(resume);
  if (total !== undefined && avg !== undefined && jobHopCount(resume) >= 3 && avg < 12) {
    return 1;
  }
  return undefined;
}

function educationScore(job: JobPosting, resume: ResumeProfile): DimensionScore {
  const highest = highestEducationOf(resume);
  if (job.minEducation) {
    if (!highest) return { dimension: '教育背景', score: 55, reason: '简历未能识别明确学历' };
    const diff = educationRank(highest) - educationRank(job.minEducation);
    if (diff < 0)
      return {
        dimension: '教育背景',
        score: 42,
        reason: `学历 ${highest} 低于要求 ${job.minEducation}`,
      };
    return {
      dimension: '教育背景',
      score: clamp(80 + diff * 8),
      reason: `学历 ${highest} 满足要求（${job.minEducation}及以上）`,
    };
  }
  const map: Record<EducationLevel, number> = {
    博士: 95,
    硕士: 88,
    本科: 80,
    大专: 68,
    高中及以下: 55,
  };
  return {
    dimension: '教育背景',
    score: highest ? map[highest] : 60,
    reason: highest ? `最高学历：${highest}` : '简历未识别学历',
  };
}

function experienceScore(job: JobPosting, resume: ResumeProfile): DimensionScore {
  const years = totalYearsOf(resume);
  if (typeof job.minYears === 'number') {
    if (years === undefined)
      return { dimension: '经验深度', score: 50, reason: '简历未能识别可计算的工作年限' };
    const ratio = job.minYears > 0 ? years / job.minYears : 1;
    const score = clamp(40 + Math.min(ratio, 1.5) * 40);
    return {
      dimension: '经验深度',
      score,
      reason: `累计约 ${years} 年（要求≥${job.minYears} 年）`,
    };
  }
  if (years === undefined) return { dimension: '经验深度', score: 55, reason: '未识别工作年限' };
  const score = years < 1 ? 50 : years < 3 ? 66 : years < 5 ? 78 : years < 10 ? 88 : 92;
  return { dimension: '经验深度', score, reason: `累计约 ${years} 年工作经验` };
}

function stabilityScore(resume: ResumeProfile): DimensionScore {
  const count = jobHopCount(resume);
  if (count <= 1) return { dimension: '稳定性', score: 75, reason: '工作经历较少，稳定性数据不足' };
  const avg = avgTenureMonths(resume);
  if (avg === undefined) return { dimension: '稳定性', score: 60, reason: '无法计算平均在职时长' };
  const score = avg >= 36 ? 90 : avg >= 24 ? 80 : avg >= 18 ? 68 : avg >= 12 ? 55 : 40;
  return {
    dimension: '稳定性',
    score,
    reason: `平均在职约 ${Math.round((avg / 12) * 10) / 10} 年（${count} 段经历）`,
  };
}

function skillStats(job: JobPosting, resume: ResumeProfile): { matched: string[]; all: string[] } {
  const all = dedupe([...(job.requiredSkills ?? []), ...(job.preferredSkills ?? [])]);
  const matched = all.filter((s) => skillFoundIn(resume, s));
  return { matched, all };
}

function skillScore(job: JobPosting, resume: ResumeProfile): DimensionScore {
  const { matched, all } = skillStats(job, resume);
  if (all.length === 0) return { dimension: '技能匹配', score: 62, reason: 'JD 未列出技能要求' };
  const ratio = matched.length / all.length;
  return {
    dimension: '技能匹配',
    score: clamp(30 + ratio * 70),
    reason: `命中 ${matched.length}/${all.length} 项技能${matched.length ? `（${matched.join('、')}）` : ''}`,
  };
}

function relevanceScore(job: JobPosting, resume: ResumeProfile): DimensionScore {
  const { matched, all } = skillStats(job, resume);
  const titleHit = titleMatches(job, resume);
  const skillRatio = all.length ? matched.length / all.length : 0.5;
  const score = clamp(50 + (titleHit ? 22 : 0) + skillRatio * 25);
  return {
    dimension: '岗位匹配',
    score,
    reason: `${titleHit ? '有同名/相关岗位经历' : '无完全同名岗位经历'}，技能相关度${Math.round(skillRatio * 100)}%`,
  };
}

const WEIGHTS: Record<string, number> = {
  岗位匹配: 0.3,
  技能匹配: 0.3,
  经验深度: 0.2,
  稳定性: 0.1,
  教育背景: 0.1,
};

function detectRisks(job: JobPosting, resume: ResumeProfile): RiskFlag[] {
  const risks: RiskFlag[] = [];
  const count = jobHopCount(resume);
  const avg = avgTenureMonths(resume);
  if (count >= 3 && avg !== undefined && avg < 18) {
    risks.push({
      type: '跳槽频繁',
      severity: avg < 12 ? 'high' : 'medium',
      detail: `共 ${count} 段经历，平均在职约 ${Math.round((avg / 12) * 10) / 10} 年`,
    });
  }
  if (hasEmploymentGap(resume)) {
    risks.push({
      type: '空窗期',
      severity: 'low',
      detail: '经历段较多且平均时长偏短，建议核实是否存在空窗期',
    });
  }
  const missing: string[] = [];
  if (!resume.phone && !resume.email) missing.push('联系方式');
  if (resume.education.length === 0 && !resume.highestEducation) missing.push('教育经历');
  if (resume.workExperience.length === 0) missing.push('工作经历');
  if (missing.length) {
    risks.push({ type: '信息缺失', severity: 'low', detail: `简历缺少：${missing.join('、')}` });
  }
  const years = totalYearsOf(resume);
  if (typeof job.minYears === 'number' && years !== undefined && years >= job.minYears + 10) {
    risks.push({
      type: '资历过高',
      severity: 'low',
      detail: `候选人经验（约 ${years} 年）远超岗位要求，需关注薪资预期与稳定性`,
    });
  }
  return risks;
}

function buildHighlights(job: JobPosting, resume: ResumeProfile, dims: DimensionScore[]): string[] {
  const highlights: string[] = [];
  const { matched, all } = skillStats(job, resume);
  if (all.length && matched.length / all.length >= 0.6) {
    highlights.push(`技能匹配度高，命中 ${matched.join('、')}`);
  }
  const stability = dims.find((d) => d.dimension === '稳定性');
  if (stability && stability.score >= 80) highlights.push(stability.reason);
  const edu = dims.find((d) => d.dimension === '教育背景');
  if (edu && edu.score >= 85) highlights.push(edu.reason);
  if (titleMatches(job, resume)) highlights.push('有与岗位同名/高度相关的任职经历');
  return highlights;
}

function buildQuestions(job: JobPosting, resume: ResumeProfile, risks: RiskFlag[]): string[] {
  const qs: string[] = [
    '确认当前求职状态与到岗时间',
    '确认目标薪资与岗位薪资区间是否匹配',
    `请候选人结合「${job.title}」岗位职责，介绍最相关的一段经历`,
  ];
  if (risks.some((r) => r.type === '跳槽频繁'))
    qs.push('请说明近几段工作的离职原因，了解职业稳定性');
  if (risks.some((r) => r.type === '空窗期')) qs.push('请确认工作经历是否连续，有无空窗期及原因');
  const { matched, all } = skillStats(job, resume);
  const miss = all.filter((s) => !matched.includes(s));
  if (miss.length) qs.push(`确认是否具备以下技能并举例：${miss.join('、')}`);
  return qs;
}

const SEVERITY_WORDS_HIGH = /(失信|被执行|虚假|犯罪|刑事|伪造|不实|严重不符)/;
const SEVERITY_WORDS_MED = /(不一致|不符|存疑|异常|风险|夸大|未通过)/;

function statusOf(result: string): VerifyStatus {
  if (SEVERITY_WORDS_HIGH.test(result) || SEVERITY_WORDS_MED.test(result)) return '存疑';
  if (/(未提供|未查到|无法核实|待核实|未核实|无记录可查)/.test(result)) return '未核实';
  return '已核实';
}

/**
 * 规则引擎：确定性、离线可用。未配置大模型 key 时作为主引擎，配置后作为大模型失败时的兜底。
 */
export class RuleBasedEngine implements ScreeningEngine {
  readonly name = 'rule-based';

  async parseJob(req: ParseJobRequest): Promise<JobPosting> {
    const desc = req.description;
    const minEducation = normalizeEducationLevel(desc);
    const yearMatch = desc.match(/(\d+)\s*年(以上)?\s*(工作)?\s*经验/);
    const minYears = yearMatch ? Number(yearMatch[1]) : undefined;
    const title =
      req.title?.trim() ||
      desc
        .split(/\n|。|；/)[0]
        .slice(0, 40)
        .trim() ||
      '未命名岗位';
    return {
      title,
      company: req.company,
      city: req.city,
      description: desc,
      minEducation,
      minYears,
      locations: req.city ? [req.city] : undefined,
    };
  }

  async scoreCandidate(req: ScoreRequest): Promise<ScreeningResult> {
    const { job, resume } = req;
    const hardFilter = evaluateHardFilter(job, resume);
    const dimensions: DimensionScore[] = [
      relevanceScore(job, resume),
      skillScore(job, resume),
      experienceScore(job, resume),
      stabilityScore(resume),
      educationScore(job, resume),
    ];
    let matchScore = clamp(
      dimensions.reduce((acc, d) => acc + d.score * (WEIGHTS[d.dimension] ?? 0), 0),
    );
    if (!hardFilter.passed) matchScore = Math.min(matchScore, 45);

    const risks = detectRisks(job, resume);
    const recommendation: Recommendation = !hardFilter.passed
      ? 'reject'
      : matchScore >= 72
        ? 'advance'
        : matchScore >= 55
          ? 'hold'
          : 'reject';
    const failed = hardFilter.checks.filter((c) => !c.passed).map((c) => c.label);
    const reason = !hardFilter.passed
      ? `未通过硬性条件：${failed.join('、')}；综合匹配分 ${matchScore}，建议淘汰或人工复核。`
      : `硬性条件全部通过，综合匹配分 ${matchScore}，${
          recommendation === 'advance'
            ? '建议推进约面'
            : recommendation === 'hold'
              ? '建议进入人才库待定'
              : '匹配度偏低，建议淘汰'
        }。`;

    return {
      candidateName: resume.name,
      hardFilter,
      matchScore,
      dimensions,
      highlights: buildHighlights(job, resume, dimensions),
      risks,
      recommendation,
      reason,
      suggestedQuestions: buildQuestions(job, resume, risks),
    };
  }

  async outreach(req: OutreachRequest): Promise<OutreachScript> {
    const channel: OutreachChannel = req.channel ?? '电话';
    const name = req.resume.name ?? '您好';
    const title = req.job.title;
    const company = req.job.company ?? '我司';
    const screeningQuestions = [
      '目前是否在职、求职进展如何、最快到岗时间',
      '期望薪资范围',
      '最近一段工作的主要职责与离职原因',
      `对「${title}」岗位的理解与擅长点`,
      '现居城市与是否接受岗位工作地点',
    ];
    const message =
      channel === '电话'
        ? `${name}，您好！我是${company}招聘负责人，看到您投递了「${title}」岗位，想用几分钟和您做个简单沟通，确认一下基本情况，方便吗？`
        : channel === '短信'
          ? `【${company}】${name}您好，我们已收到您应聘「${title}」的简历，初步评估较为匹配。方便的话请回复合适的电话沟通时间，我们将尽快与您联系。`
          : `${name}您好，我是${company}HR。看到您投递的「${title}」岗位，背景比较匹配～想和您简单聊几句确认下信息，您方便的时候回我一下哈，谢谢！`;
    return { channel, message, screeningQuestions };
  }

  async backgroundProfile(req: BackgroundProfileRequest): Promise<CandidateProfile> {
    const { resume, findings } = req;
    const osintAccounts = req.osintAccounts ?? [];
    const verifiedItems: VerifiedItem[] = findings.map((f: AuthorizedFinding) => ({
      category: f.category,
      status: statusOf(f.result),
      detail: `${f.source}：${f.result}`,
    }));
    const strengths = verifiedItems
      .filter((v) => v.status === '已核实')
      .map((v) => `${v.category}已核实一致`);
    const concerns = verifiedItems
      .filter((v) => v.status !== '已核实')
      .map(
        (v) => `${v.category}${v.status === '存疑' ? '存在不一致/风险' : '未能核实'}：${v.detail}`,
      );
    const hasHigh = findings.some((f) => SEVERITY_WORDS_HIGH.test(f.result));
    const hasMed = findings.some((f) => SEVERITY_WORDS_MED.test(f.result));
    const riskLevel: Severity = hasHigh ? 'high' : hasMed || concerns.length > 0 ? 'medium' : 'low';
    const osintNote = osintAccounts.length
      ? ` 另有 ${osintAccounts.length} 条公开足迹线索（${[
          ...new Set(osintAccounts.map((a) => a.tool)),
        ].join('、')}）待人工核实归属。`
      : '';
    const summary =
      `基于 ${findings.length} 条已授权核验信息整合${
        resume.name ? `（候选人：${resume.name}）` : ''
      }：${verifiedItems.filter((v) => v.status === '已核实').length} 项核实一致，${
        concerns.length
      } 项需关注。` + osintNote;
    const recommendation =
      riskLevel === 'high'
        ? '存在重大背调风险项，建议暂缓发放 offer 并进一步核实'
        : riskLevel === 'medium'
          ? '存在需澄清事项，建议补充核实后再决策'
          : '背调信息基本一致，未见明显风险';
    return { summary, strengths, concerns, verifiedItems, riskLevel, recommendation };
  }
}

export const BG_SOURCE_HINTS: Record<BackgroundCategory, string> = {
  身份核验: '公安实名/人脸实名核验（需本人授权）',
  学历核验: '学信网（中国高等教育学生信息网）',
  任职经历: '原雇主 HR/直属上级访谈 + 社保参保记录（需授权）',
  司法与失信: '中国裁判文书网、中国执行信息公开网（失信被执行人）',
  工商关联: '企查查/天眼查开放 API（对外任职、自营企业、竞业风险）',
  资格证书: '发证机构/主管部门官方查询入口',
};
