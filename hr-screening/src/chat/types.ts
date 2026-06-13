import type { JobPosting, Recommendation, ResumeProfile, RiskFlag } from '../types';

/** 对话角色：assistant=AI（顶级 HR 专家），candidate=候选人 */
export type ChatRole = 'assistant' | 'candidate';

export type ChatSessionStatus = 'active' | 'completed';

/** 一条对话消息（持久化于 chat_messages） */
export interface ChatMessage {
  id: string;
  sessionId: string;
  /** 同一会话内自增序号，从 1 开始，保证可复现的顺序 */
  seq: number;
  role: ChatRole;
  content: string;
  createdAt: string;
}

/** 对话所需的上下文：目标岗位 + 候选人简历画像 */
export interface ChatContext {
  job: JobPosting;
  resume: ResumeProfile;
}

/**
 * 对话式初筛结束后产出的结构化小结，回填候选人档案。
 * 复用 RiskFlag / Recommendation，与简历打分口径保持一致。
 */
export interface ChatScreeningSummary {
  /** 与岗位匹配度的总体判断 */
  fitAssessment: string;
  /** 对话中已确认的信息（求职意向/到岗时间/薪资/关键经历等） */
  confirmedInfo: string[];
  /** 仍待确认或未澄清的信息 */
  pendingInfo: string[];
  /** 对话中识别到的风险点 */
  risks: RiskFlag[];
  /** 初筛结论：推进约面 / 进人才库待定 / 淘汰 */
  recommendation: Recommendation;
  /** 结论理由（基于对话与简历的客观事实） */
  reason: string;
  /** 若继续沟通，建议进一步追问的问题 */
  nextQuestions: string[];
}

/** 会话完整视图：会话元信息 + 岗位 + 简历 + 可选小结 */
export interface ChatSession {
  id: string;
  jobId: string;
  candidateId: string;
  status: ChatSessionStatus;
  job: JobPosting;
  resume: ResumeProfile;
  summary?: ChatScreeningSummary;
  createdAt: string;
  updatedAt: string;
}

/** 会话列表项（不含完整岗位/简历，仅元信息 + 候选人姓名 + 岗位名） */
export interface ChatSessionMeta {
  id: string;
  jobId: string;
  candidateId: string;
  jobTitle: string;
  candidateName?: string;
  status: ChatSessionStatus;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}
