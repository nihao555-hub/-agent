import type { ResumeSource } from '../resume/parser';
import type { ApplicationSource } from '../pipeline/types';
import type { ApplicationStatus } from '../pipeline/status';

/** 一份待归集的简历：纯文本或文件（base64），可带来源备注。 */
export interface IntakeItem {
  text?: string;
  fileBase64?: string;
  fileName?: string;
  /** 来源备注（如邮件主题、文件名），仅用于日志与事件留痕 */
  meta?: string;
}

/** 单份简历归集结果。 */
export interface IntakeResult {
  ok: boolean;
  applicationId?: string;
  candidateName?: string;
  parseSource?: ResumeSource;
  status?: ApplicationStatus;
  matchScore?: number;
  recommendation?: string;
  hardFilterPassed?: boolean;
  meta?: string;
  error?: string;
}

/** 批量归集汇总。 */
export interface IntakeSummary {
  source: ApplicationSource;
  total: number;
  ingested: number;
  failed: number;
  results: IntakeResult[];
}
