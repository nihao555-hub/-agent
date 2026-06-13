import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';

// 无 key + 内存库 → 全程规则引擎、离线、确定性，无文件副作用。
const app = createApp(loadConfig({ DB_PATH: ':memory:' }));

const job = {
  title: '后端工程师',
  company: '某科技',
  city: '上海',
  minEducation: '本科',
  minYears: 3,
  requiredSkills: ['Node.js', 'TypeScript'],
};

const resume = {
  name: '张三',
  highestEducation: '本科',
  currentLocation: '上海',
  skills: ['Node.js', 'TypeScript'],
  workExperience: [
    { companyName: 'A', position: '后端工程师', startDate: '2017.07', endDate: '至今' },
  ],
};

async function createSession(): Promise<string> {
  const res = await request(app).post('/api/chat/sessions').send({ job, resume });
  expect(res.status).toBe(201);
  return res.body.session.id as string;
}

describe('GET /health', () => {
  it('storage 标注为 memory', async () => {
    const res = await request(app).get('/health');
    expect(res.body.storage).toBe('memory');
  });
});

describe('POST /api/chat/sessions', () => {
  it('建会话返回开场白与会话上下文', async () => {
    const res = await request(app).post('/api/chat/sessions').send({ job, resume });
    expect(res.status).toBe(201);
    expect(res.body.engine).toBe('rule-based');
    expect(res.body.session.status).toBe('active');
    expect(res.body.session.job.title).toBe('后端工程师');
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].role).toBe('assistant');
    expect(res.body.messages[0].content).toContain('张三');
  });

  it('缺 resume → 400', async () => {
    const res = await request(app).post('/api/chat/sessions').send({ job });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/chat/sessions/:id/messages', () => {
  it('候选人发消息 → 返回 AI 回复并累积历史', async () => {
    const id = await createSession();
    const res = await request(app)
      .post(`/api/chat/sessions/${id}/messages`)
      .send({ message: '方便的，我们聊吧' });
    expect(res.status).toBe(200);
    expect(res.body.reply.role).toBe('assistant');
    // opening + candidate + reply = 3
    expect(res.body.messages).toHaveLength(3);
    expect(res.body.messages.map((m: { role: string }) => m.role)).toEqual([
      'assistant',
      'candidate',
      'assistant',
    ]);
  });

  it('空消息 → 400', async () => {
    const id = await createSession();
    const res = await request(app).post(`/api/chat/sessions/${id}/messages`).send({ message: '' });
    expect(res.status).toBe(400);
  });

  it('不存在的会话 → 404', async () => {
    const res = await request(app)
      .post('/api/chat/sessions/不存在/messages')
      .send({ message: 'hi' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/chat/sessions/:id', () => {
  it('返回会话与完整历史', async () => {
    const id = await createSession();
    await request(app).post(`/api/chat/sessions/${id}/messages`).send({ message: '在职，25k' });
    const res = await request(app).get(`/api/chat/sessions/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe(id);
    expect(res.body.messages.length).toBeGreaterThanOrEqual(3);
  });
});

describe('POST /api/chat/sessions/:id/summary', () => {
  it('出小结并标记会话完成，完成后不可再发消息', async () => {
    const id = await createSession();
    await request(app)
      .post(`/api/chat/sessions/${id}/messages`)
      .send({ message: '在职，期望 25k' });

    const summaryRes = await request(app).post(`/api/chat/sessions/${id}/summary`);
    expect(summaryRes.status).toBe(200);
    expect(['advance', 'hold', 'reject']).toContain(summaryRes.body.summary.recommendation);

    const after = await request(app).get(`/api/chat/sessions/${id}`);
    expect(after.body.session.status).toBe('completed');
    expect(after.body.session.summary).toBeTruthy();

    const blocked = await request(app)
      .post(`/api/chat/sessions/${id}/messages`)
      .send({ message: '再补一句' });
    expect(blocked.status).toBe(409);
  });
});

describe('GET /api/chat/sessions', () => {
  it('列出会话（含消息计数）', async () => {
    await createSession();
    const res = await request(app).get('/api/chat/sessions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.sessions.length).toBeGreaterThan(0);
    expect(res.body.sessions[0]).toHaveProperty('messageCount');
  });
});
