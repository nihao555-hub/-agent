import type { JobPosting, ResumeProfile, ScreeningResult } from '../types';
import type { ApplicationStatus } from './status';

/** 简历来源渠道（归集层标注，用于追溯与统计） */
export const APPLICATION_SOURCES = ['manual', 'batch', 'email', 'folder'] as const;
export type ApplicationSource = (typeof APPLICATION_SOURCES)[number];

/** 通知渠道：邮件 / 短信 / 企业微信 / dry-run（仅落库不外发） */
export const NOTIFICATION_CHANNELS = ['email', 'sms', 'wecom', 'none'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** 通知发送状态：sent=已发出 / skipped=未配置渠道（dry-run 落库）/ failed=发送失败 */
export type NotificationStatus = 'sent' | 'skipped' | 'failed';

/** 一次投递记录（候选人 × 岗位），承载状态机与初筛结论。 */
export interface Application {
  id: string;
  jobId: string;
  candidateId: string;
  status: ApplicationStatus;
  source: ApplicationSource;
  /** 自动初筛打分结果（解析后自动产出，HR 据此决策） */
  screening?: ScreeningResult;
  createdAt: string;
  updatedAt: string;
}

/** 状态变更/事件历史，保证招聘流程可审计。 */
export const APPLICATION_EVENT_TYPES = [
  'created',
  'screened',
  'status_changed',
  'notified',
] as const;
export type ApplicationEventType = (typeof APPLICATION_EVENT_TYPES)[number];

export interface ApplicationEvent {
  id: string;
  applicationId: string;
  type: ApplicationEventType;
  fromStatus?: ApplicationStatus;
  toStatus?: ApplicationStatus;
  detail: string;
  createdAt: string;
}

/** 一条对候选人的反馈通知记录。 */
export interface Notification {
  id: string;
  applicationId: string;
  channel: NotificationChannel;
  recipient: string;
  subject?: string;
  body: string;
  status: NotificationStatus;
  /** 文案由大模型(llm)还是规则模板(rule-based)生成 */
  engine?: string;
  error?: string;
  createdAt: string;
}

/** 投递列表项（含候选人/岗位名与分数，便于看板展示） */
export interface ApplicationMeta {
  id: string;
  jobId: string;
  jobTitle: string;
  candidateId: string;
  candidateName?: string;
  status: ApplicationStatus;
  source: ApplicationSource;
  matchScore?: number;
  recommendation?: string;
  createdAt: string;
  updatedAt: string;
}

/** 投递详情（含岗位、候选人、事件历史、通知历史） */
export interface ApplicationDetail {
  application: Application;
  job: JobPosting;
  candidate: ResumeProfile;
  events: ApplicationEvent[];
  notifications: Notification[];
}
