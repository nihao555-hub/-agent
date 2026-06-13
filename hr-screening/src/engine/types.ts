import type { OsintAccount } from '../osint/collector';
import type {
  AuthorizedFinding,
  CandidateProfile,
  JobPosting,
  OutreachChannel,
  OutreachScript,
  ResumeProfile,
  ScreeningResult,
} from '../types';

export interface ParseJobRequest {
  description: string;
  title?: string;
  company?: string;
  city?: string;
}

export interface ScoreRequest {
  job: JobPosting;
  resume: ResumeProfile;
}

export interface BatchScoreRequest {
  job: JobPosting;
  candidates: ResumeProfile[];
}

export interface RankedScreeningResult extends ScreeningResult {
  /** 在本批候选人中的排名，从 1 开始 */
  rank: number;
}

export interface BatchScoreResult {
  ranked: RankedScreeningResult[];
}

export interface OutreachRequest {
  job: JobPosting;
  resume: ResumeProfile;
  channel?: OutreachChannel;
}

export interface BackgroundProfileRequest {
  resume: ResumeProfile;
  findings: AuthorizedFinding[];
  /** 由 OSINT 收集（授权后）得到的公开账号线索，作为「待人工核实」的参考，不作为结论依据 */
  osintAccounts?: OsintAccount[];
}

/**
 * 初筛引擎抽象。
 * 两种实现：RuleBasedEngine（确定性、无需联网）与 LlmEngine（接大模型，失败自动回退）。
 * 硬性条件过滤始终由确定性规则计算（见 hardFilter.ts），不交给大模型，保证可解释、可复现。
 */
export interface ScreeningEngine {
  /** 引擎标识，便于在响应里标注本次结果由谁生成 */
  readonly name: string;
  parseJob(req: ParseJobRequest): Promise<JobPosting>;
  scoreCandidate(req: ScoreRequest): Promise<ScreeningResult>;
  outreach(req: OutreachRequest): Promise<OutreachScript>;
  backgroundProfile(req: BackgroundProfileRequest): Promise<CandidateProfile>;
}
