import {
  type CapabilityProfile,
  type ComplianceFinding,
  type ComplianceReport,
  type CoverageStatus,
  type GapFinding,
  type GapReport,
  type Severity,
  type TenderSpec,
} from '../types';
import { bestMatch } from '../utils/textMatch';
import { assignRequirementIds } from './normalize';
import type {
  ComplianceRequest,
  GapRequest,
  ParseTenderRequest,
  TenderEngine,
} from './types';

/**
 * 规则引擎：仅作为大模型不可用（未配 key / 调用失败）时的「薄兜底」。
 *
 * 设计原则（按产品要求）：不假装做语义推理。
 * - 只做机械抽取：用正则定位日期/时间，用极少量「锚点词」切分出疑似要求/废标条款。
 * - 比对只用通用文本相似度（粗估），不内置任何行业规则清单。
 * - 凡是需要专业判断的（是否真的满足、是否构成废标），一律输出「需人工确认」，把判断权留给人/大模型。
 */

// 仅用于机械切分的最小锚点词（不是行业规则，只是定位线索）。
const REQUIREMENT_ANCHORS = ['应', '须', '必须', '不得', '具备', '提供', '资质', '资格', '业绩', '注册', '许可', '认证'];
const MANDATORY_ANCHORS = ['必须', '应当', '不得', '否则', '方可', '须'];
const DISQUALIFY_ANCHORS = ['废标', '否决', '无效投标', '作废标', '按废标'];
const SCORING_ANCHORS = ['评分', '分值', '得分', '满分', '计分', '评审因素'];

const DATE_RE =
  /(\d{4}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*日?(?:\s*\d{1,2}\s*[:：]\s*\d{2})?)|(\d{1,2}\s*[:：]\s*\d{2})/;

const MAX_ITEMS = 60;

