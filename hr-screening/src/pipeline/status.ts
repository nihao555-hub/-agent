/**
 * 候选人状态机：投递 → 初筛中 → 约面 / 淘汰 / 人才库。
 * 受控流转——只允许定义好的迁移，非法迁移直接拒绝（保证招聘流程可审计、可解释）。
 */

export const APPLICATION_STATUSES = [
  'applied', // 已投递/已收简历
  'screening', // 初筛中（已解析+打分，待人工决策）
  'interview', // 约面（进入面试环节）
  'rejected', // 淘汰
  'talent_pool', // 人才库（暂不推进，留待后续岗位）
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** 各状态的中文标签，用于通知文案与展示。 */
export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  applied: '已投递',
  screening: '初筛中',
  interview: '约面',
  rejected: '未通过',
  talent_pool: '人才库',
};

/** 允许的状态迁移表（from → 可达的 to 集合）。 */
export const ALLOWED_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  applied: ['screening', 'interview', 'rejected', 'talent_pool'],
  screening: ['interview', 'rejected', 'talent_pool'],
  interview: ['rejected', 'talent_pool'],
  talent_pool: ['screening', 'interview', 'rejected'],
  rejected: ['talent_pool'], // 误判可重新纳入人才库；其余视为终态
};

/** 进入这些状态时默认应向候选人发送反馈（实时反馈应聘结果）。 */
export const FEEDBACK_STATUSES: ApplicationStatus[] = ['interview', 'rejected'];

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
