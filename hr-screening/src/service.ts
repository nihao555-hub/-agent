import { HttpError } from './errors';
import { BG_SOURCE_HINTS, RuleBasedEngine } from './engine/ruleBased';
import type {
  BatchScoreRequest,
  BatchScoreResult,
  OutreachRequest,
  ParseJobRequest,
  RankedScreeningResult,
  ScoreRequest,
  ScreeningEngine,
} from './engine/types';
import type { OsintCollector, OsintHandles, OsintReport } from './osint/collector';
import type { ParseInput, ParseOutput, ResumeParser } from './resume/parser';
import {
  BG_CATEGORIES,
  type AuthorizedFinding,
  type BackgroundCheckItem,
  type BackgroundCheckPlan,
  type CandidateProfile,
  type JobPosting,
  type OutreachChannel,
  type OutreachScript,
  type ResumeProfile,
  type ScreeningResult,
} from './types';

const WHAT_TO_VERIFY: Record<string, string> = {
  身份核验: '核验姓名与身份证件一致性、是否为本人',
  学历核验: '最高学历/学位的真实性与获取时间',
  任职经历: '最近 2-3 段的公司、职位、在职时间与离职原因',
  司法与失信: '是否为失信被执行人、有无重大涉诉/刑事记录',
  工商关联: '对外任职、自营企业、与竞业相关的工商关联',
  资格证书: 'JD 要求的执业/资格证书真实性与有效期',
};

const REQUIRED_AUTH: Record<string, string> = {
  身份核验: '候选人身份证件 + 实名核验书面授权',
  学历核验: '学信网在线验证报告，或候选人学历核验书面授权',
  任职经历: '原雇主证明人联系方式 + 背调书面授权；社保参保记录须本人授权调取',
  司法与失信: '候选人书面授权（虽为公开记录，仍应事先告知并取得同意）',
  工商关联: '候选人书面授权（经由企查查/天眼查等持牌数据源查询）',
  资格证书: '证书编号 + 发证机构官方查询授权',
};

const REFEREE_QUESTIONS = [
  '请确认候选人在贵司的任职时间、岗位与汇报关系',
  '候选人主要负责的工作内容与实际绩效表现',
  '离职原因，以及是否属于主动离职',
  '在职期间有无重大违纪、诚信或合规问题',
  '是否愿意再次共事（综合评价）',
];

/**
 * HR 初筛服务编排层：组合「双引擎 + 简历解析 + OSINT 收集」，并实现确定性的背调计划与 consent 闸门。
 */
export class HrService {
  constructor(
    private readonly engine: ScreeningEngine,
    private readonly parser: ResumeParser,
    private readonly osint: OsintCollector,
  ) {}

  get engineName(): string {
    return this.engine.name;
  }

  parseJob(req: ParseJobRequest): Promise<JobPosting> {
    return this.engine.parseJob(req);
  }

  parseResume(input: ParseInput): Promise<ParseOutput> {
    return this.parser.parse(input);
  }

  score(req: ScoreRequest): Promise<ScreeningResult> {
    return this.engine.scoreCandidate(req);
  }

  /** 批量打分并排序（顺序执行，控制对 grsai 的并发，避免限流）。 */
  async batchScore(req: BatchScoreRequest): Promise<BatchScoreResult> {
    const results: ScreeningResult[] = [];
    for (const resume of req.candidates) {
      results.push(await this.engine.scoreCandidate({ job: req.job, resume }));
    }
    const order = { advance: 0, hold: 1, reject: 2 };
    const ranked: RankedScreeningResult[] = results
      .map((r) => r)
      .sort((a, b) => {
        if (order[a.recommendation] !== order[b.recommendation])
          return order[a.recommendation] - order[b.recommendation];
        return b.matchScore - a.matchScore;
      })
      .map((r, i) => ({ ...r, rank: i + 1 }));
    return { ranked };
  }

  outreach(req: OutreachRequest): Promise<OutreachScript> {
    return this.engine.outreach(req);
  }

  /**
   * 确定性背调计划：consent 闸门 + 合法数据源核验事项。
   * 未取得书面授权时只返回授权指引（gated=true），不产出任何核验事项。
   */
  buildBackgroundCheckPlan(input: {
    resume: ResumeProfile;
    job?: JobPosting;
    consentObtained: boolean;
  }): BackgroundCheckPlan {
    if (!input.consentObtained) {
      return {
        consentObtained: false,
        gated: true,
        notice:
          '尚未取得候选人书面授权。根据《个人信息保护法》，背景调查须事先获得候选人书面同意并明确告知核查范围；授权前不得收集、核验其个人信息。请先完成授权，再发起背调。',
        items: [],
        refereeQuestions: [],
      };
    }
    const categories = input.job?.requiredSkills?.length
      ? BG_CATEGORIES
      : BG_CATEGORIES.filter((c) => c !== '资格证书');
    const items: BackgroundCheckItem[] = categories.map((category) => ({
      category,
      source: BG_SOURCE_HINTS[category],
      whatToVerify: WHAT_TO_VERIFY[category],
      requiredAuthorization: REQUIRED_AUTH[category],
    }));
    return {
      consentObtained: true,
      gated: false,
      notice:
        '已确认取得候选人书面授权。仅通过下列合法数据源在授权范围内核验，全程留痕；不进行无授权的全网抓取。',
      items,
      refereeQuestions: REFEREE_QUESTIONS,
    };
  }

  /**
   * 授权式 OSINT 公开信息收集（maigret/sherlock/spiderfoot）。
   * 强制 consent 闸门：未取得书面授权直接拒绝；仅对候选人本人提供/确认的标识收集。
   */
  async collectOsint(input: {
    consentObtained: boolean;
    handles: OsintHandles;
  }): Promise<OsintReport> {
    if (!input.consentObtained) {
      throw new HttpError(
        403,
        '未取得候选人书面授权，禁止进行公开信息收集（OSINT）。请先完成授权。',
      );
    }
    return this.osint.collect(input.handles);
  }

  backgroundProfile(input: {
    resume: ResumeProfile;
    findings: AuthorizedFinding[];
    osintAccounts?: OsintReport['accounts'];
  }): Promise<CandidateProfile> {
    return this.engine.backgroundProfile({
      resume: input.resume,
      findings: input.findings,
      osintAccounts: input.osintAccounts,
    });
  }

  /** 端到端：打分 + 触达话术 + 背调计划（授权且有核验结论时附画像）。顺序执行控制并发。 */
  async analyze(input: {
    job: JobPosting;
    resume: ResumeProfile;
    channel?: OutreachChannel;
    consentObtained: boolean;
    findings?: AuthorizedFinding[];
  }): Promise<{
    screening: ScreeningResult;
    outreach: OutreachScript;
    backgroundCheckPlan: BackgroundCheckPlan;
    profile?: CandidateProfile;
  }> {
    const screening = await this.engine.scoreCandidate({ job: input.job, resume: input.resume });
    const outreach = await this.engine.outreach({
      job: input.job,
      resume: input.resume,
      channel: input.channel,
    });
    const backgroundCheckPlan = this.buildBackgroundCheckPlan({
      resume: input.resume,
      job: input.job,
      consentObtained: input.consentObtained,
    });
    let profile: CandidateProfile | undefined;
    if (input.consentObtained && input.findings && input.findings.length > 0) {
      profile = await this.engine.backgroundProfile({
        resume: input.resume,
        findings: input.findings,
      });
    }
    return { screening, outreach, backgroundCheckPlan, profile };
  }
}

export { RuleBasedEngine };