function segments(text: string): string[] {
  return text
    .split(/[\n\r。；;！!？?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && s.length <= 300);
}

function has(s: string, anchors: string[]): boolean {
  return anchors.some((a) => s.includes(a));
}

function ruleNote(): string {
  return '（规则兜底：机械抽取，未做语义判断，需人工确认）';
}

export class RuleBasedEngine implements TenderEngine {
  readonly name = 'rule-based';

  async parseTender(req: ParseTenderRequest): Promise<TenderSpec> {
    const segs = segments(req.text);

    const reqSegs = segs.filter((s) => has(s, REQUIREMENT_ANCHORS)).slice(0, MAX_ITEMS);
    const requirements = assignRequirementIds(
      reqSegs.map((s) => ({
        category: '未分类',
        text: s,
        mandatory: has(s, MANDATORY_ANCHORS),
        source: undefined,
      })),
    );

    const disqualifications = segs
      .filter((s) => has(s, DISQUALIFY_ANCHORS))
      .slice(0, MAX_ITEMS)
      .map((s) => ({ text: s, trigger: undefined, source: undefined }));

    const milestones = segs
      .filter((s) => DATE_RE.test(s))
      .slice(0, MAX_ITEMS)
      .map((s) => {
        const m = s.match(DATE_RE);
        return {
          name: s.slice(0, 24),
          date: m ? m[0].replace(/\s+/g, '') : undefined,
          note: undefined,
          source: undefined,
        };
      });

    const scoringItems = segs
      .filter((s) => has(s, SCORING_ANCHORS))
      .slice(0, MAX_ITEMS)
      .map((s) => {
        const m = s.match(/(\d{1,3})\s*分/);
        return {
          name: s.slice(0, 40),
          maxScore: m ? Number(m[1]) : undefined,
          criteria: s,
          category: undefined,
          source: undefined,
        };
      });

    return {
      projectName: req.projectName,
      requirements,
      scoringItems,
      disqualifications,
      milestones,
      summary: `规则引擎机械抽取：要求${requirements.length}条、废标条款${disqualifications.length}条、节点${milestones.length}个。${ruleNote()}`,
    };
  }

  async detectGaps(req: GapRequest): Promise<GapReport> {
    const cap = capabilityCorpus(req.capability);
    const hasCap = cap.length > 0;
    const blockers: string[] = [];

    const findings: GapFinding[] = req.tender.requirements.map((r) => {
      if (!hasCap) {
        return {
          requirementId: r.id,
          requirement: r.text,
          category: r.category,
          mandatory: r.mandatory,
          coverage: '需人工确认' as CoverageStatus,
          gap: '未提供我方能力资料，无法比对',
          severity: r.mandatory ? ('high' as Severity) : ('medium' as Severity),
          suggestion: '补充我方资质/业绩/人员资料后再比对',
          source: r.source,
        };
      }
      const { text, score } = bestMatch(r.text, cap);
      // 通用相似度粗估：高=已覆盖、中=部分覆盖、低=未覆盖；不代表语义结论。
      let coverage: CoverageStatus;
      if (score >= 0.34) coverage = '已覆盖';
      else if (score >= 0.15) coverage = '部分覆盖';
      else coverage = '未覆盖';
      const severity: Severity =
        coverage === '未覆盖' && r.mandatory ? 'high' : coverage === '已覆盖' ? 'low' : 'medium';
      if (coverage === '未覆盖' && r.mandatory) {
        blockers.push(`${r.id} ${r.text}`);
      }
      return {
        requirementId: r.id,
        requirement: r.text,
        category: r.category,
        mandatory: r.mandatory,
        coverage,
        matched: coverage === '未覆盖' ? undefined : text,
        gap: coverage === '未覆盖' ? '我方资料未见对应能力（粗估）' : undefined,
        severity,
        suggestion: coverage === '未覆盖' ? '需人工确认并补强' : undefined,
        source: r.source,
      };
    });

    const total = findings.length || 1;
    const covered = findings.filter((f) => f.coverage === '已覆盖').length;
    const readiness = Math.round((covered / total) * 100);

    return {
      findings,
      summary: `规则引擎按文本相似度粗估：${covered}/${findings.length} 条疑似已覆盖。${ruleNote()}`,
      readiness,
      blockers,
    };
  }

  async checkCompliance(req: ComplianceRequest): Promise<ComplianceReport> {
    const findings: ComplianceFinding[] = [];
    const disqualificationRisks: string[] = [];

    // 废标/否决条款：规则无法判定是否触发，统一「需人工确认」并按高风险提示。
    for (const d of req.tender.disqualifications) {
      findings.push({
        clause: d.text,
        status: '需人工确认',
        risk: 'high',
        evidence: req.capability ? '规则引擎不做语义判断' : '未提供我方现状',
        action: '人工逐条核对是否触发该废标情形',
        source: d.source,
      });
      disqualificationRisks.push(d.text);
    }

    // 强制性要求：同样交人工/大模型判断。
    for (const r of req.tender.requirements.filter((x) => x.mandatory)) {
      findings.push({
        clause: `${r.id} ${r.text}`,
        status: '需人工确认',
        risk: 'medium',
        evidence: req.capability ? '规则引擎不做语义判断' : '未提供我方现状',
        action: '人工核对我方是否满足该强制性要求',
        source: r.source,
      });
    }

    return {
      findings,
      summary: `规则引擎仅机械列出 ${findings.length} 条需核验项，未做语义判定。${ruleNote()}`,
      disqualificationRisks,
      passLikelihood: undefined,
    };
  }
}

function capabilityCorpus(cap: CapabilityProfile): string[] {
  return [
    ...(cap.qualifications ?? []),
    ...(cap.pastProjects ?? []),
    ...(cap.team ?? []),
    ...(cap.techCapabilities ?? []),
    cap.finance ?? '',
    cap.narrative ?? '',
    cap.companyName ?? '',
  ]
    .map((s) => s.trim())
    .filter(Boolean);
}
