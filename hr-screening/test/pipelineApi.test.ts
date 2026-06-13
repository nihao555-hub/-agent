import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';

// 无 key + 内存库 → 规则引擎 + dry-run 通知，离线确定性。
const app = createApp(loadConfig({ DB_PATH: ':memory:' }));

const job = {
  title: '后端工程师',
  company: '某科技',
  city: '上海',
  minEducation: '本科',
  minYears: 3,
  requiredSkills: ['Node.js', 'TypeScript'],
};

const strongResume = {
  name: '张三',
  email: 'zhangsan@example.com',
  highestEducation: '本科',
  currentLocation: '上海',
  skills: ['Node.js', 'TypeScript'],
  totalYears: 5,
  workExperience: [
    { companyName: 'A', position: '后端工程师', startDate: '2019.07', endDate: '至今' },
  ],
};

async function createJob(): Promise<string> {
  const res = await request(app).post('/api/pipeline/jobs').send(job);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createApplication(jobId: string): Promise<string> {
  const res = await request(app)
    .post('/api/pipeline/applications')
    .send({ jobId, resume: strongResume });
  expect(res.status).toBe(201);
  expect(res.body.application.status).toBe('applied');
  return res.body.application.id as string;
}

describe('POST /api/pipeline/jobs', () => {
  it('持久化岗位并可列出', async () => {
    const jobId = await createJob();
    const list = await request(app).get('/api/pipeline/jobs');
    expect(list.status).toBe(200);
    expect(list.body.jobs.some((j: { id: string }) => j.id === jobId)).toBe(true);
  });

  it('缺 title → 400', async () => {
    const res = await request(app).post('/api/pipeline/jobs').send({ company: '某科技' });
    expect(res.status).toBe(400);
  });
});

describe('投递 + 自动初筛 + 状态流转', () => {
  it('建投递 → 自动初筛写回打分 + 事件留痕', async () => {
    const jobId = await createJob();
    const appId = await createApplication(jobId);

    const screened = await request(app).post(`/api/pipeline/applications/${appId}/screen`);
    expect(screened.status).toBe(200);
    expect(screened.body.application.screening).toBeTruthy();
    expect(typeof screened.body.application.screening.matchScore).toBe('number');

    const detail = await request(app).get(`/api/pipeline/applications/${appId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.events.some((e: { type: string }) => e.type === 'screened')).toBe(true);
  });

  it('受控流转 applied → screening → interview，非法流转 409', async () => {
    const jobId = await createJob();
    const appId = await createApplication(jobId);

    const t1 = await request(app)
      .post(`/api/pipeline/applications/${appId}/transition`)
      .send({ toStatus: 'screening' });
    expect(t1.status).toBe(200);
    expect(t1.body.application.status).toBe('screening');

    // screening → applied 非法
    const bad = await request(app)
      .post(`/api/pipeline/applications/${appId}/transition`)
      .send({ toStatus: 'applied' });
    expect(bad.status).toBe(409);

    const t2 = await request(app)
      .post(`/api/pipeline/applications/${appId}/transition`)
      .send({ toStatus: 'interview', notify: true });
    expect(t2.status).toBe(200);
    expect(t2.body.application.status).toBe('interview');
    // notify=true → 反馈通知落库（dry-run，status=skipped）
    expect(t2.body.notification).toBeTruthy();
    expect(t2.body.notification.status).toBe('skipped');
    expect(t2.body.notification.body).toContain('面试');
  });

  it('反馈预览不落库，正式发送落库且事件留痕', async () => {
    const jobId = await createJob();
    const appId = await createApplication(jobId);
    await request(app)
      .post(`/api/pipeline/applications/${appId}/transition`)
      .send({ toStatus: 'rejected' });

    const preview = await request(app)
      .post(`/api/pipeline/applications/${appId}/feedback`)
      .send({ preview: true });
    expect(preview.status).toBe(200);
    expect(preview.body.notification.id).toBe('preview');

    const sent = await request(app).post(`/api/pipeline/applications/${appId}/feedback`).send({});
    expect(sent.status).toBe(200);
    expect(sent.body.notification.id).not.toBe('preview');

    const detail = await request(app).get(`/api/pipeline/applications/${appId}`);
    expect(detail.body.notifications.length).toBe(1);
    expect(detail.body.events.some((e: { type: string }) => e.type === 'notified')).toBe(true);
  });
});

describe('看板：列表 / 过滤 / 漏斗统计', () => {
  it('按 jobId 过滤 + stats 计数', async () => {
    const jobId = await createJob();
    const appId = await createApplication(jobId);
    await request(app)
      .post(`/api/pipeline/applications/${appId}/transition`)
      .send({ toStatus: 'screening' });

    const list = await request(app).get(`/api/pipeline/applications?jobId=${jobId}`);
    expect(list.status).toBe(200);
    expect(list.body.applications).toHaveLength(1);
    expect(list.body.applications[0].status).toBe('screening');

    const stats = await request(app).get(`/api/pipeline/stats?jobId=${jobId}`);
    expect(stats.status).toBe(200);
    expect(stats.body.stats.screening).toBe(1);
    expect(stats.body.stats.applied).toBe(0);
  });
});
