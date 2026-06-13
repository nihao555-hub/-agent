import { watch, type FSWatcher } from 'node:fs';
import { HttpError } from '../errors';
import type { IntakeConfig } from '../config';
import type { Logger } from '../logger';
import type { PipelineService } from '../pipeline/service';
import type { ApplicationSource } from '../pipeline/types';
import type { ResumeParser } from '../resume/parser';
import type { EmailIntakeSource } from './email';
import { readFolderItems } from './folder';
import type { IntakeItem, IntakeResult, IntakeSummary } from './types';

/**
 * 简历自动归集层：把「批量上传 / 邮箱收件 / 文件夹监听」三种来源统一成
 * 「解析 → 建档（投递）→ 自动初筛打分 → 按硬性条件自动流转」的流水线。
 */
export class IntakeService {
  private readonly processed = new Set<string>();
  private watcher?: FSWatcher;

  constructor(
    private readonly parser: ResumeParser,
    private readonly pipeline: PipelineService,
    private readonly config: IntakeConfig,
    private readonly emailSource?: EmailIntakeSource,
    private readonly logger?: Logger,
  ) {}

  /** 归集单份简历：解析 → 建档 → （可选）自动初筛 + 按硬性条件流转。 */
  private async ingestOne(
    jobId: string,
    item: IntakeItem,
    source: ApplicationSource,
  ): Promise<IntakeResult> {
    try {
      const parsed = await this.parser.parse({
        text: item.text,
        fileBase64: item.fileBase64,
        fileName: item.fileName,
      });
      const application = this.pipeline.createApplication({
        jobId,
        resume: parsed.resume,
        source,
      });
      const result: IntakeResult = {
        ok: true,
        applicationId: application.id,
        candidateName: parsed.resume.name,
        parseSource: parsed.source,
        status: application.status,
        meta: item.meta,
      };
      if (this.config.autoScreen) {
        const screened = await this.pipeline.screen(application.id);
        const screening = screened.screening;
        result.matchScore = screening?.matchScore;
        result.recommendation = screening?.recommendation;
        result.hardFilterPassed = screening?.hardFilter.passed;
        // 按硬性条件自动流转：达标 → 初筛中；不达标 → 淘汰（不自动发通知，留待 HR 复核后触发）。
        const passed = screening?.hardFilter.passed ?? false;
        const failedChecks = (screening?.hardFilter.checks ?? [])
          .filter((c) => !c.passed)
          .map((c) => c.label)
          .join('、');
        const next = await this.pipeline.transition(
          application.id,
          passed ? 'screening' : 'rejected',
          {
            reason: passed
              ? '自动初筛：硬性条件通过'
              : `自动初筛：硬性条件未通过（${failedChecks || '不符合要求'}）`,
          },
        );
        result.status = next.application.status;
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn({ err: msg, meta: item.meta }, '单份简历归集失败');
      return { ok: false, error: msg, meta: item.meta };
    }
  }

  /** 批量归集（顺序执行，控制对 grsai 的并发，避免限流）。 */
  async ingestBatch(
    jobId: string,
    items: IntakeItem[],
    source: ApplicationSource = 'batch',
  ): Promise<IntakeSummary> {
    const results: IntakeResult[] = [];
    for (const item of items) {
      results.push(await this.ingestOne(jobId, item, source));
    }
    const ingested = results.filter((r) => r.ok).length;
    return {
      source,
      total: items.length,
      ingested,
      failed: results.length - ingested,
      results,
    };
  }

  /** 邮箱收件归集：拉取未读邮件中的简历并入库。未配置邮箱凭据时禁用（400）。 */
  async pollEmail(jobId: string): Promise<IntakeSummary & { note: string }> {
    if (!this.emailSource) {
      throw new HttpError(
        400,
        '未配置企业邮箱收件（IMAP_HOST/IMAP_USER/IMAP_PASSWORD），邮箱归集已禁用。',
      );
    }
    const { items, note } = await this.emailSource.fetch();
    const summary = await this.ingestBatch(jobId, items, 'email');
    return { ...summary, note };
  }

  /** 文件夹扫描归集：扫描 INTAKE_WATCH_DIR 中的简历文件并入库（已处理文件自动跳过）。 */
  async scanFolder(jobId: string): Promise<IntakeSummary & { dir: string }> {
    if (!this.config.watchDir) {
      throw new HttpError(400, '未配置归集目录（INTAKE_WATCH_DIR），文件夹归集已禁用。');
    }
    const items = await readFolderItems(this.config.watchDir, this.processed);
    const summary = await this.ingestBatch(jobId, items, 'folder');
    return { ...summary, dir: this.config.watchDir };
  }

  /**
   * 启动文件夹实时监听：目录有新简历落地时自动入库（绑定到指定岗位）。
   * 仅在配置了 INTAKE_WATCH_DIR 时由服务启动调用；测试不触发。
   */
  startFolderWatch(jobId: string): void {
    if (!this.config.watchDir || this.watcher) return;
    const dir = this.config.watchDir;
    let timer: NodeJS.Timeout | undefined;
    this.watcher = watch(dir, () => {
      // 防抖：文件写入可能触发多次事件，合并为一次扫描。
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void this.scanFolder(jobId).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger?.warn({ err: msg }, '文件夹监听归集失败');
        });
      }, 500);
    });
    this.logger?.info({ dir, jobId }, '已启动文件夹实时监听归集');
  }

  stopFolderWatch(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }
}
