/**
 * 工程招投标领域模型。
 *
 * 设计原则（按产品要求）：AI 优先、不硬编码领域规则。
 * - 领域「分类」（要求属于资质/业绩/财务/人员/技术/商务…，招标方式，节点类型）一律用自由文本，
 *   交给大模型用专家知识判断，不在代码里预设清单，避免把行业知识写死。
 * - 仅对「输出状态标签」保留极小枚举（覆盖度/合规状态/严重度），因为下游统计与判断依赖稳定取值。
 */

/** 缺口覆盖度：用于范围缺口检测的结论标签。 */
export const COVERAGE_STATUS = ['已覆盖', '部分覆盖', '未覆盖', '需人工确认'] as const;
export type CoverageStatus = (typeof COVERAGE_STATUS)[number];

/** 合规/废标项核验状态。 */
export const COMPLIANCE_STATUS = ['满足', '缺失', '存疑', '需人工确认'] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUS)[number];

/** 严重度（缺口/废标风险）。 */
export const SEVERITY = ['low', 'medium', 'high'] as const;
export type Severity = (typeof SEVERITY)[number];

/**
 * 招标文件中的一条「要求」（资质 / 业绩 / 财务 / 人员 / 技术 / 商务…由 AI 归类）。
 * mandatory=true 表示强制项（不满足将导致资格不符 / 废标）。
 */
export interface TenderRequirement {
  /** 稳定编号（R1、R2…），便于在缺口/合规结果里引用。 */
  id: string;
  /** AI 判断的要求类别（自由文本，不预设清单）。 */
  category: string;
  /** 要求原文或准确概括。 */
  text: string;
  /** 是否为强制（不满足即资格不符/废标）。 */
  mandatory: boolean;
  /** 原文出处（条款号/章节/片段），便于复核。 */
  source?: string;
}

/** 评分办法中的一项（技术分/商务分/价格分…由 AI 归类）。 */
export interface ScoringItem {
  name: string;
  /** 分值（满分）。 */
  maxScore?: number;
  /** 评分标准说明。 */
  criteria?: string;
  /** AI 判断的评分维度类别（自由文本）。 */
  category?: string;
  source?: string;
}

/** 废标 / 否决 / 无效投标条款。 */
export interface DisqualificationClause {
  /** 条款原文或准确概括。 */
  text: string;
  /** 触发条件概括（什么情况会被废标）。 */
  trigger?: string;
  source?: string;
}

/** 关键时间节点（投标截止 / 开标 / 答疑截止 / 保证金缴纳…）。 */
export interface Milestone {
  /** 节点名称（自由文本）。 */
  name: string;
  /** 日期/时间，尽量保留原文表述（如 2025年7月1日 9:30）。 */
  date?: string;
  note?: string;
  source?: string;
}

/** 招标文件结构化要点。 */
export interface TenderSpec {
  projectName?: string;
  /** 招标人 / 采购人。 */
  tenderer?: string;
  /** 招标代理机构。 */
  agent?: string;
  /** 招标方式（公开招标/邀请招标/竞争性谈判/询价…，自由文本，不预设枚举）。 */
  method?: string;
  /** 预算 / 最高限价（原文）。 */
  budget?: string;
  /** 投标保证金（原文）。 */
  bidSecurity?: string;
  requirements: TenderRequirement[];
  scoringItems: ScoringItem[];
  disqualifications: DisqualificationClause[];
  milestones: Milestone[];
  /** 一句话要点总结。 */
  summary?: string;
}

/**
 * 我方能力档案（投标人画像）。
 * 全部可选 + 自由文本，能填多少填多少，AI 会按语义与招标要求比对。
 */
export interface CapabilityProfile {
  companyName?: string;
  /** 已有资质（营业执照范围、资质等级、安许、体系认证…）。 */
  qualifications?: string[];
  /** 业绩 / 类似项目经验。 */
  pastProjects?: string[];
  /** 关键人员（注册建造师、职称、社保…）。 */
  team?: string[];
  /** 财务概况（注册资本、营收、银行授信…）。 */
  finance?: string;
  /** 技术能力 / 工法 / 专利 / 设备。 */
  techCapabilities?: string[];
  /** 自由补充描述。 */
  narrative?: string;
}

/** 单条范围缺口结论。 */
export interface GapFinding {
  requirementId: string;
  requirement: string;
  category: string;
  mandatory: boolean;
  coverage: CoverageStatus;
  /** 我方对应能力（命中的资料）。 */
  matched?: string;
  /** 缺口说明。 */
  gap?: string;
  severity: Severity;
  /** 补救/补强建议。 */
  suggestion?: string;
  source?: string;
}

/** 范围缺口检测报告。 */
export interface GapReport {
  findings: GapFinding[];
  summary: string;
  /** 投标就绪度 0-100（AI 估算；规则兜底为粗估）。 */
  readiness?: number;
  /** 致命缺口（强制项未覆盖，将导致资格不符/废标）。 */
  blockers: string[];
}

/** 单条合规/废标项核验结论。 */
export interface ComplianceFinding {
  /** 被核验的废标/强制条款。 */
  clause: string;
  status: ComplianceStatus;
  risk: Severity;
  /** 依据 / 我方现状。 */
  evidence?: string;
  /** 整改建议。 */
  action?: string;
  source?: string;
}

/** 投标合规自检报告（废标风险）。 */
export interface ComplianceReport {
  findings: ComplianceFinding[];
  summary: string;
  /** 高风险废标点。 */
  disqualificationRisks: string[];
  /** 通过初步合规/资格审查的可能性 0-100（AI 估；规则兜底为粗估）。 */
  passLikelihood?: number;
}
