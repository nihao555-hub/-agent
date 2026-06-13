/**
 * 事实底座（System of Record）领域模型。
 * 一切 AI 结论都应能溯源到 chunk（原文出处）；结点之间通过 link 连成可追溯的事实图谱。
 * 这里只定义稳定的数据结构，不约束领域判断——判断交给大模型。
 */

export const PROJECT_STATUS = ['bidding', 'awarded', 'delivering', 'settled'] as const;
export type ProjectStatus = (typeof PROJECT_STATUS)[number];

export const DOCUMENT_TYPES = [
  'tender', // 招标文件
  'contract', // 合同
  'spec', // 技术规范
  'boq', // 工程量清单
  'drawing', // 图纸
  'bim', // BIM/IFC
  'bid', // 我方投标文件/技术方案
  'change_order', // 变更单/签证
  'letter', // 往来函件
  'other',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const REQUIREMENT_KINDS = [
  'qualification', // 资质/资格
  'scoring', // 评分办法
  'disqualification', // 废标项/否决投标
  'milestone', // 关键时间节点
  'technical', // 技术要求
  'commercial', // 商务要求
  'contract_clause', // 合同条款义务
] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

export const REQUIREMENT_STATUS = ['open', 'met', 'at_risk', 'breached'] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUS)[number];

export const DEVIATION_TYPES = ['missing', 'partial', 'conflict', 'over_commit'] as const;
export type DeviationType = (typeof DEVIATION_TYPES)[number];

export const SEVERITY = ['low', 'medium', 'high'] as const;
export type Severity = (typeof SEVERITY)[number];

export const IN_SCOPE = ['yes', 'no', 'uncertain'] as const;
export type InScope = (typeof IN_SCOPE)[number];

export const CLAIM_TYPES = ['time', 'cost'] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** 图谱边关系（开放集合，常用如下）。 */
export type LinkRelation =
  | 'responds_to'
  | 'evidenced_by'
  | 'about'
  | 'derived_from'
  | 'basis'
  | 'supports'
  | 'cited_from';

export type NodeType =
  | 'requirement'
  | 'commitment'
  | 'deviation'
  | 'evidence'
  | 'change'
  | 'claim'
  | 'chunk';

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  tenderer?: string;
  client?: string;
  createdAt: string;
}

export interface ProjectDocument {
  id: string;
  projectId: string;
  type: DocumentType;
  title?: string;
  source?: string;
  pageCount?: number;
  parsed: boolean;
  createdAt: string;
}

/** 文档片段：原文出处最小单元（带页码/条款），也是 RAG 检索单元。 */
export interface Chunk {
  id: string;
  documentId: string;
  projectId: string;
  ordinal: number;
  page?: number;
  clause?: string;
  text: string;
  embedding?: number[];
  createdAt: string;
}

/** 检索命中（带定位与分数），用作"带原文出处"的证据。 */
export interface ChunkHit {
  id: string;
  documentId: string;
  page?: number;
  clause?: string;
  text: string;
  score: number;
}

export interface Requirement {
  id: string;
  projectId: string;
  sourceChunkId?: string;
  kind: RequirementKind;
  category?: string;
  text: string;
  mandatory: boolean;
  status: RequirementStatus;
  severity?: Severity;
  createdAt: string;
}

export interface Commitment {
  id: string;
  projectId: string;
  sourceChunkId?: string;
  requirementId?: string;
  kind?: string;
  text: string;
  createdAt: string;
}

export interface Deviation {
  id: string;
  projectId: string;
  requirementId?: string;
  commitmentId?: string;
  type: DeviationType;
  severity?: Severity;
  status: string;
  description: string;
  detectedBy: string;
  createdAt: string;
}

export interface Evidence {
  id: string;
  projectId: string;
  chunkId: string;
  note?: string;
  createdAt: string;
}

export interface Change {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  inScope: InScope;
  basisChunkId?: string;
  costImpact?: string;
  timeImpact?: string;
  status: string;
  createdAt: string;
}

export interface Claim {
  id: string;
  projectId: string;
  changeId?: string;
  type: ClaimType;
  basis?: string;
  amount?: string;
  days?: number;
  narrative?: string;
  status: string;
  createdAt: string;
}

export interface Link {
  id: string;
  projectId: string;
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  relation: string;
  createdAt: string;
}

export interface ProjectEvent {
  id: string;
  projectId: string;
  type: string;
  detail: Record<string, unknown>;
  createdAt: string;
}
