import type {
  CapabilityProfile,
  ComplianceReport,
  GapReport,
  TenderSpec,
} from '../types';

export interface ParseTenderRequest {
  /** 招标文件纯文本（直接粘贴，或由文档解析微服务从 PDF/Word 提取得到）。 */
  text: string;
  /** 已知项目名称（可选，作为提示）。 */
  projectName?: string;
}

export interface GapRequest {
  tender: TenderSpec;
  capability: CapabilityProfile;
}

export interface ComplianceRequest {
  tender: TenderSpec;
  /** 可选：带上我方资料后，核验会结合现状判断是否满足；不带则只评估条款本身的废标风险与待办。 */
  capability?: CapabilityProfile;
}

/**
 * 工程招投标引擎抽象。
 * 两种实现：
 * - LlmEngine：接大模型（grsai / OpenAI 兼容），激活其招投标专家知识做语义判断；任何失败自动回退。
 * - RuleBasedEngine：薄兜底，只做机械抽取与文本相似度比对，语义判断一律输出「需人工确认」。
 *
 * 注意：领域判断尽量交给大模型，代码不预设行业规则清单（按产品要求，避免硬编码）。
 */
export interface TenderEngine {
  /** 引擎标识，便于在响应里标注本次结果由谁生成（llm / rule-based）。 */
  readonly name: string;
  parseTender(req: ParseTenderRequest): Promise<TenderSpec>;
  detectGaps(req: GapRequest): Promise<GapReport>;
  checkCompliance(req: ComplianceRequest): Promise<ComplianceReport>;
}
