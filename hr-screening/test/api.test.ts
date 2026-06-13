import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';

// 不传 LLM_API_KEY / 解析服务 / OSINT 服务 → 全程走规则引擎，离线、确定性，便于断言。
const app = createApp(loadConfig({}));

const job = {
  title: '后端工程师',
  company: '某科技',
  minEducation: '本科',
  minYears: 3,
  requiredSkills: ['Node.js', 'TypeScript'],
  locations: ['上海'],
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

describe('GET /health', () => {
  it('返回 ok 与引擎信息', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.engine).toBe('rule-based');
    expect(res.body.osintService).toBe('disabled');
  });
});

describe('POST /api/jobs/parse', () => {
  it('从 JD 抽取结构化字段', async () => {
    const res = await request(app).post('/api/jobs/parse').send({
      description: '本科及以上，3年以上经验，熟悉 Node.js',
      title: '后端工程师',
      city: '上海',
    });
    expect(res.status).toBe(200);
    expect(res.body.job.minEducation).toBe('本科');
    expect(res.body.job.minYears).toBe(3);
  });
});

describe('POST /api/resume/parse', () => {
  it('纯文本走兜底解析', async () => {
    const res = await request(app)
      .post('/api/resume/parse')
      .send({ text: '姓名：李四\n手机：13800000000\n本科' });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('rule-based');
    expect(res.body.resume.phone).toBe('13800000000');
  });

  it('既无 text 也无 fileBase64 → 400', async () => {
    const res = await request(app).post('/api/resume/parse').send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/screening/score', () => {
  it('合格候选人 → advance', async () => {
    const res = await request(app).post('/api/screening/score').send({ job, resume });
    expect(res.status).toBe(200);
    expect(res.body.engine).toBe('rule-based');
    expect(res.body.recommendation).toBe('advance');
    expect(res.body.hardFilter.passed).toBe(true);
  });

  it('缺 job → 400 带字段级错误', async () => {
    const res = await request(app).post('/api/screening/score').send({ resume });
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });
});

describe('POST /api/screening/batch', () => {
  it('返回带 rank 的排序结果', async () => {
    const weak = { name: '弱', highestEducation: '大专', currentLocation: '北京' };
    const res = await request(app)
      .post('/api/screening/batch')
      .send({ job, candidates: [weak, resume] });
    expect(res.status).toBe(200);
    expect(res.body.ranked).toHaveLength(2);
    expect(res.body.ranked[0].rank).toBe(1);
    expect(res.body.ranked[0].candidateName).toBe('张三');
  });
});

describe('POST /api/outreach', () => {
  it('生成触达话术', async () => {
    const res = await request(app).post('/api/outreach').send({ job, resume, channel: '电话' });
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe('电话');
    expect(res.body.message).toContain('张三');
  });
});

describe('POST /api/background-check/plan（consent 闸门）', () => {
  it('未授权 → gated', async () => {
    const res = await request(app).post('/api/background-check/plan').send({ resume });
    expect(res.status).toBe(200);
    expect(res.body.plan.gated).toBe(true);
    expect(res.body.plan.items).toHaveLength(0);
  });

  it('已授权 → 产出核验计划', async () => {
    const res = await request(app)
      .post('/api/background-check/plan')
      .send({ resume, job, consentObtained: true });
    expect(res.status).toBe(200);
    expect(res.body.plan.gated).toBe(false);
    expect(res.body.plan.items.length).toBeGreaterThan(0);
  });
});

describe('POST /api/background-check/osint（consent 闸门）', () => {
  it('未授权（consentObtained 非 true）→ 400 校验失败', async () => {
    const res = await request(app)
      .post('/api/background-check/osint')
      .send({ handles: { usernames: ['zhangsan'] } });
    expect(res.status).toBe(400);
  });

  it('已授权但未配置服务 → available=false', async () => {
    const res = await request(app)
      .post('/api/background-check/osint')
      .send({ consentObtained: true, handles: { usernames: ['zhangsan'] } });
    expect(res.status).toBe(200);
    expect(res.body.report.available).toBe(false);
  });

  it('已授权但未提供任何标识 → 400', async () => {
    const res = await request(app)
      .post('/api/background-check/osint')
      .send({ consentObtained: true, handles: {} });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/background-check/profile（consent 闸门）', () => {
  it('未确认授权 → 400', async () => {
    const res = await request(app)
      .post('/api/background-check/profile')
      .send({ resume, findings: [{ category: '学历核验', source: '学信网', result: '一致' }] });
    expect(res.status).toBe(400);
  });

  it('已授权 + 核验结论 → 返回画像', async () => {
    const res = await request(app)
      .post('/api/background-check/profile')
      .send({
        resume,
        consentObtained: true,
        findings: [{ category: '学历核验', source: '学信网', result: '学历一致，已核实' }],
      });
    expect(res.status).toBe(200);
    expect(res.body.profile.riskLevel).toBe('low');
  });
});

describe('POST /api/analyze', () => {
  it('打分 + 触达 + 背调计划齐全（未授权时无画像）', async () => {
    const res = await request(app).post('/api/analyze').send({ job, resume });
    expect(res.status).toBe(200);
    expect(res.body.screening.recommendation).toBe('advance');
    expect(res.body.outreach.message).toBeTruthy();
    expect(res.body.backgroundCheckPlan.gated).toBe(true);
    expect(res.body.profile).toBeUndefined();
  });
});

describe('错误处理', () => {
  it('未知路由返回 404', async () => {
    const res = await request(app).get('/api/不存在');
    expect(res.status).toBe(404);
    expect(res.body.error.status).toBe(404);
  });

  it('非法 JSON 体返回 400', async () => {
    const res = await request(app)
      .post('/api/screening/score')
      .set('Content-Type', 'application/json')
      .send('{ bad json');
    expect(res.status).toBe(400);
  });
});
