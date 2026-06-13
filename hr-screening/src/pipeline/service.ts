import { HttpError } from '../errors';
import type {
  ApplicationListFilter,
  ApplicationRepository,
  CandidateRepository,
  JobRepository,
  JobSummary,
  NotificationRepository,
} from '../db/repositories';
import type { ScreeningEngine } from '../engine/types';
import type { Logger } from '../logger';
import type { FeedbackComposer } from '../notify/composer';
import type { Notifier } from '../notify/channels';
import type { JobPosting, ResumeProfile } from '../types';
import { canTransition, STATUS_LABELS, type ApplicationStatus } from './status';
import type {
  Application,
  ApplicationDetail,
  ApplicationMeta,
  ApplicationSource,
  Notification,
} from './types';

export interface CreateApplicationInput {
  jobId: string;
  resume: ResumeProfile;
  source?: ApplicationSource;
}

export interface TransitionOptions {
  reason?: string;
  /** 是否向候选人发送反馈通知（实时反馈应聘结果） */
  notify?: boolean;
}

export interface TransitionResult {
  application: Application;
  notification?: Notification;
}

function recipientOf(resume: ResumeProfile): string | undefined {
  return resume.email ?? resume.phone;
}

/**
 * 候选人流水线编排层：岗位/投递持久化 + 状态机受控流转 + 自动初筛打分 + 实时反馈通知。
 * 复用既有引擎做打分、复用通知渠道与文案 Agent 做反馈，全程事件留痕、可审计。
 */
