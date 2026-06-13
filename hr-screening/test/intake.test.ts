import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db';
import {
  ApplicationRepository,
  CandidateRepository,
  JobRepository,
  NotificationRepository,
} from '../src/db/repositories';
import { createEngine } from '../src/engine';
import { DryRunNotifier } from '../src/notify/channels';
import { RuleBasedFeedbackComposer } from '../src/notify/composer';
import { PipelineService } from '../src/pipeline/service';
import { ResumeParser } from '../src/resume/parser';
import { IntakeService } from '../src/intake/service';
import type { EmailIntakeSource } from '../src/intake/email';
import type { JobPosting } from '../src/types';

const config = loadConfig({ DB_PATH: ':memory:' });
const app = createApp(config);

const job: JobPosting = {
  title: '后端工程师',
  company: '某科技',
  city: '上海',
  minEducation: '本科',
  requiredSkills: ['Node.js'],
};

const resumeText = [
  '张三 13800000000 zhangsan@example.com',
  '本科 上海',
  '技能：Node.js TypeScript',
  '工作经历：2019.07-至今 某公司 后端工程师',
].join('\n');

async function createJobId(): Promise<string> {
  const res = await request(app).post('/api/pipeline/jobs').send(job);
  return res.body.id as string;
}

describe('POST /api/intake/batch', () => {
  it('批量上传 → 解析建档 + 自动初筛 + 自动流转，汇总正确', async () => {
    const jobId = await createJobId();
    const res = await request(app)
      .post('/api/intake/batch')
      .send({ jobId, resumes: [{ text: resumeText }, { text: '李四 lisi@example.com 大专' }] });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.ingested).toBe(2);
    expect(res.body.failed).toBe(0);
    // 自动初筛后状态应已从 applied 流转（screening 或 rejected）
    for (const r of res.body.results) {
      expect(r.ok).toBe(true);
      expect(['screening', 'rejected']).toContain(r.status);
    }

    // 入库后可在看板查到
    const list = await request(app).get(`/api/pipeline/applications?jobId=${jobId}`);
    expect(list.body.applications).toHaveLength(2);
  });

  it('jobId 不存在 → 单条失败留痕（不抛 500）', async () => {
    const res = await request(app)
      .post('/api/intake/batch')
      .send({ jobId: '不存在', resumes: [{ text: resumeText }] });
    expect(res.status).toBe(200);
    expect(res.body.ingested).toBe(0);
    expect(res.body.failed).toBe(1);
    expect(res.body.results[0].ok).toBe(false);
  });

  it('空 resumes → 400', async () => {
    const jobId = await createJobId();
    const res = await request(app).post('/api/intake/batch').send({ jobId, resumes: [] });
    expect(res.status).toBe(400);
  });
});

describe('归集来源未配置时安全禁用', () => {
  it('邮箱收件未配置 → 400', async () => {
    const jobId = await createJobId();
    const res = await request(app).post('/api/intake/email/poll').send({ jobId });
    expect(res.status).toBe(400);
  });

  it('文件夹扫描未配置 → 400', async () => {
    const jobId = await createJobId();
    const res = await request(app).post('/api/intake/folder/scan').send({ jobId });
    expect(res.status).toBe(400);
  });
});

describe('邮箱收件（注入桩源，离线）', () => {
  it('从桩邮件源拉取简历并入库', async () => {
    const db = openDatabase(':memory:');
    const jobs = new JobRepository(db);
    const candidates = new CandidateRepository(db);
    const pipeline = new PipelineService(
      jobs,
      candidates,
      new ApplicationRepository(db),
      new NotificationRepository(db),
      createEngine(config),
      new RuleBasedFeedbackComposer(),
      new DryRunNotifier(),
    );
    const jobId = jobs.create(job);

    const stubSource: EmailIntakeSource = {
      fetch: () =>
        Promise.resolve({
          items: [{ text: resumeText, meta: 'from:hr@example.com' }],
          note: '已读取 1 封未读邮件',
        }),
    };
    const intake = new IntakeService(
      new ResumeParser(config.resumeService),
      pipeline,
      config.intake,
      stubSource,
    );

    const summary = await intake.pollEmail(jobId);
    expect(summary.ingested).toBe(1);
    expect(summary.note).toContain('未读邮件');
    expect(pipeline.listApplications({ jobId })).toHaveLength(1);
  });
});
