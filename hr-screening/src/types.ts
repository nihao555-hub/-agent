/**
 * 领域类型定义：AI 初筛官
 * 面向 HR / 招聘专员的简历初筛打分（复用 alibaba/SmartResume 做简历解析）
 * 与「授权式合规背调」——只基于候选人已授权的合法数据源，绝不做无授权全网爬取。
 */

/** 学历层级，按从低到高排序（用于硬性条件比较） */
export const EDUCATION_LEVELS = ['高中及以下', '大专', '本科', '硕士', '博士'] as const;
export type EducationLevel = (typeof EDUCATION_LEVELS)[number];

export const OUTREACH_CHANNELS = ['电话', '短信', '微信'] as const;
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];

/** 初筛结论：推进(约面) / 待定(人才库) / 淘汰 */
export type Recommendation = 'advance' | 'hold' | 'reject';

/** 结构化岗位需求（JD） */
export interface JobPosting {
  /** 岗位名称 */
  title: string;
  /** 公司 */
  company?: string;
  /** 工作城市 */
  city?: string;
  /** JD 原文 */
  description?: string;
  /** 岗位职责 */
  responsibilities?: string[];
  /** 最低学历要求 */
  minEducation?: EducationLevel;
  /** 最低工作年限 */
  minYears?: number;
  /** 必备技能（硬性，缺失即不达标） */
  requiredSkills?: string[];
  /** 加分技能 */
  preferredSkills?: string[];
  /** 工作地点（用于地点硬性匹配） */
  locations?: string[];
  /** 薪资范围 */
  salaryRange?: string;
  /** 招聘人数 */
  headcount?: number;
  /** 备注/其他要求 */
  notes?: string;
}

export interface EducationItem {
  school?: string;
  major?: string;
  /** 原始学历文本，如 "硕士研究生" */
  degreeLevel?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
}

export interface WorkItem {
  companyName?: string;
  position?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
}

/** 结构化简历（SmartResume 解析输出归一化后的形态） */
export interface ResumeProfile {
  name?: string;
  phone?: string;
  email?: string;
  gender?: string;
  age?: number;
  /** 现居地 */
  currentLocation?: string;
  /** 期望工作地点 */
  desiredLocations?: string[];
  /** 最高学历（可由 education 推导） */
  highestEducation?: EducationLevel;
  /** 累计工作年限（可由 workExperience 推导） */
  totalYears?: number;
  /** 技能/关键词 */
  skills?: string[];
  education: EducationItem[];
  workExperience: WorkItem[];
  /** 自我评价 */
  selfEvaluation?: string;
  /** 简历纯文本（用于关键词检索与大模型评估） */
  rawText?: string;
}

/** 单条硬性条件检查结果 */
export interface HardCheck {
  /** 人类可读标签，如 "本科及以上" */
  label: string;
  passed: boolean;
  detail: string;
}

export interface HardFilterResult {
  /** 全部硬性条件是否通过 */
  passed: boolean;
  checks: HardCheck[];
}

export const SCORE_DIMENSIONS = ['岗位匹配', '技能匹配', '经验深度', '稳定性', '教育背景'] as const;
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

export interface DimensionScore {
  dimension: ScoreDimension;
  /** 0-100 */
  score: number;
  reason: string;
}

export const RISK_TYPES = [
  '跳槽频繁',
  '空窗期',
  '经历存疑',
  '学历存疑',
  '资历过高',
  '信息缺失',
  '其他',
] as const;
export type RiskType = (typeof RISK_TYPES)[number];

export type Severity = 'low' | 'medium' | 'high';

export interface RiskFlag {
  type: RiskType;
  severity: Severity;
  detail: string;
}

/** 简历初筛打分结果 */
export interface ScreeningResult {
  candidateName?: string;
  /** 硬性条件过滤（确定性，由规则计算） */
  hardFilter: HardFilterResult;
  /** 综合匹配分 0-100 */
  matchScore: number;
  dimensions: DimensionScore[];
  /** 亮点 */
  highlights: string[];
  /** 风险点 */
  risks: RiskFlag[];
  recommendation: Recommendation;
  /** 综合结论 */
  reason: string;
  /** 电话初筛 / 面试建议追问的问题 */
  suggestedQuestions: string[];
}

/** 初步触达话术（电话初筛/微信/短信） */
export interface OutreachScript {
  channel: OutreachChannel;
  /** 开场白/话术 */
  message: string;
  /** 触达时要确认的关键问题 */
  screeningQuestions: string[];
}

/** 合规背调核验类别 */
export const BG_CATEGORIES = [
  '身份核验',
  '学历核验',
  '任职经历',
  '司法与失信',
  '工商关联',
  '资格证书',
] as const;
export type BackgroundCategory = (typeof BG_CATEGORIES)[number];

/** 一条合规背调核验事项（仅描述「该查什么、用哪个合法源、需要什么授权」，不执行抓取） */
export interface BackgroundCheckItem {
  category: BackgroundCategory;
  /** 合法数据源，如「学信网」「中国执行信息公开网」「企查查开放 API」「持牌第三方背调机构」 */
  source: string;
  whatToVerify: string;
  /** 需要候选人提供的授权/材料 */
  requiredAuthorization: string;
}

export interface BackgroundCheckPlan {
  /** 候选人是否已书面授权 */
  consentObtained: boolean;
  /** 是否因未授权被拦截（true 时 items 为空） */
  gated: boolean;
  /** 合规提示 */
  notice: string;
  items: BackgroundCheckItem[];
  /** 给证明人（前雇主/同事）的访谈问题 */
  refereeQuestions: string[];
}

/** 一条「已获授权」的核验结论（由 HR 通过合法渠道取得后回填，作为画像输入） */
export interface AuthorizedFinding {
  category: BackgroundCategory;
  source: string;
  /** 已授权获得的核验结论 */
  result: string;
}

export const VERIFY_STATUS = ['已核实', '存疑', '未核实'] as const;
export type VerifyStatus = (typeof VERIFY_STATUS)[number];

export interface VerifiedItem {
  category: BackgroundCategory;
  status: VerifyStatus;
  detail: string;
}

/** 候选人画像（仅由已授权信息整合而成） */
export interface CandidateProfile {
  summary: string;
  strengths: string[];
  concerns: string[];
  verifiedItems: VerifiedItem[];
  riskLevel: Severity;
  recommendation: string;
}