export class PipelineService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly candidates: CandidateRepository,
    private readonly applications: ApplicationRepository,
    private readonly notifications: NotificationRepository,
    private readonly engine: ScreeningEngine,
    private readonly composer: FeedbackComposer,
    private readonly notifier: Notifier,
    private readonly logger?: Logger,
  ) {}

  get engineName(): string {
    return this.engine.name;
  }

  // ---- 岗位 ----

  createJob(job: JobPosting): { id: string } {
    return { id: this.jobs.create(job) };
  }

  listJobs(): JobSummary[] {
    return this.jobs.list();
  }

  private requireJob(jobId: string): JobPosting {
    const job = this.jobs.get(jobId);
    if (!job) throw new HttpError(404, '岗位不存在，请先创建岗位（POST /api/pipeline/jobs）。');
    return job;
  }

  // ---- 投递 ----

  /** 新建投递：落库候选人 + 投递记录（applied），记录 created 事件。 */
  createApplication(input: CreateApplicationInput): Application {
    this.requireJob(input.jobId);
    const candidateId = this.candidates.create(input.resume);
    const application = this.applications.create({
      jobId: input.jobId,
      candidateId,
      source: input.source ?? 'manual',
      status: 'applied',
      screening: undefined,
    });
    this.applications.addEvent({
      applicationId: application.id,
      type: 'created',
      toStatus: 'applied',
      detail: `候选人「${input.resume.name ?? '未命名'}」投递，来源：${application.source}`,
    });
    return application;
  }

  listApplications(filter: ApplicationListFilter = {}): ApplicationMeta[] {
    return this.applications.list(filter);
  }

  private requireApplication(id: string): Application {
    const application = this.applications.get(id);
    if (!application) throw new HttpError(404, '投递记录不存在。');
    return application;
  }

  getApplicationDetail(id: string): ApplicationDetail {
    const application = this.requireApplication(id);
    const job = this.jobs.get(application.jobId);
    const candidate = this.candidates.get(application.candidateId);
    if (!job || !candidate) {
      throw new HttpError(500, '投递记录关联的岗位或候选人数据缺失。');
    }
    return {
      application,
      job,
      candidate,
      events: this.applications.listEvents(id),
      notifications: this.notifications.listByApplication(id),
    };
  }

  /** 自动初筛打分：硬性条件过滤 + 多维打分，结果写回投递记录。 */
  async screen(id: string): Promise<Application> {
    const application = this.requireApplication(id);
    const job = this.requireJob(application.jobId);
    const candidate = this.candidates.get(application.candidateId);
    if (!candidate) throw new HttpError(500, '候选人数据缺失。');
    const screening = await this.engine.scoreCandidate({ job, resume: candidate });
    this.applications.setScreening(id, screening);
    this.applications.addEvent({
      applicationId: id,
      type: 'screened',
      detail: `自动初筛完成：硬性条件${screening.hardFilter.passed ? '通过' : '未通过'}，匹配分 ${screening.matchScore}，建议 ${screening.recommendation}`,
    });
    return this.requireApplication(id);
  }

  /**
   * 受控状态流转：校验迁移合法性 → 更新状态 → 记录事件 →（可选）发送反馈通知。
   * 非法迁移抛 409，保证流程可审计、可解释。
   */
  async transition(
    id: string,
    toStatus: ApplicationStatus,
    options: TransitionOptions = {},
  ): Promise<TransitionResult> {
    const application = this.requireApplication(id);
    const from = application.status;
    if (from === toStatus) {
      throw new HttpError(409, `投递已处于「${STATUS_LABELS[toStatus]}」状态，无需重复流转。`);
    }
    if (!canTransition(from, toStatus)) {
      throw new HttpError(
        409,
        `不允许的状态流转：${STATUS_LABELS[from]} → ${STATUS_LABELS[toStatus]}。`,
      );
    }
    this.applications.updateStatus(id, toStatus);
    this.applications.addEvent({
      applicationId: id,
      type: 'status_changed',
      fromStatus: from,
      toStatus,
      detail: options.reason
        ? `状态流转：${STATUS_LABELS[from]} → ${STATUS_LABELS[toStatus]}（${options.reason}）`
        : `状态流转：${STATUS_LABELS[from]} → ${STATUS_LABELS[toStatus]}`,
    });
    let notification: Notification | undefined;
    if (options.notify) {
      notification = await this.sendFeedback(id, { reason: options.reason });
    }
    return { application: this.requireApplication(id), notification };
  }

  /**
   * 生成并发送反馈通知（实时反馈应聘结果）。
   * 文案双引擎（LLM/规则模板），经默认渠道发送（未配置渠道时 dry-run 落库）。
   */
  async sendFeedback(
    id: string,
    options: { reason?: string; preview?: boolean } = {},
  ): Promise<Notification> {
    const { application, job, candidate } = this.getApplicationDetail(id);
    const letter = await this.composer.compose({
      job,
      resume: candidate,
      status: application.status,
      reason: options.reason,
    });
    const recipient = recipientOf(candidate);
    if (options.preview) {
      // 仅预览：不落库、不发送，返回临时对象供 HR 审阅。
      return {
        id: 'preview',
        applicationId: id,
        channel: this.notifier.channel,
        recipient: recipient ?? '(未知联系方式)',
        subject: letter.subject,
        body: letter.body,
        status: 'skipped',
        engine: letter.engine,
        createdAt: new Date().toISOString(),
      };
    }
    if (!recipient) {
      const record = this.notifications.create({
        applicationId: id,
        channel: this.notifier.channel,
        recipient: '(未知联系方式)',
        subject: letter.subject,
        body: letter.body,
        status: 'failed',
        engine: letter.engine,
        error: '候选人无可用联系方式（缺少邮箱/手机号），无法发送。',
      });
      this.applications.addEvent({
        applicationId: id,
        type: 'notified',
        detail: `反馈通知失败：候选人无可用联系方式（${STATUS_LABELS[application.status]}）`,
      });
      return record;
    }
    const result = await this.notifier.send({
      recipient,
      subject: letter.subject,
      body: letter.body,
    });
    const record = this.notifications.create({
      applicationId: id,
      channel: this.notifier.channel,
      recipient,
      subject: letter.subject,
      body: letter.body,
      status: result.status,
      engine: letter.engine,
      error: result.error,
    });
    this.applications.addEvent({
      applicationId: id,
      type: 'notified',
      detail: `反馈通知（${STATUS_LABELS[application.status]}）→ ${recipient}，渠道 ${this.notifier.channel}，状态 ${result.status}`,
    });
    return record;
  }

  /** 流程漏斗统计（按状态计数），便于看板展示。 */
  stats(jobId?: string): Record<ApplicationStatus, number> {
    const metas = this.applications.list(jobId ? { jobId } : {});
    const counts = {
      applied: 0,
      screening: 0,
      interview: 0,
      rejected: 0,
      talent_pool: 0,
    } satisfies Record<ApplicationStatus, number>;
    for (const m of metas) counts[m.status] += 1;
    return counts;
  }
}
