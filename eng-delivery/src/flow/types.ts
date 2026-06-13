/**
 * 通用「长流程」编排领域模型：把一段多步骤、可能很慢（多次大模型调用 + 检索）的任务，
 * 拆成可持久化、可断点续跑的 run（一次执行） + step（每一步）。
 * 设计目标：进程崩溃/重启后，凭 SQLite 里的 run/step 状态可从上次断点继续，而不是从头再来。
 * 这里只定义稳定的数据结构，不约束某个具体流程怎么走（交给 flow 定义）。
 */

export const FLOW_STATUS = ['pending', 'running', 'completed', 'failed'] as const;
export type FlowStatus = (typeof FLOW_STATUS)[number];

export const STEP_STATUS = ['pending', 'running', 'completed', 'failed', 'skipped'] as const;
export type StepStatus = (typeof STEP_STATUS)[number];

/** 一次长流程执行。`state` 是步骤间累积、随断点续跑而恢复的共享状态。 */
export interface FlowRun {
  id: string;
  projectId: string;
  kind: string; // 流程类型，如 'change_claim'
  subjectType: string; // 流程作用对象类型，如 'change'
  subjectId: string; // 作用对象 id（如变更 id）
  status: FlowStatus;
  cursor: number; // 下一个待执行步骤的序号（已完成步骤不再重跑）
  engine: string; // 'llm' | 'rule-based'，标注本次智能来源
  state: Record<string, unknown>; // 步骤间累积的共享状态（可续跑）
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** 长流程中的一步，持久化其状态/输出，便于审计与续跑。 */
export interface FlowStep {
  id: string;
  runId: string;
  projectId: string;
  ordinal: number;
  name: string;
  status: StepStatus;
  output?: Record<string, unknown>;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
}
